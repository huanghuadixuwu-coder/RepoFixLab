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

const REQUEST_SCOPED_MEMORY_CAPACITY_ERRORS = new Set([
	`${MEMORY_INFRASTRUCTURE_ERROR}: protected_context_exceeds_budget`,
	`${MEMORY_INFRASTRUCTURE_ERROR}: condenser_input_exceeds_window`,
	`${MEMORY_INFRASTRUCTURE_ERROR}: compression_target_not_met`,
	`${MEMORY_INFRASTRUCTURE_ERROR}: assembled_context_exceeds_window`,
]);

function isRequestScopedMemoryCapacityError(error: unknown): boolean {
	return error instanceof Error && REQUEST_SCOPED_MEMORY_CAPACITY_ERRORS.has(error.message);
}

/** Exact condenser request created after deterministic head/tail selection. */
export interface MemoryCondenserRequest {
	readonly context: Context;
	readonly stage_id: RepoFixStage;
	readonly summary_max_tokens: number;
}

/** One model callback; implementations must reject tool calls and errors. */
export type MemoryCondenser = (request: MemoryCondenserRequest) => Promise<string>;

/** Local context-construction overhead reported with the attempt. */
export interface RepoFixMemoryAssemblerMetrics {
	readonly memory_assemble_ms: number;
	readonly token_count_ms: number;
	readonly condenser_wait_ms: number;
	readonly compression_trigger_count: number;
}

/** Combined memory metrics persisted by the M4 attempt. */
export type RepoFixMemoryMetrics = RepoFixMemoryStoreMetrics & RepoFixMemoryAssemblerMetrics;

type SourceUnit = {
	readonly source_event_id: string;
	readonly source_sha256: string;
	readonly text: string;
};

type RollingCondensationState = {
	readonly stage_id: RepoFixStage;
	readonly ref: MemoryArtifactRef;
	readonly summary: string;
	readonly covered_source_keys: ReadonlySet<string>;
	readonly source_event_ids: readonly string[];
};

type AssemblyInput = {
	readonly request_id: string;
	readonly stage_id: RepoFixStage;
	readonly context: Context;
	readonly current_stage_messages: readonly Message[];
};

type ProviderViewState = {
	readonly messages: readonly Message[];
	readonly stage_message_count: number;
	readonly repository_revision: number;
	readonly represented_source_keys: ReadonlySet<string>;
	readonly represented_protected_keys: ReadonlySet<string>;
	readonly evidence_body_keys: ReadonlySet<string>;
	readonly activity_sha256: string;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSerializable(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? null : JSON.parse(serialized);
}

function explicitRepositoryPath(value: unknown): string | null {
	if (!isRecord(value) || typeof value.path !== "string") return null;
	const path = value.path.trim();
	if (path === "" || path === "." || path === "./" || path === "/") return null;
	if (!path.includes("/") && !path.includes("\\") && !/(?:^|\.)[^.\s]+$/.test(path)) return null;
	return path;
}

function explicitlyReferencesPath(selectorText: string, path: string): boolean {
	const explicit = explicitRepositoryPath({ path });
	if (explicit === null) return false;
	return selectorText.includes(explicit) || selectorText.includes(explicit.replaceAll("\\", "/"));
}

function explicitlyReferencesEvent(
	selectorText: string,
	artifactRef: MemoryArtifactRef,
	event: MemoryL2Event,
): boolean {
	if (selectorText.includes(artifactRef.artifact_id)) return true;
	const path = explicitRepositoryPath(event.normalized_input);
	return path !== null && explicitlyReferencesPath(selectorText, path);
}

function requestedLineRanges(
	selectorText: string,
	path: string,
): readonly { readonly start: number; readonly end: number }[] {
	if (!explicitlyReferencesPath(selectorText, path)) return [];
	const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`${escapedPath}(?:#L|:|\\s+lines?\\s+)(\\d+)(?:\\s*[-:]\\s*L?(\\d+))?`, "g");
	const ranges: { start: number; end: number }[] = [];
	for (const match of selectorText.matchAll(pattern)) {
		const start = Number(match[1]);
		const end = match[2] === undefined ? start : Number(match[2]);
		if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start) {
			ranges.push({ start, end });
		}
	}
	return ranges;
}

function escapePointer(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

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

function freeTextProjection(value: unknown): unknown {
	if (Array.isArray(value)) return { protected_collection_count: value.length };
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, freeTextProjection(item)]),
	);
}

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

function estimateBaseTokens(context: Context): number {
	return Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(context)).byteLength / 4));
}

function estimateTokens(context: Context, policy: LayeredMemoryPolicy): number {
	return Math.ceil(estimateBaseTokens(context) * policy.estimator.multiplier) + policy.estimator.framing_margin_tokens;
}

function memoryViewMessage(memory: string, viewKind: "checkpoint" | "delta", timestamp: number): Message {
	return {
		role: "user",
		content: `<memory view_kind="${viewKind}">\n${memory}\n</memory>`,
		timestamp,
	};
}

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

function protectedEntryKey(entry: MemoryProtectedEntry): string {
	return canonicalContractSha256(entry);
}

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

function compactAssistantToolTurn(message: Message): Message {
	if (message.role !== "assistant" || !message.content.some((item) => item.type === "toolCall")) return message;
	return {
		...message,
		content: message.content.filter((item) => item.type === "toolCall"),
	};
}

function assistantToolNarrative(message: Message): string {
	if (message.role !== "assistant" || !message.content.some((item) => item.type === "toolCall")) return "";
	return message.content
		.filter((item) => item.type === "text" || item.type === "thinking")
		.map((item) => (item.type === "text" ? item.text : item.thinking))
		.join("\n");
}

function sourceIds(units: readonly SourceUnit[]): readonly string[] {
	return [...new Set(units.map((unit) => unit.source_event_id))];
}

function sourceKey(unit: SourceUnit): string {
	return `${unit.source_event_id}:${unit.source_sha256}`;
}

function freeTextBlock(units: readonly SourceUnit[]): string {
	return units.map((unit) => `[${unit.source_event_id}]\n${unit.text}`).join("\n\n");
}

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

/** Deterministically retrieve, protect, condense, and materialize one L0 view. */
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

	/** Bind one assembler to its attempt store and frozen policy. */
	constructor(store: RepoFixMemoryStore, policy: LayeredMemoryPolicy) {
		this.store = store;
		this.policy = policy;
	}

	/** Install the independently supervised condenser before the first Agent request. */
	setCondenser(condenser: MemoryCondenser): void {
		this.condenser = condenser;
	}

	/** Reset request-view state at an externally selected stage boundary. */
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

	/** Build and persist the exact Provider Context used by one Agent request. */
	async assemble(input: AssemblyInput): Promise<Context> {
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
		const selectorText = `${query}\n${latestAssistant === undefined ? "" : messageText(latestAssistant)}`;
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
		for (const record of this.store.listL1()) {
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
		for (const [path, group] of [...fileViewGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			const selectedChunkIds = new Set(
				group
					.flatMap((item) => item.view.chunks)
					.filter((chunk) => selectorText.includes(chunk.chunk_id))
					.map((chunk) => chunk.chunk_id),
			);
			const lineRanges = requestedLineRanges(selectorText, path);
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

	/** Return assembler-only overhead. */
	get metrics(): RepoFixMemoryAssemblerMetrics {
		return {
			memory_assemble_ms: this.assembleMs,
			token_count_ms: this.tokenCountMs,
			condenser_wait_ms: this.condenserWaitMs,
			compression_trigger_count: this.compressionTriggers,
		};
	}
}

/** RepoFix-facing lifecycle wrapper that keeps memory out of stage decisions. */
export class RepoFixMemoryRuntime {
	private readonly store: RepoFixMemoryStore;
	private readonly assembler: RepoFixContextAssembler;
	private historyMessageCount = 0;
	private activeStage: RepoFixStage | null = null;
	private failure: Error | null = null;
	private currentRequestId: string | null = null;

	/** Bind storage and assembly for one attempt. */
	constructor(store: RepoFixMemoryStore, assembler: RepoFixContextAssembler) {
		this.store = store;
		this.assembler = assembler;
	}

	/** Save the original task input before stage execution. */
	async initialize(problemStatement: string): Promise<void> {
		await this.store.writeTaskInput(problemStatement);
	}

	/** Start memory collection at an externally supplied stage boundary. */
	startStage(stage: RepoFixStage, stageSequence: number, historyMessageCount: number): void {
		this.store.startStage(stage, stageSequence);
		this.assembler.startStage(stage);
		this.activeStage = stage;
		this.historyMessageCount = historyMessageCount;
		this.currentRequestId = null;
	}

	/** Assemble a Provider Context without changing RepoFix stage state. */
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

	/** Save complete raw evidence from one tool the Worker already executed. */
	async appendToolEvidence(input: MemoryToolEvidenceInput): Promise<void> {
		try {
			await this.store.appendToolEvidence(input);
		} catch (error) {
			this.failure = error instanceof Error ? error : new Error(String(error));
		}
	}

	/** Capture final stage messages and append the strict completion artifact to L1. */
	async completeStage(messages: readonly unknown[], completion: StageCompletion): Promise<void> {
		this.assertHealthy();
		await this.store.captureMessages(messages.slice(this.historyMessageCount));
		await this.store.completeStage(completion);
		this.activeStage = null;
		this.currentRequestId = null;
	}

	/** Install the independently supervised model summary callback. */
	setCondenser(condenser: MemoryCondenser): void {
		this.assembler.setCondenser(condenser);
	}

	/** Return storage and assembly overhead without Provider-token duplication. */
	get metrics(): RepoFixMemoryMetrics {
		return { ...this.store.metrics, ...this.assembler.metrics };
	}

	/** Provider-request identity of the most recently assembled L0 view. */
	get current_request_id(): string | null {
		return this.currentRequestId;
	}

	private assertHealthy(): void {
		if (this.failure !== null) throw new Error(`${MEMORY_INFRASTRUCTURE_ERROR}: ${this.failure.message}`);
	}
}

/** Hash one exact assembled context for deterministic snapshot assertions. */
export function assembledContextSha256(context: Context): string {
	return canonicalContractSha256(jsonSerializable(context));
}
