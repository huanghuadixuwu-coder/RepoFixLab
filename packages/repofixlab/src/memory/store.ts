/**
 * [脚本级]
 *
 * 定位：实现四层设计中的持久化侧，拥有本次 RepoFix attempt 的 L1、L2 及 L0/Condensation 审计制品。
 * 负责：按事件只追加 L2、按完成阶段追加 L1、保存完整 Controller 返回、派生 coverage/file view/chunks，并维护仓库版本语义。
 * 不负责：筛选 Provider 消息、执行模型压缩、决定阶段完成、触发工具或把 L3 跨任务经验注入评测。
 * 数据流：任务输入/消息/工具结果 → L2；repo_read 正文 → L2 file view/chunks；阶段完成 → L1；Assembler 派生结果 → L2 审计。
 * 不变量：原始事件永不覆盖；成功 repo_edit 才推进 revision；所有引用携带 artifact_id 与 SHA-256；未知文件范围保持未知。
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { Compile } from "typebox/compile";
import ts from "typescript";
import type { RepoFixStage } from "../agent/repofix-config.ts";
import type { StageCompletion } from "../agent/repofix-fsm.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import {
	bindMemorySha256,
	type MemoryArtifactRef,
	type MemoryCondensation,
	type MemoryCondensationPayload,
	type MemoryCoverageStatus,
	type MemoryL0Payload,
	type MemoryL0Snapshot,
	type MemoryL1Payload,
	type MemoryL1Record,
	type MemoryL2Event,
	type MemoryL2EventPayload,
	type MemoryLineRange,
	type MemoryStageActivityView,
	verifyMemorySha256,
} from "../contracts/memory.ts";
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import { type RepoEditMetadata, type RepoReadMetadata, RepoToolResultSchema } from "../sandbox/protocol.ts";
import type { StoreArtifactOptions, StoredArtifact } from "../storage/artifact-store.ts";

const repoToolResultValidator = Compile(RepoToolResultSchema);

/**
 * [类别级]
 *
 * 定位：记忆存储依赖的最小不可变 ArtifactStore 端口。
 * 表示：以新路径写入字节并返回路径、大小和哈希的能力。
 * 不变量：Memory Store 只要求追加写，不依赖覆盖或删除能力。
 */
export interface MemoryArtifactStore {
	/**
	 * [函数级]
	 * 目的：以新路径持久化一个不可变记忆制品。
	 * 输入/输出：路径、内容和 artifact 元数据；返回实际写入制品信息。
	 * 约束：调用方只依赖 create-new 语义，不允许通过该端口覆盖旧记忆。
	 */
	writeNew(path: string, content: string | Uint8Array, options: StoreArtifactOptions): Promise<StoredArtifact>;
}

/**
 * [类别级]
 *
 * 定位：执行层已经完成一次仓库工具调用后交给记忆系统的原始证据输入。
 * 表示：工具调用身份、工具名、规范化输入和完整 Controller 返回。
 * 不变量：记忆系统只记录该事实，不负责发起、允许或重试工具调用。
 */
export interface MemoryToolEvidenceInput {
	readonly tool_call_id: string;
	readonly tool_name: string;
	readonly normalized_input: unknown;
	readonly controller_result: unknown;
}

/**
 * [类别级]
 *
 * 定位：把当前阶段一条 Provider 消息关联到其不可变 L2 事件。
 * 表示：消息事件和该消息在阶段历史中的索引。
 * 不变量：索引用于增量捕获，已经捕获的消息不会重复写成新事件。
 */
export interface MemoryMessageSource {
	readonly event: MemoryL2Event;
	readonly message_index: number;
}

/**
 * [类别级]
 *
 * 定位：大文件按需召回的最小正文单元。
 * 表示：路径、path revision、行范围、正文、来源哈希和 chunk 自身哈希。
 * 不变量：chunk 只来自 L2 已经取得的正文；默认目标上限 4096 tokens、相邻重叠 256 tokens 的确定性字节近似。
 */
export interface MemoryFileChunk {
	readonly chunk_id: string;
	readonly path: string;
	readonly path_revision: number;
	readonly start_line: number;
	readonly end_line: number;
	readonly content: string;
	readonly file_sha256: string;
	readonly source_sha256: string | null;
	readonly content_sha256: string;
	readonly sha256: string;
}

/**
 * [类别级]
 *
 * 定位：从已保存 repo_read 正文或可验证的 repo_edit 机械派生的可寻址文件视图。
 * 表示：文件版本、覆盖状态、JS/TS 结构目录及有序 chunks。
 * 不变量：不补全 Controller 未返回的内容，也不把 partial coverage 伪装成完整文件。
 */
export interface MemoryFileViewPayload {
	readonly schema_version: "v1";
	readonly memory_type: "file_view";
	readonly path: string;
	readonly repository_revision: number;
	readonly path_revision: number;
	readonly logical_evidence_key: string;
	readonly file_sha256: string;
	readonly source_sha256: string | null;
	readonly coverage_key: string;
	readonly coverage_status: MemoryCoverageStatus;
	readonly total_lines: number;
	readonly covered_ranges: readonly MemoryLineRange[];
	readonly missing_ranges: readonly MemoryLineRange[] | null;
	readonly provenance_event_ids: readonly string[];
	readonly structure: readonly {
		readonly kind: string;
		readonly name: string;
		readonly start_line: number;
		readonly end_line: number;
	}[];
	readonly chunks: readonly MemoryFileChunk[];
}

/**
 * [类别级]
 *
 * 定位：可落盘、可校验的 L2 文件派生视图。
 * 表示：文件视图载荷及 canonical SHA-256。
 * 不变量：它是来源事件的派生索引，不替代产生它的原始 L2 工具事件。
 */
export type MemoryFileView = MemoryFileViewPayload & { readonly sha256: string };

/**
 * [类别级]
 *
 * 定位：Assembler 可检索的文件视图及完整来源关系。
 * 表示：文件视图、artifact 引用、来源事件、阶段/事件顺序和等价工具调用 ID。
 * 不变量：相同文件视图正文只存一份，所有等价来源仍被保留和排序。
 */
export interface MemoryFileViewRecord {
	readonly view: MemoryFileView;
	readonly ref: MemoryArtifactRef;
	readonly source_event_ids: readonly string[];
	readonly stage_sequence: number;
	readonly event_sequence: number;
	readonly tool_call_ids: readonly string[];
}

/**
 * [类别级]
 *
 * 定位：当前仓库版本中一个逻辑证据键对应的有效正文记录。
 * 表示：一份代表事件及所有等价 L2 事件、工具调用来源。
 * 不变量：L2 保留重复事实；L0 只需展示一份正文并用 stub 表示重复来源。
 */
export interface MemoryActiveEvidenceRecord {
	readonly logical_evidence_key: string;
	readonly event: MemoryL2Event;
	readonly source_event_ids: readonly string[];
	readonly tool_call_ids: readonly string[];
}

/**
 * [类别级]
 *
 * 定位：记忆持久化侧的本地开销指标。
 * 表示：写入耗时、L2 字节数及 L1/L2/Condensation 数量。
 * 不变量：只统计本地存储，不重复统计 Provider token 或压缩等待时间。
 */
export interface RepoFixMemoryStoreMetrics {
	readonly memory_store_ms: number;
	readonly l2_bytes: number;
	readonly l1_records: number;
	readonly l2_events: number;
	readonly condensation_count: number;
}

/**
 * [类别级]
 *
 * 定位：由同一文件版本的派生视图或同一非文件 coverage key 的事件机械合成的累计覆盖视图。
 * 表示：覆盖类型、累计状态、合并后的已知/缺失范围和全部来源事件。
 * 不变量：派生过程不回写旧事件；任一完整事件可使累计状态变为 complete，否则保留已知或未知缺口。
 */
export interface MemoryCoverageView {
	readonly coverage_key: string;
	readonly path: string | null;
	readonly repository_revision: number | null;
	readonly path_revision: number | null;
	readonly file_sha256: string | null;
	readonly coverage_type: MemoryL2EventPayload["coverage_type"];
	readonly coverage_status: MemoryCoverageStatus;
	readonly covered_ranges: readonly MemoryLineRange[];
	readonly missing_ranges: readonly MemoryLineRange[] | null;
	readonly source_event_ids: readonly string[];
}

/**
 * [类别级]
 *
 * 定位：Memory Store 内部的单阶段追加游标。
 * 表示：外部指定阶段、下一事件序号、已捕获消息数和将写入 L1 的证据引用。
 * 不变量：任意时刻最多一个活动阶段；阶段完成后整体清空而不影响已落盘 L1/L2。
 */
type ActiveStage = {
	readonly stage_id: RepoFixStage;
	readonly stage_sequence: number;
	next_event_sequence: number;
	captured_message_count: number;
	readonly message_events: MemoryMessageSource[];
	readonly evidence_refs: MemoryArtifactRef[];
};

/**
 * [函数级]
 * 目的：把未知 JSON 值安全收窄为普通对象。
 * 输入/输出：任意值；排除 null 与数组后返回类型谓词。
 * 约束：仅做形状判断，不声明字段可信。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * [函数级]
 * 目的：计算正文级 SHA-256，用于文件内容和 chunk 身份。
 * 输入/输出：UTF-8 字符串；小写十六进制哈希。
 * 约束：不同于契约对象的 canonical JSON 哈希，不得混用语义。
 */
function rawSha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * [函数级]
 * 目的：从规范化工具输入中取得统一的仓库相对路径。
 * 输入/输出：未知输入；标准化斜杠后的非空路径或 null。
 * 约束：只读取显式 `path`，不从自由文本猜测路径。
 */
function explicitPath(value: unknown): string | null {
	if (!isRecord(value) || typeof value.path !== "string") return null;
	const path = value.path.trim().replaceAll("\\", "/");
	return path.length === 0 ? null : path;
}

/**
 * [函数级]
 * 目的：安全读取 Controller 返回中的 stdout 或 stderr。
 * 输入/输出：未知返回与字段名；缺失或非字符串字段映射为空串。
 * 约束：不修改、截断或解释原始文本。
 */
function resultText(value: unknown, key: "stdout" | "stderr"): string {
	return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

/**
 * [函数级]
 * 目的：为一次 Controller 结果构造稳定的内容身份。
 * 输入/输出：未知 Controller 返回；关键执行字段的 canonical SHA-256。
 * 约束：哈希包含退出码、stdout/stderr、截断和超时状态，避免把不同结果错误合并。
 */
function resultSha256(value: unknown): string {
	const record = isRecord(value) ? value : {};
	return canonicalContractSha256({
		exit_code: typeof record.exit_code === "number" ? record.exit_code : null,
		stdout: resultText(value, "stdout"),
		stderr: resultText(value, "stderr"),
		truncated: record.truncated === true,
		timed_out: record.timed_out === true,
	});
}

/**
 * [函数级]
 * 目的：判定一次已经执行的 repo_edit 是否真正改变了仓库版本。
 * 输入/输出：工具名与结果；仅成功、未超时的 repo_edit 返回 true。
 * 约束：失败或超时编辑绝不推进 repository/path revision。
 */
function successfulRepoEdit(toolName: string, result: unknown): boolean {
	return toolName === "repo_edit" && isRecord(result) && result.exit_code === 0 && result.timed_out !== true;
}

/**
 * [函数级]
 * 目的：把外部值收敛为可写入 JSON 制品的值。
 * 输入/输出：任意值；JSON 往返后的副本，无法序列化的顶层值变为 null。
 * 约束：落盘前移除运行时原型和不可序列化成员。
 */
function jsonSerializable(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? null : JSON.parse(serialized);
}

/**
 * [函数级]
 * 目的：校验阶段与事件相关的正安全整数。
 * 输入/输出：数值及字段名；成功无返回，失败抛错。
 * 约束：拒绝零、负数、非整数和超出安全范围的值。
 */
function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

/**
 * [函数级]
 * 目的：复用仓库工具结果 Schema 收窄 repo_read metadata，并校验 Schema 无法表达的范围关系。
 * 输入/输出：未知 Controller 结果；合法的读取元数据或 null。
 * 约束：不重复实现字段、SHA 格式和严格键集合校验。
 */
function readMetadata(result: unknown): RepoReadMetadata | null {
	if (!repoToolResultValidator.Check(result) || result.tool !== "repo_read") return null;
	const metadata = result.read_metadata;
	const returnedRange = metadata.returned_range;
	if (
		returnedRange !== null &&
		(returnedRange.end_line_exclusive < returnedRange.start_line ||
			returnedRange.end_line_exclusive > metadata.total_lines + 1)
	) {
		return null;
	}
	return metadata;
}

/**
 * [函数级]
 * 目的：复用仓库工具结果 Schema 收窄 repo_edit metadata，并校验严格联合类型的跨字段关系。
 * 输入/输出：未知 Controller 结果；合法的创建或替换元数据，否则返回 null。
 * 约束：创建和替换语义保持互斥；失败时不修补或猜测字段。
 */
function editMetadata(result: unknown): RepoEditMetadata | null {
	if (!repoToolResultValidator.Check(result) || result.tool !== "repo_edit") return null;
	const metadata = result.edit_metadata;
	const afterRange = metadata.after_range;
	if (
		afterRange.end_line_exclusive < afterRange.start_line ||
		afterRange.end_line_exclusive > metadata.after_total_lines + 1
	) {
		return null;
	}
	if (metadata.edit_kind === "create") {
		if (afterRange.start_line !== 1 || afterRange.end_line_exclusive !== metadata.after_total_lines + 1) {
			return null;
		}
		return metadata;
	}
	const beforeRange = metadata.before_range;
	if (
		beforeRange.end_line_exclusive < beforeRange.start_line ||
		metadata.line_delta !== metadata.after_total_lines - metadata.before_total_lines ||
		beforeRange.end_line_exclusive > metadata.before_total_lines + 1 ||
		beforeRange.start_line !== afterRange.start_line
	) {
		return null;
	}
	return metadata;
}

/**
 * [函数级]
 * 目的：把文件 Coverage 绑定到唯一的路径版本和完整文件身份。
 * 输入/输出：路径、path revision 和完整文件 SHA；canonical coverage key。
 * 约束：该键不能替代独立的 path revision SHA 冲突表。
 */
function fileCoverageKey(path: string, pathRevision: number, fileSha256: string): string {
	return canonicalContractSha256({ tool: "repo_read", path, path_revision: pathRevision, file_sha256: fileSha256 });
}

/**
 * [函数级]
 * 目的：为一次工具结果机械生成 coverage key、类型和初始覆盖状态。
 * 输入/输出：工具名、规范化输入和 Controller 返回；覆盖描述对象。
 * 约束：分页、截断或超时结果不得标记 complete；未知缺口保持 `partial_unknown`。
 */
function toolCoverage(
	toolName: string,
	input: unknown,
	result: unknown,
	repositoryRevision: number,
	pathRevision: number | null,
	read: RepoReadMetadata | null,
): {
	readonly key: string | null;
	readonly type: MemoryL2EventPayload["coverage_type"];
	readonly status: MemoryCoverageStatus | null;
	readonly covered: readonly MemoryLineRange[];
	readonly missing: readonly MemoryLineRange[] | null;
	readonly truncated: boolean;
	readonly totalLines: number | null;
	readonly fileSha256: string | null;
	readonly sourceSha256: string | null;
} {
	const resultRecord = isRecord(result) ? result : {};
	const truncated = resultRecord.truncated === true || resultRecord.timed_out === true;
	const inputRecord = isRecord(input) ? input : {};
	if (toolName === "repo_read") {
		const metadata = read;
		const path = explicitPath(input);
		if (metadata === null || path === null || pathRevision === null || metadata.path !== path) {
			throw new Error("Memory repo_read result is missing valid read_metadata");
		}
		const stdout = resultText(result, "stdout");
		const stdoutLineCount = splitFileLines(stdout).length;
		const returnedRange = metadata.returned_range;
		const expectedComplete =
			!truncated &&
			(metadata.total_lines === 0 ||
				(returnedRange !== null &&
					returnedRange.start_line === 1 &&
					returnedRange.end_line_exclusive === metadata.total_lines + 1));
		if (metadata.source_sha256 !== rawSha256(stdout)) {
			throw new Error("Memory repo_read source SHA-256 does not match stdout");
		}
		if (
			(returnedRange === null && stdout.length > 0) ||
			(returnedRange !== null && stdout.length === 0) ||
			(metadata.total_lines === 0 && returnedRange !== null) ||
			(returnedRange !== null && returnedRange.end_line_exclusive - returnedRange.start_line !== stdoutLineCount) ||
			metadata.complete !== expectedComplete ||
			(metadata.complete && metadata.file_sha256 !== metadata.source_sha256)
		) {
			throw new Error("Memory repo_read range or completion metadata is inconsistent");
		}
		const covered: readonly MemoryLineRange[] =
			returnedRange === null || returnedRange.end_line_exclusive === returnedRange.start_line
				? []
				: [{ start_line: returnedRange.start_line, end_line: returnedRange.end_line_exclusive - 1 }];
		return {
			key: fileCoverageKey(path, pathRevision, metadata.file_sha256),
			type: metadata.complete ? "full_file" : "file_range",
			status: metadata.complete ? "complete" : "partial_known",
			covered,
			missing: complementRanges(metadata.total_lines, covered),
			truncated,
			totalLines: metadata.total_lines,
			fileSha256: metadata.file_sha256,
			sourceSha256: metadata.source_sha256,
		};
	}
	if (toolName !== "repo_search" && toolName !== "repo_list" && toolName !== "repo_diff") {
		return {
			key: null,
			type: null,
			status: null,
			covered: [],
			missing: null,
			truncated,
			totalLines: null,
			fileSha256: null,
			sourceSha256: null,
		};
	}
	const target =
		toolName === "repo_search"
			? {
					tool: toolName,
					repository_revision: repositoryRevision,
					query: inputRecord.query ?? null,
					path: inputRecord.path ?? null,
					range_type: "results",
				}
			: { tool: toolName, repository_revision: repositoryRevision, input };
	const explicitlyPaged = toolName === "repo_search";
	return {
		key: canonicalContractSha256(target),
		type:
			toolName === "repo_search"
				? "result_page"
				: toolName === "repo_list" || toolName === "repo_diff"
					? "full_result_set"
					: null,
		status: truncated || explicitlyPaged ? "partial_unknown" : "complete",
		covered: [],
		missing: null,
		truncated,
		totalLines: null,
		fileSha256: null,
		sourceSha256: null,
	};
}

/**
 * [函数级]
 * 目的：为当前仓库版本中的一份工具证据建立确定性合并键。
 * 输入/输出：工具事实及 repository/path revision；canonical SHA-256 逻辑键。
 * 约束：repo_read 绑定路径版本、行范围和正文；search/list/diff 绑定全局仓库版本，防止跨版本误合并。
 */
function logicalEvidenceKey(
	toolName: string,
	input: unknown,
	result: unknown,
	repositoryRevision: number,
	pathRevision: number | null,
): string {
	const inputRecord = isRecord(input) ? input : {};
	const path = explicitPath(input);
	const normalizedInputSha256 = canonicalContractSha256(jsonSerializable(input));
	const outputSha256 = resultSha256(result);
	const identity =
		toolName === "repo_read"
			? {
					tool: toolName,
					path,
					path_revision: pathRevision,
					start_line: typeof inputRecord.start_line === "number" ? inputRecord.start_line : 1,
					end_line:
						typeof inputRecord.line_count === "number"
							? (typeof inputRecord.start_line === "number" ? inputRecord.start_line : 1) +
								inputRecord.line_count -
								1
							: null,
					content_sha256: rawSha256(resultText(result, "stdout")),
				}
			: toolName === "repo_search" || toolName === "repo_list"
				? {
						tool: toolName,
						repository_revision: repositoryRevision,
						normalized_input_sha256: normalizedInputSha256,
						result_sha256: outputSha256,
					}
				: toolName === "repo_diff"
					? {
							tool: toolName,
							repository_revision: repositoryRevision,
							result_sha256: outputSha256,
						}
					: {
							tool: toolName,
							repository_revision: repositoryRevision,
							path,
							path_revision: pathRevision,
							normalized_input_sha256: normalizedInputSha256,
							result_sha256: outputSha256,
						};
	return canonicalContractSha256(identity);
}

/**
 * [函数级]
 * 目的：按文件扩展名选择 TypeScript parser 的语法模式。
 * 输入/输出：仓库路径；JS、JSX、TS 或 TSX ScriptKind。
 * 约束：未知扩展名按 TS 解析，调用方只对支持的 JS/TS 系列文件提取结构。
 */
function sourceFileKind(path: string): ts.ScriptKind {
	switch (extname(path).toLowerCase()) {
		case ".js":
			return ts.ScriptKind.JS;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".tsx":
			return ts.ScriptKind.TSX;
		default:
			return ts.ScriptKind.TS;
	}
}

/**
 * [函数级]
 * 目的：为结构目录中的 AST 节点提取稳定可读名称。
 * 输入/输出：TypeScript AST 节点；标识符、字符串名或 SyntaxKind 名称。
 * 约束：仅用于索引，不把推断名称写回源码。
 */
function nodeName(node: ts.Node): string {
	if ("name" in node) {
		const name = (node as ts.Node & { readonly name?: ts.Node }).name;
		if (name !== undefined && ts.isIdentifier(name)) return name.text;
		if (name !== undefined && ts.isStringLiteral(name)) return name.text;
	}
	return ts.SyntaxKind[node.kind] ?? "unknown";
}

/**
 * [函数级]
 * 目的：从 L2 已取得的 JS/TS 正文派生 imports、类、函数和方法的行号目录。
 * 输入/输出：路径、正文和原始起始行；按位置稳定排序的结构项。
 * 约束：非 JS/TS 文件返回空目录；语法目录只覆盖当前已读正文。
 */
function fileStructure(path: string, content: string, startLine: number): MemoryFileViewPayload["structure"] {
	if (![".js", ".jsx", ".ts", ".tsx"].includes(extname(path).toLowerCase())) return [];
	const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, sourceFileKind(path));
	const entries: MemoryFileViewPayload["structure"][number][] = [];
	/**
	 * [函数级]
	 * 目的：深度遍历当前已取得源码的 AST，并收集允许暴露的结构节点。
	 * 输入/输出：一个 AST 节点；通过闭包向 `entries` 追加结构项。
	 * 约束：遍历顺序不作为最终顺序，返回前统一按行号和名称排序。
	 */
	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node)
		) {
			entries.push({
				kind: ts.SyntaxKind[node.kind] ?? "unknown",
				name: nodeName(node),
				start_line: startLine + source.getLineAndCharacterOfPosition(node.getStart(source)).line,
				end_line: startLine + source.getLineAndCharacterOfPosition(node.end).line,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return entries.sort(
		(left, right) =>
			left.start_line - right.start_line || left.end_line - right.end_line || left.name.localeCompare(right.name),
	);
}

/**
 * [函数级]
 * 目的：使用与 Controller 一致的 LF 规则切分已取得正文。
 * 输入/输出：UTF-8 正文；保留每行原始换行字符的有序数组。
 * 约束：空正文没有行；不把其他 Unicode 分隔符解释为换行。
 */
function splitFileLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split(/(?<=\n)/);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/**
 * [函数级]
 * 目的：把已取得文件正文切成可按 query 精确召回的稳定 chunks。
 * 输入/输出：文件版本与正文；带路径、行号、来源哈希和契约哈希的有序 chunks。
 * 约束：使用 4 bytes/token 近似实现 4096-token 上限和 256-token 重叠；不创建未知正文。
 */
function chunkFile(
	path: string,
	pathRevision: number,
	fileSha256: string,
	content: string,
	startLine: number,
	sourceSha256: string | null,
): readonly MemoryFileChunk[] {
	const maxBytes = 4096 * 4;
	const overlapBytes = 256 * 4;
	const lines = splitFileLines(content);
	const chunks: MemoryFileChunk[] = [];
	let cursor = 0;
	while (cursor < lines.length) {
		let end = cursor;
		let bytes = 0;
		while (end < lines.length) {
			const nextBytes = Buffer.byteLength(lines[end] ?? "", "utf8");
			if (end > cursor && bytes + nextBytes > maxBytes) break;
			bytes += nextBytes;
			end += 1;
			if (bytes >= maxBytes) break;
		}
		if (end === cursor) end += 1;
		const value = lines.slice(cursor, end).join("");
		const contentSha256 = rawSha256(value);
		const chunkStart = startLine + cursor;
		const chunkEnd = startLine + end - 1;
		const payload = {
			path,
			path_revision: pathRevision,
			start_line: chunkStart,
			end_line: chunkEnd,
			content: value,
			file_sha256: fileSha256,
			source_sha256: sourceSha256,
			content_sha256: contentSha256,
		};
		chunks.push({
			chunk_id: `chunk-${fileSha256.slice(0, 12)}-${String(chunkStart)}-${contentSha256.slice(0, 12)}`,
			...payload,
			sha256: canonicalContractSha256(payload),
		});
		if (end >= lines.length) break;
		let overlap = 0;
		let nextCursor = end;
		while (nextCursor > cursor && overlap < overlapBytes) {
			nextCursor -= 1;
			overlap += Buffer.byteLength(lines[nextCursor] ?? "", "utf8");
		}
		cursor = nextCursor === cursor ? end : nextCursor;
	}
	return chunks;
}

/**
 * [函数级]
 * 目的：规范化并合并重叠或相邻的覆盖行区间。
 * 输入/输出：任意顺序区间；按起始行排序的最小不重叠区间集。
 * 约束：只合并已知范围，不据此推断未列出的范围。
 */
function mergeRanges(ranges: readonly MemoryLineRange[]): readonly MemoryLineRange[] {
	const ordered = [...ranges].sort(
		(left, right) => left.start_line - right.start_line || left.end_line - right.end_line,
	);
	const merged: MemoryLineRange[] = [];
	for (const range of ordered) {
		const previous = merged.at(-1);
		if (previous === undefined || range.start_line > previous.end_line + 1) {
			merged.push(range);
		} else if (range.end_line > previous.end_line) {
			merged[merged.length - 1] = { start_line: previous.start_line, end_line: range.end_line };
		}
	}
	return merged;
}

/**
 * [函数级]
 * 目的：机械计算一基文件范围内尚未覆盖的补集。
 * 输入/输出：文件总行数与已覆盖范围；最小有序缺失范围集合。
 * 约束：只使用已知范围，空文件没有缺口。
 */
function complementRanges(totalLines: number, ranges: readonly MemoryLineRange[]): readonly MemoryLineRange[] {
	if (totalLines === 0) return [];
	const covered = mergeRanges(ranges).filter((range) => range.end_line >= 1 && range.start_line <= totalLines);
	const missing: MemoryLineRange[] = [];
	let cursor = 1;
	for (const range of covered) {
		const start = Math.max(1, range.start_line);
		const end = Math.min(totalLines, range.end_line);
		if (start > cursor) missing.push({ start_line: cursor, end_line: start - 1 });
		cursor = Math.max(cursor, end + 1);
	}
	if (cursor <= totalLines) missing.push({ start_line: cursor, end_line: totalLines });
	return missing;
}

/**
 * [函数级]
 * 目的：从可能重叠的可信 chunks 重建完整缓存文件。
 * 输入/输出：chunks、总行数与完整文件 SHA；校验成功的正文或 null。
 * 约束：缺行、重叠内容冲突或完整文件 SHA 不匹配时拒绝重建。
 */
function materializeFileChunks(
	chunks: readonly MemoryFileChunk[],
	totalLines: number,
	fileSha256: string,
): string | null {
	if (totalLines === 0) return fileSha256 === rawSha256("") ? "" : null;
	const lines = new Map<number, string>();
	for (const chunk of [...chunks].sort((left, right) => left.start_line - right.start_line)) {
		const chunkLines = splitFileLines(chunk.content);
		if (chunkLines.length !== chunk.end_line - chunk.start_line + 1) return null;
		for (const [offset, line] of chunkLines.entries()) {
			const lineNumber = chunk.start_line + offset;
			const existing = lines.get(lineNumber);
			if (existing !== undefined && existing !== line) return null;
			lines.set(lineNumber, line);
		}
	}
	const ordered: string[] = [];
	for (let line = 1; line <= totalLines; line += 1) {
		const value = lines.get(line);
		if (value === undefined) return null;
		ordered.push(value);
	}
	const content = ordered.join("");
	return rawSha256(content) === fileSha256 ? content : null;
}

/**
 * [函数级]
 * 目的：把确定未变化的 chunk 重新绑定到编辑后的路径版本和行范围。
 * 输入/输出：旧 chunk、新 path revision、文件 SHA 和行差；重新计算哈希的新 chunk。
 * 约束：只迁移正文，不复用旧版本身份或契约哈希。
 */
function migrateChunk(
	chunk: MemoryFileChunk,
	pathRevision: number,
	fileSha256: string,
	lineDelta: number,
): MemoryFileChunk {
	const startLine = chunk.start_line + lineDelta;
	const endLine = chunk.end_line + lineDelta;
	const contentSha256 = rawSha256(chunk.content);
	const payload = {
		path: chunk.path,
		path_revision: pathRevision,
		start_line: startLine,
		end_line: endLine,
		content: chunk.content,
		file_sha256: fileSha256,
		source_sha256: chunk.source_sha256,
		content_sha256: contentSha256,
	};
	return {
		chunk_id: `chunk-${fileSha256.slice(0, 12)}-${String(startLine)}-${contentSha256.slice(0, 12)}`,
		...payload,
		sha256: canonicalContractSha256(payload),
	};
}

/**
 * [类别级]
 *
 * 定位：一个 RepoFix attempt 的 L1/L2 权威存储与派生索引所有者。
 * 表示：活动阶段游标、不可变 L1/L2 缓存、逻辑证据组、repository/path revision、file views 和 Condensations。
 * 不变量：存储层只记录外部已执行事实；L1/L2 只追加；同一时刻仅一个活动阶段；L3 在 SWE-bench 中不存在。
 */
export class RepoFixMemoryStore {
	private readonly artifactStore: MemoryArtifactStore;
	private readonly taskId: string;
	private readonly attemptId: string;
	private active: ActiveStage | null = null;
	private readonly l1Records: MemoryL1Record[] = [];
	private readonly l2Events = new Map<string, MemoryL2Event>();
	private readonly toolEventsByCallId = new Map<string, MemoryL2Event>();
	private readonly evidenceEvents = new Map<string, MemoryL2Event[]>();
	private repositoryRevision = 0;
	private readonly pathRevisions = new Map<string, number>();
	private readonly fileShaByPathRevision = new Map<string, string>();
	private readonly fileViews = new Map<
		string,
		{
			readonly view: MemoryFileView;
			readonly ref: MemoryArtifactRef;
			readonly source_event_ids: Set<string>;
			readonly stage_sequence: number;
			readonly event_sequence: number;
			readonly tool_call_ids: Set<string>;
		}
	>();
	private readonly condensations = new Map<
		string,
		{ readonly value: MemoryCondensation; readonly ref: MemoryArtifactRef }
	>();
	private storeMs = 0;
	private l2Bytes = 0;

	/**
	 * [函数级]
	 * 目的：把一个 attempt 的记忆写入绑定到现有不可变 ArtifactStore。
	 * 输入/输出：artifact 端口、task ID 和 attempt ID；构造可追加的 Memory Store。
	 * 约束：两个身份必须非空，并复制进后续所有记忆制品。
	 */
	constructor(artifactStore: MemoryArtifactStore, taskId: string, attemptId: string) {
		if (taskId.length === 0 || attemptId.length === 0)
			throw new Error("Memory store task and attempt IDs are required");
		this.artifactStore = artifactStore;
		this.taskId = taskId;
		this.attemptId = attemptId;
	}

	/**
	 * [函数级]
	 * 目的：暴露写入每个记忆制品的稳定任务身份。
	 * 输入/输出：无输入；返回构造时冻结的 task ID。
	 * 约束：只读，不随阶段变化。
	 */
	get task_id(): string {
		return this.taskId;
	}

	/**
	 * [函数级]
	 * 目的：暴露写入每个记忆制品的稳定 attempt 身份。
	 * 输入/输出：无输入；返回构造时冻结的 attempt ID。
	 * 约束：只读，不随阶段变化。
	 */
	get attempt_id(): string {
		return this.attemptId;
	}

	/**
	 * [函数级]
	 * 目的：在任何 Provider 请求前把原始任务输入完整写入 L2。
	 * 输入/输出：问题陈述；返回不可变 task-input artifact 引用。
	 * 约束：调用方负责每 attempt 只调用一次；内容不压缩、不摘要。
	 */
	async writeTaskInput(problemStatement: string): Promise<MemoryArtifactRef> {
		return this.writeJson(
			"memory/l2/task-input.json",
			bindMemorySha256({
				schema_version: "v1",
				memory_type: "task_input",
				task_id: this.taskId,
				attempt_id: this.attemptId,
				problem_statement: problemStatement,
			}),
			"internal",
		);
	}

	/**
	 * [函数级]
	 * 目的：为执行层已经选择的阶段开启新的 L2 追加序列。
	 * 输入/输出：阶段 ID 与一基阶段序号；初始化活动阶段状态。
	 * 约束：不选择阶段；已有活动阶段时拒绝开始另一个阶段。
	 */
	startStage(stageId: RepoFixStage, stageSequence: number): void {
		if (this.active !== null) throw new Error(`Memory stage ${this.active.stage_id} is already active`);
		assertPositiveInteger(stageSequence, "stage_sequence");
		this.active = {
			stage_id: stageId,
			stage_sequence: stageSequence,
			next_event_sequence: 1,
			captured_message_count: 0,
			message_events: [],
			evidence_refs: [],
		};
	}

	/**
	 * [函数级]
	 * 目的：把当前阶段尚未捕获的 user/assistant/reasoning/tool-result 消息按序追加到 L2。
	 * 输入/输出：阶段消息全量前缀；返回截至当前的消息来源记录。
	 * 约束：以 `captured_message_count` 增量写入，旧消息不会在下一请求重复落盘。
	 */
	async captureMessages(messages: readonly unknown[]): Promise<readonly MemoryMessageSource[]> {
		const active = this.assertActive();
		for (let index = active.captured_message_count; index < messages.length; index += 1) {
			const message = messages[index];
			const event = await this.appendEvent({
				repository_revision: this.repositoryRevision,
				path_revision: null,
				logical_evidence_key: null,
				file_sha256: null,
				source_sha256: null,
				coverage_total_lines: null,
				event_kind: "message",
				tool_call_id: null,
				tool_name: null,
				normalized_input: null,
				message: jsonSerializable(message),
				controller_result: null,
				coverage_key: null,
				coverage_type: null,
				coverage_status: null,
				covered_ranges: [],
				missing_ranges: null,
				controller_truncated: null,
				controller_result_bytes: null,
			});
			active.message_events.push({ event, message_index: index });
		}
		active.captured_message_count = messages.length;
		return [...active.message_events];
	}

	/**
	 * [函数级]
	 * 目的：完整记录一次已执行仓库工具的 Controller 返回，并派生版本、coverage 与 file view。
	 * 输入/输出：工具证据输入；返回不可变 L2 工具事件。
	 * 约束：成功 repo_edit 才推进 revision；原始返回完整保存；重复证据仍分别写入 L2。
	 */
	async appendToolEvidence(input: MemoryToolEvidenceInput): Promise<MemoryL2Event> {
		const path = explicitPath(input.normalized_input);
		const previousPathRevision = path === null ? null : (this.pathRevisions.get(path) ?? 0);
		const successfulEdit = successfulRepoEdit(input.tool_name, input.controller_result);
		if (successfulEdit) {
			this.repositoryRevision += 1;
			if (path !== null) this.pathRevisions.set(path, (previousPathRevision ?? 0) + 1);
		}
		const pathRevision = path === null ? null : (this.pathRevisions.get(path) ?? 0);
		const read = input.tool_name === "repo_read" ? readMetadata(input.controller_result) : null;
		const coverage = toolCoverage(
			input.tool_name,
			input.normalized_input,
			input.controller_result,
			this.repositoryRevision,
			pathRevision,
			read,
		);
		const edit = successfulEdit ? editMetadata(input.controller_result) : null;
		const evidenceKey = logicalEvidenceKey(
			input.tool_name,
			input.normalized_input,
			input.controller_result,
			this.repositoryRevision,
			pathRevision,
		);
		const normalizedInput = jsonSerializable(input.normalized_input);
		const controllerResultJson = JSON.stringify(input.controller_result) ?? "null";
		const controllerResult: unknown = JSON.parse(controllerResultJson);
		const event = await this.appendEvent({
			repository_revision: this.repositoryRevision,
			path_revision: pathRevision,
			logical_evidence_key: evidenceKey,
			file_sha256: coverage.fileSha256 ?? edit?.after_file_sha256 ?? null,
			source_sha256: coverage.sourceSha256,
			coverage_total_lines: coverage.totalLines,
			event_kind: "tool_evidence",
			tool_call_id: input.tool_call_id,
			tool_name: input.tool_name,
			normalized_input: normalizedInput,
			message: null,
			controller_result: controllerResult,
			coverage_key: coverage.key,
			coverage_type: coverage.type,
			coverage_status: coverage.status,
			covered_ranges: coverage.covered,
			missing_ranges: coverage.missing,
			controller_truncated: coverage.truncated,
			controller_result_bytes: Buffer.byteLength(controllerResultJson, "utf8"),
		});
		this.toolEventsByCallId.set(input.tool_call_id, event);
		const equivalent = this.evidenceEvents.get(evidenceKey) ?? [];
		equivalent.push(event);
		this.evidenceEvents.set(evidenceKey, equivalent);
		if (path !== null && coverage.fileSha256 !== null && pathRevision !== null) {
			this.assertFileRevisionSha(path, pathRevision, coverage.fileSha256);
		}
		if (path !== null && edit !== null && previousPathRevision !== null && pathRevision !== null) {
			if (edit.path !== path) throw new Error("Memory repo_edit metadata path does not match tool input");
			if (edit.edit_kind === "replace") {
				this.assertFileRevisionSha(path, previousPathRevision, edit.before_file_sha256);
			}
			this.assertFileRevisionSha(path, pathRevision, edit.after_file_sha256);
		}
		if (read !== null) await this.appendReadFileView(event, read);
		if (successfulEdit) {
			if (path === null || previousPathRevision === null || pathRevision === null || edit === null) {
				throw new Error("Memory repo_edit result is missing valid edit_metadata");
			}
			await this.migrateFileViewsAfterEdit(event, path, previousPathRevision, pathRevision, edit);
		}
		return event;
	}

	/**
	 * [函数级]
	 * 目的：在外部确认阶段完成后，把完整 handoff 与本阶段全部 L2 引用追加到 L1。
	 * 输入/输出：严格 StageCompletion；返回带哈希的 L1 记录。
	 * 约束：completion 必须匹配活动阶段；不执行 top-N、截断或二次摘要；完成后关闭活动阶段。
	 */
	async completeStage(completion: StageCompletion): Promise<MemoryL1Record> {
		const active = this.assertActive();
		if (completion.stage !== active.stage_id) throw new Error("Memory L1 completion does not match the active stage");
		const payload: MemoryL1Payload = {
			schema_version: "v1",
			memory_type: "l1_handoff",
			task_id: this.taskId,
			attempt_id: this.attemptId,
			stage_id: active.stage_id,
			stage_sequence: active.stage_sequence,
			handoff: completion,
			evidence_refs: [...active.evidence_refs],
		};
		const record = bindMemorySha256(payload);
		await this.writeJson(
			`memory/l1/stages/${String(active.stage_sequence).padStart(2, "0")}.json`,
			record,
			"internal",
		);
		this.l1Records.push(record);
		this.active = null;
		return record;
	}

	/**
	 * [函数级]
	 * 目的：向 Assembler 提供本任务全部已完成阶段的 L1 交接。
	 * 输入/输出：无输入；返回按 stage sequence 排序的只读副本。
	 * 约束：不返回活动阶段的未完成 handoff。
	 */
	listL1(): readonly MemoryL1Record[] {
		return [...this.l1Records].sort((left, right) => left.stage_sequence - right.stage_sequence);
	}

	/**
	 * [函数级]
	 * 目的：取得当前阶段已经写入 L2 的全部消息来源。
	 * 输入/输出：无输入；返回消息来源数组副本。
	 * 约束：必须存在活动阶段，调用者不能修改内部集合。
	 */
	currentMessageSources(): readonly MemoryMessageSource[] {
		return [...this.assertActive().message_events];
	}

	/**
	 * [函数级]
	 * 目的：取得将随阶段 completion 写入 L1 的全部当前阶段 L2 引用。
	 * 输入/输出：无输入；返回 evidence refs 数组副本。
	 * 约束：包含原始事件和派生 file view 引用，且必须存在活动阶段。
	 */
	currentEvidenceRefs(): readonly MemoryArtifactRef[] {
		return [...this.assertActive().evidence_refs];
	}

	/**
	 * [函数级]
	 * 目的：暴露当前全局仓库修订号供证据失效和 L0 审计使用。
	 * 输入/输出：无输入；返回从零开始的 revision。
	 * 约束：只由成功 repo_edit 增加。
	 */
	get repository_revision(): number {
		return this.repositoryRevision;
	}

	/**
	 * [函数级]
	 * 目的：查询某仓库路径的当前内容修订号。
	 * 输入/输出：仓库相对路径；返回从零开始的 path revision。
	 * 约束：统一路径分隔符；仅该路径成功编辑时增加。
	 */
	pathRevision(path: string): number {
		return this.pathRevisions.get(path.replaceAll("\\", "/")) ?? 0;
	}

	/**
	 * [函数级]
	 * 目的：把 Provider 协议中的 tool call ID 解析为其完整 L2 工具事件。
	 * 输入/输出：tool call ID；对应事件或 null。
	 * 约束：只查询已记录调用，不发起工具或构造缺失事件。
	 */
	toolEvent(toolCallId: string): MemoryL2Event | null {
		return this.toolEventsByCallId.get(toolCallId) ?? null;
	}

	/**
	 * [函数级]
	 * 目的：派生当前 repository/path revision 下去重后的 ActiveEvidence 工作集。
	 * 输入/输出：无输入；每个逻辑键返回一份正文代表及所有等价来源。
	 * 约束：旧 revision 只退出 L0 候选，不从 L2 删除；输出按逻辑键稳定排序。
	 */
	listActiveEvidence(): readonly MemoryActiveEvidenceRecord[] {
		const records: MemoryActiveEvidenceRecord[] = [];
		for (const [key, events] of this.evidenceEvents) {
			const current = events.filter((event) => {
				if (event.tool_name === "repo_read") {
					const path = explicitPath(event.normalized_input);
					return path !== null && event.path_revision === this.pathRevision(path);
				}
				return event.repository_revision === this.repositoryRevision;
			});
			const event = current[0];
			if (event === undefined) continue;
			records.push({
				logical_evidence_key: key,
				event,
				source_event_ids: current.map((item) => item.event_id),
				tool_call_ids: current.flatMap((item) => item.tool_call_id ?? []),
			});
		}
		return records.sort((left, right) => left.logical_evidence_key.localeCompare(right.logical_evidence_key));
	}

	/**
	 * [函数级]
	 * 目的：从已执行事件机械投影当前阶段的高密度活动事实。
	 * 输入/输出：无输入；返回 revision、最近成功编辑、最新有效 diff 和验证引用占位。
	 * 约束：不判断 ready/done/next_stage；当前 `latest_verification_ref` 固定为 null，属于尚未实现的设计缺口。
	 */
	currentActivity(): MemoryStageActivityView {
		const active = this.assertActive();
		const events = [...this.l2Events.values()]
			.filter((event) => event.stage_id === active.stage_id)
			.sort((left, right) => left.event_sequence - right.event_sequence);
		const latestEdit = [...events]
			.reverse()
			.find(
				(event) => event.tool_name === "repo_edit" && successfulRepoEdit(event.tool_name, event.controller_result),
			);
		const latestDiff = [...events]
			.reverse()
			.find((event) => event.tool_name === "repo_diff" && event.repository_revision === this.repositoryRevision);
		const editPath = latestEdit === undefined ? null : explicitPath(latestEdit.normalized_input);
		return {
			stage_id: active.stage_id,
			repository_revision: this.repositoryRevision,
			latest_successful_edit:
				latestEdit === undefined || editPath === null
					? null
					: {
							path: editPath,
							event_id: latestEdit.event_id,
							artifact_id: latestEdit.artifact_id,
							sha256: latestEdit.sha256,
						},
			latest_diff:
				latestDiff === undefined
					? null
					: {
							repository_revision: latestDiff.repository_revision,
							event_id: latestDiff.event_id,
							artifact_id: latestDiff.artifact_id,
							result_sha256: resultSha256(latestDiff.controller_result),
						},
			latest_verification_ref: null,
		};
	}

	/**
	 * [函数级]
	 * 目的：按不可变 artifact 引用解析内存中的 L2 原始事件。
	 * 输入/输出：artifact ID 与 SHA-256 引用集合；返回存在且校验一致的事件。
	 * 约束：哈希不一致立即失败；派生 file view 等非事件引用不会伪装成事件。
	 */
	readEvents(refs: readonly MemoryArtifactRef[]): readonly MemoryL2Event[] {
		return refs.flatMap((ref) => {
			const event = this.l2Events.get(ref.artifact_id);
			if (event === undefined) return [];
			if (event.sha256 !== ref.sha256) throw new Error(`Memory evidence SHA-256 mismatch: ${ref.artifact_id}`);
			return [event];
		});
	}

	/**
	 * [函数级]
	 * 目的：向 Assembler 提供所有由已取得正文派生的 file views。
	 * 输入/输出：无输入；返回带来源关系并按路径、阶段、事件稳定排序的记录。
	 * 约束：同时包含 complete 与 partial 视图，调用者必须继续尊重 coverage 和 path revision。
	 */
	listFileViews(): readonly MemoryFileViewRecord[] {
		return [...this.fileViews.values()]
			.sort(
				(left, right) =>
					left.view.path.localeCompare(right.view.path) ||
					left.stage_sequence - right.stage_sequence ||
					left.event_sequence - right.event_sequence,
			)
			.map((item) => ({
				view: item.view,
				ref: item.ref,
				source_event_ids: [...item.source_event_ids].sort(),
				stage_sequence: item.stage_sequence,
				event_sequence: item.event_sequence,
				tool_call_ids: [...item.tool_call_ids].sort(),
			}));
	}

	/**
	 * [函数级]
	 * 目的：合并同一 coverage key 的只追加事件，得到当前累计覆盖状态。
	 * 输入/输出：无输入；返回按 coverage key 排序的覆盖视图。
	 * 约束：不修改源事件；complete 优先，否则区分已知缺口和未知缺口。
	 */
	listCoverage(): readonly MemoryCoverageView[] {
		const eventGroups = new Map<string, MemoryL2Event[]>();
		for (const event of this.l2Events.values()) {
			if (event.tool_name === "repo_read" || event.coverage_key === null || event.coverage_status === null) continue;
			const group = eventGroups.get(event.coverage_key) ?? [];
			group.push(event);
			eventGroups.set(event.coverage_key, group);
		}
		const coverage: MemoryCoverageView[] = [...eventGroups.entries()].map(([coverageKey, events]) => {
			const ordered = events.sort(
				(left, right) => left.stage_sequence - right.stage_sequence || left.event_sequence - right.event_sequence,
			);
			const completeEvent = ordered.find((event) => event.coverage_status === "complete");
			const complete = completeEvent !== undefined;
			const knownMissing = ordered.flatMap((event) => event.missing_ranges ?? []);
			return {
				coverage_key: coverageKey,
				path: null,
				repository_revision: ordered.at(-1)?.repository_revision ?? null,
				path_revision: null,
				file_sha256: null,
				coverage_type: completeEvent?.coverage_type ?? ordered.at(-1)?.coverage_type ?? null,
				coverage_status: complete ? "complete" : knownMissing.length > 0 ? "partial_known" : "partial_unknown",
				covered_ranges: mergeRanges(ordered.flatMap((event) => event.covered_ranges)),
				missing_ranges: complete ? [] : knownMissing.length > 0 ? mergeRanges(knownMissing) : null,
				source_event_ids: ordered.map((event) => event.event_id),
			};
		});

		const fileGroups = new Map<string, MemoryFileViewRecord[]>();
		for (const record of this.listFileViews()) {
			const group = fileGroups.get(record.view.coverage_key) ?? [];
			group.push(record);
			fileGroups.set(record.view.coverage_key, group);
		}
		for (const [coverageKey, records] of fileGroups) {
			const first = records[0]?.view;
			if (first === undefined) continue;
			for (const { view } of records) {
				if (
					view.path !== first.path ||
					view.path_revision !== first.path_revision ||
					view.file_sha256 !== first.file_sha256 ||
					view.total_lines !== first.total_lines
				) {
					throw new Error("repofixlab_memory_infrastructure_failure: file_coverage_identity_conflict");
				}
			}
			const coveredRanges = mergeRanges(records.flatMap(({ view }) => view.covered_ranges));
			const missingRanges = complementRanges(first.total_lines, coveredRanges);
			const hasKnownRecord = records.some(({ view }) => view.coverage_status !== "partial_unknown");
			const complete = missingRanges.length === 0 && hasKnownRecord;
			const hasUnknown = records.some(({ view }) => view.coverage_status === "partial_unknown");
			coverage.push({
				coverage_key: coverageKey,
				path: first.path,
				repository_revision: Math.max(...records.map(({ view }) => view.repository_revision)),
				path_revision: first.path_revision,
				file_sha256: first.file_sha256,
				coverage_type: complete ? "full_file" : "file_range",
				coverage_status: complete ? "complete" : hasUnknown ? "partial_unknown" : "partial_known",
				covered_ranges: coveredRanges,
				missing_ranges: complete ? [] : hasUnknown ? null : missingRanges,
				source_event_ids: [...new Set(records.flatMap((record) => record.source_event_ids))].sort(),
			});
		}
		return coverage.sort((left, right) => left.coverage_key.localeCompare(right.coverage_key));
	}

	/**
	 * [函数级]
	 * 目的：按精确输入、query 与 policy 身份复用已有 Condensation。
	 * 输入/输出：三个 SHA-256；返回缓存的摘要与引用或 undefined。
	 * 约束：只有三者全部相同才可复用，避免跨 query 或策略污染。
	 */
	findCondensation(inputSha256: string, querySha256: string, policySha256: string) {
		return this.condensations.get(`${inputSha256}:${querySha256}:${policySha256}`);
	}

	/**
	 * [函数级]
	 * 目的：保存一份滚动语义摘要，或复用同键的不可变摘要。
	 * 输入/输出：Condensation 载荷；返回带哈希制品及 artifact 引用。
	 * 约束：摘要作为 L2 派生制品追加，不删除、不覆盖其 `source_event_ids` 指向的原始事实。
	 */
	async saveCondensation(payload: MemoryCondensationPayload): Promise<{
		readonly value: MemoryCondensation;
		readonly ref: MemoryArtifactRef;
	}> {
		const key = `${payload.input_sha256}:${payload.query_sha256}:${payload.policy_sha256}`;
		const existing = this.condensations.get(key);
		if (existing !== undefined) return existing;
		const value = bindMemorySha256(payload);
		const ref = await this.writeJson(`memory/l2/condensations/${value.sha256}.json`, value, "internal");
		const stored = { value, ref };
		this.condensations.set(key, stored);
		return stored;
	}

	/**
	 * [函数级]
	 * 目的：保存一次实际 Provider 请求的完整 L0 组装审计。
	 * 输入/输出：未绑定哈希的 L0 payload；返回快照与 artifact 引用。
	 * 约束：路径由 request ID 哈希确定；该快照不能作为下一轮原始事实回流。
	 */
	async saveL0(
		payload: MemoryL0Payload,
	): Promise<{ readonly value: MemoryL0Snapshot; readonly ref: MemoryArtifactRef }> {
		const value = bindMemorySha256(payload);
		const requestKey = canonicalContractSha256(payload.request_id);
		const ref = await this.writeJson(`memory/l2/l0/${requestKey}.json`, value, "internal");
		return { value, ref };
	}

	/**
	 * [函数级]
	 * 目的：汇总本 attempt 的记忆存储成本。
	 * 输入/输出：无输入；返回耗时、字节和制品计数快照。
	 * 约束：不包含 Assembler 或 Provider 的耗时/token。
	 */
	get metrics(): RepoFixMemoryStoreMetrics {
		return {
			memory_store_ms: this.storeMs,
			l2_bytes: this.l2Bytes,
			l1_records: this.l1Records.length,
			l2_events: this.l2Events.size,
			condensation_count: this.condensations.size,
		};
	}

	/**
	 * [函数级]
	 * 目的：取得活动阶段并统一处理生命周期错误。
	 * 输入/输出：无输入；返回内部 ActiveStage。
	 * 约束：无活动阶段时立即抛错，避免把事件写入错误阶段。
	 */
	private assertActive(): ActiveStage {
		if (this.active === null) throw new Error("No RepoFix memory stage is active");
		return this.active;
	}

	/**
	 * [函数级]
	 * 目的：维护独立于 coverage key 的 path revision → full-file SHA 唯一映射。
	 * 输入/输出：规范化路径、path revision 与完整文件哈希；成功无返回。
	 * 约束：同一 path revision 观察到不同完整文件 SHA 时立即报告基础设施错误。
	 */
	private assertFileRevisionSha(path: string, pathRevision: number, fileSha256: string): void {
		const normalizedPath = path.replaceAll("\\", "/");
		const key = `${normalizedPath}\u0000${String(pathRevision)}`;
		const existing = this.fileShaByPathRevision.get(key);
		if (existing !== undefined && existing !== fileSha256) {
			throw new Error("repofixlab_memory_infrastructure_failure: file_revision_sha_conflict");
		}
		if (existing === undefined) this.fileShaByPathRevision.set(key, fileSha256);
	}

	/**
	 * [函数级]
	 * 目的：为一条消息或工具事实分配稳定顺序、绑定哈希并追加成 L2 事件。
	 * 输入/输出：除公共身份字段外的事件载荷；返回已落盘 L2 事件。
	 * 约束：`event_id=attempt:stage:sequence`，artifact 路径按阶段/事件补零；写入后才更新缓存与 L1 引用。
	 */
	private async appendEvent(
		input: Omit<
			MemoryL2EventPayload,
			| "schema_version"
			| "memory_type"
			| "task_id"
			| "attempt_id"
			| "stage_id"
			| "stage_sequence"
			| "event_id"
			| "artifact_id"
			| "event_sequence"
		>,
	): Promise<MemoryL2Event> {
		const active = this.assertActive();
		const sequence = active.next_event_sequence++;
		const eventId = `${this.attemptId}:${active.stage_id}:${String(sequence)}`;
		const artifactId = `memory/l2/stages/${String(active.stage_sequence).padStart(2, "0")}/events/${String(sequence).padStart(6, "0")}.json`;
		const payload: MemoryL2EventPayload = {
			schema_version: "v1",
			memory_type: "l2_event",
			task_id: this.taskId,
			attempt_id: this.attemptId,
			stage_id: active.stage_id,
			stage_sequence: active.stage_sequence,
			event_id: eventId,
			artifact_id: artifactId,
			event_sequence: sequence,
			...input,
		};
		const event = bindMemorySha256(payload);
		await this.writeJson(artifactId, event, "internal");
		this.l2Events.set(artifactId, event);
		active.evidence_refs.push({ artifact_id: artifactId, sha256: event.sha256 });
		return event;
	}

	/**
	 * [函数级]
	 * 目的：在 repo_read 已取得正文后派生结构目录与 chunks，并记录完整来源关系。
	 * 输入/输出：一条 L2 工具事件；需要时追加 file-view artifact，否则无操作。
	 * 约束：包括空文件和超出文件末尾的空返回；只记录 metadata 声明的实际范围，不制造未读取正文。
	 */
	private async appendReadFileView(event: MemoryL2Event, metadata: RepoReadMetadata): Promise<void> {
		if (!isRecord(event.normalized_input) || !isRecord(event.controller_result))
			throw new Error("repofixlab_memory_infrastructure_failure: invalid_repo_read_file_view");
		const path = event.normalized_input.path;
		const content = event.controller_result.stdout;
		if (typeof path !== "string" || typeof content !== "string" || event.coverage_key === null)
			throw new Error("repofixlab_memory_infrastructure_failure: invalid_repo_read_file_view");
		if (
			event.path_revision === null ||
			event.file_sha256 !== metadata.file_sha256 ||
			event.source_sha256 !== metadata.source_sha256 ||
			event.coverage_total_lines !== metadata.total_lines
		) {
			throw new Error("repofixlab_memory_infrastructure_failure: repo_read_event_metadata_drift");
		}
		const startLine = metadata.returned_range?.start_line ?? 1;
		const payload: MemoryFileViewPayload = {
			schema_version: "v1",
			memory_type: "file_view",
			path,
			repository_revision: event.repository_revision,
			path_revision: event.path_revision,
			logical_evidence_key:
				event.logical_evidence_key ?? canonicalContractSha256({ path, source_sha256: metadata.source_sha256 }),
			file_sha256: metadata.file_sha256,
			source_sha256: metadata.source_sha256,
			coverage_key: event.coverage_key,
			coverage_status: event.coverage_status ?? "partial_unknown",
			total_lines: metadata.total_lines,
			covered_ranges: event.covered_ranges,
			missing_ranges: event.missing_ranges,
			provenance_event_ids: [event.event_id],
			structure: fileStructure(path, content, startLine),
			chunks: chunkFile(path, event.path_revision, metadata.file_sha256, content, startLine, metadata.source_sha256),
		};
		await this.persistFileView(
			payload,
			event,
			[event.event_id],
			event.tool_call_id === null ? [] : [event.tool_call_id],
		);
	}

	/**
	 * [函数级]
	 * 目的：成功编辑后从旧 revision 的可信文件视图机械派生新 revision 视图。
	 * 输入/输出：编辑事件、路径、前后 path revision 及严格 edit metadata；追加完整、部分已知或部分未知视图。
	 * 约束：完整缓存优先本地精确替换；部分缓存只迁移固定一行保护带之外的 chunks；任何失败都不回退 revision。
	 */
	private async migrateFileViewsAfterEdit(
		event: MemoryL2Event,
		path: string,
		previousPathRevision: number,
		pathRevision: number,
		metadata: RepoEditMetadata,
	): Promise<void> {
		const oldRecords = [...this.fileViews.values()].filter(
			(record) => record.view.path === path && record.view.path_revision === previousPathRevision,
		);
		const eventToolCallIds = event.tool_call_id === null ? [] : [event.tool_call_id];
		if (metadata.edit_kind === "create") {
			const content = isRecord(event.normalized_input) ? event.normalized_input.content : null;
			if (
				typeof content !== "string" ||
				rawSha256(content) !== metadata.after_file_sha256 ||
				splitFileLines(content).length !== metadata.after_total_lines
			) {
				await this.persistUnknownEditView(event, path, pathRevision, metadata, [event.event_id], eventToolCallIds);
				return;
			}
			await this.persistCompleteEditView(
				event,
				path,
				pathRevision,
				metadata,
				content,
				[event.event_id],
				eventToolCallIds,
			);
			return;
		}

		const normalizedInput = isRecord(event.normalized_input) ? event.normalized_input : {};
		const oldText = normalizedInput.old_text;
		const newText = normalizedInput.new_text;
		let migrationUnknown = typeof oldText !== "string" || typeof newText !== "string";
		const compatibleRecords = oldRecords.filter(
			(record) =>
				record.view.file_sha256 === metadata.before_file_sha256 &&
				record.view.total_lines === metadata.before_total_lines,
		);
		const original = materializeFileChunks(
			compatibleRecords.flatMap((record) => record.view.chunks),
			metadata.before_total_lines,
			metadata.before_file_sha256,
		);
		if (original !== null && typeof oldText === "string" && typeof newText === "string") {
			if (original.split(oldText).length !== 2) {
				migrationUnknown = true;
			} else {
				const updated = original.replace(oldText, newText);
				if (
					rawSha256(updated) !== metadata.after_file_sha256 ||
					splitFileLines(updated).length !== metadata.after_total_lines
				) {
					migrationUnknown = true;
				} else {
					const provenance = [
						...new Set([...compatibleRecords.flatMap((record) => [...record.source_event_ids]), event.event_id]),
					].sort();
					const toolCallIds = [
						...new Set([
							...compatibleRecords.flatMap((record) => [...record.tool_call_ids]),
							...eventToolCallIds,
						]),
					].sort();
					await this.persistCompleteEditView(
						event,
						path,
						pathRevision,
						metadata,
						updated,
						provenance,
						toolCallIds,
					);
					return;
				}
			}
		} else if (
			compatibleRecords.some((record) => record.view.coverage_status === "complete") ||
			complementRanges(
				metadata.before_total_lines,
				mergeRanges(compatibleRecords.flatMap((record) => record.view.covered_ranges)),
			).length === 0
		) {
			migrationUnknown = true;
		}

		const migratedByIdentity = new Map<string, MemoryFileChunk>();
		const provenance = new Set<string>([event.event_id]);
		const toolCallIds = new Set(eventToolCallIds);
		const invalidStartLine = Math.max(1, metadata.before_range.start_line - 1);
		const invalidEndLineExclusive = Math.min(
			metadata.before_total_lines + 1,
			metadata.before_range.end_line_exclusive + 1,
		);
		for (const record of oldRecords) {
			if (
				record.view.file_sha256 !== metadata.before_file_sha256 ||
				record.view.total_lines !== metadata.before_total_lines
			) {
				migrationUnknown = true;
				continue;
			}
			for (const sourceEventId of record.source_event_ids) provenance.add(sourceEventId);
			for (const toolCallId of record.tool_call_ids) toolCallIds.add(toolCallId);
			for (const chunk of record.view.chunks) {
				if (
					chunk.path !== path ||
					chunk.path_revision !== previousPathRevision ||
					chunk.file_sha256 !== metadata.before_file_sha256 ||
					rawSha256(chunk.content) !== chunk.content_sha256 ||
					splitFileLines(chunk.content).length !== chunk.end_line - chunk.start_line + 1
				) {
					migrationUnknown = true;
					continue;
				}
				if (chunk.end_line >= invalidStartLine && chunk.start_line < invalidEndLineExclusive) continue;
				const shift = chunk.start_line >= invalidEndLineExclusive ? metadata.line_delta : 0;
				const migrated = migrateChunk(chunk, pathRevision, metadata.after_file_sha256, shift);
				if (migrated.start_line < 1 || migrated.end_line > metadata.after_total_lines) {
					migrationUnknown = true;
					continue;
				}
				migratedByIdentity.set(
					`${String(migrated.start_line)}:${String(migrated.end_line)}:${migrated.content_sha256}`,
					migrated,
				);
			}
		}
		const chunks = [...migratedByIdentity.values()].sort(
			(left, right) => left.start_line - right.start_line || left.end_line - right.end_line,
		);
		const coveredRanges = mergeRanges(
			chunks.map((chunk) => ({ start_line: chunk.start_line, end_line: chunk.end_line })),
		);
		const payload: MemoryFileViewPayload = {
			schema_version: "v1",
			memory_type: "file_view",
			path,
			repository_revision: event.repository_revision,
			path_revision: pathRevision,
			logical_evidence_key: canonicalContractSha256({
				kind: "partial_edit_migration",
				path,
				path_revision: pathRevision,
				file_sha256: metadata.after_file_sha256,
				covered_ranges: coveredRanges,
			}),
			file_sha256: metadata.after_file_sha256,
			source_sha256: null,
			coverage_key: fileCoverageKey(path, pathRevision, metadata.after_file_sha256),
			coverage_status: migrationUnknown ? "partial_unknown" : "partial_known",
			total_lines: metadata.after_total_lines,
			covered_ranges: coveredRanges,
			missing_ranges: migrationUnknown ? null : complementRanges(metadata.after_total_lines, coveredRanges),
			provenance_event_ids: [...provenance].sort(),
			structure: [],
			chunks,
		};
		await this.persistFileView(payload, event, payload.provenance_event_ids, [...toolCallIds].sort());
	}

	/**
	 * [函数级]
	 * 目的：保存由确定性编辑输入重建的完整新版本文件视图。
	 * 输入/输出：编辑事件、版本、元数据、完整正文和来源；追加 complete file view。
	 * 约束：调用前必须完成正文行数与完整文件 SHA 校验。
	 */
	private async persistCompleteEditView(
		event: MemoryL2Event,
		path: string,
		pathRevision: number,
		metadata: RepoEditMetadata,
		content: string,
		provenanceEventIds: readonly string[],
		toolCallIds: readonly string[],
	): Promise<void> {
		const coveredRanges: readonly MemoryLineRange[] =
			metadata.after_total_lines === 0 ? [] : [{ start_line: 1, end_line: metadata.after_total_lines }];
		const payload: MemoryFileViewPayload = {
			schema_version: "v1",
			memory_type: "file_view",
			path,
			repository_revision: event.repository_revision,
			path_revision: pathRevision,
			logical_evidence_key: canonicalContractSha256({
				kind: "complete_edit_rebuild",
				path,
				path_revision: pathRevision,
				file_sha256: metadata.after_file_sha256,
			}),
			file_sha256: metadata.after_file_sha256,
			source_sha256: null,
			coverage_key: fileCoverageKey(path, pathRevision, metadata.after_file_sha256),
			coverage_status: "complete",
			total_lines: metadata.after_total_lines,
			covered_ranges: coveredRanges,
			missing_ranges: [],
			provenance_event_ids: provenanceEventIds,
			structure: fileStructure(path, content, 1),
			chunks: chunkFile(path, pathRevision, metadata.after_file_sha256, content, 1, null),
		};
		await this.persistFileView(payload, event, provenanceEventIds, toolCallIds);
	}

	/**
	 * [函数级]
	 * 目的：在编辑后内容无法验证时保存新版本的未知覆盖标记。
	 * 输入/输出：编辑事件、版本、元数据和来源；追加 partial_unknown file view。
	 * 约束：保持已推进的 revision，不复用或恢复旧版本 Coverage。
	 */
	private async persistUnknownEditView(
		event: MemoryL2Event,
		path: string,
		pathRevision: number,
		metadata: RepoEditMetadata,
		provenanceEventIds: readonly string[],
		toolCallIds: readonly string[],
	): Promise<void> {
		const payload: MemoryFileViewPayload = {
			schema_version: "v1",
			memory_type: "file_view",
			path,
			repository_revision: event.repository_revision,
			path_revision: pathRevision,
			logical_evidence_key: canonicalContractSha256({
				kind: "unknown_edit_migration",
				path,
				path_revision: pathRevision,
				file_sha256: metadata.after_file_sha256,
			}),
			file_sha256: metadata.after_file_sha256,
			source_sha256: null,
			coverage_key: fileCoverageKey(path, pathRevision, metadata.after_file_sha256),
			coverage_status: "partial_unknown",
			total_lines: metadata.after_total_lines,
			covered_ranges: [],
			missing_ranges: null,
			provenance_event_ids: provenanceEventIds,
			structure: [],
			chunks: [],
		};
		await this.persistFileView(payload, event, provenanceEventIds, toolCallIds);
	}

	/**
	 * [函数级]
	 * 目的：追加不可变 file-view artifact，并维护全部等价来源关系。
	 * 输入/输出：视图载荷、来源事件和工具调用 ID；写入或复用已有 artifact。
	 * 约束：相同 artifact 正文只落盘一次，但所有来源引用都必须保留。
	 */
	private async persistFileView(
		payload: MemoryFileViewPayload,
		event: MemoryL2Event,
		sourceEventIds: readonly string[],
		toolCallIds: readonly string[],
	): Promise<void> {
		const view = bindMemorySha256(payload);
		const artifactId = `memory/l2/files/${view.sha256}.json`;
		const existing = this.fileViews.get(artifactId);
		if (existing !== undefined) {
			for (const toolCallId of toolCallIds) existing.tool_call_ids.add(toolCallId);
			for (const sourceEventId of sourceEventIds) existing.source_event_ids.add(sourceEventId);
			this.assertActive().evidence_refs.push(existing.ref);
			return;
		}
		const ref = await this.writeJson(artifactId, view, "internal");
		this.fileViews.set(artifactId, {
			view,
			ref,
			source_event_ids: new Set(sourceEventIds),
			stage_sequence: event.stage_sequence,
			event_sequence: event.event_sequence,
			tool_call_ids: new Set(toolCallIds),
		});
		this.assertActive().evidence_refs.push(ref);
	}

	/**
	 * [函数级]
	 * 目的：通过 ArtifactStore 以稳定 JSON 写入任一记忆制品，并累计本地指标。
	 * 输入/输出：artifact 路径、值和敏感级别；返回路径与内容哈希引用。
	 * 约束：生成者固定为 orchestrator；L2 路径计入 `l2_bytes`；优先返回契约绑定的对象哈希。
	 */
	private async writeJson(
		path: string,
		value: unknown,
		sensitivity: "internal" | "private" | "public",
	): Promise<MemoryArtifactRef> {
		const started = performance.now();
		const artifact = await this.artifactStore.writeNew(path, stableStringify(value), {
			mediaType: "application/json",
			sensitivity,
			generatedBy: "orchestrator",
		});
		this.storeMs += performance.now() - started;
		if (path.startsWith("memory/l2/")) this.l2Bytes += artifact.bytes;
		return {
			artifact_id: artifact.path,
			sha256: isRecord(value) && typeof value.sha256 === "string" ? value.sha256 : artifact.sha256,
		};
	}
}

/**
 * [函数级]
 * 目的：解析并验证从进程外 artifact 读取的哈希绑定记忆记录。
 * 输入/输出：JSON 字符串；返回已通过 canonical SHA-256 校验的对象。
 * 约束：拒绝非对象、无 sha256 或内容哈希不一致的记录。
 */
export function parseMemoryRecord(content: string): object & { readonly sha256: string } {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value) || typeof value.sha256 !== "string") throw new Error("Memory artifact is not hash-bound JSON");
	verifyMemorySha256(value as object & { readonly sha256: string });
	return value as object & { readonly sha256: string };
}
