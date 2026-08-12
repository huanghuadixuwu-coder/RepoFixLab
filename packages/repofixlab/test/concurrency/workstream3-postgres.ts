/**
 * 脚本职责：在 Docker PostgreSQL 中验证固定并发调度和模型闸门。
 * 输入边界：读取冻结本机配置、真实任务仓库和受控执行器。
 * 输出边界：输出百任务调度、领导租约和槽位释放证据。
 */

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { AdmissionService } from "../../src/concurrency/admission-service.ts";
import { CapacityGate } from "../../src/concurrency/capacity-gate.ts";
import type { ConcurrencyTaskRequest } from "../../src/concurrency/contracts.ts";
import { PostgresTaskStore } from "../../src/concurrency/postgres-task-store.ts";
import { TaskScheduler } from "../../src/concurrency/scheduler.ts";
import { TaskStoreExecutionLifecycle, WorkerPool } from "../../src/concurrency/worker-pool.ts";
import { ControlledTaskExecutorFactory } from "./controlled-task-executor.ts";
import { loadLocalConcurrencyProfile } from "./local-profile.ts";

const connectionString =
	process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_URL ??
	"postgresql://repofixlab:repofixlab-local-test@127.0.0.1:55432/repofixlab_concurrency";

interface CountRow {
	readonly count: string;
}

interface QueueRow {
	readonly active: string;
	readonly failed: string;
	readonly queued: string;
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
 * 函数职责：等待到达相对运行起点的固定毫秒位置。
 * 输入约束：目标值必须来自冻结提交批次计划。
 * 返回结果：到达目标时间后 Promise 完成。
 * 失败语义：已经超过目标时间时立即返回。
 */
async function waitUntilTime(target: number): Promise<void> {
	const remaining = target - performance.now();
	if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

/**
 * 函数职责：等待内存断言在固定时限内成立。
 * 输入约束：断言必须只读取本次验收状态。
 * 返回结果：条件成立时 Promise 完成。
 * 失败语义：十秒内未成立时抛出带标签的超时。
 */
async function waitFor(label: string, assertion: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!assertion()) {
		if (Date.now() >= deadline) throw new Error(`${label}_timeout`);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * 函数职责：重建 WORKSTREAM3 专用数据库结构。
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
 * 函数职责：执行 WORKSTREAM3 的五个 PostgreSQL 调度 badcase。
 * 输入约束：专用 PostgreSQL 16 容器必须处于健康状态。
 * 返回结果：输出可复核的本机验收摘要。
 * 失败语义：任一容量及领导不变量失败时设置非零退出码。
 */
async function main(): Promise<void> {
	const profile = loadLocalConcurrencyProfile();
	const pool = new Pool({ connectionString, max: 24, connectionTimeoutMillis: 5_000 });
	const store = new PostgresTaskStore(pool);
	const admission = new AdmissionService(store);
	const primaryFactory = new ControlledTaskExecutorFactory(new CapacityGate("model", profile.model_capacity));
	const followerFactory = new ControlledTaskExecutorFactory(
		new CapacityGate("follower-model", profile.model_capacity),
	);
	const lifecycle = new TaskStoreExecutionLifecycle(store);
	const primaryWorkers = new WorkerPool(profile.worker_capacity, primaryFactory, lifecycle);
	const followerWorkers = new WorkerPool(profile.worker_capacity, followerFactory, lifecycle);
	const primaryScheduler = new TaskScheduler({
		store,
		worker_pool: primaryWorkers,
		lease_name: "local-workstream3",
		owner_id: "scheduler-primary",
		scheduler_lease_ms: profile.scheduler_lease_ms,
		task_lease_ms: profile.task_lease_ms,
		tick_interval_ms: profile.scheduler_tick_ms,
	});
	const followerScheduler = new TaskScheduler({
		store,
		worker_pool: followerWorkers,
		lease_name: "local-workstream3",
		owner_id: "scheduler-follower",
		scheduler_lease_ms: profile.scheduler_lease_ms,
		task_lease_ms: profile.task_lease_ms,
		tick_interval_ms: profile.scheduler_tick_ms,
	});

	try {
		await resetSchema(pool);
		const establishedLeadership = await primaryScheduler.tick();
		assertEqual("established_primary_leadership", String(establishedLeadership.leadership_acquired), "true");
		const [primaryStart, followerStart] = await Promise.all([primaryScheduler.start(), followerScheduler.start()]);
		assertEqual("primary_start_leadership", String(primaryStart.leadership_acquired), "true");
		assertEqual("follower_start_leadership", String(followerStart.leadership_acquired), "false");

		const request: ConcurrencyTaskRequest = {
			repository: "fixture/repo",
			baseline_commit: "a".repeat(40),
			task_content: "controlled scheduling load",
			caller_id: "local-workstream3",
		};
		const submissionStartedAt = performance.now();
		for (let batch = 0; batch < profile.submission_batch_count; batch += 1) {
			await waitUntilTime(submissionStartedAt + batch * profile.submission_interval_ms);
			await Promise.all(
				Array.from({ length: profile.submission_batch_size }, (_, offset) => {
					const sequence = batch * profile.submission_batch_size + offset;
					return admission.submit({
						idempotency_key: `ws3-task-${String(sequence).padStart(3, "0")}`,
						request: { ...request, task_content: `${request.task_content} ${sequence}` },
					});
				}),
			);
		}
		const submissionDurationMs = performance.now() - submissionStartedAt;
		if (submissionDurationMs > profile.submission_window_ms) {
			throw new Error(`submission_window_exceeded: ${submissionDurationMs}`);
		}

		await waitFor("initial_worker_saturation", () => primaryWorkers.snapshot().active === profile.worker_capacity);
		await waitFor("initial_model_saturation", () => primaryFactory.snapshot().model_peak === profile.model_capacity);
		const blockedQueue = await pool.query<QueueRow>(`SELECT
		    count(*) FILTER (WHERE status = 'preparing')::text AS active,
		    count(*) FILTER (WHERE status = 'failed')::text AS failed,
		    count(*) FILTER (WHERE status = 'queued')::text AS queued
		FROM concurrency_tasks`);
		assertEqual("blocked_active_tasks", blockedQueue.rows[0].active, "20");
		assertEqual("blocked_failed_tasks", blockedQueue.rows[0].failed, "0");
		assertEqual("blocked_queued_tasks", blockedQueue.rows[0].queued, "80");
		assertEqual("follower_claimed_tasks", String(followerScheduler.snapshot().claimed_count), "0");

		const failingTaskId = primaryFactory.snapshot().model_active_task_ids[0];
		if (failingTaskId === undefined) throw new Error("missing_model_active_task");
		primaryFactory.failTask(failingTaskId);
		await waitFor("failed_execution_recorded", () => primaryScheduler.snapshot().execution_failures === 1);
		await waitFor(
			"failed_slot_replaced",
			() => primaryFactory.snapshot().started_tasks === 21 && primaryWorkers.snapshot().active === 20,
		);
		const queueAfterFailure = await pool.query<QueueRow>(`SELECT
		    count(*) FILTER (WHERE status = 'preparing')::text AS active,
		    count(*) FILTER (WHERE status = 'failed')::text AS failed,
		    count(*) FILTER (WHERE status = 'queued')::text AS queued
		FROM concurrency_tasks`);
		assertEqual("active_after_failure", queueAfterFailure.rows[0].active, "20");
		assertEqual("failed_after_failure", queueAfterFailure.rows[0].failed, "1");
		assertEqual("queued_after_failure", queueAfterFailure.rows[0].queued, "79");

		primaryFactory.releaseAll();
		await waitFor(
			"all_tasks_dispatched",
			() =>
				primaryScheduler.snapshot().claimed_count === profile.task_count &&
				primaryFactory.snapshot().started_tasks === profile.task_count &&
				primaryWorkers.snapshot().active === 0,
		);
		await Promise.all([primaryScheduler.stop(), followerScheduler.stop()]);
		await Promise.all([primaryWorkers.drain(), followerWorkers.drain()]);

		const primarySnapshot = primaryScheduler.snapshot();
		const followerSnapshot = followerScheduler.snapshot();
		const workerSnapshot = primaryWorkers.snapshot();
		const executorSnapshot = primaryFactory.snapshot();
		assertEqual("worker_peak", String(workerSnapshot.peak_active), "20");
		assertEqual("model_peak", String(executorSnapshot.model_peak), "2");
		assertEqual("primary_claimed_tasks", String(primarySnapshot.claimed_count), "100");
		assertEqual("follower_claimed_tasks_final", String(followerSnapshot.claimed_count), "0");
		assertEqual("worker_completed_tasks", String(workerSnapshot.completed), "99");
		assertEqual("worker_failed_tasks", String(workerSnapshot.failed), "1");
		assertEqual("primary_tick_failures", String(primarySnapshot.tick_failures), "0");
		assertEqual("follower_tick_failures", String(followerSnapshot.tick_failures), "0");

		const queuedFinal = await pool.query<CountRow>(
			"SELECT count(*)::text AS count FROM concurrency_tasks WHERE status = 'queued'",
		);
		const eventCount = await pool.query<CountRow>("SELECT count(*)::text AS count FROM concurrency_task_events");
		assertEqual("final_queued_tasks", queuedFinal.rows[0].count, "0");
		assertEqual("registration_claim_and_failure_events", eventCount.rows[0].count, "201");

		process.stdout.write(
			`${JSON.stringify({
				workstream: 3,
				postgres: "16-alpine",
				tasks: profile.task_count,
				submission_batches: profile.submission_batch_count,
				submission_duration_ms: Math.round(submissionDurationMs),
				blocked_active_tasks: Number(blockedQueue.rows[0].active),
				blocked_queued_tasks: Number(blockedQueue.rows[0].queued),
				worker_peak: workerSnapshot.peak_active,
				model_peak: executorSnapshot.model_peak,
				model_wait_ms_total: Math.round(executorSnapshot.model_wait_ms_total),
				model_wait_ms_max: Math.round(executorSnapshot.model_wait_ms_max),
				primary_claimed_tasks: primarySnapshot.claimed_count,
				follower_claimed_tasks: followerSnapshot.claimed_count,
				failed_task_id: failingTaskId,
				failed_slot_replacement_started: true,
				queued_after_failure: Number(queueAfterFailure.rows[0].queued),
				completed_executions: workerSnapshot.completed,
				failed_executions: workerSnapshot.failed,
				audit_events: Number(eventCount.rows[0].count),
				status: "accepted",
			})}\n`,
		);
	} finally {
		primaryFactory.releaseAll();
		followerFactory.releaseAll();
		await Promise.all([primaryScheduler.stop(), followerScheduler.stop()]);
		await Promise.all([primaryWorkers.drain(), followerWorkers.drain()]);
		try {
			await pool.query(
				"TRUNCATE concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease RESTART IDENTITY",
			);
		} finally {
			await pool.end();
		}
	}
}

await main();
