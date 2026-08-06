import { canonicalContractSha256 } from "./run-contracts.ts";

/** Memory policies compared by the paired RepoFix experiment. */
export type RepoFixMemoryPolicyId = "legacy-context-v1" | "layered-memory-v1";

/** Cumulative evidence coverage derived from append-only L2 events. */
export type MemoryCoverageStatus = "complete" | "partial_known" | "partial_unknown";

/** Stable reference from one memory object to an immutable artifact. */
export interface MemoryArtifactRef {
	readonly artifact_id: string;
	readonly sha256: string;
}

/** One line interval covered by a file-oriented evidence event. */
export interface MemoryLineRange {
	readonly start_line: number;
	readonly end_line: number;
}

/** Immutable append-only L2 event payload. */
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
	/** Repository state after this event's already-executed tool effect. */
	readonly repository_revision: number;
	/** Version of the explicitly addressed path, when one exists. */
	readonly path_revision: number | null;
	/** Mechanical identity used to merge equivalent current-view evidence. */
	readonly logical_evidence_key: string | null;
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

/** Hash-bound L2 event stored in one immutable artifact. */
export type MemoryL2Event = MemoryL2EventPayload & { readonly sha256: string };

/** Immutable stage handoff appended to L1 after strict stage completion. */
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

/** Hash-bound L1 handoff record. */
export type MemoryL1Record = MemoryL1Payload & { readonly sha256: string };

/** One structured value copied mechanically instead of summarized by a model. */
export interface MemoryProtectedEntry {
	readonly source_event_id: string;
	readonly pointer: string;
	readonly ordinal: number;
	readonly value: unknown;
	readonly source_sha256: string;
}

/** Deterministic protected index included in every layered L0 view. */
export interface MemoryProtectedIndex {
	readonly entries: readonly MemoryProtectedEntry[];
	readonly source_count: number;
	readonly sha256: string;
}

/** Model-generated summary of one exact delta and its optional prior condensation. */
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

/** Hash-bound semantic summary stored as a derived L2 artifact. */
export type MemoryCondensation = MemoryCondensationPayload & { readonly sha256: string };

/** Facts mechanically projected from already executed current-stage events. */
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
	readonly latest_verification_ref: MemoryArtifactRef | null;
}

/** Audit snapshot for one fully assembled L0 request view. */
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
	/** Incremental L0 view before an optional condensation on this request. */
	readonly uncompressed_context_sha256: string;
	readonly assembled_context_sha256: string;
	readonly uncompressed_context_tokens: number;
	readonly assembled_context_tokens: number;
	readonly loaded_chunks: readonly string[];
	readonly unloaded_ranges: readonly string[];
	readonly policy_sha256: string;
}

/** Hash-bound L0 audit snapshot. */
export type MemoryL0Snapshot = MemoryL0Payload & { readonly sha256: string };

/** Versioned deterministic assembly and compression policy. */
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

/** Create the frozen v1 memory policy bound to the active model specification. */
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

/** Attach a canonical SHA-256 without including that field in its own input. */
export function bindMemorySha256<T extends object>(payload: T): T & { readonly sha256: string } {
	return { ...payload, sha256: canonicalContractSha256(payload) };
}

/** Verify one hash-bound memory payload after removing its outer SHA-256. */
export function verifyMemorySha256(value: object & { readonly sha256: string }): void {
	const { sha256, ...payload } = value;
	if (sha256 !== canonicalContractSha256(payload)) throw new Error("Memory artifact canonical SHA-256 is invalid");
}
