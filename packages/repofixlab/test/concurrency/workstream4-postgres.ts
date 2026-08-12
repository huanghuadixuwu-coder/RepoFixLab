/**
 * 脚本职责：在 Docker 中验收工作区隔离和缓存失败闭环。
 * 输入边界：读取真实 PostgreSQL、Linux 文件权限和固定任务规模。
 * 输出边界：输出二十任务隔离、缓存重建和审计证据。
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { AdmissionService } from "../../src/concurrency/admission-service.ts";
import type { ConcurrencyTask } from "../../src/concurrency/contracts.ts";
import { PostgresTaskStore } from "../../src/concurrency/postgres-task-store.ts";
import { TaskStoreWorkspaceCleanupLifecycle } from "../../src/concurrency/workspace-cleanup-lifecycle.ts";
import {
	directoryContentSha256,
	type PrepareWorkspaceCommand,
	type WorkspaceAllocation,
	WorkspaceCleanupError,
	WorkspaceManager,
} from "../../src/concurrency/workspace-manager.ts";
import { loadLocalConcurrencyProfile } from "./local-profile.ts";

const connectionString =
	process.env.REPOFIXLAB_CONCURRENCY_POSTGRES_URL ??
	"postgresql://repofixlab:repofixlab-local-test@127.0.0.1:55432/repofixlab_concurrency";
const runParent = process.env.REPOFIXLAB_WORKSTREAM4_ROOT ?? "/tmp";

interface CountRow {
	readonly count: string;
}

interface FailureRow {
	readonly failure_code: string | null;
	readonly status: string;
}

interface WorkspaceFixture {
	readonly source_root: string;
	readonly source_sha256: string;
	readonly git_cache_source_root: string;
	readonly git_cache_sha256: string;
	readonly dependency_cache_source_root: string;
	readonly dependency_cache_sha256: string;
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
 * 函数职责：读取未知异常的文件系统错误码。
 * 输入约束：输入可以是任意拒绝原因。
 * 返回结果：字符串错误码存在时返回该值。
 * 失败语义：函数不抛出异常。
 */
function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * 函数职责：重建 WORKSTREAM4 专用数据库结构。
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
 * 函数职责：创建同仓库任务使用的冻结源码和缓存夹具。
 * 输入约束：运行根必须位于本次 Docker 临时文件系统。
 * 返回结果：返回真实目录及稳定内容哈希。
 * 失败语义：夹具创建失败时拒绝 Promise。
 */
async function createWorkspaceFixture(runRoot: string): Promise<WorkspaceFixture> {
	const sourceRoot = join(runRoot, "fixture", "source-repository");
	const gitCacheSourceRoot = join(sourceRoot, ".git", "objects");
	const dependencyCacheSourceRoot = join(runRoot, "fixture", "dependency-cache-source");
	await Promise.all([
		mkdir(join(gitCacheSourceRoot, "pack"), { recursive: true, mode: 0o750 }),
		mkdir(dependencyCacheSourceRoot, { recursive: true, mode: 0o750 }),
	]);
	await Promise.all([
		writeFile(join(sourceRoot, "shared.txt"), "baseline\n", { encoding: "utf8", mode: 0o640 }),
		writeFile(join(sourceRoot, "module.txt"), "stable-module\n", { encoding: "utf8", mode: 0o640 }),
		writeFile(join(gitCacheSourceRoot, "pack", "fixture.pack"), "git-object-bytes\n", {
			encoding: "utf8",
			mode: 0o640,
		}),
		writeFile(join(dependencyCacheSourceRoot, "dependency.bin"), "trusted-dependency\n", {
			encoding: "utf8",
			mode: 0o640,
		}),
	]);
	return {
		source_root: sourceRoot,
		source_sha256: await directoryContentSha256(sourceRoot),
		git_cache_source_root: gitCacheSourceRoot,
		git_cache_sha256: await directoryContentSha256(gitCacheSourceRoot),
		dependency_cache_source_root: dependencyCacheSourceRoot,
		dependency_cache_sha256: await directoryContentSha256(dependencyCacheSourceRoot),
	};
}

/**
 * 函数职责：为已领取任务构造固定工作区命令。
 * 输入约束：任务和夹具必须来自本次验收。
 * 返回结果：返回同源码、同基线和同缓存命令。
 * 失败语义：函数不访问外部状态。
 */
function workspaceCommand(task: ConcurrencyTask, fixture: WorkspaceFixture): PrepareWorkspaceCommand {
	return {
		task_id: task.task_id,
		baseline_commit: task.request.baseline_commit,
		frozen_source_root: fixture.source_root,
		git_cache: {
			trusted_source_root: fixture.git_cache_source_root,
			content_sha256: fixture.git_cache_sha256,
		},
		dependency_cache: {
			trusted_source_root: fixture.dependency_cache_source_root,
			content_sha256: fixture.dependency_cache_sha256,
		},
	};
}

/**
 * 函数职责：生成任务独占内容和对应制品清单。
 * 输入约束：分配必须通过当前管理器所有权校验。
 * 返回结果：返回写入源码文件的任务标识。
 * 失败语义：工作区及制品写入失败时拒绝 Promise。
 */
async function writeTaskResult(allocation: WorkspaceAllocation, index: number): Promise<string> {
	const taskMarker = `workspace-result-${String(index).padStart(2, "0")}`;
	const content = `${taskMarker}\n`;
	await writeFile(join(allocation.repository_root, "shared.txt"), content, "utf8");
	await writeFile(join(allocation.writable_dependency_cache_root, "task-state.txt"), content, "utf8");
	const manifest = {
		schema_version: "v1",
		task_id: allocation.task_id,
		baseline_commit: allocation.baseline_commit,
		file: "shared.txt",
		sha256: createHash("sha256").update(content).digest("hex"),
	};
	await writeFile(join(allocation.artifact_staging_root, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
	return taskMarker;
}

/**
 * 函数职责：递归恢复测试目录的删除权限。
 * 输入约束：路径必须位于本次 Docker 临时运行根。
 * 返回结果：普通目录和文件可由当前测试进程删除。
 * 失败语义：路径缺失时正常返回，其他错误继续抛出。
 */
async function makeTreeRemovable(root: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await lstat(root);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) return;
	if (stat.isFile()) {
		await chmod(root, 0o640);
		return;
	}
	if (!stat.isDirectory()) throw new Error("unsafe_test_cleanup_entry");
	await chmod(root, 0o750);
	for (const child of await readdir(root)) await makeTreeRemovable(join(root, child));
}

/**
 * 函数职责：执行 WORKSTREAM4 的四个真实文件系统 badcase。
 * 输入约束：Docker PostgreSQL 和 Linux 非特权用户必须可用。
 * 返回结果：输出可复核的工作区与缓存验收摘要。
 * 失败语义：任一隔离及审计不变量失败时设置非零退出码。
 */
async function main(): Promise<void> {
	const profile = loadLocalConcurrencyProfile();
	const workspaceTaskCount = profile.worker_capacity;
	const pool = new Pool({ connectionString, max: workspaceTaskCount + 2, connectionTimeoutMillis: 5_000 });
	const store = new PostgresTaskStore(pool);
	const admission = new AdmissionService(store);
	const runRoot = await mkdtemp(join(runParent, "workstream4-"));
	const manager = new WorkspaceManager(join(runRoot, "managed"));
	const cleanupLifecycle = new TaskStoreWorkspaceCleanupLifecycle(manager, store);
	let allocations: WorkspaceAllocation[] = [];
	let workspacesRootLocked = false;

	try {
		await resetSchema(pool);
		const fixture = await createWorkspaceFixture(runRoot);
		const tasks = await Promise.all(
			Array.from({ length: workspaceTaskCount }, async (_, index) => {
				const submitted = await admission.submit({
					idempotency_key: `ws4-task-${String(index).padStart(2, "0")}`,
					request: {
						repository: fixture.source_root,
						baseline_commit: "b".repeat(40),
						task_content: `workspace isolation ${index}`,
						caller_id: "local-workstream4",
					},
				});
				return submitted.task;
			}),
		);
		const now = new Date();
		const leaderExpiresAt = new Date(now.getTime() + profile.scheduler_lease_ms);
		const taskLeaseExpiresAt = new Date(now.getTime() + profile.task_lease_ms);
		const leadershipAcquired = await store.acquireSchedulerLease({
			lease_name: "local-workstream4",
			owner_id: "workspace-owner",
			now: now.toISOString(),
			expires_at: leaderExpiresAt.toISOString(),
		});
		assertEqual("workspace_leadership", String(leadershipAcquired), "true");
		const claimedTasks = await store.claimQueued({
			lease_name: "local-workstream4",
			owner_id: "workspace-owner",
			limit: workspaceTaskCount,
			now: now.toISOString(),
			lease_expires_at: taskLeaseExpiresAt.toISOString(),
		});
		assertEqual("claimed_workspace_tasks", String(claimedTasks.length), String(workspaceTaskCount));
		assertEqual("submitted_workspace_tasks", String(tasks.length), String(workspaceTaskCount));

		const commands = claimedTasks.map((task) => workspaceCommand(task, fixture));
		allocations = [...(await Promise.all(commands.map((command) => manager.prepare(command))))];
		let readOnlyWriteCode: string | undefined;
		const markers = await Promise.all(
			allocations.map(async (allocation, index) => {
				if (index === 0) {
					const dependencyMount = allocation.read_only_cache_mounts.find(
						(mount) => mount.cache_kind === "dependencies",
					);
					if (dependencyMount === undefined) throw new Error("missing_dependency_cache_mount");
					try {
						await writeFile(join(dependencyMount.target_root, "dependency.bin"), "forbidden-write\n", "utf8");
					} catch (error) {
						readOnlyWriteCode = errorCode(error);
					}
				}
				await manager.verifyOwnership(allocation);
				return writeTaskResult(allocation, index);
			}),
		);
		assertEqual("readonly_cache_write_code", readOnlyWriteCode ?? "missing", "EACCES");
		assertEqual("isolated_workspace_results", String(new Set(markers).size), String(workspaceTaskCount));
		assertEqual(
			"unique_workspace_roots",
			String(new Set(allocations.map((allocation) => allocation.workspace_root)).size),
			String(workspaceTaskCount),
		);
		assertEqual(
			"unique_writable_cache_roots",
			String(new Set(allocations.map((allocation) => allocation.writable_dependency_cache_root)).size),
			String(workspaceTaskCount),
		);
		assertEqual("source_repository_hash", await directoryContentSha256(fixture.source_root), fixture.source_sha256);
		assertEqual(
			"source_repository_content",
			await readFile(join(fixture.source_root, "shared.txt"), "utf8"),
			"baseline\n",
		);

		const cacheProbeIndex = 1;
		const cacheProbe = allocations[cacheProbeIndex];
		await manager.cleanup(cacheProbe);
		const dependencyMount = cacheProbe.read_only_cache_mounts.find((mount) => mount.cache_kind === "dependencies");
		if (dependencyMount === undefined) throw new Error("missing_dependency_cache_mount");
		await chmod(dependencyMount.source_root, 0o750);
		await chmod(join(dependencyMount.source_root, "dependency.bin"), 0o640);
		await writeFile(join(dependencyMount.source_root, "dependency.bin"), "damaged-dependency\n", "utf8");
		const rebuiltAllocation = await manager.prepare(commands[cacheProbeIndex]);
		allocations[cacheProbeIndex] = rebuiltAllocation;
		assertEqual(
			"rebuilt_dependency_cache_hash",
			await directoryContentSha256(dependencyMount.source_root),
			fixture.dependency_cache_sha256,
		);
		assertEqual(
			"rebuilt_dependency_cache_content",
			await readFile(join(dependencyMount.source_root, "dependency.bin"), "utf8"),
			"trusted-dependency\n",
		);

		const cleanupFailureIndex = workspaceTaskCount - 1;
		const workspacesRoot = join(runRoot, "managed", "workspaces");
		await chmod(workspacesRoot, 0o550);
		workspacesRootLocked = true;
		let cleanupFailureObserved = false;
		try {
			await cleanupLifecycle.cleanup(claimedTasks[cleanupFailureIndex], allocations[cleanupFailureIndex]);
		} catch (error) {
			cleanupFailureObserved = error instanceof WorkspaceCleanupError;
		}
		assertEqual("cleanup_failure_observed", String(cleanupFailureObserved), "true");
		await chmod(workspacesRoot, 0o750);
		workspacesRootLocked = false;

		const failedTask = await pool.query<FailureRow>(
			"SELECT status, failure_code FROM concurrency_tasks WHERE task_id = $1",
			[claimedTasks[cleanupFailureIndex].task_id],
		);
		assertEqual("cleanup_failed_task_status", failedTask.rows[0].status, "failed");
		assertEqual("cleanup_failed_task_code", failedTask.rows[0].failure_code ?? "missing", "workspace_cleanup_failed");
		const cleanupAudit = await pool.query<CountRow>(
			`SELECT count(*)::text AS count
			 FROM concurrency_task_events
			 WHERE task_id = $1
			   AND to_status = 'failed'
			   AND failure_code = 'workspace_cleanup_failed'`,
			[claimedTasks[cleanupFailureIndex].task_id],
		);
		assertEqual("cleanup_failure_audit_events", cleanupAudit.rows[0].count, "1");

		await Promise.all(allocations.map((allocation) => manager.cleanup(allocation)));
		const remainingWorkspaces = await readdir(workspacesRoot);
		assertEqual("remaining_workspaces", String(remainingWorkspaces.length), "0");
		process.stdout.write(
			`${JSON.stringify({
				workstream: 4,
				filesystem: "docker-linux-tmpfs",
				tasks: workspaceTaskCount,
				source_repository_unchanged: true,
				isolated_workspace_results: new Set(markers).size,
				unique_writable_cache_roots: new Set(
					allocations.map((allocation) => allocation.writable_dependency_cache_root),
				).size,
				read_only_cache_write_error: readOnlyWriteCode,
				other_tasks_continued: workspaceTaskCount - 1,
				cache_rebuilt_from_trusted_source: true,
				cleanup_failure_code: failedTask.rows[0].failure_code,
				cleanup_failure_audit_events: Number(cleanupAudit.rows[0].count),
				remaining_workspaces: remainingWorkspaces.length,
				status: "accepted",
			})}\n`,
		);
	} finally {
		if (workspacesRootLocked) await chmod(join(runRoot, "managed", "workspaces"), 0o750);
		try {
			await pool.query(
				"TRUNCATE concurrency_task_events, concurrency_tasks, concurrency_scheduler_lease RESTART IDENTITY",
			);
		} finally {
			await pool.end();
			await makeTreeRemovable(runRoot);
			await rm(runRoot, { recursive: true, force: true });
		}
	}
}

await main();
