/**
 * 脚本职责：在 Docker PostgreSQL 中验收基线重验和不可变结果发布。
 * 输入边界：使用二十项确定性产物夹具、真实 ArtifactStore 和固定本机资源档位。
 * 输出边界：输出基线分流、发布失败、发布竞争及清单失效证据。
 */

import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { AdmissionService } from "../../src/concurrency/admission-service.ts";
import type { ConcurrencyTask } from "../../src/concurrency/contracts.ts";
import { PostgresTaskStore } from "../../src/concurrency/postgres-task-store.ts";
import { type BaselineSource, type PublishedResult, ResultGate } from "../../src/concurrency/result-gate.ts";
import { ArtifactStore } from "../../src/storage/artifact-store.ts";
import { loadLocalConcurrencyProfile } from "./local-profile.ts";

const connectionString =
	process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_URL ??
	"postgresql://repofixlab:repofixlab-local-test@127.0.0.1:55432/repofixlab_concurrency";
const runParent = "/run/repofixlab";
const taskCount = 20;
const baselineCommit = "c".repeat(40);
const movedCommit = "d".repeat(40);

interface CountRow {
	readonly count: string;
}

interface StateCountRow {
	readonly status: string;
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
 * 函数职责：判断指定文件系统路径是否存在。
 * 输入约束：路径必须位于本次验收临时根目录。
 * 返回结果：路径存在返回 true，路径缺失返回 false。
 * 失败语义：缺失之外的文件系统错误拒绝 Promise。
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * 函数职责：重建 WORKSTREAM6 专用数据库结构。
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
 * 函数职责：将一批 preparing 任务推进至 validating。
 * 输入约束：每项任务均带当前版本及有效 attempt。
 * 返回结果：返回完成两次原子转换的 validating 快照。
 * 失败语义：任一版本竞争及状态非法时拒绝 Promise。
 */
async function moveToValidating(
	store: PostgresTaskStore,
	tasks: readonly ConcurrencyTask[],
): Promise<ConcurrencyTask[]> {
	const running = await Promise.all(
		tasks.map((task) =>
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
	return Promise.all(
		running.map((task) =>
			store.transition({
				task_id: task.task_id,
				expected_version: task.status_version,
				to_status: "validating",
				attempt_id: task.attempt_id,
				failure_code: null,
				result_manifest_path: null,
				result_manifest_sha256: null,
			}),
		),
	);
}

/**
 * 函数职责：为二十项任务创建互相隔离的确定性产物暂存区。
 * 输入约束：任务标识唯一且 results 父目录可写。
 * 返回结果：返回任务标识到真实 ArtifactStore 的完整映射。
 * 失败语义：目录复用及产物写入失败时拒绝 Promise。
 */
async function createArtifactStores(
	runRoot: string,
	tasks: readonly ConcurrencyTask[],
): Promise<ReadonlyMap<string, ArtifactStore>> {
	const entries = await Promise.all(
		tasks.map(async (task, index) => {
			const artifactStore = await ArtifactStore.createNew(join(runRoot, "results", `.staging-${task.task_id}`));
			await artifactStore.writeNew("candidate.patch", `task=${task.task_id}\nchange=${index}\n`, {
				mediaType: "text/x-diff",
				sensitivity: "internal",
				generatedBy: "agent",
			});
			await artifactStore.writeNew("test-report.json", `${JSON.stringify({ passed: true, index })}\n`, {
				mediaType: "application/json",
				sensitivity: "internal",
				generatedBy: "evaluator",
			});
			return [task.task_id, artifactStore] as const;
		}),
	);
	return new Map(entries);
}

/**
 * 函数职责：执行 WORKSTREAM6 的四组真实 PostgreSQL badcase。
 * 输入约束：Docker PostgreSQL 16 和非特权 Node 容器必须可用。
 * 返回结果：输出可复核的结果门禁验收摘要。
 * 失败语义：任一基线及发布不变量失败时设置非零退出码。
 */
async function main(): Promise<void> {
	const profile = loadLocalConcurrencyProfile();
	const pool = new Pool({ connectionString, max: 24, connectionTimeoutMillis: 5_000 });
	const store = new PostgresTaskStore(pool);
	const admission = new AdmissionService(store);
	const runRoot = await mkdtemp(join(runParent, "workstream6-"));
	const baselineTime = new Date("2026-08-09T00:00:00.000Z");

	try {
		await resetSchema(pool);
		await Promise.all(
			Array.from({ length: taskCount }, (_, index) =>
				admission.submit({
					idempotency_key: `ws6-task-${String(index).padStart(2, "0")}`,
					request: {
						repository: "fixture/repo",
						baseline_commit: baselineCommit,
						task_content: `result publication ${index}`,
						caller_id: "local-workstream6",
					},
				}),
			),
		);
		const leadership = await store.acquireSchedulerLease({
			lease_name: "local-workstream6",
			owner_id: "worker-primary",
			now: baselineTime.toISOString(),
			expires_at: new Date(baselineTime.getTime() + profile.scheduler_lease_ms).toISOString(),
		});
		assertEqual("workstream6_leadership", String(leadership), "true");
		const claimed = await store.claimQueued({
			lease_name: "local-workstream6",
			owner_id: "worker-primary",
			limit: taskCount,
			now: baselineTime.toISOString(),
			lease_expires_at: new Date(baselineTime.getTime() + profile.task_lease_ms).toISOString(),
		});
		assertEqual("claimed_tasks", String(claimed.length), String(taskCount));
		const validating = await moveToValidating(store, claimed);
		const artifactStores = await createArtifactStores(runRoot, validating);
		const movedTaskIds = new Set(validating.slice(0, 4).map((task) => task.task_id));
		const baselineSource: BaselineSource = {
			async currentCommit(task) {
				return movedTaskIds.has(task.task_id) ? movedCommit : baselineCommit;
			},
		};
		const gate = new ResultGate({ root: runRoot, store, baselineSource });
		const verified = await Promise.all(validating.map((task) => gate.verifyBaseline(task)));
		const revalidationTasks = verified.filter((task) => task.status === "revalidation_required");
		const publishingTasks = verified.filter((task) => task.status === "publishing");
		assertEqual("revalidation_tasks", String(revalidationTasks.length), "4");
		assertEqual("publishing_tasks", String(publishingTasks.length), "16");

		const publishFailureTasks = publishingTasks.slice(0, 4);
		let publishFailureCount = 0;
		for (const task of publishFailureTasks) {
			const artifactStore = artifactStores.get(task.task_id);
			if (artifactStore === undefined) throw new Error("missing_publish_failure_artifact_store");
			const resultsRoot = join(runRoot, "results");
			await chmod(resultsRoot, 0o550);
			try {
				await gate.publish(task, artifactStore);
			} catch {
				publishFailureCount += 1;
			} finally {
				await chmod(resultsRoot, 0o750);
			}
			assertEqual(
				"publish_failure_final_absent",
				String(await pathExists(join(resultsRoot, task.task_id))),
				"false",
			);
		}
		assertEqual("publish_failures", String(publishFailureCount), "4");

		const invalidManifestTask = publishingTasks[4];
		const invalidStore = artifactStores.get(invalidManifestTask.task_id);
		if (invalidStore === undefined) throw new Error("missing_invalid_manifest_artifact_store");
		const invalidPublished = await gate.publish(invalidManifestTask, invalidStore);
		await writeFile(join(runRoot, invalidPublished.manifest_path), "{}\n", "utf8");
		const invalidFinal = await gate.recordManifest(invalidManifestTask, invalidPublished);
		assertEqual("invalid_manifest_status", invalidFinal.status, "failed");
		assertEqual("invalid_manifest_code", invalidFinal.failure_code ?? "missing", "result_manifest_invalid");

		const raceTask = publishingTasks[5];
		const raceStore = artifactStores.get(raceTask.task_id);
		if (raceStore === undefined) throw new Error("missing_race_artifact_store");
		const originalRaceBytes = await raceStore.read("candidate.patch");
		const raceAttempts = await Promise.allSettled([
			gate.publish(raceTask, raceStore),
			gate.publish(raceTask, raceStore),
		]);
		const raceWinners = raceAttempts.filter(
			(result): result is PromiseFulfilledResult<PublishedResult> => result.status === "fulfilled",
		);
		assertEqual("race_publish_winners", String(raceWinners.length), "1");
		const completedRace = await gate.recordManifest(raceTask, raceWinners[0].value);
		assertEqual("race_task_status", completedRace.status, "completed");
		const finalRaceBytes = await readFile(join(runRoot, "results", raceTask.task_id, "candidate.patch"));
		assertEqual("race_artifact_bytes", Buffer.compare(finalRaceBytes, originalRaceBytes).toString(), "0");

		const normalTasks = publishingTasks.slice(6);
		await Promise.all(
			normalTasks.map(async (task) => {
				const artifactStore = artifactStores.get(task.task_id);
				if (artifactStore === undefined) throw new Error("missing_normal_artifact_store");
				const published = await gate.publish(task, artifactStore);
				const completed = await gate.recordManifest(task, published);
				assertEqual("normal_task_status", completed.status, "completed");
			}),
		);

		const stateCounts = await pool.query<StateCountRow>(
			`SELECT status, count(*)::text AS count
			 FROM concurrency_tasks
			 GROUP BY status
			 ORDER BY status`,
		);
		const counts = new Map(stateCounts.rows.map((row) => [row.status, row.count]));
		assertEqual("completed_tasks", counts.get("completed") ?? "0", "11");
		assertEqual("failed_tasks", counts.get("failed") ?? "0", "1");
		assertEqual("publishing_failure_tasks", counts.get("publishing") ?? "0", "4");
		assertEqual("revalidation_required_tasks", counts.get("revalidation_required") ?? "0", "4");
		const completedBindings = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_tasks
			 WHERE status = 'completed'
			   AND result_manifest_path = 'results/' || task_id || '/result-manifest.json'
			   AND result_manifest_sha256 ~ '^[a-f0-9]{64}$'`,
		);
		assertEqual("completed_manifest_bindings", completedBindings.rows[0].count, "11");
		const invalidAudit = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_task_events
			 WHERE to_status = 'failed' AND failure_code = 'result_manifest_invalid'`,
		);
		assertEqual("invalid_manifest_audit_events", invalidAudit.rows[0].count, "1");
		const revalidationAudit = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_task_events
			 WHERE to_status = 'revalidation_required'`,
		);
		assertEqual("revalidation_audit_events", revalidationAudit.rows[0].count, "4");

		process.stdout.write(
			`${JSON.stringify({
				workstream: 6,
				postgres: "16-alpine",
				tasks: taskCount,
				fixture_artifact_stores: artifactStores.size,
				baseline_advanced: revalidationTasks.length,
				publish_failures: publishFailureCount,
				publish_failure_final_directories: 0,
				manifest_invalid_failed: 1,
				publish_race_winners: raceWinners.length,
				completed_with_manifest: Number(completedBindings.rows[0].count),
				first_artifact_bytes_unchanged: true,
				repofix_execution: false,
				status: "accepted",
			})}\n`,
		);
	} finally {
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
