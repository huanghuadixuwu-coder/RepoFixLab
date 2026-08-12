/**
 * 脚本职责：在 Docker PostgreSQL 中验收租约失效和单所有者恢复。
 * 输入边界：读取固定本机配置、测试时钟和持久化 checkpoint。
 * 输出边界：输出失联发现、恢复竞争和证据保留结果。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { AdmissionService } from "../../src/concurrency/admission-service.ts";
import type { ConcurrencyTask } from "../../src/concurrency/contracts.ts";
import {
	LeaseManager,
	type LeaseManagerOptions,
	type RecoveryBatchResult,
	type RecoveryCheckpointSource,
} from "../../src/concurrency/lease-manager.ts";
import { PostgresTaskStore } from "../../src/concurrency/postgres-task-store.ts";
import type { TaskLeaseStore } from "../../src/concurrency/task-store.ts";
import { directoryContentSha256 } from "../../src/concurrency/workspace-manager.ts";
import type { AttemptRecoveryCheckpoint } from "../../src/runner/batch-state.ts";
import { loadLocalConcurrencyProfile } from "./local-profile.ts";

const connectionString =
	process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_URL ??
	"postgresql://repofixlab:repofixlab-local-test@127.0.0.1:55432/repofixlab_concurrency";
const runParent = "/run/repofixlab";

interface CountRow {
	readonly count: string;
}

interface RecoveryAuditRow {
	readonly max_claims: string;
	readonly task_count: string;
}

interface TaskStateRow {
	readonly attempt_id: string | null;
	readonly failure_code: string | null;
	readonly lease_owner: string | null;
	readonly status: string;
	readonly status_version: string;
}

interface RecoveryEvidence {
	readonly root: string;
	readonly sha256: string;
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
 * 函数职责：重建 WORKSTREAM5 专用数据库结构。
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
DROP FUNCTION IF EXISTS transition_concurrency_task(text, bigint, text, text, text, text, text);`);
	const migration = await readFile(new URL("../../migrations/001_concurrency.sql", import.meta.url), "utf8");
	await pool.query(migration);
}

/**
 * 函数职责：创建两方完成候选读取后的同步屏障。
 * 输入约束：函数只允许被两个恢复管理器各调用一次。
 * 返回结果：第二方到达后同时释放两个 Promise。
 * 失败语义：重复调用会停留并由验收超时暴露。
 */
function createRecoveryReadBarrier(): () => Promise<void> {
	let arrivals = 0;
	let release = (): void => {
		throw new Error("recovery_barrier_not_initialized");
	};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	return async () => {
		arrivals += 1;
		if (arrivals === 2) release();
		await barrier;
	};
}

/**
 * 函数职责：在真实租约端口前同步两个候选读取结果。
 * 输入约束：真实存储必须实现全部租约原子操作。
 * 返回结果：返回仅延迟候选返回的测试适配端口。
 * 失败语义：真实存储失败时原样拒绝 Promise。
 */
function synchronizedLeaseStore(store: TaskLeaseStore, waitForPeer: () => Promise<void>): LeaseManagerOptions["store"] {
	return {
		heartbeat: (command) => store.heartbeat(command),
		async findExpiredLeases(command) {
			const candidates = await store.findExpiredLeases(command);
			await waitForPeer();
			return candidates;
		},
		claimExpiredLease: (command) => store.claimExpiredLease(command),
		transition: (command) => store.transition(command),
	};
}

/**
 * 函数职责：创建与失联任务 attempt 绑定的完整 checkpoint。
 * 输入约束：任务必须处于 running 且带有效 attempt。
 * 返回结果：返回通过静止边界检查的持久化记录。
 * 失败语义：缺少 attempt 时抛出夹具错误。
 */
function completeCheckpoint(task: ConcurrencyTask, ledgerOffset: number): AttemptRecoveryCheckpoint {
	if (task.attempt_id === null) throw new Error("missing_recovery_attempt_id");
	return {
		attempt_id: task.attempt_id,
		status: "running",
		worker_lease_id: "worker-primary",
		session_sha256: "1".repeat(64),
		stage_sha256: "2".repeat(64),
		trace_offset: ledgerOffset * 10,
		token_ledger_offset: ledgerOffset,
		checkpoint_sha256: "3".repeat(64),
		quiescent: true,
		in_flight_operations: 0,
		open_reservations: 0,
	};
}

/**
 * 函数职责：为失联任务写入日志、工作区索引和费用账本。
 * 输入约束：运行根及任务 attempt 必须属于本次验收。
 * 返回结果：返回证据目录及写入后的内容哈希。
 * 失败语义：证据写入失败时拒绝 Promise。
 */
async function writeRecoveryEvidence(runRoot: string, task: ConcurrencyTask): Promise<RecoveryEvidence> {
	if (task.attempt_id === null) throw new Error("missing_evidence_attempt_id");
	const evidenceRoot = join(runRoot, "evidence", task.task_id);
	await mkdir(evidenceRoot, { recursive: true, mode: 0o750 });
	await Promise.all([
		writeFile(join(evidenceRoot, "executor.log"), `lost executor ${task.task_id}\n`, "utf8"),
		writeFile(
			join(evidenceRoot, "workspace-index.json"),
			`${JSON.stringify({ schema_version: "v1", task_id: task.task_id, attempt_id: task.attempt_id })}\n`,
			"utf8",
		),
		writeFile(
			join(evidenceRoot, "model-ledger.jsonl"),
			`${JSON.stringify({ attempt_id: task.attempt_id, charge_sequence: 1, input_tokens: 100 })}\n`,
			"utf8",
		),
	]);
	return { root: evidenceRoot, sha256: await directoryContentSha256(evidenceRoot) };
}

/**
 * 函数职责：统计证据目录中的模型费用记录行数。
 * 输入约束：证据目录必须包含固定模型账本文件。
 * 返回结果：返回非空 JSONL 行数量。
 * 失败语义：账本缺失及读取失败时拒绝 Promise。
 */
async function modelLedgerRecordCount(evidence: readonly RecoveryEvidence[]): Promise<number> {
	let total = 0;
	for (const item of evidence) {
		const content = await readFile(join(item.root, "model-ledger.jsonl"), "utf8");
		total += content.split("\n").filter((line) => line.length > 0).length;
	}
	return total;
}

/**
 * 函数职责：执行 WORKSTREAM5 的四个真实 PostgreSQL badcase。
 * 输入约束：Docker PostgreSQL 16 和非特权 Node 容器必须可用。
 * 返回结果：输出可复核的租约恢复验收摘要。
 * 失败语义：任一租约及 checkpoint 不变量失败时设置非零退出码。
 */
async function main(): Promise<void> {
	const profile = loadLocalConcurrencyProfile();
	const pool = new Pool({ connectionString, max: profile.worker_capacity + 4, connectionTimeoutMillis: 5_000 });
	const store = new PostgresTaskStore(pool);
	const admission = new AdmissionService(store);
	const runRoot = await mkdtemp(join(runParent, "workstream5-"));
	const baselineTime = new Date("2026-08-09T00:00:00.000Z");
	const initialLeaseExpiry = new Date(baselineTime.getTime() + profile.task_lease_ms);
	const heartbeatTime = new Date(baselineTime.getTime() + 40_000);
	const recoveryTime = new Date(baselineTime.getTime() + profile.task_lease_ms + 1_000);
	let heartbeatManager: LeaseManager | null = null;
	let heartbeatTaskIds: readonly string[] = [];

	try {
		await resetSchema(pool);
		await Promise.all(
			Array.from({ length: profile.worker_capacity }, (_, index) =>
				admission.submit({
					idempotency_key: `ws5-task-${String(index).padStart(2, "0")}`,
					request: {
						repository: "fixture/repo",
						baseline_commit: "c".repeat(40),
						task_content: `lease recovery ${index}`,
						caller_id: "local-workstream5",
					},
				}),
			),
		);
		const leadership = await store.acquireSchedulerLease({
			lease_name: "local-workstream5",
			owner_id: "worker-primary",
			now: baselineTime.toISOString(),
			expires_at: new Date(baselineTime.getTime() + profile.scheduler_lease_ms).toISOString(),
		});
		assertEqual("workstream5_leadership", String(leadership), "true");
		const claimedTasks = await store.claimQueued({
			lease_name: "local-workstream5",
			owner_id: "worker-primary",
			limit: profile.worker_capacity,
			now: baselineTime.toISOString(),
			lease_expires_at: initialLeaseExpiry.toISOString(),
		});
		assertEqual("claimed_tasks", String(claimedTasks.length), String(profile.worker_capacity));
		const runningTasks = await Promise.all(
			claimedTasks.map((task) =>
				store.transition({
					task_id: task.task_id,
					expected_version: task.status_version,
					to_status: "running",
					attempt_id: task.attempt_id,
					failure_code: null,
					result_manifest_path: null,
					result_manifest_sha256: null,
				}),
			),
		);
		const terminatedTasks = runningTasks.slice(-4);
		const healthyTasks = runningTasks.slice(0, profile.worker_capacity - terminatedTasks.length);
		heartbeatTaskIds = healthyTasks.map((task) => task.task_id);
		heartbeatManager = new LeaseManager({
			store,
			checkpoint_source: {
				async load() {
					return null;
				},
			},
			owner_id: "worker-primary",
			now: () => heartbeatTime,
		});
		await Promise.all(healthyTasks.map((task) => heartbeatManager?.startHeartbeat(task)));
		assertEqual(
			"healthy_active_heartbeats",
			String(heartbeatManager.snapshot().active_heartbeats),
			String(healthyTasks.length),
		);
		for (const taskId of heartbeatTaskIds) heartbeatManager.stopHeartbeat(taskId);

		const evidence = await Promise.all(terminatedTasks.map((task) => writeRecoveryEvidence(runRoot, task)));
		const modelLedgerBefore = await modelLedgerRecordCount(evidence);
		const checkpointByTaskId = new Map<string, AttemptRecoveryCheckpoint>();
		for (const [index, task] of terminatedTasks.slice(0, 2).entries()) {
			checkpointByTaskId.set(task.task_id, completeCheckpoint(task, index + 1));
		}
		const checkpointSource: RecoveryCheckpointSource = {
			async load(task) {
				return checkpointByTaskId.get(task.task_id) ?? null;
			},
		};
		const waitForPeer = createRecoveryReadBarrier();
		const synchronizedStore = synchronizedLeaseStore(store, waitForPeer);
		const recoveryA = new LeaseManager({
			store: synchronizedStore,
			checkpoint_source: checkpointSource,
			owner_id: "recovery-a",
			now: () => recoveryTime,
		});
		const recoveryB = new LeaseManager({
			store: synchronizedStore,
			checkpoint_source: checkpointSource,
			owner_id: "recovery-b",
			now: () => recoveryTime,
		});
		const recoveryBatches: readonly RecoveryBatchResult[] = await Promise.all([
			recoveryA.recoverExpired(4),
			recoveryB.recoverExpired(4),
		]);
		const recoveryResults = recoveryBatches.flatMap((batch) => batch.results);
		assertEqual("recovery_candidates_per_owner_a", String(recoveryBatches[0].inspected_count), "4");
		assertEqual("recovery_candidates_per_owner_b", String(recoveryBatches[1].inspected_count), "4");
		assertEqual("claimed_recovery_tasks", String(recoveryResults.length), "4");
		assertEqual(
			"resumed_recovery_tasks",
			String(recoveryResults.filter((result) => result.disposition === "resumed").length),
			"2",
		);
		assertEqual(
			"failed_recovery_tasks",
			String(recoveryResults.filter((result) => result.disposition === "failed").length),
			"2",
		);

		const recoveryAudit = await pool.query<RecoveryAuditRow>(
			`SELECT count(*)::text AS task_count, max(recovery_claims)::text AS max_claims
			 FROM (
			     SELECT task_id, count(*) AS recovery_claims
			     FROM concurrency_task_events
			     WHERE to_status = 'recovering'
			     GROUP BY task_id
			 ) AS recovery_events`,
		);
		assertEqual("recovering_task_events", recoveryAudit.rows[0].task_count, "4");
		assertEqual("max_recovery_claims_per_task", recoveryAudit.rows[0].max_claims, "1");
		const healthyCount = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_tasks
			 WHERE task_id = ANY($1::text[])
			   AND status = 'running'
			   AND status_version = 2
			   AND lease_owner = 'worker-primary'
			   AND lease_expires_at > $2::timestamptz`,
			[healthyTasks.map((task) => task.task_id), recoveryTime.toISOString()],
		);
		assertEqual("healthy_tasks_unchanged", healthyCount.rows[0].count, String(healthyTasks.length));

		for (const task of terminatedTasks.slice(0, 2)) {
			const finalState = await pool.query<TaskStateRow>(
				`SELECT status, status_version::text, attempt_id, lease_owner, failure_code
				 FROM concurrency_tasks WHERE task_id = $1`,
				[task.task_id],
			);
			assertEqual("resumed_task_status", finalState.rows[0].status, "running");
			assertEqual("resumed_task_attempt", finalState.rows[0].attempt_id ?? "missing", task.attempt_id ?? "missing");
			assertEqual("resumed_task_version", finalState.rows[0].status_version, "4");
		}
		for (const task of terminatedTasks.slice(2)) {
			const finalState = await pool.query<TaskStateRow>(
				`SELECT status, status_version::text, attempt_id, lease_owner, failure_code
				 FROM concurrency_tasks WHERE task_id = $1`,
				[task.task_id],
			);
			assertEqual("failed_task_status", finalState.rows[0].status, "failed");
			assertEqual("failed_task_code", finalState.rows[0].failure_code ?? "missing", "checkpoint_incomplete");
			assertEqual("failed_task_lease_owner", finalState.rows[0].lease_owner ?? "null", "null");
		}

		const modelLedgerAfter = await modelLedgerRecordCount(evidence);
		assertEqual("model_ledger_records", String(modelLedgerAfter), String(modelLedgerBefore));
		for (const item of evidence) {
			assertEqual("recovery_evidence_hash", await directoryContentSha256(item.root), item.sha256);
		}
		const failedAudit = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_task_events
			 WHERE to_status = 'failed' AND failure_code = 'checkpoint_incomplete'`,
		);
		assertEqual("checkpoint_failure_audit_events", failedAudit.rows[0].count, "2");

		process.stdout.write(
			`${JSON.stringify({
				workstream: 5,
				postgres: "16-alpine",
				tasks: profile.worker_capacity,
				healthy_tasks: healthyTasks.length,
				terminated_executors: terminatedTasks.length,
				clock_advanced_seconds: 61,
				recovering_task_events: Number(recoveryAudit.rows[0].task_count),
				max_recovery_claims_per_task: Number(recoveryAudit.rows[0].max_claims),
				resumed_same_attempt: recoveryResults.filter((result) => result.disposition === "resumed").length,
				checkpoint_incomplete_failed: recoveryResults.filter((result) => result.disposition === "failed").length,
				model_ledger_records_before: modelLedgerBefore,
				model_ledger_records_after: modelLedgerAfter,
				preserved_evidence_directories: evidence.length,
				checkpoint_failure_audit_events: Number(failedAudit.rows[0].count),
				status: "accepted",
			})}\n`,
		);
	} finally {
		if (heartbeatManager !== null) {
			for (const taskId of heartbeatTaskIds) heartbeatManager.stopHeartbeat(taskId);
		}
		try {
			await pool.query(
				"TRUNCATE concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease RESTART IDENTITY",
			);
		} finally {
			await pool.end();
			await rm(runRoot, { recursive: true, force: true });
		}
	}
}

await main();
