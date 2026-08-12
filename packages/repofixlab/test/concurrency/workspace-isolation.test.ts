/**
 * 脚本职责：验证工作区写入隔离和内容缓存重建。
 * 输入边界：使用本机临时目录及固定源码夹具。
 * 输出边界：产生确定性的 Vitest 文件系统断言。
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	directoryContentSha256,
	type PrepareWorkspaceCommand,
	type WorkspaceAllocation,
	WorkspaceManager,
} from "../../src/concurrency/workspace-manager.ts";

interface WorkspaceFixture {
	readonly source_root: string;
	readonly git_cache_source_root: string;
	readonly dependency_cache_source_root: string;
	readonly git_cache_sha256: string;
	readonly dependency_cache_sha256: string;
}

/**
 * 函数职责：创建带 Git 元数据和依赖缓存的冻结源码夹具。
 * 输入约束：测试根目录必须是当前用例独占临时目录。
 * 返回结果：返回绝对路径及两项内容缓存哈希。
 * 失败语义：文件系统写入失败时拒绝 Promise。
 */
async function createWorkspaceFixture(root: string): Promise<WorkspaceFixture> {
	const sourceRoot = join(root, "source-repository");
	const gitCacheSourceRoot = join(sourceRoot, ".git", "objects");
	const dependencyCacheSourceRoot = join(root, "dependency-cache-source");
	await Promise.all([
		mkdir(join(gitCacheSourceRoot, "pack"), { recursive: true }),
		mkdir(dependencyCacheSourceRoot, { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(sourceRoot, "shared.txt"), "baseline\n", "utf8"),
		writeFile(join(gitCacheSourceRoot, "pack", "fixture.pack"), "git-object-bytes\n", "utf8"),
		writeFile(join(dependencyCacheSourceRoot, "dependency.bin"), "trusted-dependency\n", "utf8"),
	]);
	return {
		source_root: sourceRoot,
		git_cache_source_root: gitCacheSourceRoot,
		dependency_cache_source_root: dependencyCacheSourceRoot,
		git_cache_sha256: await directoryContentSha256(gitCacheSourceRoot),
		dependency_cache_sha256: await directoryContentSha256(dependencyCacheSourceRoot),
	};
}

/**
 * 函数职责：为固定任务构造工作区准备命令。
 * 输入约束：任务 ID 和夹具必须属于当前用例。
 * 返回结果：返回同基线及同缓存来源的准备命令。
 * 失败语义：函数不访问文件系统。
 */
function workspaceCommand(taskId: string, fixture: WorkspaceFixture): PrepareWorkspaceCommand {
	return {
		task_id: taskId,
		baseline_commit: "a".repeat(40),
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

describe("concurrency workspace isolation", () => {
	/**
	 * 函数职责：验证独占写目录及损坏缓存自动重建。
	 * 输入约束：四项任务使用同一冻结源码和缓存。
	 * 返回结果：源文件不变且任务结果互不相同。
	 * 失败语义：交叉写入及缓存污染使断言失败。
	 */
	it("isolates writable state and rebuilds corrupted cache", async () => {
		const testRoot = await mkdtemp(join(tmpdir(), "repofixlab-workspace-test-"));
		try {
			const fixture = await createWorkspaceFixture(testRoot);
			const manager = new WorkspaceManager(join(testRoot, "run"));
			const commands = Array.from({ length: 4 }, (_, index) => workspaceCommand(`task-unit-${index}`, fixture));
			const allocations = await Promise.all(commands.map((command) => manager.prepare(command)));
			await Promise.all(
				allocations.map(async (allocation, index) => {
					await writeFile(join(allocation.repository_root, "shared.txt"), `task-${index}\n`, "utf8");
					await writeFile(
						join(allocation.writable_dependency_cache_root, "task-state.txt"),
						`cache-${index}\n`,
						"utf8",
					);
					await manager.verifyOwnership(allocation);
				}),
			);

			expect(await readFile(join(fixture.source_root, "shared.txt"), "utf8")).toBe("baseline\n");
			const workspaceResults = await Promise.all(
				allocations.map((allocation) => readFile(join(allocation.repository_root, "shared.txt"), "utf8")),
			);
			expect(new Set(workspaceResults).size).toBe(4);
			expect(new Set(allocations.map((allocation) => allocation.workspace_root)).size).toBe(4);
			expect(new Set(allocations.map((allocation) => allocation.writable_dependency_cache_root)).size).toBe(4);
			expect(new Set(allocations.map((allocation) => allocation.read_only_cache_mounts[0].source_root)).size).toBe(
				1,
			);

			const cacheProbeIndex = 1;
			const initialProbe = allocations[cacheProbeIndex];
			await manager.cleanup(initialProbe);
			const dependencyMount = initialProbe.read_only_cache_mounts.find(
				(mount) => mount.cache_kind === "dependencies",
			);
			if (dependencyMount === undefined) throw new Error("missing_dependency_cache_mount");
			await chmod(dependencyMount.source_root, 0o750);
			await chmod(join(dependencyMount.source_root, "dependency.bin"), 0o640);
			await writeFile(join(dependencyMount.source_root, "dependency.bin"), "damaged-dependency\n", "utf8");
			const rebuiltProbe = await manager.prepare(commands[cacheProbeIndex]);
			expect(await directoryContentSha256(dependencyMount.source_root)).toBe(fixture.dependency_cache_sha256);
			expect(await readFile(join(dependencyMount.source_root, "dependency.bin"), "utf8")).toBe(
				"trusted-dependency\n",
			);

			const finalAllocations: WorkspaceAllocation[] = [...allocations];
			finalAllocations[cacheProbeIndex] = rebuiltProbe;
			await Promise.all(finalAllocations.map((allocation) => manager.cleanup(allocation)));
		} finally {
			await rm(testRoot, { recursive: true, force: true });
		}
	});
});
