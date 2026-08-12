/**
 * 脚本职责：在真实 PostgreSQL 中验证首个并发工作流。
 * 输入边界：读取专用 Docker 容器和版本化迁移脚本。
 * 输出边界：输出事务竞争与审计一致性的 JSON 证据。
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const container = process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_CONTAINER ?? "repofixlab-concurrency-postgres-1";
const database = "repofixlab_concurrency";
const user = "repofixlab";
const migration = readFileSync(new URL("../../migrations/001_concurrency.sql", import.meta.url), "utf8");
const sha256 = "b".repeat(64);
const gitSha = "a".repeat(40);

/**
 * 函数职责：在专用容器内同步执行一段 SQL。
 * 输入约束：容器必须运行且 SQL 必须是可信测试内容。
 * 返回结果：返回去除末尾空白的标准输出。
 * 失败语义：psql 失败时抛出包含标准错误的异常。
 */
function executeSql(sql) {
	const result = spawnSync(
		"docker",
		["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-Atq"],
		{ encoding: "utf8", input: sql },
	);
	if (result.status !== 0) {
		throw new Error(`psql_failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

/**
 * 函数职责：在独立 psql 进程中异步执行一段 SQL。
 * 输入约束：调用方必须提供可并发执行的单事务 SQL。
 * 返回结果：返回进程退出码和标准错误。
 * 失败语义：进程启动失败时拒绝 Promise。
 */
function executeSqlConcurrent(sql) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"docker",
			["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-Atq"],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (value) => {
			stderr += value;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stderr: stderr.trim() }));
		child.stdin.end(sql);
	});
}

/**
 * 函数职责：执行预期失败的 SQL 并校验稳定错误文本。
 * 输入约束：SQL 必须触发 expectedMessage 指定的数据库错误。
 * 返回结果：错误匹配时正常返回。
 * 失败语义：SQL 成功、错误文本不匹配均抛出异常。
 */
function expectSqlFailure(sql, expectedMessage) {
	const result = spawnSync(
		"docker",
		["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-Atq"],
		{ encoding: "utf8", input: sql },
	);
	if (result.status === 0 || !result.stderr.includes(expectedMessage)) {
		throw new Error(`expected_psql_failure_missing: ${expectedMessage}: ${result.stderr.trim()}`);
	}
}

/**
 * 函数职责：构造一条固定 queued 任务插入语句。
 * 输入约束：任务 ID 和幂等键必须满足数据库标识符约束。
 * 返回结果：返回不含外部输入的可信 SQL 文本。
 * 失败语义：函数不访问外部状态。
 */
function insertTaskSql(taskId, idempotencyKey) {
	return `
INSERT INTO concurrency_tasks (
    task_id,
    idempotency_key,
    request_sha256,
    request_payload,
    baseline_commit
) VALUES (
    '${taskId}',
    '${idempotencyKey}',
    '${sha256}',
    '{"repository":"fixture","task_content":"fix","caller_id":"local"}'::jsonb,
    '${gitSha}'
);`;
}

/**
 * 函数职责：比较实际字符串和固定预期值。
 * 输入约束：两个值必须已经转换为字符串。
 * 返回结果：相等时正常返回。
 * 失败语义：不相等时抛出带标签的异常。
 */
function assertEqual(label, actual, expected) {
	if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

/**
 * 函数职责：执行 WORKSTREAM1 的三个数据库 badcase。
 * 输入约束：专用 PostgreSQL 容器必须处于健康状态。
 * 返回结果：输出可复核的 JSON 验收摘要。
 * 失败语义：任一不变量失败时设置非零进程退出码。
 */
async function main() {
	executeSql(`
DROP TABLE IF EXISTS concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease CASCADE;
DROP FUNCTION IF EXISTS concurrency_task_transition_allowed(text, text);
DROP FUNCTION IF EXISTS enforce_concurrency_task_update();
DROP FUNCTION IF EXISTS record_concurrency_task_event();`);
	executeSql(migration);
	executeSql("TRUNCATE concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease RESTART IDENTITY;");
	try {
		const transitionMatrix = executeSql(`
WITH statuses(value) AS (
    SELECT unnest(ARRAY[
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
    ])
)
SELECT source.value || '>' || target.value
FROM statuses source
CROSS JOIN statuses target
WHERE concurrency_task_transition_allowed(source.value, target.value)
ORDER BY source.value, target.value;`);
		assertEqual(
			"database_transition_matrix",
			transitionMatrix,
			[
				"preparing>failed",
				"preparing>recovering",
				"preparing>running",
				"publishing>completed",
				"publishing>failed",
				"publishing>recovering",
				"publishing>revalidation_required",
				"queued>cancelled",
				"queued>preparing",
				"recovering>failed",
				"recovering>running",
				"running>failed",
				"running>recovering",
				"running>validating",
				"validating>failed",
				"validating>publishing",
				"validating>recovering",
				"validating>revalidation_required",
			].join("\n"),
		);

		executeSql(insertTaskSql("task-race", "key-race"));
		const raceSql = `SELECT status_version FROM transition_concurrency_task(
            'task-race', 0, 'preparing', 'attempt-race', NULL, NULL, NULL
        );`;
		const raceResults = await Promise.all(Array.from({ length: 20 }, () => executeSqlConcurrent(raceSql)));
		const raceSuccesses = raceResults.filter((result) => result.code === 0).length;
		const raceConflicts = raceResults.filter((result) => result.stderr.includes("task_version_conflict")).length;
		assertEqual("race_successes", String(raceSuccesses), "1");
		assertEqual("race_conflicts", String(raceConflicts), "19");
		assertEqual(
			"race_state",
			executeSql("SELECT status || '|' || status_version FROM concurrency_tasks WHERE task_id = 'task-race';"),
			"preparing|1",
		);

		executeSql(insertTaskSql("task-terminal", "key-terminal"));
		executeSql(`
SELECT status FROM transition_concurrency_task('task-terminal', 0, 'preparing', 'attempt-terminal', NULL, NULL, NULL);
SELECT status FROM transition_concurrency_task('task-terminal', 1, 'running', 'attempt-terminal', NULL, NULL, NULL);
SELECT status FROM transition_concurrency_task('task-terminal', 2, 'validating', 'attempt-terminal', NULL, NULL, NULL);
SELECT status FROM transition_concurrency_task('task-terminal', 3, 'publishing', 'attempt-terminal', NULL, NULL, NULL);
SELECT status FROM transition_concurrency_task(
    'task-terminal',
    4,
    'completed',
    'attempt-terminal',
    NULL,
    'results/task-terminal/manifest.json',
    '${sha256}'
);`);
		expectSqlFailure(
			"SELECT status FROM transition_concurrency_task('task-terminal', 5, 'running', 'attempt-terminal', NULL, NULL, NULL);",
			"invalid_task_transition: completed -> running",
		);
		assertEqual(
			"terminal_state",
			executeSql("SELECT status || '|' || status_version FROM concurrency_tasks WHERE task_id = 'task-terminal';"),
			"completed|5",
		);
		assertEqual(
			"terminal_event_count",
			executeSql("SELECT count(*) FROM concurrency_task_events WHERE task_id = 'task-terminal';"),
			"6",
		);

		executeSql(insertTaskSql("task-atomic", "key-atomic"));
		expectSqlFailure(
			"SELECT status FROM transition_concurrency_task('task-atomic', 1, 'preparing', 'attempt-atomic', NULL, NULL, NULL);",
			"task_version_conflict",
		);
		assertEqual(
			"atomic_state_and_events",
			executeSql(`
SELECT task.status_version || '|' || count(event.event_id)
FROM concurrency_tasks task
JOIN concurrency_task_events event ON event.task_id = task.task_id
WHERE task.task_id = 'task-atomic'
GROUP BY task.status_version;`),
			"0|1",
		);

		process.stdout.write(
			`${JSON.stringify({
				workstream: 1,
				postgres: "16-alpine",
				race_clients: 20,
				race_successes: raceSuccesses,
				race_conflicts: raceConflicts,
				transition_matrix_matches_contract: true,
				invalid_terminal_transition_rejected: true,
				failed_write_event_count: 0,
				status: "accepted",
			})}\n`,
		);
	} finally {
		executeSql("TRUNCATE concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease RESTART IDENTITY;");
	}
}

await main();
