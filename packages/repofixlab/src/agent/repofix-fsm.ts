import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { RepoFixStage, RepoFixWorkflowConfig } from "./repofix-config.ts";

const EvidenceSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const ShortTextSchema = Type.String({ minLength: 1, maxLength: 8_192 });
const TextListSchema = Type.Array(ShortTextSchema, { minItems: 1, maxItems: 32 });
const OptionalTextListSchema = Type.Array(ShortTextSchema, { minItems: 0, maxItems: 32 });
const JsonEncodedStructuredValueSchema = Type.String({ minLength: 2, maxLength: 262_144 });
const WireTextListSchema = Type.Union([TextListSchema, JsonEncodedStructuredValueSchema]);
const WireOptionalTextListSchema = Type.Union([OptionalTextListSchema, JsonEncodedStructuredValueSchema]);

const UnderstandCompletionSchema = Type.Object(
	{
		stage: Type.Literal("UNDERSTAND"),
		problem_summary: ShortTextSchema,
		expected_behavior: TextListSchema,
		constraints: TextListSchema,
		acceptance_evidence: TextListSchema,
	},
	{ additionalProperties: false },
);

const LocalizeCandidateSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 4_096 }),
		symbol: Type.String({ minLength: 1, maxLength: 1_024 }),
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

const PreservationInvariantSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
		scope: ShortTextSchema,
		preserved_behavior: ShortTextSchema,
		counterexample: ShortTextSchema,
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

const PlanObligationSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
		code_scope: ShortTextSchema,
		required_change: ShortTextSchema,
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

const ObligationDispositionSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
		status: Type.Union([Type.Literal("implemented"), Type.Literal("ruled_out"), Type.Literal("blocked")]),
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

const PreservationDispositionSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
		status: Type.Literal("verified"),
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

const LocalizeCompletionSchema = Type.Object(
	{
		stage: Type.Literal("LOCALIZE"),
		candidates: Type.Array(LocalizeCandidateSchema, { minItems: 1, maxItems: 16 }),
		exclusions: OptionalTextListSchema,
	},
	{ additionalProperties: false },
);

const PlanCompletionSchema = Type.Object(
	{
		stage: Type.Literal("PLAN"),
		minimal_change_steps: TextListSchema,
		obligations: Type.Array(PlanObligationSchema, { minItems: 1, maxItems: 16 }),
		risks: TextListSchema,
		preservation_invariants: Type.Array(PreservationInvariantSchema, { minItems: 1, maxItems: 16 }),
		state_transition_checks: TextListSchema,
		verification_candidate_id: Type.String({ minLength: 1, maxLength: 160 }),
	},
	{ additionalProperties: false },
);

const ImplementCompletionSchema = Type.Object(
	{
		stage: Type.Literal("IMPLEMENT"),
		change_summary: TextListSchema,
		obligation_dispositions: Type.Array(ObligationDispositionSchema, { minItems: 1, maxItems: 16 }),
	},
	{ additionalProperties: false },
);

const Refine1CompletionSchema = Type.Object(
	{
		stage: Type.Literal("REFINE_1"),
		feedback_assessment: ShortTextSchema,
		revision_summary: TextListSchema,
	},
	{ additionalProperties: false },
);

const Refine2CompletionSchema = Type.Object(
	{
		stage: Type.Literal("REFINE_2"),
		feedback_assessment: ShortTextSchema,
		revision_summary: TextListSchema,
	},
	{ additionalProperties: false },
);

const SelfReviewCompletionSchema = Type.Object(
	{
		stage: Type.Literal("SELF_REVIEW"),
		diff_checklist: TextListSchema,
		remaining_risks: TextListSchema,
		risk_disposition: TextListSchema,
		obligation_dispositions: Type.Array(ObligationDispositionSchema, { minItems: 1, maxItems: 16 }),
		preservation_dispositions: Type.Array(PreservationDispositionSchema, { minItems: 1, maxItems: 16 }),
	},
	{ additionalProperties: false },
);

const UnderstandCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("UNDERSTAND"),
		problem_summary: ShortTextSchema,
		expected_behavior: WireTextListSchema,
		constraints: WireTextListSchema,
		acceptance_evidence: WireTextListSchema,
	},
	{ additionalProperties: false },
);

const LocalizeCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("LOCALIZE"),
		candidates: Type.Union([
			Type.Array(LocalizeCandidateSchema, { minItems: 1, maxItems: 16 }),
			JsonEncodedStructuredValueSchema,
		]),
		exclusions: WireOptionalTextListSchema,
	},
	{ additionalProperties: false },
);

const PlanCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("PLAN"),
		minimal_change_steps: WireTextListSchema,
		obligations: Type.Union([Type.Array(PlanObligationSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema]),
		risks: WireTextListSchema,
		preservation_invariants: Type.Union([
			Type.Array(PreservationInvariantSchema, { minItems: 1, maxItems: 16 }),
			JsonEncodedStructuredValueSchema,
		]),
		state_transition_checks: WireTextListSchema,
		verification_candidate_id: Type.String({ minLength: 1, maxLength: 160 }),
	},
	{ additionalProperties: false },
);

const ImplementCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("IMPLEMENT"),
		change_summary: WireTextListSchema,
		obligation_dispositions: Type.Union([Type.Array(ObligationDispositionSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema]),
	},
	{ additionalProperties: false },
);

const Refine1CompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("REFINE_1"),
		feedback_assessment: ShortTextSchema,
		revision_summary: WireTextListSchema,
	},
	{ additionalProperties: false },
);

const Refine2CompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("REFINE_2"),
		feedback_assessment: ShortTextSchema,
		revision_summary: WireTextListSchema,
	},
	{ additionalProperties: false },
);

const SelfReviewCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("SELF_REVIEW"),
		diff_checklist: WireTextListSchema,
		remaining_risks: WireTextListSchema,
		risk_disposition: WireTextListSchema,
		obligation_dispositions: Type.Union([Type.Array(ObligationDispositionSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema]),
		preservation_dispositions: Type.Union([Type.Array(PreservationDispositionSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema]),
	},
	{ additionalProperties: false },
);

/**
 * Provider tool-call serializers disagree about nested arrays and objects.
 * This intentionally permissive boundary guarantees malformed payloads reach
 * RepoFix's normalizer and controller recovery path. The FSM still validates
 * the exact stage artifact before changing state.
 */
const StageCompletionWireSchema = Type.Object(
	{
		stage: Type.Union([
			Type.Literal("UNDERSTAND"),
			Type.Literal("LOCALIZE"),
			Type.Literal("PLAN"),
			Type.Literal("IMPLEMENT"),
			Type.Literal("REFINE_1"),
			Type.Literal("REFINE_2"),
			Type.Literal("SELF_REVIEW"),
		]),
	},
	{ additionalProperties: true },
);

const UnderstandCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("UNDERSTAND"),
		problem_summary: Type.Optional(ShortTextSchema),
		expected_behavior: Type.Optional(WireTextListSchema),
		constraints: Type.Optional(WireTextListSchema),
		acceptance_evidence: Type.Optional(WireTextListSchema),
	},
	{ additionalProperties: true },
);

const LocalizeCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("LOCALIZE"),
		candidates: Type.Optional(Type.Union([Type.Array(LocalizeCandidateSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema])),
		exclusions: Type.Optional(WireOptionalTextListSchema),
	},
	{ additionalProperties: true },
);

const PlanCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("PLAN"),
		minimal_change_steps: Type.Optional(WireTextListSchema),
		obligations: Type.Optional(Type.Union([Type.Array(PlanObligationSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema])),
		risks: Type.Optional(WireTextListSchema),
		preservation_invariants: Type.Optional(
			Type.Union([Type.Array(PreservationInvariantSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema]),
		),
		state_transition_checks: Type.Optional(WireTextListSchema),
		verification_candidate_id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
	},
	{ additionalProperties: true },
);

const ImplementCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("IMPLEMENT"),
		change_summary: Type.Optional(WireTextListSchema),
		obligation_dispositions: Type.Optional(Type.Union([Type.Array(ObligationDispositionSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema])),
	},
	{ additionalProperties: true },
);

const Refine1CompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("REFINE_1"),
		feedback_assessment: Type.Optional(ShortTextSchema),
		revision_summary: Type.Optional(WireTextListSchema),
	},
	{ additionalProperties: true },
);

const Refine2CompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("REFINE_2"),
		feedback_assessment: Type.Optional(ShortTextSchema),
		revision_summary: Type.Optional(WireTextListSchema),
	},
	{ additionalProperties: true },
);

const SelfReviewCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("SELF_REVIEW"),
		diff_checklist: Type.Optional(WireTextListSchema),
		remaining_risks: Type.Optional(WireTextListSchema),
		risk_disposition: Type.Optional(WireTextListSchema),
		obligation_dispositions: Type.Optional(Type.Union([Type.Array(ObligationDispositionSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema])),
		preservation_dispositions: Type.Optional(Type.Union([Type.Array(PreservationDispositionSchema, { minItems: 1, maxItems: 16 }), JsonEncodedStructuredValueSchema])),
	},
	{ additionalProperties: true },
);

const STAGE_COMPLETION_WIRE_SCHEMAS = {
	UNDERSTAND: UnderstandCompletionWireSchema,
	LOCALIZE: LocalizeCompletionWireSchema,
	PLAN: PlanCompletionWireSchema,
	IMPLEMENT: ImplementCompletionWireSchema,
	REFINE_1: Refine1CompletionWireSchema,
	REFINE_2: Refine2CompletionWireSchema,
	SELF_REVIEW: SelfReviewCompletionWireSchema,
} as const;

const STAGE_COMPLETION_ARTIFACT_REQUIREMENTS: Record<RepoFixStage, string> = {
	UNDERSTAND: 'For UNDERSTAND call stage_complete with exactly {"stage":"UNDERSTAND","problem_summary":"...","expected_behavior":["..."],"constraints":["..."],"acceptance_evidence":["..."]}.',
	LOCALIZE: 'For LOCALIZE call stage_complete with exactly {"stage":"LOCALIZE","candidates":[{"path":"src/file.ts","symbol":"target","evidence":"why this code is relevant"}],"exclusions":["..."]}; use an empty exclusions array when no relevant alternatives were excluded.',
	PLAN: 'For PLAN call stage_complete with exactly {"stage":"PLAN","minimal_change_steps":["..."],"obligations":[{"id":"obligation-id","code_scope":"repository code site","required_change":"required semantic outcome","evidence":"repository evidence"}],"risks":["..."],"preservation_invariants":[{"id":"invariant-id","scope":"affected branch or neighbor","preserved_behavior":"must remain true","counterexample":"observable behavior that would falsify it","evidence":"repository evidence"}],"state_transition_checks":["callback/re-entry state ordering, or not applicable with evidence"],"verification_candidate_id":"controller-provided-id"}.',
	IMPLEMENT: 'For IMPLEMENT call stage_complete with exactly {"stage":"IMPLEMENT","change_summary":["..."],"obligation_dispositions":[{"id":"PLAN obligation id","status":"implemented|ruled_out|blocked","evidence":"diff or repository evidence"}]}.',
	REFINE_1: 'For REFINE_1 call stage_complete with exactly {"stage":"REFINE_1","feedback_assessment":"...","revision_summary":["..."]}.',
	REFINE_2: 'For REFINE_2 call stage_complete with exactly {"stage":"REFINE_2","feedback_assessment":"...","revision_summary":["..."]}.',
	SELF_REVIEW: 'For SELF_REVIEW call stage_complete with exactly {"stage":"SELF_REVIEW","diff_checklist":["..."],"remaining_risks":["..."],"risk_disposition":["..."],"obligation_dispositions":[{"id":"PLAN obligation id","status":"implemented|ruled_out|blocked","evidence":"diff or repository evidence"}],"preservation_dispositions":[{"id":"PLAN invariant id","status":"verified","evidence":"diff and repository/test evidence"}]}.',
};

export const StageCompletionSchema = Type.Union([
	UnderstandCompletionSchema,
	LocalizeCompletionSchema,
	PlanCompletionSchema,
	ImplementCompletionSchema,
	Refine1CompletionSchema,
	Refine2CompletionSchema,
	SelfReviewCompletionSchema,
]);

export const STAGE_COMPLETION_SCHEMAS = {
	UNDERSTAND: UnderstandCompletionSchema,
	LOCALIZE: LocalizeCompletionSchema,
	PLAN: PlanCompletionSchema,
	IMPLEMENT: ImplementCompletionSchema,
	REFINE_1: Refine1CompletionSchema,
	REFINE_2: Refine2CompletionSchema,
	SELF_REVIEW: SelfReviewCompletionSchema,
} as const;

const STAGE_COMPLETION_TOOL_SCHEMAS = {
	UNDERSTAND: UnderstandCompletionToolSchema,
	LOCALIZE: LocalizeCompletionToolSchema,
	PLAN: PlanCompletionToolSchema,
	IMPLEMENT: ImplementCompletionToolSchema,
	REFINE_1: Refine1CompletionToolSchema,
	REFINE_2: Refine2CompletionToolSchema,
	SELF_REVIEW: SelfReviewCompletionToolSchema,
} as const;

export const StageCompletionToolSchema = Type.Union([
	UnderstandCompletionToolSchema,
	LocalizeCompletionToolSchema,
	PlanCompletionToolSchema,
	ImplementCompletionToolSchema,
	Refine1CompletionToolSchema,
	Refine2CompletionToolSchema,
	SelfReviewCompletionToolSchema,
]);

export function stageCompletionSchema(stage: RepoFixStage) {
	return STAGE_COMPLETION_SCHEMAS[stage];
}

export function stageCompletionToolSchema(stage: RepoFixStage) {
	return STAGE_COMPLETION_TOOL_SCHEMAS[stage];
}

export function stageCompletionWireSchema(stage: RepoFixStage) {
	return STAGE_COMPLETION_WIRE_SCHEMAS[stage];
}

export function stageCompletionArtifactRequirement(stage: RepoFixStage): string {
	return STAGE_COMPLETION_ARTIFACT_REQUIREMENTS[stage];
}

export type StageCompletion = Static<typeof StageCompletionSchema>;
export const REPOFIX_STAGE_COMPLETE_TOOL_NAME = "stage_complete";
export const REPOFIX_TOOL_NAMES = [
	"repo_list",
	"repo_read",
	"repo_search",
	"repo_edit",
	"repo_exec",
	"repo_diff",
	REPOFIX_STAGE_COMPLETE_TOOL_NAME,
] as const;
export type RepoFixToolName = (typeof REPOFIX_TOOL_NAMES)[number];

const completionValidators = {
	UNDERSTAND: Compile(UnderstandCompletionSchema),
	LOCALIZE: Compile(LocalizeCompletionSchema),
	PLAN: Compile(PlanCompletionSchema),
	IMPLEMENT: Compile(ImplementCompletionSchema),
	REFINE_1: Compile(Refine1CompletionSchema),
	REFINE_2: Compile(Refine2CompletionSchema),
	SELF_REVIEW: Compile(SelfReviewCompletionSchema),
} as const;

function assertObligationDispositionCoverage(
	stage: "IMPLEMENT" | "SELF_REVIEW",
	plan: Extract<StageCompletion, { stage: "PLAN" }>,
	dispositions: ReadonlyArray<{
		readonly id: string;
		readonly status: "implemented" | "ruled_out" | "blocked";
		readonly evidence: string;
	}>,
): void {
	const planned = new Set(plan.obligations.map((obligation) => obligation.id));
	const supplied = new Set(dispositions.map((disposition) => disposition.id));
	if (planned.size !== plan.obligations.length || supplied.size !== dispositions.length || planned.size !== supplied.size) {
		throw new Error(`${stage} obligation dispositions must provide each PLAN obligation exactly once`);
	}
	for (const id of planned) {
		if (!supplied.has(id)) throw new Error(`${stage} obligation disposition is missing PLAN obligation ${id}`);
	}
	if (dispositions.some((disposition) => disposition.status === "blocked")) {
		throw new Error(`${stage} cannot complete with a blocked PLAN obligation`);
	}
}

function assertSelfReviewCoverage(
	plan: Extract<StageCompletion, { stage: "PLAN" }>,
	completion: Extract<StageCompletion, { stage: "SELF_REVIEW" }>,
): void {
	assertObligationDispositionCoverage("SELF_REVIEW", plan, completion.obligation_dispositions);
	const plannedIds = new Set(plan.preservation_invariants.map((invariant) => invariant.id));
	const suppliedIds = new Set(completion.preservation_dispositions.map((disposition) => disposition.id));
	if (
		plannedIds.size !== plan.preservation_invariants.length ||
		suppliedIds.size !== completion.preservation_dispositions.length ||
		plannedIds.size !== suppliedIds.size
	) {
		throw new Error("SELF_REVIEW preservation dispositions must provide each PLAN invariant exactly once");
	}
	for (const id of plannedIds) {
		if (!suppliedIds.has(id)) throw new Error(`SELF_REVIEW preservation disposition is missing PLAN invariant ${id}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStructuredFields(
	value: Record<string, unknown>,
	fields: readonly string[],
	plainTextListFields: readonly string[] = [],
): Record<string, unknown> {
	const normalized = { ...value };
	for (const field of fields) {
		const supplied = normalized[field];
		if (typeof supplied !== "string") continue;
		try {
			const parsed: unknown = JSON.parse(supplied);
			normalized[field] = parsed;
		} catch {
			if (plainTextListFields.includes(field)) {
				normalized[field] = [supplied];
				continue;
			}
			throw new Error(`stage_complete field ${field} must be native JSON or a valid JSON-encoded value`);
		}
	}
	return normalized;
}

function normalizeLocalizeCandidates(value: Record<string, unknown>): Record<string, unknown> {
	const normalized = normalizeStructuredFields(value, ["candidates", "exclusions"], ["exclusions"]);
	if (!Array.isArray(normalized.candidates)) return normalized;
	normalized.candidates = normalized.candidates.map((candidate) => {
		if (typeof candidate !== "string") return candidate;
		try {
			const parsed: unknown = JSON.parse(candidate);
			return parsed;
		} catch {
			throw new Error(
				"LOCALIZE candidates must be objects with path, symbol, and evidence fields; prose descriptions cannot be converted safely",
			);
		}
	});
	return normalized;
}

/**
 * Some OpenAI-compatible providers serialize nested tool arguments as JSON
 * strings. Convert only known structured completion fields, then validate the
 * exact v1 artifact schema before allowing a stage transition.
 */
export function normalizeStageCompletionParams(value: unknown): unknown {
	if (!isRecord(value) || typeof value.stage !== "string") return value;
	switch (value.stage) {
		case "UNDERSTAND":
			return normalizeStructuredFields(
				value,
				["expected_behavior", "constraints", "acceptance_evidence"],
				["expected_behavior", "constraints", "acceptance_evidence"],
			);
		case "LOCALIZE":
			return normalizeLocalizeCandidates(value);
		case "PLAN":
			return normalizeStructuredFields(
				value,
				["minimal_change_steps", "obligations", "risks", "preservation_invariants", "state_transition_checks"],
				["minimal_change_steps", "risks", "state_transition_checks"],
			);
		case "IMPLEMENT":
			return normalizeStructuredFields(value, ["change_summary", "obligation_dispositions"], ["change_summary"]);
		case "REFINE_1":
		case "REFINE_2":
			return normalizeStructuredFields(value, ["revision_summary"], ["revision_summary"]);
		case "SELF_REVIEW":
			return normalizeStructuredFields(
				value,
				["diff_checklist", "remaining_risks", "risk_disposition", "obligation_dispositions", "preservation_dispositions"],
				["diff_checklist", "remaining_risks", "risk_disposition"],
			);
		default:
			return value;
	}
}

function stageTools(_config: RepoFixWorkflowConfig, stage: RepoFixStage): readonly RepoFixToolName[] {
	const completion = [REPOFIX_STAGE_COMPLETE_TOOL_NAME] as const;
	switch (stage) {
		case "UNDERSTAND":
			return ["repo_list", "repo_read", "repo_search", ...completion];
		case "LOCALIZE":
			return ["repo_read", "repo_search", ...completion];
		case "PLAN":
			return ["repo_read", "repo_search", "repo_diff", ...completion];
		case "IMPLEMENT":
			return ["repo_read", "repo_search", "repo_edit", "repo_diff", ...completion];
		case "REFINE_1":
		case "REFINE_2":
			return ["repo_read", "repo_search", "repo_edit", "repo_diff", ...completion];
		case "SELF_REVIEW":
			return ["repo_read", "repo_diff", ...completion];
	}
}

export class RepoFixStageMachine {
	private readonly completions = new Map<RepoFixStage, StageCompletion>();
	private active: RepoFixStage | null = null;
	private completionOnly = false;
	private readonly config: RepoFixWorkflowConfig;

	constructor(config: RepoFixWorkflowConfig) {
		if (config.workflow_kind !== "repofix") {
			throw new Error("RepoFixStageMachine requires a RepoFix workflow configuration");
		}
		this.config = config;
	}

	get workflowConfig(): RepoFixWorkflowConfig {
		return this.config;
	}

	get activeStage(): RepoFixStage | null {
		return this.active;
	}

	get completedStages(): readonly RepoFixStage[] {
		return this.config.stages.filter((stage) => this.completions.has(stage));
	}

	start(stage: RepoFixStage): void {
		const expected = this.config.stages[this.completions.size];
		if (this.active !== null || expected !== stage) {
			throw new Error(`Cannot start ${stage}; expected ${expected ?? "no further stage"}`);
		}
		this.active = stage;
		this.completionOnly = false;
	}

	allowedTools(): readonly RepoFixToolName[] {
		if (this.active === null) throw new Error("No RepoFix stage is active");
		if (this.completionOnly) return [REPOFIX_STAGE_COMPLETE_TOOL_NAME];
		return stageTools(this.config, this.active);
	}

	restrictToCompletion(stage: RepoFixStage): void {
		if (this.active !== stage || this.completions.has(stage)) {
			throw new Error(`Cannot restrict ${stage} to completion-only mode`);
		}
		this.completionOnly = true;
	}

	complete(value: unknown): StageCompletion {
		if (this.active === null) throw new Error("stage_complete is not valid without an active stage");
		const validator = completionValidators[this.active];
		if (!validator.Check(value)) {
			const violation = validator.Errors(value)[0];
			const location = violation === undefined || violation.instancePath.length === 0
				? "payload"
				: `payload${violation.instancePath}`;
			const detail = violation === undefined ? "does not match the required structure" : violation.message;
			throw new Error(`stage_complete payload violates the v1 stage schema at ${location}: ${detail}. ${stageCompletionArtifactRequirement(this.active)}`);
		}
		const completion = value as StageCompletion;
		if (completion.stage !== this.active) {
			throw new Error(`stage_complete declared ${completion.stage} while ${this.active} is active`);
		}
		if (completion.stage === "IMPLEMENT") {
			const plan = this.completions.get("PLAN");
			if (plan === undefined || plan.stage !== "PLAN") throw new Error("IMPLEMENT reached without a completed PLAN artifact");
			assertObligationDispositionCoverage("IMPLEMENT", plan, completion.obligation_dispositions);
		}
		if (completion.stage === "SELF_REVIEW") {
			const plan = this.completions.get("PLAN");
			if (plan === undefined || plan.stage !== "PLAN") throw new Error("SELF_REVIEW reached without a completed PLAN artifact");
			assertSelfReviewCoverage(plan, completion);
		}
		this.completions.set(this.active, completion);
		this.active = null;
		this.completionOnly = false;
		return completion;
	}

	assertComplete(stage: RepoFixStage): StageCompletion {
		const completion = this.completions.get(stage);
		if (completion === undefined) throw new Error(`RepoFix stage ${stage} did not complete`);
		return completion;
	}

	isComplete(stage: RepoFixStage): boolean {
		return this.completions.has(stage);
	}

	isFinished(): boolean {
		return this.active === null && this.completions.size === this.config.stages.length;
	}
}

export function isRepoFixToolName(value: string): value is RepoFixToolName {
	return (REPOFIX_TOOL_NAMES as readonly string[]).includes(value);
}

export function createStageCompleteTool(machine: RepoFixStageMachine): ToolDefinition {
	return defineTool({
		name: REPOFIX_STAGE_COMPLETE_TOOL_NAME,
		label: "Complete RepoFix stage",
		description:
			"Submit the required structured artifact for the current RepoFix stage. It must be the only tool call in its assistant message.",
		promptSnippet: "Complete the current RepoFix stage with its required structured artifact",
		parameters: StageCompletionWireSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const completion = machine.complete(normalizeStageCompletionParams(params));
			return {
				content: [{ type: "text" as const, text: `Completed ${completion.stage}.` }],
				details: completion,
			};
		},
	});
}
