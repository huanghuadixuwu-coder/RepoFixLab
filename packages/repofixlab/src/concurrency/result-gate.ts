/**
 * 脚本职责：校验任务基线并原子发布不可变结果。
 * 输入边界：接收 validating 及 publishing 任务、基线读取端口和真实 ArtifactStore。
 * 输出边界：仅写入任务独占结果目录及最终清单引用。
 */

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { ArtifactStore, StoredArtifact } from "../storage/artifact-store.ts";
import type { ConcurrencyTask } from "./contracts.ts";
import type { TaskStore } from "./task-store.ts";

const RESULT_MANIFEST_PATH = "result-manifest.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const artifactSensitivities: ReadonlySet<string> = new Set(["public", "internal", "private"]);
const artifactProducers: ReadonlySet<string> = new Set(["orchestrator", "agent", "controller", "evaluator"]);

export interface BaselineSource {
	/**
	 * 函数职责：读取任务目标分支的当前提交。
	 * 输入约束：任务仓库已在基线源中完成确定性映射。
	 * 返回结果：返回四十位小写十六进制提交标识。
	 * 失败语义：仓库不存在及读取失败时拒绝 Promise。
	 */
	currentCommit(task: ConcurrencyTask): Promise<string>;
}

export interface ResultManifestArtifact {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly media_type: string;
	readonly sensitivity: string;
	readonly generated_by: string;
}

export interface ResultManifest {
	readonly schema_version: "v1";
	readonly task_id: string;
	readonly baseline_commit: string;
	readonly artifacts: readonly ResultManifestArtifact[];
}

export interface PublishedResult {
	readonly task_id: string;
	readonly baseline_commit: string;
	readonly manifest_path: string;
	readonly manifest_sha256: string;
}

export interface ResultGateOptions {
	readonly root: string;
	readonly store: Pick<TaskStore, "transition" | "recordResult">;
	readonly baselineSource: BaselineSource;
}

/**
 * 函数职责：计算结果字节的小写 SHA-256 标识。
 * 输入约束：输入是已经完整读取的不可变字节。
 * 返回结果：返回六十四位小写十六进制文本。
 * 失败语义：哈希计算失败时同步抛出异常。
 */
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 函数职责：判断未知值是否为普通键值对象。
 * 输入约束：允许任意反序列化结果进入检查。
 * 返回结果：非空对象且不是数组时返回 true。
 * 失败语义：该函数不抛出异常且不修改输入。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 函数职责：校验清单中的安全相对文件路径。
 * 输入约束：路径使用正斜线并指向结果目录下的文件。
 * 返回结果：满足非空、非遍历和非清单自身约束时返回 true。
 * 失败语义：非法路径返回 false 且不访问文件系统。
 */
function isSafeArtifactPath(path: string): boolean {
	return (
		path.length > 0 &&
		path !== RESULT_MANIFEST_PATH &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		!path.startsWith("/") &&
		path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
	);
}

/**
 * 函数职责：校验一项反序列化清单文件元数据。
 * 输入约束：输入来自未信任的最终清单 JSON。
 * 返回结果：字段类型、哈希、路径和枚举均有效时返回 true。
 * 失败语义：非法字段返回 false 且不读取产物文件。
 */
function isManifestArtifact(value: unknown): value is ResultManifestArtifact {
	if (!isRecord(value)) return false;
	return (
		typeof value.path === "string" &&
		isSafeArtifactPath(value.path) &&
		typeof value.bytes === "number" &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes >= 0 &&
		typeof value.sha256 === "string" &&
		SHA256_PATTERN.test(value.sha256) &&
		typeof value.media_type === "string" &&
		value.media_type.length > 0 &&
		typeof value.sensitivity === "string" &&
		artifactSensitivities.has(value.sensitivity) &&
		typeof value.generated_by === "string" &&
		artifactProducers.has(value.generated_by)
	);
}

/**
 * 函数职责：解析并完整校验最终结果清单。
 * 输入约束：输入字节必须是单个 UTF-8 JSON 对象。
 * 返回结果：返回字段冻结且产物路径无重复的 v1 清单。
 * 失败语义：语法、字段及重复路径非法时抛出稳定异常。
 */
function parseManifest(bytes: Uint8Array): ResultManifest {
	const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
	if (
		!isRecord(parsed) ||
		parsed.schema_version !== "v1" ||
		typeof parsed.task_id !== "string" ||
		typeof parsed.baseline_commit !== "string" ||
		!COMMIT_PATTERN.test(parsed.baseline_commit) ||
		!Array.isArray(parsed.artifacts) ||
		parsed.artifacts.length === 0 ||
		!parsed.artifacts.every(isManifestArtifact)
	) {
		throw new Error("result_manifest_invalid");
	}
	const artifacts = parsed.artifacts as readonly ResultManifestArtifact[];
	if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
		throw new Error("result_manifest_invalid");
	}
	return {
		schema_version: "v1",
		task_id: parsed.task_id,
		baseline_commit: parsed.baseline_commit,
		artifacts,
	};
}

/**
 * 函数职责：将 ArtifactStore 元数据映射为冻结清单结构。
 * 输入约束：输入仅来自当前任务独占的真实 ArtifactStore。
 * 返回结果：返回按路径排序且字段名稳定的清单产物数组。
 * 失败语义：空产物集合及清单路径冲突时抛出异常。
 */
function manifestArtifacts(artifacts: readonly StoredArtifact[]): readonly ResultManifestArtifact[] {
	if (artifacts.length === 0 || artifacts.some((artifact) => artifact.path === RESULT_MANIFEST_PATH)) {
		throw new Error("result_manifest_source_invalid");
	}
	return artifacts.map((artifact) => ({
		path: artifact.path,
		bytes: artifact.bytes,
		sha256: artifact.sha256,
		media_type: artifact.mediaType,
		sensitivity: artifact.sensitivity,
		generated_by: artifact.generatedBy,
	}));
}

/**
 * 类职责：执行基线重验、不可变发布和最终清单登记。
 * 持有状态：保存运行根目录、任务持久化端口和基线读取端口。
 * 协作边界：不执行代码修复、不回收工作区且不操作调度容量。
 */
export class ResultGate {
	private readonly root: string;
	private readonly store: Pick<TaskStore, "transition" | "recordResult">;
	private readonly baselineSource: BaselineSource;

	/**
	 * 函数职责：绑定结果根目录及两个外部端口。
	 * 输入约束：根目录经绝对化后用于派生唯一 results 子目录。
	 * 返回结果：创建无后台任务且无文件系统副作用的门禁实例。
	 * 失败语义：构造阶段不连接数据库且不读取基线。
	 */
	constructor(options: ResultGateOptions) {
		this.root = resolve(options.root);
		this.store = options.store;
		this.baselineSource = options.baselineSource;
	}

	/**
	 * 函数职责：重读目标分支提交并推进确定状态。
	 * 输入约束：任务必须处于 validating 且基线提交已冻结。
	 * 返回结果：基线一致进入 publishing，不一致进入 revalidation_required。
	 * 失败语义：基线读取及状态竞争失败时不发布任何文件。
	 */
	async verifyBaseline(task: ConcurrencyTask): Promise<ConcurrencyTask> {
		if (task.status !== "validating") throw new Error("result_gate_requires_validating_task");
		const currentCommit = await this.baselineSource.currentCommit(task);
		if (!COMMIT_PATTERN.test(currentCommit)) throw new Error("baseline_source_commit_invalid");
		return this.store.transition({
			task_id: task.task_id,
			expected_version: task.status_version,
			to_status: currentCommit === task.request.baseline_commit ? "publishing" : "revalidation_required",
			attempt_id: task.attempt_id,
			failure_code: null,
			result_manifest_path: null,
			result_manifest_sha256: null,
		});
	}

	/**
	 * 函数职责：写入最终清单并原子发布任务结果目录。
	 * 输入约束：任务处于 publishing，产物根目录严格匹配任务暂存路径。
	 * 返回结果：返回绑定任务、基线、清单路径和清单哈希的发布凭据。
	 * 失败语义：目录冲突及文件系统失败保持任务处于 publishing。
	 */
	async publish(task: ConcurrencyTask, artifactStore: ArtifactStore): Promise<PublishedResult> {
		if (task.status !== "publishing") throw new Error("result_gate_requires_publishing_task");
		const resultsRoot = join(this.root, "results");
		const stagingRoot = join(resultsRoot, `.staging-${task.task_id}`);
		const finalRoot = join(resultsRoot, task.task_id);
		if (resolve(artifactStore.rootPath) !== resolve(stagingRoot)) {
			throw new Error("result_staging_path_mismatch");
		}

		const manifest: ResultManifest = {
			schema_version: "v1",
			task_id: task.task_id,
			baseline_commit: task.request.baseline_commit,
			artifacts: manifestArtifacts(artifactStore.listArtifacts()),
		};
		const manifestArtifact = await artifactStore.writeNew(RESULT_MANIFEST_PATH, `${stableStringify(manifest)}\n`, {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "controller",
		});
		await artifactStore.publishTo(finalRoot);
		return {
			task_id: task.task_id,
			baseline_commit: task.request.baseline_commit,
			manifest_path: `results/${task.task_id}/${RESULT_MANIFEST_PATH}`,
			manifest_sha256: manifestArtifact.sha256,
		};
	}

	/**
	 * 函数职责：复核最终清单及全部产物并原子完成任务。
	 * 输入约束：任务处于 publishing，发布凭据必须绑定当前任务及冻结基线。
	 * 返回结果：校验通过返回 completed，校验失败返回 failed。
	 * 失败语义：清单及产物失配写入 result_manifest_invalid 审计状态。
	 */
	async recordManifest(task: ConcurrencyTask, published: PublishedResult): Promise<ConcurrencyTask> {
		if (task.status !== "publishing") throw new Error("result_gate_requires_publishing_task");
		const expectedManifestPath = `results/${task.task_id}/${RESULT_MANIFEST_PATH}`;
		const finalRoot = join(this.root, "results", task.task_id);
		let valid =
			published.task_id === task.task_id &&
			published.baseline_commit === task.request.baseline_commit &&
			published.manifest_path === expectedManifestPath &&
			SHA256_PATTERN.test(published.manifest_sha256);

		try {
			const rootStats = await lstat(finalRoot);
			const manifestFile = join(finalRoot, RESULT_MANIFEST_PATH);
			const manifestStats = await lstat(manifestFile);
			valid = valid && rootStats.isDirectory() && !rootStats.isSymbolicLink();
			valid = valid && manifestStats.isFile() && !manifestStats.isSymbolicLink();
			const manifestBytes = await readFile(manifestFile);
			valid = valid && sha256(manifestBytes) === published.manifest_sha256;
			const manifest = parseManifest(manifestBytes);
			valid =
				valid && manifest.task_id === task.task_id && manifest.baseline_commit === task.request.baseline_commit;
			for (const artifact of manifest.artifacts) {
				const artifactFile = join(finalRoot, ...artifact.path.split("/"));
				const artifactStats = await lstat(artifactFile);
				const artifactBytes = await readFile(artifactFile);
				valid =
					valid &&
					artifactStats.isFile() &&
					!artifactStats.isSymbolicLink() &&
					artifactBytes.byteLength === artifact.bytes &&
					sha256(artifactBytes) === artifact.sha256;
			}
		} catch {
			valid = false;
		}

		if (!valid) {
			return this.store.transition({
				task_id: task.task_id,
				expected_version: task.status_version,
				to_status: "failed",
				attempt_id: task.attempt_id,
				failure_code: "result_manifest_invalid",
				result_manifest_path: null,
				result_manifest_sha256: null,
			});
		}

		return this.store.recordResult({
			task_id: task.task_id,
			expected_version: task.status_version,
			result_manifest_path: published.manifest_path,
			result_manifest_sha256: published.manifest_sha256,
		});
	}
}
