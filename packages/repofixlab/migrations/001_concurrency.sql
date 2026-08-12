/*
 * 脚本职责：创建并发任务、审计事件和调度租约结构。
 * 输入边界：要求 PostgreSQL 16 和空闲 public 命名空间。
 * 输出边界：提供版本化状态写入及不可分割审计记录。
 */

BEGIN;

CREATE TABLE concurrency_tasks (
    task_id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    request_sha256 text NOT NULL,
    request_payload jsonb NOT NULL,
    baseline_commit text NOT NULL,
    enqueue_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    status text NOT NULL DEFAULT 'queued',
    status_version bigint NOT NULL DEFAULT 0,
    attempt_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0,
    failure_code text,
    result_manifest_path text,
    result_manifest_sha256 text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT concurrency_tasks_task_id_format CHECK (task_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    CONSTRAINT concurrency_tasks_idempotency_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
    CONSTRAINT concurrency_tasks_request_sha256_format CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT concurrency_tasks_baseline_commit_format CHECK (baseline_commit ~ '^[a-f0-9]{40}$'),
    CONSTRAINT concurrency_tasks_status CHECK (
        status IN (
            'queued',
            'preparing',
            'running',
            'validating',
            'publishing',
            'recovering',
            'revalidation_required',
            'completed',
            'failed',
            'cancelled'
        )
    ),
    CONSTRAINT concurrency_tasks_status_version CHECK (status_version >= 0),
    CONSTRAINT concurrency_tasks_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT concurrency_tasks_attempt_id_format CHECK (
        attempt_id IS NULL OR attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    ),
    CONSTRAINT concurrency_tasks_lease_owner_format CHECK (
        lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    ),
    CONSTRAINT concurrency_tasks_failure_binding CHECK (
        (status = 'failed' AND failure_code IS NOT NULL)
        OR (status <> 'failed' AND failure_code IS NULL)
    ),
    CONSTRAINT concurrency_tasks_failure_code CHECK (
        failure_code IS NULL
        OR failure_code IN (
            'checkpoint_incomplete',
            'workspace_cleanup_failed',
            'result_manifest_invalid',
            'task_executor_failure'
        )
    ),
    CONSTRAINT concurrency_tasks_result_sha256_format CHECK (
        result_manifest_sha256 IS NULL OR result_manifest_sha256 ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT concurrency_tasks_result_binding CHECK (
        (
            status = 'completed'
            AND result_manifest_path = 'results/' || task_id || '/result-manifest.json'
            AND result_manifest_sha256 IS NOT NULL
        )
        OR (
            status <> 'completed'
            AND result_manifest_path IS NULL
            AND result_manifest_sha256 IS NULL
        )
    )
);

CREATE INDEX concurrency_tasks_queue_index
    ON concurrency_tasks (enqueue_sequence)
    WHERE status = 'queued';

CREATE INDEX concurrency_tasks_expired_lease_index
    ON concurrency_tasks (lease_expires_at)
    WHERE lease_expires_at IS NOT NULL;

CREATE TABLE concurrency_task_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id text NOT NULL REFERENCES concurrency_tasks(task_id) ON DELETE RESTRICT,
    event_type text NOT NULL,
    from_status text,
    to_status text NOT NULL,
    from_version bigint,
    to_version bigint NOT NULL,
    attempt_id text,
    failure_code text,
    result_manifest_sha256 text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT concurrency_task_events_type CHECK (event_type IN ('task_registered', 'task_transition')),
    CONSTRAINT concurrency_task_events_from_status CHECK (
        from_status IS NULL
        OR from_status IN (
            'queued',
            'preparing',
            'running',
            'validating',
            'publishing',
            'recovering',
            'revalidation_required',
            'completed',
            'failed',
            'cancelled'
        )
    ),
    CONSTRAINT concurrency_task_events_to_status CHECK (
        to_status IN (
            'queued',
            'preparing',
            'running',
            'validating',
            'publishing',
            'recovering',
            'revalidation_required',
            'completed',
            'failed',
            'cancelled'
        )
    ),
    CONSTRAINT concurrency_task_events_unique_version UNIQUE (task_id, to_version),
    CONSTRAINT concurrency_task_events_shape CHECK (
        (
            event_type = 'task_registered'
            AND from_status IS NULL
            AND from_version IS NULL
            AND to_status = 'queued'
            AND to_version = 0
        )
        OR (
            event_type = 'task_transition'
            AND from_status IS NOT NULL
            AND from_version IS NOT NULL
            AND to_version = from_version + 1
        )
    )
);

CREATE TABLE concurrency_scheduler_lease (
    lease_name text PRIMARY KEY,
    owner_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    lease_version bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT concurrency_scheduler_lease_name_format CHECK (
        lease_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    ),
    CONSTRAINT concurrency_scheduler_owner_id_format CHECK (
        owner_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    ),
    CONSTRAINT concurrency_scheduler_lease_version CHECK (lease_version >= 0)
);

/**
 * 函数职责：判断两项任务状态是否满足冻结转换规则。
 * 输入约束：输入值必须来自任务状态集合。
 * 返回结果：合法转换返回 true，其他转换返回 false。
 * 失败语义：未知状态返回 false，不修改数据库。
 */
CREATE FUNCTION concurrency_task_transition_allowed(
    from_status text,
    to_status text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE from_status
        WHEN 'queued' THEN to_status IN ('preparing', 'cancelled')
        WHEN 'preparing' THEN to_status IN ('running', 'recovering', 'failed')
        WHEN 'running' THEN to_status IN ('validating', 'recovering', 'failed')
        WHEN 'validating' THEN to_status IN ('publishing', 'recovering', 'revalidation_required', 'failed')
        WHEN 'publishing' THEN to_status IN ('recovering', 'revalidation_required', 'completed', 'failed')
        WHEN 'recovering' THEN to_status IN ('running', 'failed')
        ELSE false
    END;
$$;

/**
 * 函数职责：保护任务不可变字段并校验状态版本递增。
 * 输入约束：由 concurrency_tasks 更新触发器调用。
 * 返回结果：返回经过时间戳归一化的新任务行。
 * 失败语义：字段漂移和非法转换终止整个事务。
 */
CREATE FUNCTION enforce_concurrency_task_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.task_id <> OLD.task_id
        OR NEW.idempotency_key <> OLD.idempotency_key
        OR NEW.request_sha256 <> OLD.request_sha256
        OR NEW.request_payload <> OLD.request_payload
        OR NEW.baseline_commit <> OLD.baseline_commit
        OR NEW.enqueue_sequence <> OLD.enqueue_sequence
        OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable_task_field_changed' USING ERRCODE = '23000';
    END IF;

    IF NEW.status <> OLD.status THEN
        IF NEW.status_version <> OLD.status_version + 1 THEN
            RAISE EXCEPTION 'task_status_version_not_incremented' USING ERRCODE = '40001';
        END IF;
        IF NOT concurrency_task_transition_allowed(OLD.status, NEW.status) THEN
            RAISE EXCEPTION 'invalid_task_transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.status_version <> OLD.status_version THEN
        RAISE EXCEPTION 'task_status_version_changed_without_transition' USING ERRCODE = '40001';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

/**
 * 函数职责：为任务注册和状态转换追加审计事件。
 * 输入约束：由 concurrency_tasks 插入及更新触发器调用。
 * 返回结果：写入同事务事件并返回任务行。
 * 失败语义：事件写入失败时回滚任务主记录变化。
 */
CREATE FUNCTION record_concurrency_task_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO concurrency_task_events (
            task_id,
            event_type,
            from_status,
            to_status,
            from_version,
            to_version,
            attempt_id,
            failure_code,
            result_manifest_sha256
        ) VALUES (
            NEW.task_id,
            'task_registered',
            NULL,
            NEW.status,
            NULL,
            NEW.status_version,
            NEW.attempt_id,
            NEW.failure_code,
            NEW.result_manifest_sha256
        );
    ELSE
        INSERT INTO concurrency_task_events (
            task_id,
            event_type,
            from_status,
            to_status,
            from_version,
            to_version,
            attempt_id,
            failure_code,
            result_manifest_sha256
        ) VALUES (
            NEW.task_id,
            'task_transition',
            OLD.status,
            NEW.status,
            OLD.status_version,
            NEW.status_version,
            NEW.attempt_id,
            NEW.failure_code,
            NEW.result_manifest_sha256
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER concurrency_tasks_enforce_update
    BEFORE UPDATE ON concurrency_tasks
    FOR EACH ROW
    EXECUTE FUNCTION enforce_concurrency_task_update();

CREATE TRIGGER concurrency_tasks_record_registration
    AFTER INSERT ON concurrency_tasks
    FOR EACH ROW
    EXECUTE FUNCTION record_concurrency_task_event();

CREATE TRIGGER concurrency_tasks_record_transition
    AFTER UPDATE OF status ON concurrency_tasks
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION record_concurrency_task_event();

/**
 * 函数职责：按预期版本原子推进任务状态。
 * 输入约束：任务存在且预期版本匹配当前版本。
 * 返回结果：返回任务行，终态租约清空并追加审计。
 * 失败语义：版本冲突和非法转换不产生持久化变化。
 */
CREATE FUNCTION transition_concurrency_task(
    input_task_id text,
    expected_version bigint,
    target_status text,
    target_attempt_id text,
    target_failure_code text,
    target_result_manifest_path text,
    target_result_manifest_sha256 text
) RETURNS concurrency_tasks
LANGUAGE plpgsql
AS $$
DECLARE
    changed concurrency_tasks%ROWTYPE;
BEGIN
    UPDATE concurrency_tasks
    SET
        status = target_status,
        status_version = status_version + 1,
        attempt_id = COALESCE(target_attempt_id, attempt_id),
        lease_owner = CASE
            WHEN target_status IN ('revalidation_required', 'completed', 'failed', 'cancelled') THEN NULL
            ELSE lease_owner
        END,
        lease_expires_at = CASE
            WHEN target_status IN ('revalidation_required', 'completed', 'failed', 'cancelled') THEN NULL
            ELSE lease_expires_at
        END,
        heartbeat_at = CASE
            WHEN target_status IN ('revalidation_required', 'completed', 'failed', 'cancelled') THEN NULL
            ELSE heartbeat_at
        END,
        failure_code = target_failure_code,
        result_manifest_path = COALESCE(target_result_manifest_path, result_manifest_path),
        result_manifest_sha256 = COALESCE(target_result_manifest_sha256, result_manifest_sha256)
    WHERE task_id = input_task_id
      AND status_version = expected_version
    RETURNING * INTO changed;

    IF NOT FOUND THEN
        IF EXISTS (SELECT 1 FROM concurrency_tasks WHERE task_id = input_task_id) THEN
            RAISE EXCEPTION 'task_version_conflict' USING ERRCODE = '40001';
        END IF;
        RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
    END IF;

    RETURN changed;
END;
$$;

COMMIT;
