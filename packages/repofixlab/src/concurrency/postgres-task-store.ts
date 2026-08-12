/**
 * 脚本职责：使用 PostgreSQL 事务持久化并发任务和调度租约。
 * 输入边界：接收经过契约校验的任务及调度命令。
 * 输出边界：返回数据库提交后的任务快照。
 */

import type { Pool, PoolClient } from "pg";
import type { ConcurrencyTask, ConcurrencyTaskRequest, FailureCode, TaskStatus } from "./contracts.ts";
import { TASK_FAILURE_CODES, TASK_STATUSES } from "./contracts.ts";
import type {
	AcquireSchedulerLeaseCommand,
	ClaimExpiredLeaseCommand,
	ClaimQueuedCommand,
	FindExpiredLeasesCommand,
	HeartbeatTaskCommand,
	RecordTaskResultCommand,
	SubmitTaskCommand,
	SubmitTaskResult,
	TaskStore,
	TransitionTaskCommand,
} from "./task-store.ts";

const TASK_ROW_COLUMNS = `
    task_id,
    idempotency_key,
    request_sha256,
    request_payload,
    enqueue_sequence,
    status,
    status_version,
    attempt_id,
    lease_owner,
    lease_expires_at,
    heartbeat_at,
    attempt_count,
    failure_code,
    result_manifest_path,
    result_manifest_sha256,
    created_at,
    updated_at`;

const taskStatusSet: ReadonlySet<string> = new Set(TASK_STATUSES);
const failureCodeSet: ReadonlySet<string> = new Set(TASK_FAILURE_CODES);

interface TaskRow {
	readonly task_id: string;
	readonly idempotency_key: string;
	readonly request_sha256: string;
	readonly request_payload: unknown;
	readonly enqueue_sequence: number | string;
	readonly status: string;
	readonly status_version: number | string;
	readonly attempt_id: string | null;
	readonly lease_owner: string | null;
	readonly lease_expires_at: Date | string | null;
	readonly heartbeat_at: Date | string | null;
	readonly attempt_count: number | string;
	readonly failure_code: string | null;
	readonly result_manifest_path: string | null;
	readonly result_manifest_sha256: string | null;
	readonly created_at: Date | string;
	readonly updated_at: Date | string;
	readonly request_matches?: boolean;
}

interface LeaseRow {
	readonly lease_name: string;
}

/**
 * 类职责：表达同一幂等键绑定了不同任务请求。
 * 持有状态：保存冲突幂等键和已有任务 ID。
 * 协作边界：不修改已有任务且不隐藏冲突语义。
 */
export class IdempotencyKeyConflictError extends Error {
	readonly idempotencyKey: string;
	readonly existingTaskId: string;

	/**
	 * 函数职责：创建稳定幂等冲突错误。
	 * 输入约束：幂等键和已有任务 ID 必须来自数据库记录。
	 * 返回结果：返回消息固定的冲突错误实例。
	 * 失败语义：构造过程不修改数据库。
	 */
	constructor(idempotencyKey: string, existingTaskId: string) {
		super("idempotency_key_conflict");
		this.name = "IdempotencyKeyConflictError";
		this.idempotencyKey = idempotencyKey;
		this.existingTaskId = existingTaskId;
	}
}

/**
 * 类职责：表达任务持久化没有取得确定提交结果。
 * 持有状态：通过标准 cause 保存底层失败。
 * 协作边界：向服务层提供稳定错误消息。
 */
export class TaskPersistenceError extends Error {
	/**
	 * 函数职责：包装数据库连接及事务失败。
	 * 输入约束：原因值必须来自当前持久化调用。
	 * 返回结果：返回消息固定的持久化错误实例。
	 * 失败语义：构造过程不创建内存任务。
	 */
	constructor(cause: unknown) {
		super("task_persistence_failed", { cause });
		this.name = "TaskPersistenceError";
	}
}

/**
 * 函数职责：在独立连接中执行单个 PostgreSQL 事务。
 * 输入约束：操作函数只能使用收到的事务连接。
 * 返回结果：提交成功后返回操作结果并释放连接。
 * 失败语义：失败时回滚并返回稳定持久化错误。
 */
async function runTransaction<Result>(pool: Pool, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
	let client: PoolClient;
	try {
		client = await pool.connect();
	} catch (error) {
		throw new TaskPersistenceError(error);
	}

	try {
		await client.query("BEGIN");
		try {
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackError) {
				throw new TaskPersistenceError(new AggregateError([error, rollbackError], "task_rollback_failed"));
			}
			if (error instanceof IdempotencyKeyConflictError) throw error;
			throw new TaskPersistenceError(error);
		}
	} finally {
		client.release();
	}
}

/**
 * 函数职责：将数据库时间值转换为 UTC 文本。
 * 输入约束：输入必须是有效 Date 及可解析时间文本。
 * 返回结果：返回 ISO 8601 时间文本。
 * 失败语义：无效时间值抛出数据库行错误。
 */
function timestampToIso(value: Date | string): string {
	const timestamp = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(timestamp.getTime())) throw new Error("invalid_task_timestamp");
	return timestamp.toISOString();
}

/**
 * 函数职责：将数据库整数值转换为安全整数。
 * 输入约束：输入必须表示非负安全整数。
 * 返回结果：返回 JavaScript number。
 * 失败语义：越界及非整数值抛出数据库行错误。
 */
function safeInteger(value: number | string): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid_task_integer");
	return parsed;
}

/**
 * 函数职责：将 PostgreSQL 行映射为版本化任务快照。
 * 输入约束：数据库行必须满足迁移脚本约束。
 * 返回结果：返回不暴露数据库类型的任务对象。
 * 失败语义：字段类型及冻结集合不匹配时抛出异常。
 */
function taskFromRow(row: TaskRow): ConcurrencyTask {
	if (typeof row.request_payload !== "object" || row.request_payload === null || Array.isArray(row.request_payload)) {
		throw new Error("invalid_task_request_payload");
	}
	const payload = row.request_payload as Record<string, unknown>;
	if (
		typeof payload.repository !== "string" ||
		typeof payload.baseline_commit !== "string" ||
		typeof payload.task_content !== "string" ||
		typeof payload.caller_id !== "string"
	) {
		throw new Error("invalid_task_request_payload");
	}
	if (!taskStatusSet.has(row.status)) throw new Error("invalid_task_status");
	if (row.failure_code !== null && !failureCodeSet.has(row.failure_code)) {
		throw new Error("invalid_task_failure_code");
	}

	const request: ConcurrencyTaskRequest = {
		repository: payload.repository,
		baseline_commit: payload.baseline_commit,
		task_content: payload.task_content,
		caller_id: payload.caller_id,
	};
	const status = row.status as TaskStatus;
	const failureCode = row.failure_code as FailureCode | null;

	return {
		schema_version: "v1",
		task_id: row.task_id,
		idempotency_key: row.idempotency_key,
		request_sha256: row.request_sha256,
		request,
		enqueue_sequence: safeInteger(row.enqueue_sequence),
		status,
		status_version: safeInteger(row.status_version),
		attempt_id: row.attempt_id,
		lease_owner: row.lease_owner,
		lease_expires_at: row.lease_expires_at === null ? null : timestampToIso(row.lease_expires_at),
		heartbeat_at: row.heartbeat_at === null ? null : timestampToIso(row.heartbeat_at),
		attempt_count: safeInteger(row.attempt_count),
		failure_code: failureCode,
		result_manifest_path: row.result_manifest_path,
		result_manifest_sha256: row.result_manifest_sha256,
		created_at: timestampToIso(row.created_at),
		updated_at: timestampToIso(row.updated_at),
	};
}

/**
 * 类职责：以 PostgreSQL 事务实现任务准入、调度和租约。
 * 持有状态：仅持有调用方提供的连接池。
 * 协作边界：不保存内存任务且不判定 checkpoint。
 */
export class PostgresTaskStore implements TaskStore {
	private readonly pool: Pool;

	/**
	 * 函数职责：绑定 PostgreSQL 连接池。
	 * 输入约束：连接池必须指向已经完成迁移的数据库。
	 * 返回结果：创建无本地任务缓存的持久化适配器。
	 * 失败语义：构造过程不建立数据库事务。
	 */
	constructor(pool: Pool) {
		this.pool = pool;
	}

	/**
	 * 函数职责：原子创建任务并处理并发幂等竞争。
	 * 输入约束：任务 ID、幂等键、哈希和请求必须通过准入校验。
	 * 返回结果：事务提交后返回新建任务及已有任务。
	 * 失败语义：请求冲突返回稳定冲突，数据库失败返回持久化错误。
	 */
	async submit(command: SubmitTaskCommand): Promise<SubmitTaskResult> {
		return runTransaction(this.pool, async (client) => {
			const inserted = await client.query<TaskRow>(
				`INSERT INTO concurrency_tasks (
					    task_id,
					    idempotency_key,
					    request_sha256,
					    request_payload,
					    baseline_commit
					) VALUES ($1, $2, $3, $4::jsonb, $5)
					ON CONFLICT (idempotency_key) DO NOTHING
					RETURNING ${TASK_ROW_COLUMNS}`,
				[
					command.task_id,
					command.idempotency_key,
					command.request_sha256,
					command.request,
					command.request.baseline_commit,
				],
			);

			if (inserted.rowCount === 1) {
				return { disposition: "created", task: taskFromRow(inserted.rows[0]) };
			}

			const existing = await client.query<TaskRow>(
				`SELECT
					    ${TASK_ROW_COLUMNS},
					    request_sha256 = $2 AND request_payload = $3::jsonb AS request_matches
					FROM concurrency_tasks
					WHERE idempotency_key = $1
					FOR UPDATE`,
				[command.idempotency_key, command.request_sha256, command.request],
			);
			if (existing.rowCount !== 1) throw new Error("idempotency_record_missing");

			const task = taskFromRow(existing.rows[0]);
			if (existing.rows[0].request_matches !== true) {
				throw new IdempotencyKeyConflictError(command.idempotency_key, task.task_id);
			}

			return { disposition: "existing", task };
		});
	}

	/**
	 * 函数职责：按先进先出顺序原子领取排队任务。
	 * 输入约束：所有者必须持有未到期的指定领导租约。
	 * 返回结果：返回已经进入 preparing 的任务快照。
	 * 失败语义：租约失配返回空集合，事务失败拒绝 Promise。
	 */
	async claimQueued(command: ClaimQueuedCommand): Promise<readonly ConcurrencyTask[]> {
		if (!Number.isSafeInteger(command.limit) || command.limit <= 0) {
			throw new TaskPersistenceError(new Error("invalid_claim_limit"));
		}
		const now = new Date(command.now);
		const leaseExpiresAt = new Date(command.lease_expires_at);
		if (
			Number.isNaN(now.getTime()) ||
			Number.isNaN(leaseExpiresAt.getTime()) ||
			leaseExpiresAt.getTime() <= now.getTime()
		) {
			throw new TaskPersistenceError(new Error("invalid_task_lease_window"));
		}

		return runTransaction(this.pool, async (client) => {
			const claimed = await client.query<TaskRow>(
				`WITH candidates AS (
				    SELECT task_id
				    FROM concurrency_tasks
				    WHERE status = 'queued'
				      AND EXISTS (
				          SELECT 1
				          FROM concurrency_scheduler_lease
				          WHERE lease_name = $4
				            AND owner_id = $1
				            AND expires_at > $2::timestamptz
				      )
				    ORDER BY enqueue_sequence
				    FOR UPDATE SKIP LOCKED
				    LIMIT $5
				), updated AS (
				    UPDATE concurrency_tasks AS task
				    SET
				        status = 'preparing',
				        status_version = task.status_version + 1,
				        attempt_id = task.task_id || ':attempt:' || (task.attempt_count + 1)::text,
				        lease_owner = $1,
				        lease_expires_at = $3::timestamptz,
				        heartbeat_at = $2::timestamptz,
				        attempt_count = task.attempt_count + 1
				    FROM candidates
				    WHERE task.task_id = candidates.task_id
				    RETURNING task.*
				)
				SELECT *
				FROM updated
				ORDER BY enqueue_sequence`,
				[command.owner_id, command.now, command.lease_expires_at, command.lease_name, command.limit],
			);
			return claimed.rows.map(taskFromRow);
		});
	}

	/**
	 * 函数职责：按预期版本原子推进任务状态。
	 * 输入约束：状态和版本必须符合冻结任务契约。
	 * 返回结果：返回已经写入审计事件的新任务快照。
	 * 失败语义：版本冲突及非法转换返回持久化错误。
	 */
	async transition(command: TransitionTaskCommand): Promise<ConcurrencyTask> {
		return runTransaction(this.pool, async (client) => {
			const changed = await client.query<TaskRow>(
				`SELECT * FROM transition_concurrency_task($1, $2, $3, $4, $5, $6, $7)`,
				[
					command.task_id,
					command.expected_version,
					command.to_status,
					command.attempt_id,
					command.failure_code,
					command.result_manifest_path,
					command.result_manifest_sha256,
				],
			);
			if (changed.rowCount !== 1) throw new Error("task_transition_missing_row");
			return taskFromRow(changed.rows[0]);
		});
	}

	/**
	 * 函数职责：续期当前所有者持有的未失效任务租约。
	 * 输入约束：心跳时间单调且新到期时间严格晚于心跳。
	 * 返回结果：租约续期成功返回 true，失配返回 false。
	 * 失败语义：数据库失败时拒绝 Promise。
	 */
	async heartbeat(command: HeartbeatTaskCommand): Promise<boolean> {
		const heartbeatAt = new Date(command.heartbeat_at);
		const leaseExpiresAt = new Date(command.lease_expires_at);
		if (
			Number.isNaN(heartbeatAt.getTime()) ||
			Number.isNaN(leaseExpiresAt.getTime()) ||
			leaseExpiresAt.getTime() <= heartbeatAt.getTime()
		) {
			throw new TaskPersistenceError(new Error("invalid_heartbeat_lease_window"));
		}

		return runTransaction(this.pool, async (client) => {
			const changed = await client.query<{ readonly task_id: string }>(
				`UPDATE concurrency_tasks
				 SET
				     heartbeat_at = $3::timestamptz,
				     lease_expires_at = $4::timestamptz
				 WHERE task_id = $1
				   AND lease_owner = $2
				   AND status IN ('preparing', 'running', 'validating', 'publishing')
				   AND lease_expires_at > $3::timestamptz
				   AND heartbeat_at <= $3::timestamptz
				 RETURNING task_id`,
				[command.task_id, command.lease_owner, command.heartbeat_at, command.lease_expires_at],
			);
			return changed.rowCount === 1;
		});
	}

	/**
	 * 函数职责：按租约到期顺序读取失联任务候选。
	 * 输入约束：当前时间有效且查询上限为正安全整数。
	 * 返回结果：返回未加锁的恢复候选任务快照。
	 * 失败语义：查询失败时拒绝 Promise。
	 */
	async findExpiredLeases(command: FindExpiredLeasesCommand): Promise<readonly ConcurrencyTask[]> {
		const now = new Date(command.now);
		if (Number.isNaN(now.getTime()) || !Number.isSafeInteger(command.limit) || command.limit <= 0) {
			throw new TaskPersistenceError(new Error("invalid_expired_lease_query"));
		}

		return runTransaction(this.pool, async (client) => {
			const expired = await client.query<TaskRow>(
				`SELECT ${TASK_ROW_COLUMNS}
				 FROM concurrency_tasks
				 WHERE status IN ('preparing', 'running', 'validating', 'publishing')
				   AND attempt_id IS NOT NULL
				   AND lease_owner IS NOT NULL
				   AND lease_expires_at <= $1::timestamptz
				 ORDER BY lease_expires_at, enqueue_sequence
				 LIMIT $2`,
				[command.now, command.limit],
			);
			return expired.rows.map(taskFromRow);
		});
	}

	/**
	 * 函数职责：以版本和原所有者双条件领取失效任务。
	 * 输入约束：新租约到期时间严格晚于恢复时间。
	 * 返回结果：成功返回 recovering 快照，竞争失败返回 null。
	 * 失败语义：事务失败时不产生状态事件。
	 */
	async claimExpiredLease(command: ClaimExpiredLeaseCommand): Promise<ConcurrencyTask | null> {
		const now = new Date(command.now);
		const leaseExpiresAt = new Date(command.lease_expires_at);
		if (
			!Number.isSafeInteger(command.expected_version) ||
			command.expected_version < 0 ||
			Number.isNaN(now.getTime()) ||
			Number.isNaN(leaseExpiresAt.getTime()) ||
			leaseExpiresAt.getTime() <= now.getTime()
		) {
			throw new TaskPersistenceError(new Error("invalid_recovery_lease_command"));
		}

		return runTransaction(this.pool, async (client) => {
			const claimed = await client.query<TaskRow>(
				`UPDATE concurrency_tasks
				 SET
				     status = 'recovering',
				     status_version = status_version + 1,
				     lease_owner = $4,
				     heartbeat_at = $5::timestamptz,
				     lease_expires_at = $6::timestamptz
				 WHERE task_id = $1
				   AND status_version = $2
				   AND lease_owner = $3
				   AND status IN ('preparing', 'running', 'validating', 'publishing')
				   AND lease_expires_at <= $5::timestamptz
				 RETURNING ${TASK_ROW_COLUMNS}`,
				[
					command.task_id,
					command.expected_version,
					command.expected_lease_owner,
					command.recovery_owner,
					command.now,
					command.lease_expires_at,
				],
			);
			return claimed.rowCount === 1 ? taskFromRow(claimed.rows[0]) : null;
		});
	}

	/**
	 * 函数职责：原子绑定已发布清单并完成任务。
	 * 输入约束：任务处于 publishing，版本匹配，清单路径及哈希满足冻结契约。
	 * 返回结果：返回已清理租约并写入审计事件的 completed 快照。
	 * 失败语义：状态竞争、结果重复及字段非法时拒绝 Promise。
	 */
	async recordResult(command: RecordTaskResultCommand): Promise<ConcurrencyTask> {
		const expectedPath = `results/${command.task_id}/result-manifest.json`;
		if (
			!Number.isSafeInteger(command.expected_version) ||
			command.expected_version < 0 ||
			command.result_manifest_path !== expectedPath ||
			!/^[a-f0-9]{64}$/.test(command.result_manifest_sha256)
		) {
			throw new TaskPersistenceError(new Error("invalid_result_manifest_command"));
		}

		return runTransaction(this.pool, async (client) => {
			const changed = await client.query<TaskRow>(
				`UPDATE concurrency_tasks
				 SET
				     status = 'completed',
				     status_version = status_version + 1,
				     lease_owner = NULL,
				     lease_expires_at = NULL,
				     heartbeat_at = NULL,
				     failure_code = NULL,
				     result_manifest_path = $3,
				     result_manifest_sha256 = $4
				 WHERE task_id = $1
				   AND status_version = $2
				   AND status = 'publishing'
				   AND result_manifest_path IS NULL
				   AND result_manifest_sha256 IS NULL
				 RETURNING ${TASK_ROW_COLUMNS}`,
				[command.task_id, command.expected_version, command.result_manifest_path, command.result_manifest_sha256],
			);
			if (changed.rowCount !== 1) throw new Error("result_manifest_record_conflict");
			return taskFromRow(changed.rows[0]);
		});
	}

	/**
	 * 函数职责：原子取得及续期单调度器领导租约。
	 * 输入约束：到期时间必须严格晚于当前时间。
	 * 返回结果：当前所有者取得租约返回 true。
	 * 失败语义：其他有效所有者存在时返回 false。
	 */
	async acquireSchedulerLease(command: AcquireSchedulerLeaseCommand): Promise<boolean> {
		const now = new Date(command.now);
		const expiresAt = new Date(command.expires_at);
		if (Number.isNaN(now.getTime()) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
			throw new TaskPersistenceError(new Error("invalid_scheduler_lease_window"));
		}

		return runTransaction(this.pool, async (client) => {
			const acquired = await client.query<LeaseRow>(
				`INSERT INTO concurrency_scheduler_lease (
				    lease_name,
				    owner_id,
				    expires_at
				) VALUES ($1, $2, $4::timestamptz)
				ON CONFLICT (lease_name) DO UPDATE
				SET
				    owner_id = EXCLUDED.owner_id,
				    expires_at = EXCLUDED.expires_at,
				    lease_version = concurrency_scheduler_lease.lease_version + 1,
				    updated_at = clock_timestamp()
				WHERE concurrency_scheduler_lease.owner_id = EXCLUDED.owner_id
				   OR concurrency_scheduler_lease.expires_at <= $3::timestamptz
				RETURNING lease_name`,
				[command.lease_name, command.owner_id, command.now, command.expires_at],
			);
			return acquired.rowCount === 1;
		});
	}
}
