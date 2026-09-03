/**
 * [脚本级]
 *
 * 定位：实现 Context Assembler，把持久化 L1/L2 与当前阶段新增消息组装成一次请求使用的 L0，再形成完整 Provider Context。
 * 负责：确定性召回、protected index、ActiveEvidence 去重与 revision 失效、大文件 chunk 选择、工作集连续性、checkpoint/delta 和滚动压缩。
 * 不负责：保存 L3、执行仓库工具、选择/切换阶段、判断补丁完成、循环检测，或根据 activity 决定 Agent 动作。
 * 数据流：L1/L2 + 冻结阶段 query + 当前消息 → 高密度 L0 messages；systemPrompt + tools + L0 才是完整 Provider Context；L0 审计回写 L2。
 * 交接：IMPLEMENT 以 PLAN 的修改步骤和 code_scope 选择 L2 代码片段，使决策与可执行 old_text 同时进入首轮上下文。
 * 压缩：只压缩进入 L0 的自由文本，protected index 与 L1/L2 原文不压缩；达到 70% 触发，目标 50%，滚动输入为上一摘要加新增 delta。
 * 缓存：阶段首轮或 revision/压缩变化建立 checkpoint；普通轮次只追加 delta，使前一轮 messages 成为后一轮严格前缀。
 * 完整性：source key 必须由 head、原文 delta、协议 tail 或 Condensation 覆盖；query 只能追加工作集，不能重新筛掉已进入 L0 的有效来源。
 * 当前缺口：尚无 confirmed_findings 稳定视图；目标字段为显式 finding、L2 evidence refs、repository/path revisions 和 source SHA-256。
 * 验证缺口：尚未把完整 L2 stdout/stderr 投影为“命令、退出/超时、通过/失败数、首批不重复错误、artifact 引用”的高密度视图。
 * 能力边界：现有实现去除证据/token 重复，但不能消除语义重复思考，也不会据此让 Agent 停止或切换阶段。
 */
import type { Context, Message } from "@earendil-works/pi-ai/compat";
import type { RepoFixStage } from "../agent/repofix-config.ts";
import type { StageCompletion } from "../agent/repofix-fsm.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type {
	LayeredMemoryPolicy,
	MemoryArtifactRef,
	MemoryCondensationPayload,
	MemoryL0Payload,
	MemoryL2Event,
	MemoryProtectedEntry,
	MemoryProtectedIndex,
	MemoryStageActivityView,
} from "../contracts/memory.ts";
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import type {
	MemoryActiveEvidenceRecord,
	MemoryFileViewRecord,
	MemoryToolEvidenceInput,
	RepoFixMemoryStore,
	RepoFixMemoryStoreMetrics,
} from "./store.ts";

export const MEMORY_INFRASTRUCTURE_ERROR = "repofixlab_memory_infrastructure_failure";

/**
 * [类别级]
 *
 * 定位：允许一次请求安全回退、但不永久污染整个 memory runtime 的容量错误集合。
 * 表示：受保护内容、压缩输入/目标或最终上下文超出固定预算。
 * 不变量：集合外错误被视为持久基础设施故障；Condenser 失败本身仅在无法安全回退时升级。
 */
const REQUEST_SCOPED_MEMORY_CAPACITY_ERRORS = new Set([
	`${MEMORY_INFRASTRUCTURE_ERROR}: protected_context_exceeds_budget`,
	`${MEMORY_INFRASTRUCTURE_ERROR}: condenser_input_exceeds_window`,
	`${MEMORY_INFRASTRUCTURE_ERROR}: compression_target_not_met`,
	`${MEMORY_INFRASTRUCTURE_ERROR}: assembled_context_exceeds_window`,
]);

/**
 * [函数级]
 * 目的：区分请求级容量失败与应锁死 runtime 的持久故障。
 * 输入/输出：任意异常；仅固定容量错误消息返回 true。
 * 约束：按确定性错误码判断，不使用模糊字符串匹配。
 */
function isRequestScopedMemoryCapacityError(error: unknown): boolean {
	return error instanceof Error && REQUEST_SCOPED_MEMORY_CAPACITY_ERRORS.has(error.message);
}

/**
 * [类别级]
 *
 * 定位：确定性 head/tail 选择后交给独立 Condenser 的精确请求。
 * 表示：无工具的摘要 Context、当前阶段和本次允许的最大摘要 token。
 * 不变量：Condenser 不接触 Agent session history，也不改变阶段轮次。
 */
export interface MemoryCondenserRequest {
	readonly context: Context;
	readonly stage_id: RepoFixStage;
	readonly summary_max_tokens: number;
}

/**
 * [类别级]
 *
 * 定位：记忆系统唯一允许的模型压缩端口。
 * 表示：输入冻结请求并返回纯 summary 文本的异步回调。
 * 不变量：实现必须禁止工具调用；其 token 和耗时计入 run，但不计入 Agent 阶段 turn。
 */
export type MemoryCondenser = (request: MemoryCondenserRequest) => Promise<string>;

/**
 * [类别级]
 *
 * 定位：Assembler 本地组装与压缩等待的开销指标。
 * 表示：组装、token 估算、Condenser 等待耗时和触发次数。
 * 不变量：与 Store 指标分开采集，最终只在汇总类型中合并。
 */
export interface RepoFixMemoryAssemblerMetrics {
	readonly memory_assemble_ms: number;
	readonly token_count_ms: number;
	readonly condenser_wait_ms: number;
	readonly compression_trigger_count: number;
}

/**
 * [类别级]
 *
 * 定位：M4 attempt 持久化的完整记忆开销视图。
 * 表示：Store 和 Assembler 两组互不重复的指标合集。
 * 不变量：Provider token 使用由既有 run 指标统计，不在此重复计数。
 */
export type RepoFixMemoryMetrics = RepoFixMemoryStoreMetrics & RepoFixMemoryAssemblerMetrics;

/**
 * [类别级]
 *
 * 定位：进入 L0 自由文本或 Condenser 的最小可追溯来源单元。
 * 表示：稳定来源 ID、来源哈希和可压缩文本。
 * 不变量：`source_event_id:source_sha256` 构成覆盖校验键，摘要不能自行声明不存在的来源。
 */
type SourceUnit = {
	readonly source_event_id: string;
	readonly source_sha256: string;
	readonly text: string;
};

/**
 * [类别级]
 *
 * 定位：当前阶段已成功生成的滚动 Condensation 状态。
 * 表示：摘要制品引用、摘要正文、累计覆盖 source keys 和来源事件集合。
 * 不变量：后续压缩输入只使用该 summary 加新增 delta；revision 改变时清空。
 */
type RollingCondensationState = {
	readonly stage_id: RepoFixStage;
	readonly ref: MemoryArtifactRef;
	readonly summary: string;
	readonly covered_source_keys: ReadonlySet<string>;
	readonly source_event_ids: readonly string[];
};

/**
 * [类别级]
 *
 * 定位：Assembler 处理一次 Agent Provider 请求所需的边界输入。
 * 表示：请求/阶段身份、完整基础 Context 和当前阶段消息切片。
 * 不变量：第一条当前阶段消息必须是 user；阶段身份由执行层提供。
 */
type AssemblyInput = {
	readonly request_id: string;
	readonly stage_id: RepoFixStage;
	readonly context: Context;
	readonly current_stage_messages: readonly Message[];
};

/**
 * [类别级]
 *
 * 定位：上一次实际发送给 Provider 的缓存友好 L0 物化状态。
 * 表示：已发送 messages、消息计数、revision、已表示来源/保护成员/证据正文和 activity 哈希。
 * 不变量：revision 不变时下一轮只能在该 messages 后追加；不把该状态当作 L1/L2 事实来源。
 */
type ProviderViewState = {
	readonly messages: readonly Message[];
	readonly stage_message_count: number;
	readonly repository_revision: number;
	readonly represented_source_keys: ReadonlySet<string>;
	readonly represented_protected_keys: ReadonlySet<string>;
	readonly evidence_body_keys: ReadonlySet<string>;
	readonly activity_sha256: string;
};

/**
 * [函数级]
 * 目的：把不同角色的 Provider Message 投影为可检索、可压缩的文本。
 * 输入/输出：一条 user/assistant/toolResult 消息；按原内容顺序连接的文本。
 * 约束：assistant thinking 可进入自由文本压缩；tool call 同时保留名称和规范化参数。
 */
function messageText(message: Message): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((item) => {
				if (item.type === "text") return item.text;
				if (item.type === "thinking") return item.thinking;
				return `tool_call ${item.name} ${stableStringify(item.arguments).trim()}`;
			})
			.join("\n");
	}
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

/**
 * [函数级]
 * 目的：把未知值安全收窄为普通 JSON 对象。
 * 输入/输出：任意值；排除 null 和数组后的类型谓词。
 * 约束：仅做外形判断，不保证具体字段有效。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * [函数级]
 * 目的：生成适合哈希和快照的纯 JSON 副本。
 * 输入/输出：任意值；JSON 往返结果或 null。
 * 约束：剔除原型与不可序列化数据，使 assembled context 哈希稳定。
 */
function jsonSerializable(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? null : JSON.parse(serialized);
}

/**
 * [函数级]
 * 目的：只从结构化输入识别可信的仓库路径选择器。
 * 输入/输出：未知值；明确、非仓库根路径或 null。
 * 约束：拒绝空路径、`.`、根目录和明显不是路径的单词，避免 query 误命中。
 */
function explicitRepositoryPath(value: unknown): string | null {
	if (!isRecord(value) || typeof value.path !== "string") return null;
	const path = value.path.trim();
	if (path === "" || path === "." || path === "./" || path === "/") return null;
	if (!path.includes("/") && !path.includes("\\") && !/(?:^|\.)[^.\s]+$/.test(path)) return null;
	return path;
}

/**
 * [函数级]
 * 目的：判断冻结 query 或最新 assistant 是否明确提到某仓库路径。
 * 输入/输出：选择器文本与路径；布尔命中结果。
 * 约束：同时支持原分隔符与正斜杠形式，不进行语义猜测或模糊搜索。
 */
function explicitlyReferencesPath(selectorText: string, path: string): boolean {
	const explicit = explicitRepositoryPath({ path });
	if (explicit === null) return false;
	return selectorText.includes(explicit) || selectorText.includes(explicit.replaceAll("\\", "/"));
}

/**
 * [函数级]
 * 目的：判断选择器是否通过 artifact ID 或显式路径指向一条 L2 事件。
 * 输入/输出：选择器、artifact 引用和事件；布尔命中结果。
 * 约束：只接受可追溯的显式引用，不按内容相似度自动召回。
 */
function explicitlyReferencesEvent(
	selectorText: string,
	artifactRef: MemoryArtifactRef,
	event: MemoryL2Event,
): boolean {
	if (selectorText.includes(artifactRef.artifact_id)) return true;
	const path = explicitRepositoryPath(event.normalized_input);
	return path !== null && explicitlyReferencesPath(selectorText, path);
}

/**
 * [函数级]
 * 目的：从当前请求或 PLAN 修改范围中提取显式代码行，供 L2 chunk 精确召回。
 * 输入/输出：分离的选择文本、当前路径及已知路径；去重排序的一基闭区间集合。
 * 约束：每个路径的解析止于下一已知路径，仅接受 `#Lx-Ly`、`:x-y` 或 `[~]lines x-y`。
 */
function requestedLineRanges(
	selectorTexts: readonly string[],
	path: string,
	knownPaths: readonly string[],
): readonly { readonly start: number; readonly end: number }[] {
	const normalizedPath = path.replaceAll("\\", "/");
	const normalizedKnownPaths = knownPaths.map((item) => item.replaceAll("\\", "/"));
	const ranges = new Map<string, { readonly start: number; readonly end: number }>();
	for (const selectorText of selectorTexts) {
		const normalizedText = selectorText.replaceAll("\\", "/");
		let pathIndex = normalizedText.indexOf(normalizedPath);
		while (pathIndex >= 0) {
			const scopeStart = pathIndex + normalizedPath.length;
			let scopeEnd = normalizedText.length;
			for (const knownPath of normalizedKnownPaths) {
				const nextPathIndex = normalizedText.indexOf(knownPath, scopeStart);
				if (nextPathIndex >= 0) scopeEnd = Math.min(scopeEnd, nextPathIndex);
			}
			const scope = normalizedText.slice(scopeStart, scopeEnd);
			const patterns = [/^\s*(?:#L|:)\s*(\d+)(?:\s*[-:]\s*L?(\d+))?/g, /~?lines?\s+(\d+)(?:\s*[-:]\s*L?(\d+))?/gi];
			for (const pattern of patterns) {
				for (const match of scope.matchAll(pattern)) {
					const start = Number(match[1]);
					const end = match[2] === undefined ? start : Number(match[2]);
					if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start) {
						ranges.set(`${String(start)}:${String(end)}`, { start, end });
					}
				}
			}
			pathIndex = normalizedText.indexOf(normalizedPath, scopeStart);
		}
	}
	return [...ranges.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}

/**
 * [函数级]
 * 目的：提取 PLAN 已决定修改位置的最小选择文本，供 IMPLEMENT 从 L2 装入可直接编辑的代码片段。
 * 输入/输出：完整 PLAN handoff；仅返回 minimal_change_steps 与 obligation code_scope 中的字符串。
 * 约束：不把风险、排除项或一般调查证据扩成 IMPLEMENT 工作集，也不改变原始 L1。
 */
function planExecutableSelectors(handoff: unknown): readonly string[] {
	if (!isRecord(handoff) || handoff.stage !== "PLAN") return [];
	const minimalSteps = Array.isArray(handoff.minimal_change_steps)
		? handoff.minimal_change_steps.filter((item): item is string => typeof item === "string")
		: [];
	const obligationScopes = Array.isArray(handoff.obligations)
		? handoff.obligations.flatMap((item) =>
				isRecord(item) && typeof item.code_scope === "string" ? [item.code_scope] : [],
			)
		: [];
	return [...minimalSteps, ...obligationScopes];
}

/**
 * [函数级]
 * 目的：按 JSON Pointer 规则转义 protected index 的对象键。
 * 输入/输出：原始键；转义 `~` 和 `/` 后的片段。
 * 约束：保证结构成员位置可稳定寻址。
 */
function escapePointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * [函数级]
 * 目的：递归提取 L1 handoff 中所有数组成员，形成不经过模型压缩的 protected entries。
 * 输入/输出：结构值、指针和来源身份；向目标数组追加成员。
 * 约束：数组逐项保留 ordinal；对象键稳定排序；因此 8 个候选始终保持 8/8。
 */
function collectProtectedArrays(
	value: unknown,
	basePointer: string,
	sourceEventId: string,
	sourceSha256: string,
	entries: MemoryProtectedEntry[],
): void {
	if (Array.isArray(value)) {
		for (const [ordinal, item] of value.entries()) {
			entries.push({
				source_event_id: sourceEventId,
				pointer: basePointer,
				ordinal,
				value: item,
				source_sha256: sourceSha256,
			});
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
		collectProtectedArrays(item, `${basePointer}/${escapePointer(key)}`, sourceEventId, sourceSha256, entries);
	}
}

/**
 * [函数级]
 * 目的：为可压缩自由文本创建不重复复制大型集合的 L1 投影。
 * 输入/输出：任意 handoff 值；数组替换为成员计数，其余结构递归保留。
 * 约束：数组原值已由 protected index 完整承载，此处只提供语义上下文。
 */
function freeTextProjection(value: unknown): unknown {
	if (Array.isArray(value)) return { protected_collection_count: value.length };
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, freeTextProjection(item)]),
	);
}

/**
 * [函数级]
 * 目的：把受保护成员规范排序并绑定确定性索引哈希。
 * 输入/输出：protected entries；带 source count 和 SHA-256 的索引。
 * 约束：排序键固定为 source event、pointer、ordinal；不调用模型、不删成员。
 */
function protectedIndex(entries: readonly MemoryProtectedEntry[]): MemoryProtectedIndex {
	const ordered = [...entries].sort(
		(left, right) =>
			left.source_event_id.localeCompare(right.source_event_id) ||
			left.pointer.localeCompare(right.pointer) ||
			left.ordinal - right.ordinal,
	);
	const payload = {
		entries: ordered,
		source_count: new Set(ordered.map((entry) => entry.source_event_id)).size,
	};
	return { ...payload, sha256: canonicalContractSha256(payload) };
}

/**
 * [函数级]
 * 目的：用固定 UTF-8 字节近似估算 Context 的基础 token 数。
 * 输入/输出：完整 Context；至少为一的 `ceil(JSON bytes / 4)`。
 * 约束：该值只是策略估算器的第一步，不等于 Provider 实际计费 token。
 */
function estimateBaseTokens(context: Context): number {
	return Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(context)).byteLength / 4));
}

/**
 * [函数级]
 * 目的：应用冻结倍率与 framing margin，得到压缩和窗口检查使用的保守 token 估算。
 * 输入/输出：Context 与策略；`ceil(base × multiplier) + margin`。
 * 约束：所有请求使用同一版本估算器，避免动态阈值导致非确定性。
 */
function estimateTokens(context: Context, policy: LayeredMemoryPolicy): number {
	return Math.ceil(estimateBaseTokens(context) * policy.estimator.multiplier) + policy.estimator.framing_margin_tokens;
}

/**
 * [函数级]
 * 目的：把序列化记忆视图包装成可进入 L0 的 user message。
 * 输入/输出：记忆文本、checkpoint/delta 类型和时间戳；标准 `<memory>` 消息。
 * 约束：阶段原始 user 请求保持独立，不与动态记忆拼成不断变化的首消息。
 */
function memoryViewMessage(memory: string, viewKind: "checkpoint" | "delta", timestamp: number): Message {
	return {
		role: "user",
		content: `<memory view_kind="${viewKind}">\n${memory}\n</memory>`,
		timestamp,
	};
}

/**
 * [函数级]
 * 目的：按固定顺序物化一个完整 L0 checkpoint 消息序列。
 * 输入/输出：记忆视图、阶段首请求、当前请求、请求索引和协议 tail；新 messages 数组。
 * 约束：阶段首请求始终为稳定前缀；非首轮 checkpoint 仍保留当前 user 请求。
 */
function checkpointMessages(
	memory: string,
	initialRequest: Extract<Message, { role: "user" }>,
	currentRequest: Extract<Message, { role: "user" }>,
	requestIndex: number,
	tail: readonly Message[],
): Message[] {
	return [
		initialRequest,
		memoryViewMessage(memory, "checkpoint", initialRequest.timestamp),
		...tail,
		...(requestIndex === 0 ? [] : [currentRequest]),
	];
}

/**
 * [函数级]
 * 目的：为一个 protected entry 生成可比较的稳定集合键。
 * 输入/输出：受保护成员；canonical SHA-256。
 * 约束：用于 checkpoint/delta 差分，不改变成员自身。
 */
function protectedEntryKey(entry: MemoryProtectedEntry): string {
	return canonicalContractSha256(entry);
}

/**
 * [函数级]
 * 目的：在 L0 中用短协议占位替代重复、失效或已由其他视图承载的工具正文。
 * 输入/输出：原 toolResult、L2 事件和替代理由；保持 toolCallId 的短 toolResult。
 * 约束：原始 Controller 返回仍完整存在 L2；stub 必须携带逻辑键、event ID 和哈希以便追溯。
 */
function evidenceStub(
	message: Extract<Message, { role: "toolResult" }>,
	event: MemoryL2Event,
	reason: "duplicate" | "stale" | "represented",
): Message {
	return {
		...message,
		content: [
			{
				type: "text",
				text: `[memory ${reason} evidence; logical_evidence_key=${event.logical_evidence_key ?? "none"}; source_event_id=${event.event_id}; sha256=${event.sha256}]`,
			},
		],
		details: {},
	};
}

/**
 * [函数级]
 * 目的：确认 Provider 当前可见 toolResult 是否真的含有 L2 保存的完整 stdout。
 * 输入/输出：toolResult 与其 L2 事件；完整可见时返回 true。
 * 约束：显式 model_output_truncated 或正文缺失时返回 false，防止误判证据已表示。
 */
function containsCompleteControllerBody(
	message: Extract<Message, { role: "toolResult" }>,
	event: MemoryL2Event,
): boolean {
	if (!isRecord(event.controller_result)) return false;
	const stdout = event.controller_result.stdout;
	if (typeof stdout !== "string") return false;
	const visible = messageText(message);
	return !visible.includes("model_output_truncated: true") && (stdout.length === 0 || visible.includes(stdout));
}

/**
 * [函数级]
 * 目的：找到为维持 assistant tool-call/tool-result 协议必须保留的最近完整 tail 起点。
 * 输入/输出：阶段消息；最近一组完整工具轮次的 assistant 索引。
 * 约束：不拆散 tool call 与对应结果；无完整轮次时退化为最后一条消息。
 */
function tailStart(messages: readonly Message[]): number {
	if (messages.length <= 1) return messages.length;
	for (let index = messages.length - 1; index >= 1; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const toolCalls = message.content.filter((item) => item.type === "toolCall");
		if (toolCalls.length === 0) continue;
		const results = new Set(
			messages
				.slice(index + 1)
				.filter((item): item is Extract<Message, { role: "toolResult" }> => item.role === "toolResult")
				.map((item) => item.toolCallId),
		);
		if (toolCalls.every((call) => results.has(call.id))) return index;
	}
	return messages.length - 1;
}

/**
 * [函数级]
 * 目的：在正文已进入其他 L0 视图时，只保留 assistant 的 tool-call 协议骨架。
 * 输入/输出：任意消息；含工具调用的 assistant 被投影为仅 toolCall，其余原样返回。
 * 约束：自由文本和 reasoning 仍通过 SourceUnit 进入 head/delta/summary，不从 L2 删除。
 */
function compactAssistantToolTurn(message: Message): Message {
	if (message.role !== "assistant" || !message.content.some((item) => item.type === "toolCall")) return message;
	return {
		...message,
		content: message.content.filter((item) => item.type === "toolCall"),
	};
}

/**
 * [函数级]
 * 目的：提取含工具调用 assistant 消息中的叙述与 thinking，供滚动压缩覆盖。
 * 输入/输出：消息；连接后的自由文本，非工具 assistant 返回空串。
 * 约束：toolCall 协议本身由消息 tail 保留，不混入该自由文本。
 */
function assistantToolNarrative(message: Message): string {
	if (message.role !== "assistant" || !message.content.some((item) => item.type === "toolCall")) return "";
	return message.content
		.filter((item) => item.type === "text" || item.type === "thinking")
		.map((item) => (item.type === "text" ? item.text : item.thinking))
		.join("\n");
}

/**
 * [函数级]
 * 目的：从 SourceUnits 提取去重后的事件来源集合。
 * 输入/输出：来源单元；保持首次出现顺序的 source event IDs。
 * 约束：用于 Condensation 审计，不替代 source key 级完整性校验。
 */
function sourceIds(units: readonly SourceUnit[]): readonly string[] {
	return [...new Set(units.map((unit) => unit.source_event_id))];
}

/**
 * [函数级]
 * 目的：构造压缩完整性和工作集连续性使用的精确来源键。
 * 输入/输出：SourceUnit；`source_event_id:source_sha256`。
 * 约束：同一事件内容变化会形成不同键，禁止仅按事件 ID 错误覆盖。
 */
function sourceKey(unit: SourceUnit): string {
	return `${unit.source_event_id}:${unit.source_sha256}`;
}

/**
 * [函数级]
 * 目的：把可压缩来源序列化成含显式来源标签的自由文本块。
 * 输入/输出：SourceUnits；按输入顺序连接的标注文本。
 * 约束：每段正文前保留 source event ID，使摘要能引用来源。
 */
function freeTextBlock(units: readonly SourceUnit[]): string {
	return units.map((unit) => `[${unit.source_event_id}]\n${unit.text}`).join("\n\n");
}

/**
 * [函数级]
 * 目的：为 Condenser 构造固定、无工具、query 引导的独立 Provider Context。
 * 输入/输出：冻结阶段 query 与精确来源单元；固定 system prompt 和单条 user message。
 * 约束：要求保留事实、失败和来源引用；禁止发明证据与调用工具；只返回摘要文本。
 */
function fixedCondenserPrompt(query: string, units: readonly SourceUnit[]): Context {
	return {
		systemPrompt: [
			"Summarize the supplied RepoFix memory view for the current query.",
			"Preserve query-relevant facts, unresolved questions, failed results, and exact source references.",
			"Do not invent evidence. Do not call tools. Return summary text only.",
		].join("\n"),
		messages: [
			{
				role: "user",
				content: `<query>\n${query}\n</query>\n<sources>\n${freeTextBlock(units)}\n</sources>`,
				timestamp: 0,
			},
		],
	};
}

/**
 * [类别级]
 *
 * 定位：分层记忆的核心读路径，为一个阶段连续生成缓存友好的 L0 checkpoint/delta。
 * 表示：冻结策略与阶段 query、受保护/已选/已加载工作集、ActiveEvidence、滚动摘要和上次 Provider view。
 * 不变量：相同来源、query、policy 和已有 Condensation 得到相同选择与哈希；有效工作集只能追加、压缩表示或因 revision 失效。
 */
export class RepoFixContextAssembler {
	private readonly store: RepoFixMemoryStore;
	private readonly policy: LayeredMemoryPolicy;
	private condenser: MemoryCondenser | null = null;
	private assembleMs = 0;
	private tokenCountMs = 0;
	private condenserWaitMs = 0;
	private compressionTriggers = 0;
	private activeStage: RepoFixStage | null = null;
	private stableStageQuery: string | null = null;
	private readonly headSourceKeys = new Set<string>();
	private readonly stageSelectedEvidenceArtifactIds = new Set<string>();
	private readonly stageLoadedFileChunkKeys = new Set<string>();
	private readonly stageWorkingSourceKeys = new Set<string>();
	private readonly activeEvidence = new Map<string, MemoryActiveEvidenceRecord>();
	private headInitialized = false;
	private rollingCondensation: RollingCondensationState | null = null;
	private providerView: ProviderViewState | null = null;

	/**
	 * [函数级]
	 * 目的：把一次 attempt 的权威 Store 与冻结组装策略绑定为 Context Assembler。
	 * 输入/输出：Memory Store 和 LayeredMemoryPolicy；构造阶段内有状态组装器。
	 * 约束：策略在实例生命周期内不变，所有 L0 都从 Store 而非旧 L0 快照派生。
	 */
	constructor(store: RepoFixMemoryStore, policy: LayeredMemoryPolicy) {
		this.store = store;
		this.policy = policy;
	}

	/**
	 * [函数级]
	 * 目的：安装由执行层独立监督的模型摘要回调。
	 * 输入/输出：MemoryCondenser；更新组装器依赖，无返回值。
	 * 约束：压缩触发前必须安装；回调不得调用工具或修改 Agent session history。
	 */
	setCondenser(condenser: MemoryCondenser): void {
		this.condenser = condenser;
	}

	/**
	 * [函数级]
	 * 目的：在外部执行系统声明的新阶段边界重置所有阶段内 L0 状态。
	 * 输入/输出：外部已选择的阶段；清空 query、工作集、摘要和 Provider 前缀状态。
	 * 约束：不选择或推进阶段；L1/L2 持久内容仍保留在 Store。
	 */
	startStage(stage: RepoFixStage): void {
		this.activeStage = stage;
		this.stableStageQuery = null;
		this.headSourceKeys.clear();
		this.stageSelectedEvidenceArtifactIds.clear();
		this.stageLoadedFileChunkKeys.clear();
		this.stageWorkingSourceKeys.clear();
		this.activeEvidence.clear();
		this.headInitialized = false;
		this.rollingCondensation = null;
		this.providerView = null;
	}

	/**
	 * [函数级]
	 * 目的：从 L1/L2 和当前阶段消息确定性构建、校验并审计一次请求的 L0 与完整 Provider Context。
	 * 输入/输出：请求身份、阶段、基础 Context 和当前阶段消息；返回实际发送给 Provider 的 Context。
	 * 约束：冻结首条 user 为 query；query 只追加召回；普通轮次追加 delta；70% 触发滚动压缩；输出预留后不得越过窗口。
	 */
	async assemble(input: AssemblyInput): Promise<Context> {
		// ── 组装步骤 1/10：校验阶段消息，增量写入 L2，并冻结首条阶段请求为稳定 query。 ──
		const started = performance.now();
		if (input.current_stage_messages.length === 0 || input.current_stage_messages[0]?.role !== "user") {
			throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: missing_current_stage_request`);
		}
		await this.store.captureMessages(input.current_stage_messages);
		const messageSources = this.store.currentMessageSources();
		let requestIndex = 0;
		for (const [index, message] of input.current_stage_messages.entries()) {
			if (message.role === "user") requestIndex = index;
		}
		const request = input.current_stage_messages[requestIndex];
		if (request === undefined || request.role !== "user") {
			throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: missing_current_stage_request`);
		}
		if (this.activeStage !== input.stage_id) this.startStage(input.stage_id);
		const initialRequest = input.current_stage_messages[0];
		if (initialRequest === undefined || initialRequest.role !== "user") {
			throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: missing_current_stage_request`);
		}
		this.stableStageQuery ??= messageText(initialRequest);
		const query = this.stableStageQuery;
		const repositoryRevision = this.store.repository_revision;

		// ── 组装步骤 2/10：刷新 ActiveEvidence；revision 变化时让旧正文、chunks、head 和摘要退出新 checkpoint。 ──
		const revisionChanged =
			this.providerView !== null && this.providerView.repository_revision !== repositoryRevision;
		this.activeEvidence.clear();
		for (const evidence of this.store.listActiveEvidence())
			this.activeEvidence.set(evidence.logical_evidence_key, evidence);
		if (revisionChanged) {
			const activeArtifactIds = new Set([
				...[...this.activeEvidence.values()].map((item) => item.event.artifact_id),
				...this.store
					.listFileViews()
					.filter((item) => item.view.path_revision === this.store.pathRevision(item.view.path))
					.map((item) => item.ref.artifact_id),
			]);
			for (const artifactId of this.stageSelectedEvidenceArtifactIds) {
				if (!activeArtifactIds.has(artifactId)) this.stageSelectedEvidenceArtifactIds.delete(artifactId);
			}
			const editedPath = this.store.currentActivity().latest_successful_edit?.path;
			if (editedPath !== undefined) {
				for (const key of this.stageLoadedFileChunkKeys) {
					if (key.startsWith(`${editedPath}:`)) this.stageLoadedFileChunkKeys.delete(key);
				}
			}
			this.headSourceKeys.clear();
			this.stageWorkingSourceKeys.clear();
			this.headInitialized = false;
			this.rollingCondensation = null;
		}
		const activeEvidenceByToolCall = new Map(
			[...this.activeEvidence.values()].flatMap((item) =>
				item.tool_call_ids.map((toolCallId) => [toolCallId, item] as const),
			),
		);
		const activeToolEventIds = new Set([...this.activeEvidence.values()].flatMap((item) => item.source_event_ids));
		const latestAssistant = [...input.current_stage_messages]
			.reverse()
			.find((message) => message.role === "assistant");
		const l1Records = this.store.listL1();
		const planSelectors =
			input.stage_id === "IMPLEMENT"
				? planExecutableSelectors(l1Records.find((record) => record.stage_id === "PLAN")?.handoff)
				: [];
		const selectorTexts = [
			query,
			latestAssistant === undefined ? "" : messageText(latestAssistant),
			...planSelectors,
		];
		const selectorText = selectorTexts.join("\n");

		// ── 组装步骤 3/10：完整保护 L1 集合成员，并按冻结 query/显式引用从 L1、L2 追加可追溯证据。 ──
		const protectedEntries: MemoryProtectedEntry[] = [];
		const units: SourceUnit[] = [];
		const checkpointEvidenceBodyKeys = new Set<string>();
		const fileChunkEvidenceKeyBySourceKey = new Map<string, string>();
		const selectedEvidenceRefs = new Map<string, MemoryArtifactRef>();
		const selectedCoverageKeys = new Set<string>();
		const fileViews = this.store
			.listFileViews()
			.filter((item) => item.view.path_revision === this.store.pathRevision(item.view.path));
		const fileViewCoverageKeys = new Set(fileViews.map((item) => item.view.coverage_key));
		const currentRefs = this.store.currentEvidenceRefs();
		const currentEvents = this.store.readEvents(currentRefs);
		const currentRefByArtifactId = new Map(currentRefs.map((ref) => [ref.artifact_id, ref]));
		for (const record of l1Records) {
			const sourceId = `l1:${String(record.stage_sequence)}`;
			collectProtectedArrays(record.handoff, "/handoff", sourceId, record.sha256, protectedEntries);
			protectedEntries.push({
				source_event_id: sourceId,
				pointer: "/stage_ref",
				ordinal: 0,
				value: {
					artifact_id: `memory/l1/stages/${String(record.stage_sequence).padStart(2, "0")}.json`,
					sha256: record.sha256,
				},
				source_sha256: record.sha256,
			});
			units.push({
				source_event_id: sourceId,
				source_sha256: record.sha256,
				text: stableStringify({
					stage_id: record.stage_id,
					handoff: freeTextProjection(record.handoff),
				}).trim(),
			});
			const referencedEvents = this.store.readEvents(record.evidence_refs);
			for (const event of referencedEvents) {
				const artifactRef = record.evidence_refs.find((ref) => ref.sha256 === event.sha256);
				if (
					artifactRef !== undefined &&
					(event.event_kind !== "tool_evidence" || activeToolEventIds.has(event.event_id)) &&
					(event.coverage_key === null || !fileViewCoverageKeys.has(event.coverage_key)) &&
					(explicitlyReferencesEvent(selectorText, artifactRef, event) ||
						this.stageSelectedEvidenceArtifactIds.has(artifactRef.artifact_id))
				) {
					this.stageSelectedEvidenceArtifactIds.add(artifactRef.artifact_id);
					selectedEvidenceRefs.set(artifactRef.artifact_id, artifactRef);
					if (event.coverage_key !== null) selectedCoverageKeys.add(event.coverage_key);
					units.push({
						source_event_id: event.event_id,
						source_sha256: event.sha256,
						text: stableStringify({
							tool_name: event.tool_name,
							normalized_input: event.normalized_input,
							controller_result: event.controller_result,
						}).trim(),
					});
					if (event.logical_evidence_key !== null) checkpointEvidenceBodyKeys.add(event.logical_evidence_key);
				}
			}
		}
		for (const event of currentEvents) {
			const artifactRef = currentRefByArtifactId.get(event.artifact_id);
			if (
				artifactRef === undefined ||
				event.event_kind !== "tool_evidence" ||
				!activeToolEventIds.has(event.event_id) ||
				(event.coverage_key !== null && fileViewCoverageKeys.has(event.coverage_key)) ||
				(!explicitlyReferencesEvent(selectorText, artifactRef, event) &&
					!this.stageSelectedEvidenceArtifactIds.has(artifactRef.artifact_id))
			) {
				continue;
			}
			this.stageSelectedEvidenceArtifactIds.add(artifactRef.artifact_id);
			selectedEvidenceRefs.set(artifactRef.artifact_id, artifactRef);
			if (event.coverage_key !== null) selectedCoverageKeys.add(event.coverage_key);
			units.push({
				source_event_id: event.event_id,
				source_sha256: event.sha256,
				text: stableStringify({
					tool_name: event.tool_name,
					normalized_input: event.normalized_input,
					controller_result: event.controller_result,
				}).trim(),
			});
			if (event.logical_evidence_key !== null) checkpointEvidenceBodyKeys.add(event.logical_evidence_key);
		}

		// ── 组装步骤 4/10：保留最近完整 assistant/tool 协议轮次，以短 stub 替换重复或旧版本工具正文。 ──
		const tailIndex = tailStart(input.current_stage_messages);
		const messageSourceByIndex = new Map(messageSources.map((source) => [source.message_index, source]));
		const tailRecords = input.current_stage_messages
			.map((message, messageIndex) => ({
				message,
				messageIndex,
				source: messageSourceByIndex.get(messageIndex),
			}))
			.filter(
				(
					record,
				): record is typeof record & {
					source: NonNullable<typeof record.source>;
				} =>
					record.messageIndex >= tailIndex && record.messageIndex !== requestIndex && record.source !== undefined,
			);
		const tail = tailRecords.map((record) => {
			if (record.message.role !== "toolResult") return compactAssistantToolTurn(record.message);
			const event = this.store.toolEvent(record.message.toolCallId);
			if (event === null || event.logical_evidence_key === null) return record.message;
			const active = activeEvidenceByToolCall.get(record.message.toolCallId);
			if (active === undefined) return evidenceStub(record.message, event, "stale");
			return active.tool_call_ids[0] === record.message.toolCallId
				? record.message
				: evidenceStub(record.message, event, "duplicate");
		});
		const compressedTail = tailRecords.flatMap(({ message, source }) => {
			if (message.role === "assistant" && message.content.some((item) => item.type === "toolCall")) {
				return [compactAssistantToolTurn(message)];
			}
			if (message.role !== "toolResult") return [];
			return [
				{
					...message,
					content: [
						{
							type: "text" as const,
							text: `[compressed memory view; source_event_id=${source.event.event_id}; sha256=${source.event.sha256}]`,
						},
					],
					details: {},
				},
			];
		});
		const tailToolResultIds = new Set(
			tail
				.filter((message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult")
				.map((message) => message.toolCallId),
		);
		// ── 组装步骤 5/10：按 artifact、路径、行号、chunk、既有工作集和协议 tail 选择大文件片段。 ──
		const loadedChunks: string[] = [];
		const unloadedRanges: string[] = [];
		const loadedChunkKeys = new Set<string>();
		const fullyLoadedReadToolCallIds = new Set<string>();
		const fileViewGroups = new Map<string, MemoryFileViewRecord[]>();
		for (const item of fileViews) {
			const group = fileViewGroups.get(item.view.path) ?? [];
			group.push(item);
			fileViewGroups.set(item.view.path, group);
		}
		const knownFilePaths = [...fileViewGroups.keys()];
		for (const [path, group] of [...fileViewGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			const selectedChunkIds = new Set(
				group
					.flatMap((item) => item.view.chunks)
					.filter((chunk) => selectorText.includes(chunk.chunk_id))
					.map((chunk) => chunk.chunk_id),
			);
			const lineRanges = requestedLineRanges(selectorTexts, path, knownFilePaths);
			const addressedViews = group.filter((item) => selectorText.includes(item.ref.artifact_id));
			const retainedViews = group.filter((item) => this.stageSelectedEvidenceArtifactIds.has(item.ref.artifact_id));
			const tailViews = group.filter((item) => item.tool_call_ids.some((id) => tailToolResultIds.has(id)));
			const rangeViews = group.filter((item) =>
				item.view.chunks.some(
					(chunk) =>
						selectedChunkIds.has(chunk.chunk_id) ||
						lineRanges.some((range) => range.start <= chunk.end_line && range.end >= chunk.start_line),
				),
			);
			const completeViews = group.filter((item) => item.view.coverage_status === "complete");
			const querySelectedViews =
				addressedViews.length > 0
					? addressedViews
					: rangeViews.length > 0
						? rangeViews
						: explicitlyReferencesPath(selectorText, path)
							? [completeViews.at(-1) ?? group.at(-1)].filter(
									(item): item is MemoryFileViewRecord => item !== undefined,
								)
							: [];
			const selectedArtifactIds = new Set(
				[...retainedViews, ...tailViews, ...querySelectedViews].map((item) => item.ref.artifact_id),
			);
			const selectedViews = group.filter((item) => selectedArtifactIds.has(item.ref.artifact_id));
			for (const item of selectedViews) {
				this.stageSelectedEvidenceArtifactIds.add(item.ref.artifact_id);
				selectedEvidenceRefs.set(item.ref.artifact_id, item.ref);
				selectedCoverageKeys.add(item.view.coverage_key);
				protectedEntries.push({
					source_event_id: `artifact:${item.ref.artifact_id}`,
					pointer: "/file_view",
					ordinal: 0,
					value: {
						path: item.view.path,
						coverage_status: item.view.coverage_status,
						structure: item.view.structure,
						chunks: item.view.chunks.map((chunk) => ({
							chunk_id: chunk.chunk_id,
							start_line: chunk.start_line,
							end_line: chunk.end_line,
							sha256: chunk.sha256,
						})),
					},
					source_sha256: item.view.sha256,
				});
				const explicitlySelectedView = addressedViews.includes(item);
				const tailOwnsResult = item.tool_call_ids.some((id) => tailToolResultIds.has(id));
				const loadWholeView = item.view.chunks.length === 1 && (!tailOwnsResult || explicitlySelectedView);
				for (const chunk of item.view.chunks) {
					const chunkKey = `${item.view.path}:${String(chunk.start_line)}:${String(chunk.end_line)}:${chunk.sha256}`;
					const intersectsRequestedLines = lineRanges.some(
						(range) => range.start <= chunk.end_line && range.end >= chunk.start_line,
					);
					if (
						this.stageLoadedFileChunkKeys.has(chunkKey) ||
						loadWholeView ||
						selectedChunkIds.has(chunk.chunk_id) ||
						intersectsRequestedLines
					) {
						if (loadedChunkKeys.has(chunkKey)) continue;
						this.stageLoadedFileChunkKeys.add(chunkKey);
						loadedChunkKeys.add(chunkKey);
						loadedChunks.push(`${item.view.path}:${chunk.chunk_id}`);
						checkpointEvidenceBodyKeys.add(item.view.logical_evidence_key);
						const fileUnit: SourceUnit = {
							source_event_id: `artifact:${item.ref.artifact_id}:${chunk.chunk_id}`,
							source_sha256: chunk.sha256,
							text: `${item.view.path}:${String(chunk.start_line)}-${String(chunk.end_line)}\n${chunk.content}`,
						};
						units.push(fileUnit);
						fileChunkEvidenceKeyBySourceKey.set(sourceKey(fileUnit), item.view.logical_evidence_key);
					} else {
						unloadedRanges.push(`${item.view.path}:${String(chunk.start_line)}-${String(chunk.end_line)}`);
					}
				}
				if (
					item.view.chunks.length > 0 &&
					item.view.chunks.every((chunk) =>
						loadedChunkKeys.has(
							`${item.view.path}:${String(chunk.start_line)}:${String(chunk.end_line)}:${chunk.sha256}`,
						),
					)
				) {
					for (const id of item.tool_call_ids) fullyLoadedReadToolCallIds.add(id);
				}
			}
		}
		const checkpointTail = tail.map((message) => {
			if (message.role !== "toolResult") return message;
			const event = this.store.toolEvent(message.toolCallId);
			if (event === null || event.logical_evidence_key === null) return message;
			if (checkpointEvidenceBodyKeys.has(event.logical_evidence_key))
				return evidenceStub(message, event, "represented");
			if (
				!message.content.some((item) => item.type === "text" && item.text.startsWith("[memory ")) &&
				containsCompleteControllerBody(message, event)
			)
				checkpointEvidenceBodyKeys.add(event.logical_evidence_key);
			return message;
		});

		// ── 组装步骤 6/10：把所选证据的累计 coverage 与 artifact 引用机械加入 protected index。 ──
		for (const coverage of this.store.listCoverage()) {
			if (!selectedCoverageKeys.has(coverage.coverage_key)) continue;
			protectedEntries.push({
				source_event_id: `coverage:${coverage.coverage_key}`,
				pointer: "/coverage",
				ordinal: 0,
				value: coverage,
				source_sha256: canonicalContractSha256(coverage),
			});
		}
		const selectedRefs = [...selectedEvidenceRefs.values()].sort((left, right) =>
			left.artifact_id.localeCompare(right.artifact_id),
		);
		const selectedRefsSha256 = canonicalContractSha256(selectedRefs);
		for (const [ordinal, ref] of selectedRefs.entries()) {
			protectedEntries.push({
				source_event_id: `selected:${input.stage_id}`,
				pointer: "/evidence_refs",
				ordinal,
				value: ref,
				source_sha256: selectedRefsSha256,
			});
		}

		// ── 组装步骤 7/10：构造自由文本 SourceUnits；tool 协议与 reasoning/text 分离，正文只保留一份。 ──
		const recentNarrativeUnits: SourceUnit[] = [];
		const tailSourceUnits: SourceUnit[] = tailRecords.map(({ message, source }, index) => ({
			source_event_id: source.event.event_id,
			source_sha256: source.event.sha256,
			text: `${message.role}:\n${messageText(message.role === "assistant" ? message : (checkpointTail[index] ?? message))}`,
		}));
		const tailWorkingSourceKeys = new Set(
			tailRecords.map(({ source }) => `${source.event.event_id}:${source.event.sha256}`),
		);
		for (const source of messageSources) {
			if (source.message_index === 0 || source.message_index === requestIndex) continue;
			const message = input.current_stage_messages[source.message_index];
			if (message === undefined) continue;
			if (source.message_index >= tailIndex) {
				const narrative = assistantToolNarrative(message);
				if (narrative.length > 0) {
					recentNarrativeUnits.push({
						source_event_id: source.event.event_id,
						source_sha256: source.event.sha256,
						text: `assistant:\n${narrative}`,
					});
				}
				continue;
			}
			let projectedMessage = message;
			if (message.role === "toolResult") {
				const event = this.store.toolEvent(message.toolCallId);
				if (event !== null && event.logical_evidence_key !== null) {
					const active = activeEvidenceByToolCall.get(message.toolCallId);
					if (active === undefined) {
						projectedMessage = evidenceStub(message, event, "stale");
					} else if (
						checkpointEvidenceBodyKeys.has(event.logical_evidence_key) ||
						fullyLoadedReadToolCallIds.has(message.toolCallId)
					) {
						projectedMessage = evidenceStub(message, event, "represented");
					} else if (active.tool_call_ids[0] !== message.toolCallId) {
						projectedMessage = evidenceStub(message, event, "duplicate");
					} else if (containsCompleteControllerBody(message, event)) {
						checkpointEvidenceBodyKeys.add(event.logical_evidence_key);
					}
				}
			}
			units.push({
				source_event_id: source.event.event_id,
				source_sha256: source.event.sha256,
				text: `${projectedMessage.role}:\n${messageText(projectedMessage)}`,
			});
		}

		// ── 组装步骤 8/10：维护只能追加或显式失效的阶段工作集，并划分固定 head、已有 summary 与新增 delta。 ──
		const index = protectedIndex(protectedEntries);
		const allUnits = [...units, ...recentNarrativeUnits];
		const currentSourceKeys = new Set([...allUnits.map(sourceKey), ...tailWorkingSourceKeys]);
		for (const key of this.stageWorkingSourceKeys) {
			if (!currentSourceKeys.has(key) && !this.rollingCondensation?.covered_source_keys.has(key)) {
				throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: working_set_source_missing`);
			}
		}
		for (const key of currentSourceKeys) this.stageWorkingSourceKeys.add(key);
		if (!this.headInitialized) {
			for (const unit of units.slice(0, this.policy.head_event_count)) this.headSourceKeys.add(sourceKey(unit));
			this.headInitialized = true;
		}
		const head = allUnits.filter((unit) => this.headSourceKeys.has(sourceKey(unit)));
		const middle = allUnits.filter((unit) => !this.headSourceKeys.has(sourceKey(unit)));
		const rolling = this.rollingCondensation;
		const delta =
			rolling === null ? middle : middle.filter((unit) => !rolling.covered_source_keys.has(sourceKey(unit)));
		const compressionDeltaBySource = new Map(delta.map((unit) => [sourceKey(unit), unit]));
		for (const unit of tailSourceUnits) {
			if (!rolling?.covered_source_keys.has(sourceKey(unit))) compressionDeltaBySource.set(sourceKey(unit), unit);
		}
		const compressionDelta = [...compressionDeltaBySource.values()];
		const tailCoveredByRolling =
			rolling !== null &&
			tailSourceUnits.length > 0 &&
			tailSourceUnits.every((unit) => rolling.covered_source_keys.has(sourceKey(unit)));
		const activity: MemoryStageActivityView = this.store.currentActivity();
		const uncompressedTail = tailCoveredByRolling ? compressedTail : checkpointTail;
		const uncompressedMemory = stableStringify(
			rolling !== null && delta.length === 0
				? {
						activity,
						protected_index: index,
						head: freeTextBlock(head),
						summary: rolling.summary,
					}
				: {
						activity,
						protected_index: index,
						head: freeTextBlock(head),
						summary: rolling?.summary ?? "",
						delta: freeTextBlock(delta),
					},
		).trim();
		// ── 组装步骤 9/10：优先复用上一轮完整 messages 追加 delta；仅首轮、revision 变化或成功压缩重建 checkpoint。 ──
		const checkpointContext: Context = {
			...input.context,
			messages: checkpointMessages(uncompressedMemory, initialRequest, request, requestIndex, uncompressedTail),
		};
		const currentProtectedKeys = new Set(protectedEntries.map(protectedEntryKey));
		const messageSourceEventIds = new Set(messageSources.map((source) => source.event.event_id));
		let uncompressedContext = checkpointContext;
		let uncompressedViewKind: "checkpoint" | "delta" = "checkpoint";
		let stablePrefixMessageCount = 0;
		let nextEvidenceBodyKeys = new Set(checkpointEvidenceBodyKeys);
		let nextRepresentedSourceKeys = new Set(currentSourceKeys);
		let nextRepresentedProtectedKeys = new Set(currentProtectedKeys);
		const priorView = this.providerView;
		if (priorView !== null && !revisionChanged) {
			if (input.current_stage_messages.length < priorView.stage_message_count)
				throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: stage_message_history_rewound`);
			nextEvidenceBodyKeys = new Set(priorView.evidence_body_keys);
			const memoryDeltaUnits = allUnits.filter(
				(unit) =>
					!messageSourceEventIds.has(unit.source_event_id) &&
					!priorView.represented_source_keys.has(sourceKey(unit)) &&
					!priorView.evidence_body_keys.has(fileChunkEvidenceKeyBySourceKey.get(sourceKey(unit)) ?? ""),
			);
			const memoryDeltaSourceKeys = new Set(memoryDeltaUnits.map(sourceKey));
			for (const item of fileViews) {
				if (
					item.view.chunks.some((chunk) =>
						memoryDeltaSourceKeys.has(`${`artifact:${item.ref.artifact_id}:${chunk.chunk_id}`}:${chunk.sha256}`),
					)
				)
					nextEvidenceBodyKeys.add(item.view.logical_evidence_key);
			}
			const projectedMessages = input.current_stage_messages.slice(priorView.stage_message_count).map((message) => {
				if (message.role !== "toolResult") return message;
				const event = this.store.toolEvent(message.toolCallId);
				if (event === null || event.logical_evidence_key === null) return message;
				const active = activeEvidenceByToolCall.get(message.toolCallId);
				if (active === undefined) return evidenceStub(message, event, "stale");
				if (nextEvidenceBodyKeys.has(event.logical_evidence_key) || active.tool_call_ids[0] !== message.toolCallId)
					return evidenceStub(message, event, "duplicate");
				if (containsCompleteControllerBody(message, event)) nextEvidenceBodyKeys.add(event.logical_evidence_key);
				return message;
			});
			const protectedDelta = protectedEntries.filter(
				(entry) => !priorView.represented_protected_keys.has(protectedEntryKey(entry)),
			);
			const activitySha256 = canonicalContractSha256(activity);
			const hasMemoryDelta =
				memoryDeltaUnits.length > 0 || protectedDelta.length > 0 || activitySha256 !== priorView.activity_sha256;
			const deltaMessage = hasMemoryDelta
				? memoryViewMessage(
						stableStringify({
							activity,
							protected_index_delta: protectedIndex(protectedDelta),
							evidence_delta: freeTextBlock(memoryDeltaUnits),
						}).trim(),
						"delta",
						projectedMessages.at(-1)?.timestamp ?? request.timestamp,
					)
				: null;
			let trailingUserStart = projectedMessages.length;
			while (trailingUserStart > 0 && projectedMessages[trailingUserStart - 1]?.role === "user")
				trailingUserStart -= 1;
			const appendedMessages =
				deltaMessage === null
					? projectedMessages
					: [
							...projectedMessages.slice(0, trailingUserStart),
							deltaMessage,
							...projectedMessages.slice(trailingUserStart),
						];
			uncompressedContext = {
				...input.context,
				messages: [...priorView.messages, ...appendedMessages],
			};
			uncompressedViewKind = "delta";
			stablePrefixMessageCount = priorView.messages.length;
			nextRepresentedSourceKeys = new Set([...priorView.represented_source_keys, ...currentSourceKeys]);
			nextRepresentedProtectedKeys = new Set([...priorView.represented_protected_keys, ...currentProtectedKeys]);
		}
		// ── 组装步骤 10/10：估算窗口，必要时压缩“上一摘要 + 新 delta”，校验来源覆盖与预算，再保存 L0 审计。 ──
		const tokenStarted = performance.now();
		const uncompressedTokens = estimateTokens(uncompressedContext, this.policy);
		this.tokenCountMs += performance.now() - tokenStarted;
		const trigger = Math.floor((this.policy.context_window * this.policy.trigger_percent) / 100);
		const target = Math.floor((this.policy.context_window * this.policy.target_percent) / 100);
		let assembledContext = uncompressedContext;
		let condensationRef: MemoryArtifactRef | null = rolling?.ref ?? null;
		let compressedThisRequest = false;

		if (uncompressedTokens >= trigger) {
			this.compressionTriggers += 1;
			if (compressionDelta.length > 0) {
				// Protected index、activity、head 和协议 tail 不交给模型；它们自身超预算时也不删关键成员强行继续。
				const protectedMemory = stableStringify({
					activity,
					protected_index: index,
					head: freeTextBlock(head),
					summary: "",
				}).trim();
				const protectedContext: Context = {
					...input.context,
					messages: checkpointMessages(protectedMemory, initialRequest, request, requestIndex, compressedTail),
				};
				const protectedTokens = estimateTokens(protectedContext, this.policy);
				const summaryMaxTokens = Math.min(this.policy.summary_max_tokens, target - protectedTokens);
				if (summaryMaxTokens < 1) {
					if (uncompressedTokens + this.policy.agent_max_output_tokens > this.policy.context_window) {
						throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: protected_context_exceeds_budget`);
					}
				} else {
					const policySha256 = canonicalContractSha256(this.policy);
					const querySha256 = canonicalContractSha256(query);
					const condenserUnits: SourceUnit[] =
						rolling === null
							? [...compressionDelta]
							: [
									{
										source_event_id: `condensation:${rolling.ref.artifact_id}`,
										source_sha256: rolling.ref.sha256,
										text: `previous_summary:\n${rolling.summary}`,
									},
									...compressionDelta,
								];
					const inputSha256 = canonicalContractSha256(condenserUnits);
					const existing = this.store.findCondensation(inputSha256, querySha256, policySha256);
					let summary: string;
					let savedRef: MemoryArtifactRef | null = null;
					if (existing !== undefined) {
						summary = existing.value.summary;
						savedRef = existing.ref;
					} else {
						const condenser = this.condenser;
						if (condenser === null) throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: condenser_unavailable`);
						const condenserContext = fixedCondenserPrompt(query, condenserUnits);
						if (estimateTokens(condenserContext, this.policy) + summaryMaxTokens > this.policy.context_window) {
							throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: condenser_input_exceeds_window`);
						}
						const condenserStarted = performance.now();
						try {
							summary = await condenser({
								context: condenserContext,
								stage_id: input.stage_id,
								summary_max_tokens: summaryMaxTokens,
							});
						} catch (error) {
							// Condenser 单次失败不重试：未压缩上下文仍容纳输出时回退，否则报告基础设施错误。
							if (uncompressedTokens + this.policy.agent_max_output_tokens > this.policy.context_window) {
								throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: condenser_failed: ${String(error)}`);
							}
							summary = "";
						} finally {
							this.condenserWaitMs += performance.now() - condenserStarted;
						}
						if (summary.length > 0) {
							const combinedSourceEventIds = [
								...new Set([...(rolling?.source_event_ids ?? []), ...sourceIds(compressionDelta)]),
							];
							const payload: MemoryCondensationPayload = {
								schema_version: "v1",
								memory_type: "condensation",
								summary,
								previous_condensation_ref: rolling?.ref ?? null,
								source_event_ids: combinedSourceEventIds,
								delta_source_event_ids: sourceIds(compressionDelta),
								query_sha256: querySha256,
								input_sha256: inputSha256,
								policy_sha256: policySha256,
							};
							const saved = await this.store.saveCondensation(payload);
							savedRef = saved.ref;
						}
					}
					if (summary.length > 0 && savedRef !== null) {
						const coveredSourceKeys = new Set(rolling?.covered_source_keys ?? []);
						for (const unit of compressionDelta) coveredSourceKeys.add(sourceKey(unit));
						this.rollingCondensation = {
							stage_id: input.stage_id,
							ref: savedRef,
							summary,
							covered_source_keys: coveredSourceKeys,
							source_event_ids: [
								...new Set([...(rolling?.source_event_ids ?? []), ...sourceIds(compressionDelta)]),
							],
						};
						condensationRef = savedRef;
						compressedThisRequest = true;
						const memory = stableStringify({
							activity,
							protected_index: index,
							head: freeTextBlock(head),
							summary,
						}).trim();
						assembledContext = {
							...input.context,
							messages: checkpointMessages(memory, initialRequest, request, requestIndex, compressedTail),
						};
						uncompressedViewKind = "checkpoint";
						stablePrefixMessageCount = 0;
						nextEvidenceBodyKeys = new Set(checkpointEvidenceBodyKeys);
						nextRepresentedSourceKeys = new Set(currentSourceKeys);
						nextRepresentedProtectedKeys = new Set(currentProtectedKeys);
					}
				}
			}
		}

		const assembledTokenStarted = performance.now();
		const assembledTokens = estimateTokens(assembledContext, this.policy);
		this.tokenCountMs += performance.now() - assembledTokenStarted;
		if (compressedThisRequest && assembledTokens > target) {
			throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: compression_target_not_met`);
		}
		if (assembledTokens + this.policy.agent_max_output_tokens > this.policy.context_window) {
			throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: assembled_context_exceeds_window`);
		}
		const representedSourceKeys = new Set([
			...head.map(sourceKey),
			...(compressedThisRequest ? [] : delta.map(sourceKey)),
			...(this.rollingCondensation?.covered_source_keys ?? []),
			...(!compressedThisRequest && !tailCoveredByRolling ? tailWorkingSourceKeys : []),
		]);
		for (const key of this.stageWorkingSourceKeys) {
			if (!representedSourceKeys.has(key)) {
				throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: condensation_source_coverage_mismatch`);
			}
		}
		const policySha256 = canonicalContractSha256(this.policy);
		const payload: MemoryL0Payload = {
			schema_version: "v1",
			memory_type: "l0_snapshot",
			request_id: input.request_id,
			task_id: this.store.task_id,
			attempt_id: this.store.attempt_id,
			stage_id: input.stage_id,
			view_kind: uncompressedViewKind,
			repository_revision: repositoryRevision,
			active_evidence_count: this.activeEvidence.size,
			stable_prefix_message_count: stablePrefixMessageCount,
			activity,
			protected_index: index,
			source_event_ids: [
				...new Set([...sourceIds(allUnits), ...messageSources.map((source) => source.event.event_id)]),
			],
			condensation_ref: condensationRef,
			uncompressed_context_sha256: canonicalContractSha256(jsonSerializable(uncompressedContext)),
			assembled_context_sha256: canonicalContractSha256(jsonSerializable(assembledContext)),
			uncompressed_context_tokens: uncompressedTokens,
			assembled_context_tokens: assembledTokens,
			loaded_chunks: loadedChunks,
			unloaded_ranges: unloadedRanges,
			policy_sha256: policySha256,
		};
		await this.store.saveL0(payload);
		this.providerView = {
			messages: [...assembledContext.messages],
			stage_message_count: input.current_stage_messages.length,
			repository_revision: repositoryRevision,
			represented_source_keys: nextRepresentedSourceKeys,
			represented_protected_keys: nextRepresentedProtectedKeys,
			evidence_body_keys: nextEvidenceBodyKeys,
			activity_sha256: canonicalContractSha256(activity),
		};
		this.assembleMs += performance.now() - started;
		return assembledContext;
	}

	/**
	 * [函数级]
	 * 目的：取得 Context Assembler 的本地开销快照。
	 * 输入/输出：无输入；返回组装、估算、压缩等待和触发计数。
	 * 约束：不含 Store 写入开销，避免指标重复。
	 */
	get metrics(): RepoFixMemoryAssemblerMetrics {
		return {
			memory_assemble_ms: this.assembleMs,
			token_count_ms: this.tokenCountMs,
			condenser_wait_ms: this.condenserWaitMs,
			compression_trigger_count: this.compressionTriggers,
		};
	}
}

/**
 * [类别级]
 *
 * 定位：面向 RepoFix 执行层的薄生命周期适配器，把 Store 与 Assembler 接入现有 Agent hook。
 * 表示：当前阶段边界、历史消息切点、最近请求 ID 和持久故障状态。
 * 不变量：只响应外部阶段事件，不决定阶段；记录的是已执行工具事实；非请求级故障后拒绝继续组装。
 */
export class RepoFixMemoryRuntime {
	private readonly store: RepoFixMemoryStore;
	private readonly assembler: RepoFixContextAssembler;
	private historyMessageCount = 0;
	private activeStage: RepoFixStage | null = null;
	private failure: Error | null = null;
	private currentRequestId: string | null = null;

	/**
	 * [函数级]
	 * 目的：绑定一个 attempt 的记忆写路径和上下文读路径。
	 * 输入/输出：Store 与 Assembler；构造 RepoFix-facing runtime。
	 * 约束：两者必须属于同一 attempt，由调用方负责正确配对。
	 */
	constructor(store: RepoFixMemoryStore, assembler: RepoFixContextAssembler) {
		this.store = store;
		this.assembler = assembler;
	}

	/**
	 * [函数级]
	 * 目的：在阶段执行前把原始问题完整写入 L2。
	 * 输入/输出：problem statement；完成后无返回值。
	 * 约束：不压缩任务输入，不触发 Provider 请求。
	 */
	async initialize(problemStatement: string): Promise<void> {
		await this.store.writeTaskInput(problemStatement);
	}

	/**
	 * [函数级]
	 * 目的：在外部给定阶段边界同时启动 Store 追加序列和 Assembler 阶段状态。
	 * 输入/输出：阶段、阶段序号、全局 history 的切片起点；更新 runtime 状态。
	 * 约束：不判断该阶段是否应开始；history 切点确保只捕获本阶段消息。
	 */
	startStage(stage: RepoFixStage, stageSequence: number, historyMessageCount: number): void {
		this.store.startStage(stage, stageSequence);
		this.assembler.startStage(stage);
		this.activeStage = stage;
		this.historyMessageCount = historyMessageCount;
		this.currentRequestId = null;
	}

	/**
	 * [函数级]
	 * 目的：为一次 Agent 请求组装 Provider Context，同时保持 RepoFix FSM 状态不变。
	 * 输入/输出：基础 Context 与 request ID；返回分层记忆后的 Context。
	 * 约束：请求级容量错误可由下一请求恢复；其他错误记为持久故障并阻止后续组装。
	 */
	async prepareProviderContext(context: Context, requestId: string): Promise<Context> {
		this.assertHealthy();
		const stage = this.activeStage;
		if (stage === null) throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: no_active_stage`);
		try {
			const assembled = await this.assembler.assemble({
				request_id: requestId,
				stage_id: stage,
				context,
				current_stage_messages: context.messages.slice(this.historyMessageCount),
			});
			this.currentRequestId = requestId;
			return assembled;
		} catch (error) {
			if (!isRequestScopedMemoryCapacityError(error)) {
				this.failure = error instanceof Error ? error : new Error(String(error));
			}
			throw error;
		}
	}

	/**
	 * [函数级]
	 * 目的：把 Worker 已经执行的工具返回完整追加到 L2。
	 * 输入/输出：MemoryToolEvidenceInput；完成后无返回值。
	 * 约束：该方法不执行工具；写入失败记为持久 memory failure，防止无证据继续运行。
	 */
	async appendToolEvidence(input: MemoryToolEvidenceInput): Promise<void> {
		try {
			await this.store.appendToolEvidence(input);
		} catch (error) {
			this.failure = error instanceof Error ? error : new Error(String(error));
		}
	}

	/**
	 * [函数级]
	 * 目的：在外部阶段完成后补录末尾消息，并追加完整 L1 handoff。
	 * 输入/输出：全局消息与严格 completion；完成后关闭 runtime 活动阶段。
	 * 约束：不自行判定完成；先确认 runtime 健康，再由 Store 校验 completion 与阶段匹配。
	 */
	async completeStage(messages: readonly unknown[], completion: StageCompletion): Promise<void> {
		this.assertHealthy();
		await this.store.captureMessages(messages.slice(this.historyMessageCount));
		await this.store.completeStage(completion);
		this.activeStage = null;
		this.currentRequestId = null;
	}

	/**
	 * [函数级]
	 * 目的：把独立 Condenser 从 RepoFix 集成层转交给 Assembler。
	 * 输入/输出：MemoryCondenser；无返回值。
	 * 约束：不改变 Agent 模型 history 或阶段轮次。
	 */
	setCondenser(condenser: MemoryCondenser): void {
		this.assembler.setCondenser(condenser);
	}

	/**
	 * [函数级]
	 * 目的：返回当前 attempt 的 Store 与 Assembler 记忆开销合集。
	 * 输入/输出：无输入；返回 RepoFixMemoryMetrics 快照。
	 * 约束：不重复计入 Provider token。
	 */
	get metrics(): RepoFixMemoryMetrics {
		return { ...this.store.metrics, ...this.assembler.metrics };
	}

	/**
	 * [函数级]
	 * 目的：暴露最近一次成功组装 L0 的 Provider request ID。
	 * 输入/输出：无输入；返回 request ID 或 null。
	 * 约束：阶段开始/完成时重置，组装失败不冒充成功请求。
	 */
	get current_request_id(): string | null {
		return this.currentRequestId;
	}

	/**
	 * [函数级]
	 * 目的：在进入需要可靠记忆的操作前统一检查持久故障状态。
	 * 输入/输出：无输入；健康时返回，否则抛出带 memory infrastructure 前缀的错误。
	 * 约束：请求级容量错误不会写入 `failure`，其余记录或组装错误会阻止静默继续。
	 */
	private assertHealthy(): void {
		if (this.failure !== null) throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: ${this.failure.message}`);
	}
}

/**
 * [函数级]
 * 目的：为一次实际组装的完整 Provider Context 计算确定性快照哈希。
 * 输入/输出：Context；纯 JSON 投影的 canonical SHA-256。
 * 约束：用于测试和审计相同输入是否产生相同上下文，不代表 Provider token 身份。
 */
export function assembledContextSha256(context: Context): string {
	return canonicalContractSha256(jsonSerializable(context));
}
