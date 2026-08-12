/**
 * 脚本职责：创建任务独占工作区并维护只读内容缓存。
 * 输入边界：接收冻结源码、内容哈希和受控运行根目录。
 * 输出边界：返回任务目录、缓存挂载和所有权凭据。
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const BASELINE_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OWNERSHIP_FILE = ".repofixlab-workspace-owner.json";

export interface ContentCacheSource {
	readonly trusted_source_root: string;
	readonly content_sha256: string;
}

export interface PrepareWorkspaceCommand {
	readonly task_id: string;
	readonly baseline_commit: string;
	readonly frozen_source_root: string;
	readonly git_cache: ContentCacheSource;
	readonly dependency_cache: ContentCacheSource;
}

export interface ReadOnlyCacheMount {
	readonly cache_kind: "git" | "dependencies";
	readonly source_root: string;
	readonly target_root: string;
	readonly content_sha256: string;
	readonly read_only: true;
}

export interface WorkspaceAllocation {
	readonly schema_version: "v1";
	readonly task_id: string;
	readonly baseline_commit: string;
	readonly workspace_root: string;
	readonly repository_root: string;
	readonly artifact_staging_root: string;
	readonly writable_dependency_cache_root: string;
	readonly read_only_cache_mounts: readonly ReadOnlyCacheMount[];
	readonly ownership_token: string;
}

interface OwnershipRecord {
	readonly schema_version: "v1";
	readonly task_id: string;
	readonly baseline_commit: string;
	readonly ownership_token: string;
}

interface DirectoryEntry {
	readonly entry_kind: "directory" | "file";
	readonly relative_path: string;
}

/**
 * 类职责：表达工作区路径及所有权校验失败。
 * 持有状态：通过标准 cause 保存底层失败。
 * 协作边界：不删除目录且不更新任务状态。
 */
export class WorkspaceOwnershipError extends Error {
	/**
	 * 函数职责：创建稳定工作区所有权错误。
	 * 输入约束：原因值必须来自当前所有权检查。
	 * 返回结果：返回消息固定的错误实例。
	 * 失败语义：构造过程不访问文件系统。
	 */
	constructor(cause?: unknown) {
		super("workspace_ownership_invalid", { cause });
		this.name = "WorkspaceOwnershipError";
	}
}

/**
 * 类职责：表达工作区资源未能完整回收。
 * 持有状态：通过标准 cause 保存底层失败。
 * 协作边界：不决定任务状态及重试策略。
 */
export class WorkspaceCleanupError extends Error {
	/**
	 * 函数职责：创建稳定工作区回收错误。
	 * 输入约束：原因值必须来自当前回收调用。
	 * 返回结果：返回消息固定的错误实例。
	 * 失败语义：构造过程不修改任务状态。
	 */
	constructor(cause: unknown) {
		super("workspace_cleanup_failed", { cause });
		this.name = "WorkspaceCleanupError";
	}
}

/**
 * 类职责：表达内容缓存未通过哈希校验。
 * 持有状态：保存稳定缓存类别。
 * 协作边界：不承担任务状态与工作区回收职责。
 */
export class CacheIntegrityError extends Error {
	readonly cacheKind: "git" | "dependencies";

	/**
	 * 函数职责：创建带缓存类别的完整性错误。
	 * 输入约束：缓存类别必须来自冻结集合。
	 * 返回结果：返回可供调用方识别的错误实例。
	 * 失败语义：构造过程不改写缓存。
	 */
	constructor(cacheKind: "git" | "dependencies", message: string) {
		super(message);
		this.name = "CacheIntegrityError";
		this.cacheKind = cacheKind;
	}
}

/**
 * 函数职责：判断目标路径是否处于指定根目录内。
 * 输入约束：根目录和目标路径必须已经绝对化。
 * 返回结果：严格位于根目录内时返回 true。
 * 失败语义：函数不访问文件系统。
 */
function isContainedPath(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

/**
 * 函数职责：读取目录并生成稳定排序的内容条目。
 * 输入约束：根目录只允许普通文件和普通目录。
 * 返回结果：返回路径采用正斜线的稳定条目列表。
 * 失败语义：链接及特殊文件触发不安全目录错误。
 */
async function collectDirectoryEntries(root: string, current = ""): Promise<readonly DirectoryEntry[]> {
	const currentRoot = current === "" ? root : join(root, current);
	const children = await readdir(currentRoot, { withFileTypes: true });
	children.sort((left, right) => left.name.localeCompare(right.name, "en"));
	const entries: DirectoryEntry[] = [];
	for (const child of children) {
		const relativePath = current === "" ? child.name : `${current}/${child.name}`;
		if (child.isDirectory()) {
			entries.push({ entry_kind: "directory", relative_path: relativePath });
			entries.push(...(await collectDirectoryEntries(root, relativePath)));
			continue;
		}
		if (child.isFile()) {
			entries.push({ entry_kind: "file", relative_path: relativePath });
			continue;
		}
		throw new Error("unsafe_directory_entry");
	}
	return entries;
}

/**
 * 函数职责：计算普通目录内容的稳定 SHA-256。
 * 输入约束：根路径必须是无链接的普通目录。
 * 返回结果：返回包含路径和文件字节的十六进制哈希。
 * 失败语义：目录无效及读取失败时拒绝 Promise。
 */
export async function directoryContentSha256(root: string): Promise<string> {
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid_content_directory");
	const hash = createHash("sha256");
	for (const entry of await collectDirectoryEntries(root)) {
		hash.update(entry.entry_kind);
		hash.update("\0");
		hash.update(entry.relative_path);
		hash.update("\0");
		if (entry.entry_kind === "file") {
			const content = await readFile(join(root, ...entry.relative_path.split("/")));
			hash.update(String(content.byteLength));
			hash.update("\0");
			hash.update(content);
			hash.update("\0");
		}
	}
	return hash.digest("hex");
}

/**
 * 函数职责：复制普通目录内容并排除根级 Git 元数据。
 * 输入约束：来源目录不允许链接及特殊文件。
 * 返回结果：目标目录获得独立文件副本。
 * 失败语义：不安全条目及写入失败时拒绝 Promise。
 */
async function copyDirectoryContents(
	sourceRoot: string,
	targetRoot: string,
	excludeGitMetadata: boolean,
): Promise<void> {
	await mkdir(targetRoot, { recursive: true, mode: 0o750 });
	const children = await readdir(sourceRoot, { withFileTypes: true });
	children.sort((left, right) => left.name.localeCompare(right.name, "en"));
	for (const child of children) {
		if (excludeGitMetadata && child.name === ".git") continue;
		const sourcePath = join(sourceRoot, child.name);
		const targetPath = join(targetRoot, child.name);
		if (child.isDirectory()) {
			await copyDirectoryContents(sourcePath, targetPath, false);
			continue;
		}
		if (child.isFile()) {
			await copyFile(sourcePath, targetPath);
			continue;
		}
		throw new Error("unsafe_directory_entry");
	}
}

/**
 * 函数职责：递归收紧目录为共享只读权限。
 * 输入约束：根目录只包含管理器刚创建的普通条目。
 * 返回结果：文件为只读且目录禁止新增条目。
 * 失败语义：权限设置失败时拒绝 Promise。
 */
async function makeTreeReadOnly(root: string): Promise<void> {
	const children = await readdir(root, { withFileTypes: true });
	for (const child of children) {
		const childPath = join(root, child.name);
		if (child.isDirectory()) {
			await makeTreeReadOnly(childPath);
			continue;
		}
		if (!child.isFile()) throw new Error("unsafe_directory_entry");
		await chmod(childPath, 0o444);
	}
	await chmod(root, 0o555);
}

/**
 * 函数职责：递归恢复受控目录的删除权限。
 * 输入约束：根目录必须是缓存根下的已校验路径。
 * 返回结果：目录树可由当前进程安全删除。
 * 失败语义：权限恢复失败时拒绝 Promise。
 */
async function makeTreeWritable(root: string): Promise<void> {
	await chmod(root, 0o750);
	const children = await readdir(root, { withFileTypes: true });
	for (const child of children) {
		const childPath = join(root, child.name);
		if (child.isDirectory()) {
			await makeTreeWritable(childPath);
			continue;
		}
		if (child.isFile()) await chmod(childPath, 0o640);
	}
}

/**
 * 函数职责：读取并校验工作区所有权记录结构。
 * 输入约束：记录路径必须处于管理器派生目录。
 * 返回结果：返回字段完整的所有权记录。
 * 失败语义：缺失及结构错误时抛出所有权错误。
 */
async function readOwnershipRecord(path: string): Promise<OwnershipRecord> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("invalid_workspace_ownership_record");
		}
		const record = parsed as Record<string, unknown>;
		if (
			record.schema_version !== "v1" ||
			typeof record.task_id !== "string" ||
			typeof record.baseline_commit !== "string" ||
			typeof record.ownership_token !== "string"
		) {
			throw new Error("invalid_workspace_ownership_record");
		}
		return {
			schema_version: "v1",
			task_id: record.task_id,
			baseline_commit: record.baseline_commit,
			ownership_token: record.ownership_token,
		};
	} catch (error) {
		if (error instanceof WorkspaceOwnershipError) throw error;
		throw new WorkspaceOwnershipError(error);
	}
}

/**
 * 类职责：管理任务独占目录与内容寻址只读缓存。
 * 持有状态：保存运行根路径和进行中的缓存构建。
 * 协作边界：不读取队列且不更新任务状态。
 */
export class WorkspaceManager {
	private readonly root: string;
	private readonly workspacesRoot: string;
	private readonly resultsRoot: string;
	private readonly cacheRoot: string;
	private readonly cacheOperations = new Map<string, Promise<string>>();

	/**
	 * 函数职责：创建绑定单个受控运行根的管理器。
	 * 输入约束：运行根必须是绝对路径且不能指向文件系统根。
	 * 返回结果：创建不立即访问文件系统的管理器。
	 * 失败语义：路径无效时抛出稳定配置错误。
	 */
	constructor(root: string) {
		if (!isAbsolute(root)) throw new Error("workspace_root_must_be_absolute");
		const resolvedRoot = resolve(root);
		if (resolve(resolvedRoot, "..") === resolvedRoot) throw new Error("workspace_root_too_broad");
		this.root = resolvedRoot;
		this.workspacesRoot = join(this.root, "workspaces");
		this.resultsRoot = join(this.root, "results");
		this.cacheRoot = join(this.root, "cache");
	}

	/**
	 * 函数职责：为任务准备独占源码、暂存目录和缓存入口。
	 * 输入约束：任务、基线、冻结源码和缓存哈希必须有效。
	 * 返回结果：返回带所有权凭据的不可变目录分配。
	 * 失败语义：准备失败时清理当前任务的部分目录。
	 */
	async prepare(command: PrepareWorkspaceCommand): Promise<WorkspaceAllocation> {
		this.assertPrepareCommand(command);
		await Promise.all([
			mkdir(this.workspacesRoot, { recursive: true, mode: 0o750 }),
			mkdir(this.resultsRoot, { recursive: true, mode: 0o750 }),
			mkdir(this.cacheRoot, { recursive: true, mode: 0o750 }),
		]);
		const [gitCacheRoot, dependencyCacheRoot] = await Promise.all([
			this.ensureCache("git", command.git_cache),
			this.ensureCache("dependencies", command.dependency_cache),
		]);
		const workspaceRoot = join(this.workspacesRoot, command.task_id);
		const artifactStagingRoot = join(this.resultsRoot, `.staging-${command.task_id}`);
		this.assertManagedPath(this.workspacesRoot, workspaceRoot);
		this.assertManagedPath(this.resultsRoot, artifactStagingRoot);

		let workspaceCreated = false;
		let stagingCreated = false;
		try {
			await mkdir(workspaceRoot, { mode: 0o750 });
			workspaceCreated = true;
			await mkdir(artifactStagingRoot, { mode: 0o750 });
			stagingCreated = true;
			const repositoryRoot = join(workspaceRoot, "repository");
			const writableDependencyCacheRoot = join(workspaceRoot, "cache", "writable", "dependencies");
			const readOnlyCacheRoot = join(workspaceRoot, "cache", "read-only");
			await copyDirectoryContents(resolve(command.frozen_source_root), repositoryRoot, true);
			await Promise.all([
				mkdir(writableDependencyCacheRoot, { recursive: true, mode: 0o750 }),
				mkdir(readOnlyCacheRoot, { recursive: true, mode: 0o750 }),
			]);
			const gitTargetRoot = join(readOnlyCacheRoot, "git");
			const dependencyTargetRoot = join(readOnlyCacheRoot, "dependencies");
			await Promise.all([
				symlink(gitCacheRoot, gitTargetRoot, process.platform === "win32" ? "junction" : "dir"),
				symlink(dependencyCacheRoot, dependencyTargetRoot, process.platform === "win32" ? "junction" : "dir"),
			]);
			const ownershipToken = randomUUID();
			const ownership: OwnershipRecord = {
				schema_version: "v1",
				task_id: command.task_id,
				baseline_commit: command.baseline_commit,
				ownership_token: ownershipToken,
			};
			const ownershipJson = `${JSON.stringify(ownership)}\n`;
			await Promise.all([
				writeFile(join(workspaceRoot, OWNERSHIP_FILE), ownershipJson, { encoding: "utf8", mode: 0o600 }),
				writeFile(join(artifactStagingRoot, OWNERSHIP_FILE), ownershipJson, { encoding: "utf8", mode: 0o600 }),
			]);
			return Object.freeze({
				schema_version: "v1",
				task_id: command.task_id,
				baseline_commit: command.baseline_commit,
				workspace_root: workspaceRoot,
				repository_root: repositoryRoot,
				artifact_staging_root: artifactStagingRoot,
				writable_dependency_cache_root: writableDependencyCacheRoot,
				read_only_cache_mounts: Object.freeze([
					Object.freeze({
						cache_kind: "git",
						source_root: gitCacheRoot,
						target_root: gitTargetRoot,
						content_sha256: command.git_cache.content_sha256,
						read_only: true,
					}),
					Object.freeze({
						cache_kind: "dependencies",
						source_root: dependencyCacheRoot,
						target_root: dependencyTargetRoot,
						content_sha256: command.dependency_cache.content_sha256,
						read_only: true,
					}),
				]),
				ownership_token: ownershipToken,
			});
		} catch (error) {
			if (stagingCreated) await rm(artifactStagingRoot, { recursive: true, force: true });
			if (workspaceCreated) await rm(workspaceRoot, { recursive: true, force: true });
			throw error;
		}
	}

	/**
	 * 函数职责：校验分配路径和磁盘所有权记录一致。
	 * 输入约束：分配必须来自当前管理器的 prepare。
	 * 返回结果：两个目录均归属当前任务时完成。
	 * 失败语义：路径漂移及记录失配时抛出所有权错误。
	 */
	async verifyOwnership(allocation: WorkspaceAllocation): Promise<void> {
		const paths = this.expectedAllocationPaths(allocation.task_id);
		if (
			resolve(allocation.workspace_root) !== paths.workspaceRoot ||
			resolve(allocation.artifact_staging_root) !== paths.artifactStagingRoot
		) {
			throw new WorkspaceOwnershipError();
		}
		const [workspaceOwnership, stagingOwnership] = await Promise.all([
			readOwnershipRecord(join(paths.workspaceRoot, OWNERSHIP_FILE)),
			readOwnershipRecord(join(paths.artifactStagingRoot, OWNERSHIP_FILE)),
		]);
		this.assertOwnershipRecord(allocation, workspaceOwnership);
		this.assertOwnershipRecord(allocation, stagingOwnership);
	}

	/**
	 * 函数职责：回收当前任务工作区和制品暂存目录。
	 * 输入约束：现存目录必须携带匹配所有权记录。
	 * 返回结果：两个任务目录均不存在时完成。
	 * 失败语义：所有权及删除失败时抛出稳定回收错误。
	 */
	async cleanup(allocation: WorkspaceAllocation): Promise<void> {
		try {
			const paths = this.expectedAllocationPaths(allocation.task_id);
			if (
				resolve(allocation.workspace_root) !== paths.workspaceRoot ||
				resolve(allocation.artifact_staging_root) !== paths.artifactStagingRoot
			) {
				throw new WorkspaceOwnershipError();
			}
			const stagingExists = await this.verifyExistingOwnership(paths.artifactStagingRoot, allocation);
			const workspaceExists = await this.verifyExistingOwnership(paths.workspaceRoot, allocation);
			if (stagingExists) await rm(paths.artifactStagingRoot, { recursive: true });
			if (workspaceExists) await rm(paths.workspaceRoot, { recursive: true });
		} catch (error) {
			if (error instanceof WorkspaceCleanupError) throw error;
			throw new WorkspaceCleanupError(error);
		}
	}

	/**
	 * 函数职责：校验工作区准备命令的固定字段。
	 * 输入约束：命令必须来自可信任务快照和缓存配置。
	 * 返回结果：字段及来源路径有效时正常返回。
	 * 失败语义：格式失配时抛出稳定输入错误。
	 */
	private assertPrepareCommand(command: PrepareWorkspaceCommand): void {
		if (!TASK_ID_PATTERN.test(command.task_id)) throw new Error("invalid_workspace_task_id");
		if (!BASELINE_PATTERN.test(command.baseline_commit)) throw new Error("invalid_workspace_baseline_commit");
		if (!isAbsolute(command.frozen_source_root)) throw new Error("frozen_source_root_must_be_absolute");
		for (const cache of [command.git_cache, command.dependency_cache]) {
			if (!isAbsolute(cache.trusted_source_root)) throw new Error("cache_source_root_must_be_absolute");
			if (!SHA256_PATTERN.test(cache.content_sha256)) throw new Error("invalid_cache_sha256");
		}
	}

	/**
	 * 函数职责：串行化同一内容缓存的校验和构建。
	 * 输入约束：缓存类别和来源已经通过命令校验。
	 * 返回结果：返回哈希匹配的只读缓存路径。
	 * 失败语义：可信源失配及发布失败时拒绝 Promise。
	 */
	private async ensureCache(cacheKind: "git" | "dependencies", source: ContentCacheSource): Promise<string> {
		const operationKey = `${cacheKind}:${source.content_sha256}`;
		const activeOperation = this.cacheOperations.get(operationKey);
		if (activeOperation !== undefined) return activeOperation;
		const operation = this.ensureCacheEntry(cacheKind, source);
		this.cacheOperations.set(operationKey, operation);
		try {
			return await operation;
		} finally {
			if (this.cacheOperations.get(operationKey) === operation) this.cacheOperations.delete(operationKey);
		}
	}

	/**
	 * 函数职责：校验现有缓存并从可信源原子重建。
	 * 输入约束：预期哈希必须等于可信源内容哈希。
	 * 返回结果：返回权限已收紧的内容寻址目录。
	 * 失败语义：哈希漂移及原子发布失败时拒绝 Promise。
	 */
	private async ensureCacheEntry(cacheKind: "git" | "dependencies", source: ContentCacheSource): Promise<string> {
		const trustedSourceRoot = resolve(source.trusted_source_root);
		if ((await directoryContentSha256(trustedSourceRoot)) !== source.content_sha256) {
			throw new CacheIntegrityError(cacheKind, "trusted_cache_hash_mismatch");
		}
		const kindRoot = join(this.cacheRoot, cacheKind);
		const cacheEntryRoot = join(kindRoot, source.content_sha256);
		this.assertManagedPath(kindRoot, cacheEntryRoot);
		await mkdir(kindRoot, { recursive: true, mode: 0o750 });
		if (await this.pathExists(cacheEntryRoot)) {
			let existingHash: string | null = null;
			try {
				existingHash = await directoryContentSha256(cacheEntryRoot);
			} catch {
				existingHash = null;
			}
			if (existingHash === source.content_sha256) return cacheEntryRoot;
			const cacheEntryStat = await lstat(cacheEntryRoot);
			if (cacheEntryStat.isDirectory() && !cacheEntryStat.isSymbolicLink()) {
				await makeTreeWritable(cacheEntryRoot);
			}
			await rm(cacheEntryRoot, { recursive: true });
		}

		const stagingRoot = join(kindRoot, `.staging-${source.content_sha256}-${randomUUID()}`);
		this.assertManagedPath(kindRoot, stagingRoot);
		try {
			await copyDirectoryContents(trustedSourceRoot, stagingRoot, false);
			if ((await directoryContentSha256(stagingRoot)) !== source.content_sha256) {
				throw new CacheIntegrityError(cacheKind, "rebuilt_cache_hash_mismatch");
			}
			await makeTreeReadOnly(stagingRoot);
			try {
				await rename(stagingRoot, cacheEntryRoot);
			} catch (error) {
				const code = this.errorCode(error);
				if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
				await makeTreeWritable(stagingRoot);
				await rm(stagingRoot, { recursive: true });
				if ((await directoryContentSha256(cacheEntryRoot)) !== source.content_sha256) {
					throw new CacheIntegrityError(cacheKind, "cache_publish_conflict");
				}
			}
			return cacheEntryRoot;
		} catch (error) {
			if (await this.pathExists(stagingRoot)) {
				await makeTreeWritable(stagingRoot);
				await rm(stagingRoot, { recursive: true });
			}
			throw error;
		}
	}

	/**
	 * 函数职责：生成任务对应的固定受管目录路径。
	 * 输入约束：任务 ID 必须来自已校验分配。
	 * 返回结果：返回工作区和制品暂存绝对路径。
	 * 失败语义：派生路径逃逸时抛出所有权错误。
	 */
	private expectedAllocationPaths(taskId: string): {
		readonly workspaceRoot: string;
		readonly artifactStagingRoot: string;
	} {
		if (!TASK_ID_PATTERN.test(taskId)) throw new WorkspaceOwnershipError();
		const workspaceRoot = join(this.workspacesRoot, taskId);
		const artifactStagingRoot = join(this.resultsRoot, `.staging-${taskId}`);
		this.assertManagedPath(this.workspacesRoot, workspaceRoot);
		this.assertManagedPath(this.resultsRoot, artifactStagingRoot);
		return { workspaceRoot, artifactStagingRoot };
	}

	/**
	 * 函数职责：校验磁盘记录绑定当前目录分配。
	 * 输入约束：记录必须从分配派生路径读取。
	 * 返回结果：所有字段一致时正常返回。
	 * 失败语义：任一字段失配时抛出所有权错误。
	 */
	private assertOwnershipRecord(allocation: WorkspaceAllocation, record: OwnershipRecord): void {
		if (
			record.task_id !== allocation.task_id ||
			record.baseline_commit !== allocation.baseline_commit ||
			record.ownership_token !== allocation.ownership_token
		) {
			throw new WorkspaceOwnershipError();
		}
	}

	/**
	 * 函数职责：校验仍存在目录的所有权记录。
	 * 输入约束：目录必须是当前任务派生路径。
	 * 返回结果：目录存在且匹配时返回 true，不存在时返回 false。
	 * 失败语义：记录缺失及字段失配时拒绝回收。
	 */
	private async verifyExistingOwnership(root: string, allocation: WorkspaceAllocation): Promise<boolean> {
		if (!(await this.pathExists(root))) return false;
		this.assertOwnershipRecord(allocation, await readOwnershipRecord(join(root, OWNERSHIP_FILE)));
		return true;
	}

	/**
	 * 函数职责：断言派生路径严格位于受管根目录内。
	 * 输入约束：两个路径必须已经绝对化。
	 * 返回结果：路径受控时正常返回。
	 * 失败语义：路径逃逸时抛出所有权错误。
	 */
	private assertManagedPath(root: string, candidate: string): void {
		if (!isContainedPath(resolve(root), resolve(candidate))) throw new WorkspaceOwnershipError();
	}

	/**
	 * 函数职责：判断受管路径当前是否存在。
	 * 输入约束：路径必须由管理器内部派生。
	 * 返回结果：存在返回 true，缺失返回 false。
	 * 失败语义：非缺失类文件系统错误继续抛出。
	 */
	private async pathExists(path: string): Promise<boolean> {
		try {
			await lstat(path);
			return true;
		} catch (error) {
			if (this.errorCode(error) === "ENOENT") return false;
			throw error;
		}
	}

	/**
	 * 函数职责：读取未知异常的文件系统错误码。
	 * 输入约束：输入可以是任意拒绝原因。
	 * 返回结果：字符串错误码存在时返回该值。
	 * 失败语义：函数不抛出异常。
	 */
	private errorCode(error: unknown): string | undefined {
		if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
		const code = (error as { readonly code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
}
