/**
 * [脚本级]
 *
 * 定位：定义 RepoFixLab 四层记忆中可持久化制品、L0 审计快照和组装策略的稳定契约。
 * 负责：约束 L1 完整阶段交接、L2 只追加事件、压缩派生制品、受保护索引、阶段活动视图及确定性哈希。
 * 不负责：保存制品、检索证据、调用压缩模型、切换 RepoFix 阶段或决定 Agent 下一步动作。
 * 数据流：执行结果先成为 L2；阶段完成后形成 L1；Assembler 由 L1/L2 派生 L0，并把 L0 与 Condensation 审计回 L2。
 * 不变量：原始 L1/L2 不因压缩而改写；所有落盘契约均以不含自身 sha256 的 canonical JSON 绑定哈希。
 */
import { canonicalContractSha256 } from "./run-contracts.ts";

/**
 * [类别级]
 *
 * 定位：标识基线历史上下文与四层记忆两种实验策略。
 * 表示：`legacy-context-v1` 不启用分层组装；`layered-memory-v1` 使用本文定义的 L0/L1/L2 设计。
 * 不变量：策略 ID 进入实验与审计记录，不由运行时隐式改写。
 */
export type RepoFixMemoryPolicyId = "legacy-context-v1" | "layered-memory-v1";

/**
 * [类别级]
 *
 * 定位：描述 L2 已取得证据的累计覆盖程度。
 * 表示：完整覆盖、已知缺口的部分覆盖，或缺口边界未知的部分覆盖。
 * 不变量：它只陈述 Controller 已返回的范围，不能把未返回内容推定为已知。
 */
export type MemoryCoverageStatus = "complete" | "partial_known" | "partial_unknown";

/**
 * [类别级]
 *
 * 定位：从一个记忆制品指向另一个不可变制品的可追溯引用。
 * 表示：稳定 artifact 路径及该制品的 canonical SHA-256。
 * 不变量：读取引用时必须同时核对路径和哈希，禁止仅凭路径信任内容。
 */
export interface MemoryArtifactRef {
	readonly artifact_id: string;
	readonly sha256: string;
}

/**
 * [类别级]
 *
 * 定位：记录文件证据已经覆盖的闭区间。
 * 表示：一段从 `start_line` 到 `end_line` 的一基行号范围。
 * 不变量：范围来自已执行读取，不表示文件其他区间已被取得。
 */
export interface MemoryLineRange {
	readonly start_line: number;
	readonly end_line: number;
}

/**
 * [类别级]
 *
 * 定位：L2 任务长期记忆的原子事件，是本任务完整证据链的事实来源。
 * 表示：按阶段和事件序号记录消息或完整 Controller 工具返回，并携带 revision、覆盖范围和逻辑证据键。
 * 不变量：事件只追加、不覆盖；`event_id`、`artifact_id` 与顺序稳定；截断结果必须显式保留不完整状态。
 */
export interface MemoryL2EventPayload {
	readonly schema_version: "v1";
	readonly memory_type: "l2_event";
	readonly task_id: string;
	readonly attempt_id: string;
	readonly stage_id: string;
	readonly stage_sequence: number;
	readonly event_id: string;
	readonly artifact_id: string;
	readonly event_sequence: number;
	/** 字段约束：记录该事件已执行工具效果之后的仓库 revision。 */
	readonly repository_revision: number;
	/** 字段约束：存在显式目标路径时，记录该路径在事件后的 revision。 */
	readonly path_revision: number | null;
	/** 字段约束：仅用于 L0 合并当前版本等价证据，不改变 L2 原始事件身份。 */
	readonly logical_evidence_key: string | null;
	/** 字段约束：存在结构化文件元数据时，绑定该 path revision 的完整文件正文。 */
	readonly file_sha256: string | null;
	/** 字段约束：仅 repo_read 使用，绑定经过 Controller 完整行限制后实际返回的 stdout。 */
	readonly source_sha256: string | null;
	/** 字段约束：仅文件 Coverage 使用；空文件为 0，其他工具为 null。 */
	readonly coverage_total_lines: number | null;
	readonly event_kind: "message" | "tool_evidence";
	readonly tool_call_id: string | null;
	readonly tool_name: string | null;
	readonly normalized_input: unknown;
	readonly message: unknown;
	readonly controller_result: unknown;
	readonly coverage_key: string | null;
	readonly coverage_type: "full_file" | "full_result_set" | "file_range" | "result_page" | null;
	readonly coverage_status: MemoryCoverageStatus | null;
	readonly covered_ranges: readonly MemoryLineRange[];
	readonly missing_ranges: readonly MemoryLineRange[] | null;
	readonly controller_truncated: boolean | null;
	readonly controller_result_bytes: number | null;
}

/**
 * [类别级]
 *
 * 定位：可落盘、可校验的 L2 事件。
 * 表示：`MemoryL2EventPayload` 与其 canonical SHA-256。
 * 不变量：压缩、合并和版本失效都不能改写该原始事件。
 */
export type MemoryL2Event = MemoryL2EventPayload & { readonly sha256: string };

/**
 * [类别级]
 *
 * 定位：L1 阶段交接记忆的未绑定哈希载荷。
 * 表示：一个已完成阶段的完整 schema handoff，以及该阶段全部 L2 证据引用。
 * 不变量：每阶段只追加一份；集合成员不得 top-N、字符串截断或二次摘要。
 */
export interface MemoryL1Payload {
	readonly schema_version: "v1";
	readonly memory_type: "l1_handoff";
	readonly task_id: string;
	readonly attempt_id: string;
	readonly stage_id: string;
	readonly stage_sequence: number;
	readonly handoff: unknown;
	readonly evidence_refs: readonly MemoryArtifactRef[];
}

/**
 * [类别级]
 *
 * 定位：可落盘、可校验的 L1 阶段交接。
 * 表示：完整 L1 载荷与 canonical SHA-256。
 * 不变量：L1 保存交接结构，不复制整段对话和工具正文；正文仍由 L2 持有。
 */
export type MemoryL1Record = MemoryL1Payload & { readonly sha256: string };

/**
 * [类别级]
 *
 * 定位：受保护索引中的一个机械复制值。
 * 表示：L1 集合成员、证据引用、coverage 或 chunk 元数据及其来源位置。
 * 不变量：该值不进入模型语义压缩，因此候选数量和成员身份不会因摘要丢失。
 */
export interface MemoryProtectedEntry {
	readonly source_event_id: string;
	readonly pointer: string;
	readonly ordinal: number;
	readonly value: unknown;
	readonly source_sha256: string;
}

/**
 * [类别级]
 *
 * 定位：每个分层 L0 视图都携带的确定性结构索引。
 * 表示：按来源、JSON Pointer 和序号排序的受保护成员全集。
 * 不变量：相同输入产生相同顺序和哈希；压缩前后的成员数量必须保持不变。
 */
export interface MemoryProtectedIndex {
	readonly entries: readonly MemoryProtectedEntry[];
	readonly source_count: number;
	readonly sha256: string;
}

/**
 * [类别级]
 *
 * 定位：对自由文本视图执行滚动语义压缩后形成的 L2 派生制品载荷。
 * 表示：上一版 summary（如有）与本轮新增 delta 的摘要、完整来源集合及 query/input/policy 哈希。
 * 不变量：它只替代 L0 中的自由文本表示，不替代或删除任何 L1/L2 原始内容。
 */
export interface MemoryCondensationPayload {
	readonly schema_version: "v1";
	readonly memory_type: "condensation";
	readonly summary: string;
	readonly previous_condensation_ref: MemoryArtifactRef | null;
	readonly source_event_ids: readonly string[];
	readonly delta_source_event_ids: readonly string[];
	readonly query_sha256: string;
	readonly input_sha256: string;
	readonly policy_sha256: string;
}

/**
 * [类别级]
 *
 * 定位：可复用、可审计的语义压缩结果。
 * 表示：Condensation 载荷与 canonical SHA-256。
 * 不变量：同一 input/query/policy 组合只生成一次，后续直接复用不可变制品。
 */
export type MemoryCondensation = MemoryCondensationPayload & { readonly sha256: string };

/**
 * [类别级]
 *
 * 定位：L0 顶部稳定呈现的当前阶段活动事实视图。
 * 表示：仓库 revision、最近成功编辑、最新 diff 和未来可接入的验证引用。
 * 不变量：只投影已经发生的事件；不包含 ready、done、next_stage 或任何动作许可。
 */
export interface MemoryStageActivityView {
	readonly stage_id: string;
	readonly repository_revision: number;
	readonly latest_successful_edit: {
		readonly path: string;
		readonly event_id: string;
		readonly artifact_id: string;
		readonly sha256: string;
	} | null;
	readonly latest_diff: {
		readonly repository_revision: number;
		readonly event_id: string;
		readonly artifact_id: string;
		readonly result_sha256: string;
	} | null;
	/** 字段约束：验证高密度视图尚未实现，当前固定为 null；完整验证 stdout/stderr 仍只保存在 L2。 */
	readonly latest_verification_ref: MemoryArtifactRef | null;
}

/**
 * [类别级]
 *
 * 定位：一次 Provider 请求实际使用的 L0 工作记忆审计快照。
 * 表示：checkpoint/delta 类型、活动视图、受保护索引、来源、压缩引用、token 估算及最终上下文哈希。
 * 不变量：快照只用于追溯，不反向成为下一轮原始事实；下一轮仍从 L1/L2 和阶段状态重新派生。
 */
export interface MemoryL0Payload {
	readonly schema_version: "v1";
	readonly memory_type: "l0_snapshot";
	readonly request_id: string;
	readonly task_id: string;
	readonly attempt_id: string;
	readonly stage_id: string;
	readonly view_kind: "checkpoint" | "delta";
	readonly repository_revision: number;
	readonly active_evidence_count: number;
	readonly stable_prefix_message_count: number;
	readonly activity: MemoryStageActivityView;
	readonly protected_index: MemoryProtectedIndex;
	readonly source_event_ids: readonly string[];
	readonly condensation_ref: MemoryArtifactRef | null;
	/** 字段约束：记录本请求执行可选压缩之前的增量 L0 哈希。 */
	readonly uncompressed_context_sha256: string;
	readonly assembled_context_sha256: string;
	readonly uncompressed_context_tokens: number;
	readonly assembled_context_tokens: number;
	readonly loaded_chunks: readonly string[];
	readonly unloaded_ranges: readonly string[];
	readonly policy_sha256: string;
}

/**
 * [类别级]
 *
 * 定位：可落盘、可校验的 L0 审计制品。
 * 表示：一次完整 L0 快照及其 canonical SHA-256。
 * 不变量：L0 是 Provider Context 的消息历史视图，不包含 system prompt 和工具定义，因而不等于完整上下文。
 */
export type MemoryL0Snapshot = MemoryL0Payload & { readonly sha256: string };

/**
 * [类别级]
 *
 * 定位：冻结分层组装、token 估算、大文件分块和压缩阈值的确定性策略。
 * 表示：131072 窗口、16384 输出预留、70% 触发、50% 目标、head=4、summary/chunk 上限及估算器参数。
 * 不变量：策略和模型规格共同进入哈希；相同来源、query、策略和已有 Condensation 必须得到相同组装结果。
 */
export interface LayeredMemoryPolicy {
	readonly policy_id: "layered-memory-v1";
	readonly context_window: number;
	readonly agent_max_output_tokens: number;
	readonly trigger_percent: 70;
	readonly target_percent: 50;
	readonly head_event_count: 4;
	readonly summary_max_tokens: 4096;
	readonly chunk_max_tokens: 4096;
	readonly chunk_overlap_tokens: 256;
	readonly estimator: {
		readonly version: string;
		readonly multiplier: number;
		readonly framing_margin_tokens: number;
	};
	readonly model_spec_sha256: string;
}

/**
 * [函数级]
 *
 * 目的：创建并冻结当前实现使用的 `layered-memory-v1` 组装与压缩策略。
 * 输入：已校验的小写模型规格 SHA-256，用于把策略绑定到具体 Provider 模型配置。
 * 输出：包含固定窗口、阈值、head、chunk、summary 和 token 估算参数的不可变策略。
 * 约束：不接受非 64 位小写十六进制哈希；运行期间不得动态调节策略字段。
 */
export function createLayeredMemoryPolicy(modelSpecSha256: string): LayeredMemoryPolicy {
	if (!/^[0-9a-f]{64}$/.test(modelSpecSha256)) throw new Error("Memory policy requires a lowercase model SHA-256");
	return {
		policy_id: "layered-memory-v1",
		context_window: 131_072,
		agent_max_output_tokens: 16_384,
		trigger_percent: 70,
		target_percent: 50,
		head_event_count: 4,
		summary_max_tokens: 4096,
		chunk_max_tokens: 4096,
		chunk_overlap_tokens: 256,
		estimator: { version: "m4-dev-v1", multiplier: 1.25, framing_margin_tokens: 512 },
		model_spec_sha256: modelSpecSha256,
	};
}

/**
 * [函数级]
 *
 * 目的：为一个记忆载荷绑定 canonical SHA-256。
 * 输入：尚不含外层 `sha256` 的可序列化对象。
 * 输出：原载荷字段与根据该载荷计算出的只读哈希。
 * 约束：哈希输入绝不包含哈希字段自身，保证写入与复算规则一致。
 */
export function bindMemorySha256<T extends object>(payload: T): T & { readonly sha256: string } {
	return { ...payload, sha256: canonicalContractSha256(payload) };
}

/**
 * [函数级]
 *
 * 目的：验证外部读取的记忆制品没有被修改或错误引用。
 * 输入：带外层 `sha256` 的对象。
 * 输出：校验成功时无返回值；失败时抛出确定性错误。
 * 约束：复算前必须移除外层哈希，使用与写入完全相同的 canonical JSON 规则。
 */
export function verifyMemorySha256(value: object & { readonly sha256: string }): void {
	const { sha256, ...payload } = value;
	if (sha256 !== canonicalContractSha256(payload)) throw new Error("Memory artifact canonical SHA-256 is invalid");
}
