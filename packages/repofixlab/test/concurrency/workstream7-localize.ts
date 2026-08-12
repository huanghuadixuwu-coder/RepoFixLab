/**
 * 脚本职责：在 Docker 中真实执行二十六项 RepoFix 定位任务并生成验收报告。
 * 输入边界：读取冻结任务集、DeepSeek 凭据、真实 Controller 和 PostgreSQL。
 * 输出边界：发布二十六份定位结果及 JSON、Markdown 一致性报告。
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { AdmissionService } from "../../src/concurrency/admission-service.ts";
import { CapacityGate } from "../../src/concurrency/capacity-gate.ts";
import { LeaseManager } from "../../src/concurrency/lease-manager.ts";
import {
	createDefaultLocalizeExecutionDependencies,
	LocalizeTaskExecutorFactory,
} from "../../src/concurrency/localize-task-executor.ts";
import { PostgresTaskStore } from "../../src/concurrency/postgres-task-store.ts";
import { TaskScheduler } from "../../src/concurrency/scheduler.ts";
import type { TaskExecutionLifecycle } from "../../src/concurrency/worker-pool.ts";
import { WorkerPool } from "../../src/concurrency/worker-pool.ts";
import { stableStringify } from "../../src/contracts/canonical-json.ts";
import { ArtifactStore } from "../../src/storage/artifact-store.ts";
import { loadLocalConcurrencyProfile } from "./local-profile.ts";

const connectionString =
	process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_URL ??
	"postgresql://repofixlab:repofixlab-local-test@127.0.0.1:55432/repofixlab_concurrency";
const controllerUrl = process.env.REPOFIX_CONTROLLER_URL ?? "http://controller:8000";
const artifactsRoot = process.env.REPOFIX_ARTIFACTS_PATH ?? "/artifacts";
const eligibilityManifestPath =
	process.env.REPOFIX_WORKSTREAM7_ELIGIBILITY_MANIFEST ??
	join(artifactsRoot, "m3-eligibility", "20260720T193400Z-26-task-v1", "eligibility-manifest.json");
const runId = process.env.REPOFIX_WORKSTREAM7_RUN_ID ?? `workstream7-${new Date().toISOString().replace(/[-:.]/g, "")}`;
const gitCommit = process.env.REPOFIX_WORKSTREAM7_GIT_COMMIT ?? "unavailable";
const terminalStatuses = ["revalidation_required", "completed", "failed", "cancelled"] as const;

interface EligibilityManifest {
	readonly schema_version: "v1";
	readonly manifest_type: "m3_official_preflight_eligibility";
	readonly eligible_task_count: 26;
	readonly eligible_instance_ids: readonly string[];
	readonly eligibility_sha256: string;
}

interface CountRow {
	readonly count: string;
}

interface PostgreSqlVersionRow {
	readonly version: string;
}

interface DurationRow {
	readonly task_id: string;
	readonly queue_ms: number | string;
	readonly localize_ms: number | string;
}

interface RunWindowRow {
	readonly total_ms: number | string;
}

interface ResultRow {
	readonly task_id: string;
	readonly result_manifest_path: string | null;
	readonly result_manifest_sha256: string | null;
}

interface PublishedResultAudit {
	readonly cross_write_count: number;
	readonly artifact_overwrite_count: number;
	readonly artifact_integrity_failure_count: number;
	readonly forbidden_stage_artifact_count: number;
}

interface Workstream7Report {
	readonly schema_version: "v1";
	readonly report_type: "workstream7_local_16gb";
	readonly run_id: string;
	readonly git_commit: string;
	readonly configuration_sha256: string;
	readonly eligibility_sha256: string;
	readonly task_count: 26;
	readonly worker_capacity: 4;
	readonly model_capacity: 2;
	readonly batch_count: 7;
	readonly stop_stage: "LOCALIZE";
	readonly completed_tasks: number;
	readonly failed_tasks: number;
	readonly result_manifest_count: number;
	readonly duplicate_task_count: number;
	readonly cross_write_count: number;
	readonly artifact_overwrite_count: number;
	readonly artifact_integrity_failure_count: number;
	readonly forbidden_stage_artifact_count: number;
	readonly lost_terminal_count: number;
	readonly residual_active_lease_count: number;
	readonly worker_peak: number;
	readonly model_peak: number;
	readonly model_wait_ms_total: number;
	readonly model_wait_ms_max: number;
	readonly localization_candidate_count: number;
	readonly scheduler_tick_failures: number;
	readonly database_interruption_observed: boolean;
	readonly p95_queue_ms: number;
	readonly p95_localize_ms: number;
	readonly localization_throughput_per_minute: number;
	readonly process_peak_rss_bytes: number;
	readonly container_peak_memory_bytes: number;
	readonly system_min_available_memory_bytes: number;
	readonly operating_system: string;
	readonly cpu_count: number;
	readonly total_memory_bytes: number;
	readonly postgresql_version: string;
	readonly repofix_execution: true;
	readonly repair_execution: false;
	readonly localization_completion_rate: number;
	readonly status: "accepted" | "rejected";
}

/**
 * 类职责：声明任务执行器自行持久化全部失败状态。
 * 持有状态：不保存任务及错误信息。
 * 协作边界：仅满足 WorkerPool 生命周期端口，不重复状态转换。
 */
class SelfManagedExecutionLifecycle implements TaskExecutionLifecycle {
	/**
	 * 函数职责：确认执行器已经自行登记失败状态。
	 * 输入约束：调用发生在执行器拒绝 Promise 之后。
	 * 返回结果：立即完成且不重复写入 PostgreSQL。
	 * 失败语义：该适配器不产生新失败。
	 */
	async recordFailure(): Promise<void> {}
}

/**
 * 函数职责：暂停指定毫秒数以等待异步调度状态变化。
 * 输入约束：毫秒值必须由冻结轮询配置提供。
 * 返回结果：定时器到期后完成 Promise。
 * 失败语义：函数不访问外部资源。
 */
function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/**
 * 函数职责：计算文件字节的小写 SHA-256。
 * 输入约束：字节必须来自本次运行读取的版本化文件。
 * 返回结果：返回六十四位小写十六进制哈希。
 * 失败语义：哈希计算失败时同步抛出异常。
 */
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
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
 * 函数职责：判断反序列化值是否为普通键值对象。
 * 输入约束：允许接收任意 JSON 解析结果。
 * 返回结果：非空对象且不是数组时返回 true。
 * 失败语义：函数不抛出异常且不修改输入。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 函数职责：校验最终清单中的安全相对文件路径。
 * 输入约束：路径来自已发布结果清单。
 * 返回结果：路径非空、无反斜线、无遍历段时返回 true。
 * 失败语义：非法路径返回 false 且不访问文件系统。
 */
function isSafeArtifactPath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		!path.startsWith("/") &&
		path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
	);
}

/**
 * 函数职责：独立审计已发布定位结果的归属、不可覆盖性和阶段边界。
 * 输入约束：数据库结果行属于当前运行且任务已经进入终态。
 * 返回结果：返回跨任务写入、重复路径、内容失配和越界阶段计数。
 * 失败语义：结果根目录缺失及读取失败时拒绝 Promise。
 */
async function auditPublishedResults(runRoot: string, rows: readonly ResultRow[]): Promise<PublishedResultAudit> {
	const resultsRoot = join(runRoot, "results");
	const expectedTaskIds = new Set(rows.map((row) => row.task_id));
	const resultEntries = await readdir(resultsRoot, { withFileTypes: true });
	let crossWriteCount = resultEntries.filter(
		(entry) => !entry.isDirectory() || !expectedTaskIds.has(entry.name),
	).length;
	for (const taskId of expectedTaskIds) {
		if (!resultEntries.some((entry) => entry.isDirectory() && entry.name === taskId)) crossWriteCount += 1;
	}

	const manifestPaths = rows.map((row) => row.result_manifest_path).filter((path): path is string => path !== null);
	let artifactOverwriteCount = manifestPaths.length - new Set(manifestPaths).size;
	let artifactIntegrityFailureCount = 0;
	let forbiddenStageArtifactCount = 0;
	const forbiddenPaths = new Set(["patch.diff", "controlled-verification.json"]);
	const allowedStagePaths = new Set([
		"stages/understand.json",
		"stages/understand.context-budget.json",
		"stages/understand.recovery.json",
		"stages/localize.json",
		"stages/localize.context-budget.json",
		"stages/localize.recovery.json",
	]);
	const requiredPaths = new Set(["stages/understand.json", "stages/localize.json", "localize-summary.json"]);

	for (const row of rows) {
		const expectedManifestPath = `results/${row.task_id}/result-manifest.json`;
		if (row.result_manifest_path !== expectedManifestPath || row.result_manifest_sha256 === null) {
			artifactIntegrityFailureCount += 1;
			continue;
		}
		const finalRoot = join(resultsRoot, row.task_id);
		const manifestBytes = await readFile(join(finalRoot, "result-manifest.json"));
		if (sha256(manifestBytes) !== row.result_manifest_sha256) artifactIntegrityFailureCount += 1;
		const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
		if (!isRecord(parsed) || parsed.task_id !== row.task_id || !Array.isArray(parsed.artifacts)) {
			crossWriteCount += 1;
			continue;
		}
		const paths: string[] = [];
		for (const artifact of parsed.artifacts) {
			if (
				!isRecord(artifact) ||
				typeof artifact.path !== "string" ||
				!isSafeArtifactPath(artifact.path) ||
				typeof artifact.bytes !== "number" ||
				typeof artifact.sha256 !== "string"
			) {
				artifactIntegrityFailureCount += 1;
				continue;
			}
			paths.push(artifact.path);
			if (
				forbiddenPaths.has(artifact.path) ||
				(artifact.path.startsWith("stages/") && !allowedStagePaths.has(artifact.path))
			) {
				forbiddenStageArtifactCount += 1;
			}
			const artifactBytes = await readFile(join(finalRoot, ...artifact.path.split("/")));
			if (artifactBytes.byteLength !== artifact.bytes || sha256(artifactBytes) !== artifact.sha256) {
				artifactIntegrityFailureCount += 1;
			}
		}
		artifactOverwriteCount += paths.length - new Set(paths).size;
		for (const requiredPath of requiredPaths) {
			if (!paths.includes(requiredPath)) artifactIntegrityFailureCount += 1;
		}
		const summaryValue: unknown = JSON.parse(await readFile(join(finalRoot, "localize-summary.json"), "utf8"));
		if (!isRecord(summaryValue) || summaryValue.task_id !== row.task_id) crossWriteCount += 1;
	}
	return {
		cross_write_count: crossWriteCount,
		artifact_overwrite_count: artifactOverwriteCount,
		artifact_integrity_failure_count: artifactIntegrityFailureCount,
		forbidden_stage_artifact_count: forbiddenStageArtifactCount,
	};
}

/**
 * 函数职责：解析并校验二十六项冻结资格清单。
 * 输入约束：文件必须是当前 M3 资格产物的 UTF-8 JSON。
 * 返回结果：返回实例唯一且数量固定的资格清单。
 * 失败语义：结构、数量及实例重复时抛出稳定错误。
 */
async function loadEligibilityManifest(): Promise<EligibilityManifest> {
	const parsed: unknown = JSON.parse(await readFile(eligibilityManifestPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("workstream7_eligibility_manifest_invalid");
	}
	const value = parsed as Record<string, unknown>;
	if (
		value.schema_version !== "v1" ||
		value.manifest_type !== "m3_official_preflight_eligibility" ||
		value.eligible_task_count !== 26 ||
		!Array.isArray(value.eligible_instance_ids) ||
		value.eligible_instance_ids.length !== 26 ||
		!value.eligible_instance_ids.every((instance) => typeof instance === "string" && instance.length > 0) ||
		new Set(value.eligible_instance_ids).size !== 26 ||
		typeof value.eligibility_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.eligibility_sha256)
	) {
		throw new Error("workstream7_eligibility_manifest_invalid");
	}
	return value as unknown as EligibilityManifest;
}

/**
 * 函数职责：重建 WORKSTREAM7 专用数据库结构。
 * 输入约束：连接池必须指向本机 Docker 测试数据库。
 * 返回结果：迁移完整提交后返回。
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
 * 函数职责：计算固定样本的 P95 毫秒值。
 * 输入约束：集合非空且全部为非负有限数。
 * 返回结果：返回向上取位的第九十五百分位整数。
 * 失败语义：非法集合抛出指标错误。
 */
function percentile95(values: readonly number[]): number {
	if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new Error("workstream7_duration_metrics_invalid");
	}
	const sorted = [...values].sort((left, right) => left - right);
	return Math.ceil(sorted[Math.ceil(sorted.length * 0.95) - 1]);
}

/**
 * 函数职责：读取当前容器 cgroup 历史内存峰值。
 * 输入约束：运行环境使用 Linux cgroup v2。
 * 返回结果：返回非负安全整数内存字节数。
 * 失败语义：指标文件缺失时回退到当前进程 RSS 峰值。
 */
async function readContainerPeakMemory(processPeakRss: number): Promise<number> {
	try {
		const value = Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim());
		return Number.isSafeInteger(value) && value >= 0 ? value : processPeakRss;
	} catch {
		return processPeakRss;
	}
}

/**
 * 函数职责：构建与 JSON 报告关键字段一致的 Markdown 报告。
 * 输入约束：报告已经完成全部验收判定。
 * 返回结果：返回固定标题和指标表格的 Markdown 文本。
 * 失败语义：该函数不访问文件系统。
 */
function markdownReport(report: Workstream7Report): string {
	return [
		"# WORKSTREAM7 本机真实定位验收报告",
		"",
		`- 运行 ID：${report.run_id}`,
		`- Git 提交：${report.git_commit}`,
		`- 配置 SHA-256：${report.configuration_sha256}`,
		`- 任务数：${report.task_count}`,
		`- 定位完成数：${report.completed_tasks}`,
		`- 定位完成率：${report.localization_completion_rate}`,
		`- Worker 峰值：${report.worker_peak}`,
		`- 模型峰值：${report.model_peak}`,
		`- P95 排队时间：${report.p95_queue_ms} ms`,
		`- P95 定位时间：${report.p95_localize_ms} ms`,
		`- PostgreSQL 中断已观测：${report.database_interruption_observed}`,
		`- 验收状态：${report.status}`,
		"",
		"本机结果不能替代企业环境 200 并发容量测试。",
		"",
	].join("\n");
}

/**
 * 函数职责：执行 WORKSTREAM7 真实定位、故障注入观测和报告发布。
 * 输入约束：Docker Controller、PostgreSQL、数据卷和 DeepSeek 凭据必须可用。
 * 返回结果：二十六项任务满足全部交付条件时输出 accepted 摘要。
 * 失败语义：任一定位及并发不变量失败时保留证据并设置非零退出码。
 */
async function main(): Promise<void> {
	const profile = loadLocalConcurrencyProfile();
	const configurationBytes = await readFile(new URL("../../configs/concurrency/local-16gb.json", import.meta.url));
	const eligibility = await loadEligibilityManifest();
	assertEqual(
		"localize_task_count",
		String(eligibility.eligible_instance_ids.length),
		String(profile.localize_task_count),
	);
	const pool = new Pool({ connectionString, max: 12, connectionTimeoutMillis: 5_000 });
	const store = new PostgresTaskStore(pool);
	const dependencies = createDefaultLocalizeExecutionDependencies(controllerUrl);
	const admission = new AdmissionService(store);
	const modelGate = new CapacityGate("workstream7-model", profile.localize_model_capacity);
	const leaseManager = new LeaseManager({
		store,
		checkpoint_source: { load: async () => null },
		owner_id: "workstream7-runner",
	});
	const runRoot = join(artifactsRoot, "concurrency", "workstream7", runId);
	let processPeakRss = process.memoryUsage().rss;
	let systemMinAvailableMemory = freemem();
	const memorySampler = setInterval(() => {
		processPeakRss = Math.max(processPeakRss, process.memoryUsage().rss);
		systemMinAvailableMemory = Math.min(systemMinAvailableMemory, freemem());
	}, 1_000);
	let scheduler: TaskScheduler | null = null;

	try {
		await mkdir(runRoot, { recursive: true });
		await resetSchema(pool);
		const taskInputs = await Promise.all(
			eligibility.eligible_instance_ids.map(async (instanceId) => {
				const environment = await dependencies.environmentLockSource.load(instanceId);
				const publicTask = await dependencies.publicTaskSource.load(instanceId, environment);
				return { instanceId, publicTask };
			}),
		);
		const instanceByIdempotencyKey = new Map<string, string>();
		await Promise.all(
			taskInputs.map(async ({ instanceId, publicTask }) => {
				const idempotencyKey = `ws7:${instanceId}`;
				instanceByIdempotencyKey.set(idempotencyKey, instanceId);
				await admission.submit({
					idempotency_key: idempotencyKey,
					request: {
						repository: publicTask.task.repo,
						baseline_commit: publicTask.task.base_commit,
						task_content: publicTask.task.problem_statement,
						caller_id: "workstream7-localize",
					},
				});
			}),
		);
		const executorFactory = new LocalizeTaskExecutorFactory({
			root: runRoot,
			store,
			model_gate: modelGate,
			lease_manager: leaseManager,
			dependencies,
			instance_by_idempotency_key: instanceByIdempotencyKey,
		});
		const workerPool = new WorkerPool(
			profile.localize_worker_capacity,
			executorFactory,
			new SelfManagedExecutionLifecycle(),
		);
		scheduler = new TaskScheduler({
			store,
			worker_pool: workerPool,
			lease_name: "workstream7-scheduler",
			owner_id: "workstream7-runner",
			scheduler_lease_ms: profile.scheduler_lease_ms,
			task_lease_ms: profile.task_lease_ms,
			tick_interval_ms: profile.scheduler_tick_ms,
		});
		await scheduler.start();
		const readyDeadline = performance.now() + 300_000;
		while (workerPool.snapshot().active < profile.localize_worker_capacity) {
			if (performance.now() >= readyDeadline) throw new Error("workstream7_worker_peak_not_reached");
			await sleep(250);
		}
		await writeFile(
			join(runRoot, "db-interruption-ready.json"),
			`${stableStringify({ event: "db_interruption_ready", run_id: runId })}\n`,
			{ encoding: "utf8", flag: "wx" },
		);
		process.stdout.write(`${JSON.stringify({ event: "db_interruption_ready", run_id: runId })}\n`);

		const completionDeadline = performance.now() + 7_200_000;
		let pollFailures = 0;
		for (;;) {
			try {
				const terminal = await pool.query<CountRow>(
					`SELECT count(*)::text AS count
					 FROM concurrency_tasks
					 WHERE status = ANY($1::text[])`,
					[[...terminalStatuses]],
				);
				if (Number(terminal.rows[0].count) === profile.localize_task_count) break;
			} catch {
				pollFailures += 1;
			}
			if (performance.now() >= completionDeadline) throw new Error("workstream7_completion_timeout");
			await sleep(1_000);
		}
		await scheduler.stop();
		await workerPool.drain();

		const completed = await pool.query<CountRow>(
			"SELECT count(*)::text AS count FROM concurrency_tasks WHERE status = 'completed'",
		);
		const failed = await pool.query<CountRow>(
			"SELECT count(*)::text AS count FROM concurrency_tasks WHERE status <> 'completed'",
		);
		const manifestCount = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_tasks
			 WHERE status = 'completed'
			   AND result_manifest_path = 'results/' || task_id || '/result-manifest.json'
			   AND result_manifest_sha256 ~ '^[a-f0-9]{64}$'`,
		);
		const duplicateCount = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM (SELECT idempotency_key FROM concurrency_tasks GROUP BY idempotency_key HAVING count(*) > 1) AS duplicates`,
		);
		const residualLeases = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_tasks
			 WHERE lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL OR heartbeat_at IS NOT NULL`,
		);
		const publishedResults = await pool.query<ResultRow>(
			`SELECT task_id, result_manifest_path, result_manifest_sha256
			 FROM concurrency_tasks
			 WHERE status = 'completed'
			 ORDER BY task_id`,
		);
		const durations = await pool.query<DurationRow>(
			`SELECT
			     task_id,
			     extract(epoch FROM (
			         min(created_at) FILTER (WHERE to_status = 'preparing') -
			         min(created_at) FILTER (WHERE to_status = 'queued')
			     )) * 1000 AS queue_ms,
			     extract(epoch FROM (
			         min(created_at) FILTER (WHERE to_status = 'completed') -
			         min(created_at) FILTER (WHERE to_status = 'preparing')
			     )) * 1000 AS localize_ms
			 FROM concurrency_task_events
			 GROUP BY task_id
			 ORDER BY task_id`,
		);
		const runWindow = await pool.query<RunWindowRow>(
			`SELECT extract(epoch FROM (
			     max(created_at) FILTER (WHERE to_status = 'completed') -
			     min(created_at) FILTER (WHERE to_status = 'preparing')
			 )) * 1000 AS total_ms
			 FROM concurrency_task_events`,
		);
		const queueDurations = durations.rows.map((row) => Number(row.queue_ms));
		const localizeDurations = durations.rows.map((row) => Number(row.localize_ms));
		const totalExecutionMs = Number(runWindow.rows[0].total_ms);
		if (!Number.isFinite(totalExecutionMs) || totalExecutionMs <= 0) {
			throw new Error("workstream7_run_window_invalid");
		}
		const postgresql = await pool.query<PostgreSqlVersionRow>("SELECT version()");
		const resultAudit = await auditPublishedResults(runRoot, publishedResults.rows);
		const executorSnapshot = executorFactory.snapshot();
		const workerSnapshot = workerPool.snapshot();
		const modelSnapshot = modelGate.snapshot();
		const schedulerSnapshot = scheduler.snapshot();
		const containerPeakMemory = await readContainerPeakMemory(processPeakRss);
		const completedCount = Number(completed.rows[0].count);
		const failedCount = Number(failed.rows[0].count);
		const manifestBindings = Number(manifestCount.rows[0].count);
		const duplicateTasks = Number(duplicateCount.rows[0].count);
		const residualActiveLeases = Number(residualLeases.rows[0].count);
		const databaseInterruptionObserved = schedulerSnapshot.tick_failures > 0 || pollFailures > 0;
		const accepted =
			completedCount === 26 &&
			failedCount === 0 &&
			manifestBindings === 26 &&
			duplicateTasks === 0 &&
			resultAudit.cross_write_count === 0 &&
			resultAudit.artifact_overwrite_count === 0 &&
			resultAudit.artifact_integrity_failure_count === 0 &&
			resultAudit.forbidden_stage_artifact_count === 0 &&
			residualActiveLeases === 0 &&
			workerSnapshot.peak_active === 4 &&
			modelSnapshot.peak_in_use === 2 &&
			executorSnapshot.completed_tasks === 26 &&
			executorSnapshot.failed_tasks === 0 &&
			databaseInterruptionObserved &&
			containerPeakMemory <= profile.test_memory_peak_bytes &&
			systemMinAvailableMemory >= profile.system_available_memory_floor_bytes;
		const report: Workstream7Report = {
			schema_version: "v1",
			report_type: "workstream7_local_16gb",
			run_id: runId,
			git_commit: gitCommit,
			configuration_sha256: sha256(configurationBytes),
			eligibility_sha256: eligibility.eligibility_sha256,
			task_count: 26,
			worker_capacity: 4,
			model_capacity: 2,
			batch_count: 7,
			stop_stage: "LOCALIZE",
			completed_tasks: completedCount,
			failed_tasks: failedCount,
			result_manifest_count: manifestBindings,
			duplicate_task_count: duplicateTasks,
			cross_write_count: resultAudit.cross_write_count,
			artifact_overwrite_count: resultAudit.artifact_overwrite_count,
			artifact_integrity_failure_count: resultAudit.artifact_integrity_failure_count,
			forbidden_stage_artifact_count: resultAudit.forbidden_stage_artifact_count,
			lost_terminal_count: 26 - completedCount - failedCount,
			residual_active_lease_count: residualActiveLeases,
			worker_peak: workerSnapshot.peak_active,
			model_peak: modelSnapshot.peak_in_use,
			model_wait_ms_total: executorSnapshot.model_wait_ms_total,
			model_wait_ms_max: executorSnapshot.model_wait_ms_max,
			localization_candidate_count: executorSnapshot.localization_candidates,
			scheduler_tick_failures: schedulerSnapshot.tick_failures,
			database_interruption_observed: databaseInterruptionObserved,
			p95_queue_ms: percentile95(queueDurations),
			p95_localize_ms: percentile95(localizeDurations),
			localization_throughput_per_minute: Number(((26 * 60_000) / totalExecutionMs).toFixed(3)),
			process_peak_rss_bytes: processPeakRss,
			container_peak_memory_bytes: containerPeakMemory,
			system_min_available_memory_bytes: systemMinAvailableMemory,
			operating_system: `${platform()} ${release()}`,
			cpu_count: cpus().length,
			total_memory_bytes: totalmem(),
			postgresql_version: postgresql.rows[0].version,
			repofix_execution: true,
			repair_execution: false,
			localization_completion_rate: Number((completedCount / 26).toFixed(4)),
			status: accepted ? "accepted" : "rejected",
		};
		const reportStore = await ArtifactStore.createNew(join(runRoot, ".staging-reports"));
		await reportStore.writeNew("local-16gb-report.json", `${stableStringify(report)}\n`, {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await reportStore.writeNew("local-16gb-report.md", markdownReport(report), {
			mediaType: "text/markdown",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await reportStore.publishTo(join(runRoot, "reports"));
		process.stdout.write(`${JSON.stringify(report)}\n`);
		if (!accepted) throw new Error("workstream7_acceptance_rejected");
	} finally {
		clearInterval(memorySampler);
		await scheduler?.stop().catch(() => undefined);
		await pool.end();
	}
}

await main();
