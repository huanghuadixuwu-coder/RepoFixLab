import { createHash } from "node:crypto";
import { extname } from "node:path";
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
import type { StoreArtifactOptions, StoredArtifact } from "../storage/artifact-store.ts";

/** Minimal existing ArtifactStore surface used by memory persistence. */
export interface MemoryArtifactStore {
	writeNew(path: string, content: string | Uint8Array, options: StoreArtifactOptions): Promise<StoredArtifact>;
}

/** Repository-tool evidence accepted from the existing Agent hook. */
export interface MemoryToolEvidenceInput {
	readonly tool_call_id: string;
	readonly tool_name: string;
	readonly normalized_input: unknown;
	readonly controller_result: unknown;
}

/** One stored current-stage message and its stable event identity. */
export interface MemoryMessageSource {
	readonly event: MemoryL2Event;
	readonly message_index: number;
}

/** One deterministic source-file chunk available for L0 retrieval. */
export interface MemoryFileChunk {
	readonly chunk_id: string;
	readonly path: string;
	readonly path_revision: number;
	readonly start_line: number;
	readonly end_line: number;
	readonly content: string;
	readonly source_sha256: string;
	readonly sha256: string;
}

/** Structure and chunks derived only from source text already present in L2. */
export interface MemoryFileViewPayload {
	readonly schema_version: "v1";
	readonly memory_type: "file_view";
	readonly path: string;
	readonly repository_revision: number;
	readonly path_revision: number;
	readonly logical_evidence_key: string;
	readonly source_sha256: string;
	readonly coverage_key: string;
	readonly coverage_status: MemoryCoverageStatus;
	readonly structure: readonly {
		readonly kind: string;
		readonly name: string;
		readonly start_line: number;
		readonly end_line: number;
	}[];
	readonly chunks: readonly MemoryFileChunk[];
}

/** Hash-bound file view stored as a derived L2 artifact. */
export type MemoryFileView = MemoryFileViewPayload & { readonly sha256: string };

/** One derived file view with stable source-event and tool-call provenance. */
export interface MemoryFileViewRecord {
	readonly view: MemoryFileView;
	readonly ref: MemoryArtifactRef;
	readonly source_event_ids: readonly string[];
	readonly stage_sequence: number;
	readonly event_sequence: number;
	readonly tool_call_ids: readonly string[];
}

/** One current repository-version evidence body with all equivalent L2 sources. */
export interface MemoryActiveEvidenceRecord {
	readonly logical_evidence_key: string;
	readonly event: MemoryL2Event;
	readonly source_event_ids: readonly string[];
	readonly tool_call_ids: readonly string[];
}

/** Local memory overhead accumulated without adding a second metric system. */
export interface RepoFixMemoryStoreMetrics {
	readonly memory_store_ms: number;
	readonly l2_bytes: number;
	readonly l1_records: number;
	readonly l2_events: number;
	readonly condensation_count: number;
}

/** Cumulative coverage derived from every immutable event sharing one key. */
export interface MemoryCoverageView {
	readonly coverage_key: string;
	readonly coverage_type: MemoryL2EventPayload["coverage_type"];
	readonly coverage_status: MemoryCoverageStatus;
	readonly covered_ranges: readonly MemoryLineRange[];
	readonly missing_ranges: readonly MemoryLineRange[] | null;
	readonly source_event_ids: readonly string[];
}

type ActiveStage = {
	readonly stage_id: RepoFixStage;
	readonly stage_sequence: number;
	next_event_sequence: number;
	captured_message_count: number;
	readonly message_events: MemoryMessageSource[];
	readonly evidence_refs: MemoryArtifactRef[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawSha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function explicitPath(value: unknown): string | null {
	if (!isRecord(value) || typeof value.path !== "string") return null;
	const path = value.path.trim().replaceAll("\\", "/");
	return path.length === 0 ? null : path;
}

function resultText(value: unknown, key: "stdout" | "stderr"): string {
	return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

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

function successfulRepoEdit(toolName: string, result: unknown): boolean {
	return toolName === "repo_edit" && isRecord(result) && result.exit_code === 0 && result.timed_out !== true;
}

function jsonSerializable(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? null : JSON.parse(serialized);
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function lineRange(input: unknown): readonly MemoryLineRange[] {
	if (!isRecord(input)) return [];
	const start = typeof input.start_line === "number" ? input.start_line : 1;
	const count = typeof input.line_count === "number" ? input.line_count : null;
	if (!Number.isSafeInteger(start) || start < 1 || count === null || !Number.isSafeInteger(count) || count < 1)
		return [];
	return [{ start_line: start, end_line: start + count - 1 }];
}

function toolCoverage(
	toolName: string,
	input: unknown,
	result: unknown,
): {
	readonly key: string;
	readonly type: MemoryL2EventPayload["coverage_type"];
	readonly status: MemoryCoverageStatus;
	readonly covered: readonly MemoryLineRange[];
	readonly missing: readonly MemoryLineRange[] | null;
	readonly truncated: boolean;
} {
	const resultRecord = isRecord(result) ? result : {};
	const truncated = resultRecord.truncated === true || resultRecord.timed_out === true;
	const inputRecord = isRecord(input) ? input : {};
	const target =
		toolName === "repo_read"
			? { tool: toolName, path: inputRecord.path ?? null, range_type: "file" }
			: toolName === "repo_search"
				? {
						tool: toolName,
						query: inputRecord.query ?? null,
						path: inputRecord.path ?? null,
						range_type: "results",
					}
				: { tool: toolName, input };
	const covered = toolName === "repo_read" ? lineRange(input) : [];
	const explicitlyPaged =
		toolName === "repo_read"
			? inputRecord.start_line !== undefined || inputRecord.line_count !== undefined
			: toolName === "repo_search";
	return {
		key: canonicalContractSha256(target),
		type:
			toolName === "repo_read"
				? explicitlyPaged || truncated
					? "file_range"
					: "full_file"
				: toolName === "repo_search"
					? "result_page"
					: toolName === "repo_list" || toolName === "repo_diff"
						? "full_result_set"
						: null,
		status: truncated || explicitlyPaged ? "partial_unknown" : "complete",
		covered,
		missing: null,
		truncated,
	};
}

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

function nodeName(node: ts.Node): string {
	if ("name" in node) {
		const name = (node as ts.Node & { readonly name?: ts.Node }).name;
		if (name !== undefined && ts.isIdentifier(name)) return name.text;
		if (name !== undefined && ts.isStringLiteral(name)) return name.text;
	}
	return ts.SyntaxKind[node.kind] ?? "unknown";
}

function fileStructure(path: string, content: string, startLine: number): MemoryFileViewPayload["structure"] {
	if (![".js", ".jsx", ".ts", ".tsx"].includes(extname(path).toLowerCase())) return [];
	const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, sourceFileKind(path));
	const entries: MemoryFileViewPayload["structure"][number][] = [];
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

function chunkFile(path: string, pathRevision: number, content: string, startLine: number): readonly MemoryFileChunk[] {
	const maxBytes = 4096 * 4;
	const overlapBytes = 256 * 4;
	const lines = content.split(/(?<=\n)/);
	const sourceSha256 = rawSha256(content);
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
		const chunkStart = startLine + cursor;
		const chunkEnd = startLine + end - 1;
		const payload = {
			path,
			path_revision: pathRevision,
			start_line: chunkStart,
			end_line: chunkEnd,
			content: value,
			source_sha256: sourceSha256,
		};
		chunks.push({
			chunk_id: `chunk-${sourceSha256.slice(0, 12)}-${String(chunks.length + 1).padStart(4, "0")}`,
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

/** Own append-only L1/L2 artifacts for one RepoFix attempt. */
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

	/** Bind memory artifacts to the existing immutable attempt store. */
	constructor(artifactStore: MemoryArtifactStore, taskId: string, attemptId: string) {
		if (taskId.length === 0 || attemptId.length === 0)
			throw new Error("Memory store task and attempt IDs are required");
		this.artifactStore = artifactStore;
		this.taskId = taskId;
		this.attemptId = attemptId;
	}

	/** Stable task identity copied into every memory artifact. */
	get task_id(): string {
		return this.taskId;
	}

	/** Stable attempt identity copied into every memory artifact. */
	get attempt_id(): string {
		return this.attemptId;
	}

	/** Persist the original task input once before any Provider request. */
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

	/** Start one externally selected stage with a fresh append sequence. */
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

	/** Append current-stage messages not seen by an earlier Provider request. */
	async captureMessages(messages: readonly unknown[]): Promise<readonly MemoryMessageSource[]> {
		const active = this.assertActive();
		for (let index = active.captured_message_count; index < messages.length; index += 1) {
			const message = messages[index];
			const event = await this.appendEvent({
				repository_revision: this.repositoryRevision,
				path_revision: null,
				logical_evidence_key: null,
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

	/** Append the complete Controller return for one already executed repository tool. */
	async appendToolEvidence(input: MemoryToolEvidenceInput): Promise<MemoryL2Event> {
		const path = explicitPath(input.normalized_input);
		if (successfulRepoEdit(input.tool_name, input.controller_result)) {
			this.repositoryRevision += 1;
			if (path !== null) this.pathRevisions.set(path, (this.pathRevisions.get(path) ?? 0) + 1);
		}
		const pathRevision = path === null ? null : (this.pathRevisions.get(path) ?? 0);
		const coverage = toolCoverage(input.tool_name, input.normalized_input, input.controller_result);
		const evidenceKey = logicalEvidenceKey(
			input.tool_name,
			input.normalized_input,
			input.controller_result,
			this.repositoryRevision,
			pathRevision,
		);
		const event = await this.appendEvent({
			repository_revision: this.repositoryRevision,
			path_revision: pathRevision,
			logical_evidence_key: evidenceKey,
			event_kind: "tool_evidence",
			tool_call_id: input.tool_call_id,
			tool_name: input.tool_name,
			normalized_input: jsonSerializable(input.normalized_input),
			message: null,
			controller_result: jsonSerializable(input.controller_result),
			coverage_key: coverage.key,
			coverage_type: coverage.type,
			coverage_status: coverage.status,
			covered_ranges: coverage.covered,
			missing_ranges: coverage.missing,
			controller_truncated: coverage.truncated,
			controller_result_bytes: Buffer.byteLength(JSON.stringify(jsonSerializable(input.controller_result)), "utf8"),
		});
		this.toolEventsByCallId.set(input.tool_call_id, event);
		const equivalent = this.evidenceEvents.get(evidenceKey) ?? [];
		equivalent.push(event);
		this.evidenceEvents.set(evidenceKey, equivalent);
		await this.maybeAppendFileView(event);
		return event;
	}

	/** Append the completed stage's full schema artifact and all stage evidence references to L1. */
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

	/** Return immutable completed-stage handoffs in stage order. */
	listL1(): readonly MemoryL1Record[] {
		return [...this.l1Records].sort((left, right) => left.stage_sequence - right.stage_sequence);
	}

	/** Return all current-stage message sources captured so far. */
	currentMessageSources(): readonly MemoryMessageSource[] {
		return [...this.assertActive().message_events];
	}

	/** Return every current-stage L2 reference accumulated before stage completion. */
	currentEvidenceRefs(): readonly MemoryArtifactRef[] {
		return [...this.assertActive().evidence_refs];
	}

	/** Current repository revision derived only from successful repo_edit returns. */
	get repository_revision(): number {
		return this.repositoryRevision;
	}

	/** Current version of one repository-relative path. */
	pathRevision(path: string): number {
		return this.pathRevisions.get(path.replaceAll("\\", "/")) ?? 0;
	}

	/** Resolve one already-executed tool call to its immutable L2 event. */
	toolEvent(toolCallId: string): MemoryL2Event | null {
		return this.toolEventsByCallId.get(toolCallId) ?? null;
	}

	/** Return one body per logical key for the current repository version. */
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

	/** Project current-stage activity facts without deciding an action. */
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

	/** Return L2 events addressed by immutable L1 evidence references. */
	readEvents(refs: readonly MemoryArtifactRef[]): readonly MemoryL2Event[] {
		return refs.flatMap((ref) => {
			const event = this.l2Events.get(ref.artifact_id);
			if (event === undefined) return [];
			if (event.sha256 !== ref.sha256) throw new Error(`Memory evidence SHA-256 mismatch: ${ref.artifact_id}`);
			return [event];
		});
	}

	/** Return file views already derived from complete or partial L2 source text. */
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

	/** Derive cumulative coverage without rewriting any source L2 event. */
	listCoverage(): readonly MemoryCoverageView[] {
		const groups = new Map<string, MemoryL2Event[]>();
		for (const event of this.l2Events.values()) {
			if (event.coverage_key === null || event.coverage_status === null) continue;
			const group = groups.get(event.coverage_key) ?? [];
			group.push(event);
			groups.set(event.coverage_key, group);
		}
		return [...groups.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([coverageKey, events]) => {
				const ordered = events.sort(
					(left, right) =>
						left.stage_sequence - right.stage_sequence || left.event_sequence - right.event_sequence,
				);
				const completeEvent = ordered.find((event) => event.coverage_status === "complete");
				const complete = completeEvent !== undefined;
				const knownMissing = ordered.flatMap((event) => event.missing_ranges ?? []);
				return {
					coverage_key: coverageKey,
					coverage_type: completeEvent?.coverage_type ?? ordered.at(-1)?.coverage_type ?? null,
					coverage_status: complete ? "complete" : knownMissing.length > 0 ? "partial_known" : "partial_unknown",
					covered_ranges: mergeRanges(ordered.flatMap((event) => event.covered_ranges)),
					missing_ranges: complete ? [] : knownMissing.length > 0 ? mergeRanges(knownMissing) : null,
					source_event_ids: ordered.map((event) => event.event_id),
				};
			});
	}

	/** Reuse a previously saved semantic summary for the exact same inputs. */
	findCondensation(inputSha256: string, querySha256: string, policySha256: string) {
		return this.condensations.get(`${inputSha256}:${querySha256}:${policySha256}`);
	}

	/** Append one derived semantic summary without replacing any source event. */
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

	/** Append one L0 audit snapshot keyed by the Provider request identity. */
	async saveL0(
		payload: MemoryL0Payload,
	): Promise<{ readonly value: MemoryL0Snapshot; readonly ref: MemoryArtifactRef }> {
		const value = bindMemorySha256(payload);
		const requestKey = canonicalContractSha256(payload.request_id);
		const ref = await this.writeJson(`memory/l2/l0/${requestKey}.json`, value, "internal");
		return { value, ref };
	}

	/** Report local storage overhead for the attempt summary. */
	get metrics(): RepoFixMemoryStoreMetrics {
		return {
			memory_store_ms: this.storeMs,
			l2_bytes: this.l2Bytes,
			l1_records: this.l1Records.length,
			l2_events: this.l2Events.size,
			condensation_count: this.condensations.size,
		};
	}

	private assertActive(): ActiveStage {
		if (this.active === null) throw new Error("No RepoFix memory stage is active");
		return this.active;
	}

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

	private async maybeAppendFileView(event: MemoryL2Event): Promise<void> {
		if (event.tool_name !== "repo_read" || !isRecord(event.normalized_input) || !isRecord(event.controller_result))
			return;
		const path = event.normalized_input.path;
		const content = event.controller_result.stdout;
		if (
			typeof path !== "string" ||
			typeof content !== "string" ||
			event.coverage_key === null ||
			content.length === 0
		)
			return;
		const startLine = typeof event.normalized_input.start_line === "number" ? event.normalized_input.start_line : 1;
		const payload: MemoryFileViewPayload = {
			schema_version: "v1",
			memory_type: "file_view",
			path,
			repository_revision: event.repository_revision,
			path_revision: event.path_revision ?? 0,
			logical_evidence_key:
				event.logical_evidence_key ?? canonicalContractSha256({ path, source_sha256: rawSha256(content) }),
			source_sha256: rawSha256(content),
			coverage_key: event.coverage_key,
			coverage_status: event.coverage_status ?? "partial_unknown",
			structure: fileStructure(path, content, startLine),
			chunks: chunkFile(path, event.path_revision ?? 0, content, startLine),
		};
		const view = bindMemorySha256(payload);
		const artifactId = `memory/l2/files/${view.sha256}.json`;
		const existing = this.fileViews.get(artifactId);
		if (existing !== undefined) {
			if (event.tool_call_id !== null) existing.tool_call_ids.add(event.tool_call_id);
			existing.source_event_ids.add(event.event_id);
			this.assertActive().evidence_refs.push(existing.ref);
			return;
		}
		const ref = await this.writeJson(artifactId, view, "internal");
		this.fileViews.set(artifactId, {
			view,
			ref,
			source_event_ids: new Set([event.event_id]),
			stage_sequence: event.stage_sequence,
			event_sequence: event.event_sequence,
			tool_call_ids: new Set(event.tool_call_id === null ? [] : [event.tool_call_id]),
		});
		this.assertActive().evidence_refs.push(ref);
	}

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

/** Parse and verify a memory record read outside the in-process store cache. */
export function parseMemoryRecord(content: string): object & { readonly sha256: string } {
	const value: unknown = JSON.parse(content);
	if (!isRecord(value) || typeof value.sha256 !== "string") throw new Error("Memory artifact is not hash-bound JSON");
	verifyMemorySha256(value as object & { readonly sha256: string });
	return value as object & { readonly sha256: string };
}
