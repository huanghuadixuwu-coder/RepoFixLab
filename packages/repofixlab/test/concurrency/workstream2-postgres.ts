/**
 * 脚本职责：在 Docker PostgreSQL 中验证任务准入与幂等事务。
 * 输入边界：读取本机专用连接串和版本化迁移脚本。
 * 输出边界：输出二十客户端竞争与回滚一致性的 JSON 证据。
 */

import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { AdmissionService, taskIdForIdempotencyKey } from "../../src/concurrency/admission-service.ts";
import type { ConcurrencyTaskRequest } from "../../src/concurrency/contracts.ts";
import {
	IdempotencyKeyConflictError,
	PostgresTaskStore,
	TaskPersistenceError,
} from "../../src/concurrency/postgres-task-store.ts";

const connectionString =
	process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_URL ??
	"postgresql://repofixlab:repofixlab-local-test@127.0.0.1:55432/repofixlab_concurrency";
const request: ConcurrencyTaskRequest = {
	repository: "fixture/repo",
	baseline_commit: "a".repeat(40),
	task_content: "fix concentrated submission",
	caller_id: "local-user",
};

interface CountRow {
	readonly count: string;
}

/**
 * 函数职责：比较实际值和冻结预期值。
 * 输入约束：标签和两个值必须已经转换为字符串。
 * 返回结果：两个值相等时正常返回。
 * 失败语义：值不相等时抛出带标签的异常。
 */
function assertEqual(label: string, actual: string, expected: string): void {
	if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

/**
 * 函数职责：重建 WORKSTREAM2 专用数据库结构。
 * 输入约束：连接池必须指向可清理的本机测试数据库。
 * 返回结果：迁移完成后返回。
 * 失败语义：清理及迁移失败时拒绝 Promise。
 */
async function resetSchema(pool: Pool): Promise<void> {
	await pool.query(`
DROP TABLE IF EXISTS concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease CASCADE;
DROP FUNCTION IF EXISTS concurrency_task_transition_allowed(text, text);
DROP FUNCTION IF EXISTS enforce_concurrency_task_update();
DROP FUNCTION IF EXISTS record_concurrency_task_event();
DROP FUNCTION IF EXISTS transition_concurrency_task(text, bigint, text, text, text, text, text);
DROP FUNCTION IF EXISTS reject_concurrency_registration_test();`);
	const migration = await readFile(new URL("../../migrations/001_concurrency.sql", import.meta.url), "utf8");
	await pool.query(migration);
}

/**
 * 函数职责：执行 WORKSTREAM2 的三个 PostgreSQL badcase。
 * 输入约束：专用 PostgreSQL 16 容器必须处于健康状态。
 * 返回结果：输出可复核的本机验收摘要。
 * 失败语义：任一幂等及事务不变量失败时设置非零退出码。
 */
async function main(): Promise<void> {
	const pool = new Pool({ connectionString, max: 20, connectionTimeoutMillis: 5_000 });
	try {
		await resetSchema(pool);
		const service = new AdmissionService(new PostgresTaskStore(pool));
		const idempotencyKey = "ws2-same-request";
		const responses = await Promise.all(
			Array.from({ length: 20 }, () => service.submit({ idempotency_key: idempotencyKey, request })),
		);
		const taskIds = responses.map((response) => response.task.task_id);
		const requestHashes = responses.map((response) => response.task.request_sha256);
		const idempotencyKeys = responses.map((response) => response.task.idempotency_key);
		const createdCount = responses.filter((response) => response.disposition === "created").length;
		const existingCount = responses.filter((response) => response.disposition === "existing").length;
		const sameRequestTaskCount = await pool.query<CountRow>(
			"SELECT count(*)::text AS count FROM concurrency_tasks WHERE idempotency_key = $1",
			[idempotencyKey],
		);
		assertEqual("same_request_task_count", sameRequestTaskCount.rows[0].count, "1");
		assertEqual("unique_response_task_ids", String(new Set(taskIds).size), "1");
		assertEqual("created_response_count", String(createdCount), "1");
		assertEqual("existing_response_count", String(existingCount), "19");

		const conflictKey = "ws2-conflict";
		await service.submit({ idempotency_key: conflictKey, request });
		let conflictCode = "missing";
		try {
			await service.submit({
				idempotency_key: conflictKey,
				request: { ...request, task_content: "different content" },
			});
		} catch (error) {
			if (!(error instanceof IdempotencyKeyConflictError)) throw error;
			conflictCode = error.message;
		}
		assertEqual("conflict_code", conflictCode, "idempotency_key_conflict");

		const disconnectedPool = new Pool({
			connectionString: "postgresql://repofixlab:repofixlab-local-test@127.0.0.1:1/repofixlab_concurrency",
			max: 1,
			connectionTimeoutMillis: 300,
		});
		let disconnectedDatabaseCode = "missing";
		try {
			const disconnectedService = new AdmissionService(new PostgresTaskStore(disconnectedPool));
			await disconnectedService.submit({ idempotency_key: "ws2-disconnected", request });
		} catch (error) {
			if (!(error instanceof TaskPersistenceError)) throw error;
			disconnectedDatabaseCode = error.message;
		} finally {
			await disconnectedPool.end();
		}
		assertEqual("disconnected_database_code", disconnectedDatabaseCode, "task_persistence_failed");
		const disconnectedRows = await pool.query<CountRow>(
			"SELECT count(*)::text AS count FROM concurrency_tasks WHERE idempotency_key = 'ws2-disconnected'",
		);
		assertEqual("disconnected_database_task_count", disconnectedRows.rows[0].count, "0");

		await pool.query(`
CREATE FUNCTION reject_concurrency_registration_test()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM concurrency_tasks
        WHERE task_id = NEW.task_id
          AND idempotency_key = 'ws2-atomic-failure'
    ) THEN
        RAISE EXCEPTION 'injected_registration_failure';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER concurrency_task_events_reject_test
    BEFORE INSERT ON concurrency_task_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_concurrency_registration_test();`);

		let persistenceCode = "missing";
		try {
			await service.submit({ idempotency_key: "ws2-atomic-failure", request });
		} catch (error) {
			if (!(error instanceof TaskPersistenceError)) throw error;
			persistenceCode = error.message;
		}
		assertEqual("persistence_code", persistenceCode, "task_persistence_failed");

		const atomicTaskId = taskIdForIdempotencyKey("ws2-atomic-failure");
		const atomicCounts = await pool.query<CountRow>(
			`SELECT (
			    (SELECT count(*) FROM concurrency_tasks WHERE task_id = $1) +
			    (SELECT count(*) FROM concurrency_task_events WHERE task_id = $1)
			)::text AS count`,
			[atomicTaskId],
		);
		assertEqual("atomic_task_and_event_count", atomicCounts.rows[0].count, "0");

		process.stdout.write(
			`${JSON.stringify({
				workstream: 2,
				postgres: "16-alpine",
				concurrent_clients: 20,
				created_responses: createdCount,
				existing_responses: existingCount,
				request_sha256: requestHashes,
				idempotency_keys: idempotencyKeys,
				task_ids: taskIds,
				conflict_code: conflictCode,
				disconnected_database_code: disconnectedDatabaseCode,
				disconnected_database_task_rows: 0,
				interrupted_transaction_task_rows: 0,
				interrupted_transaction_event_rows: 0,
				status: "accepted",
			})}\n`,
		);
	} finally {
		try {
			await pool.query(`
DROP TRIGGER IF EXISTS concurrency_task_events_reject_test ON concurrency_task_events;
DROP FUNCTION IF EXISTS reject_concurrency_registration_test();
TRUNCATE concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease RESTART IDENTITY;`);
		} finally {
			await pool.end();
		}
	}
}

await main();
