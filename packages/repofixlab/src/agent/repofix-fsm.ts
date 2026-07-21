import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { RepoFixStage, RepoFixWorkflowConfig } from "./repofix-config.ts";

const EvidenceSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const ShortTextSchema = Type.String({ minLength: 1, maxLength: 8_192 });
const TextListSchema = Type.Array(ShortTextSchema, { minItems: 1, maxItems: 32 });
const JsonEncodedStructuredValueSchema = Type.String({ minLength: 2, maxLength: 262_144 });
const WireTextListSchema = Type.Union([TextListSchema, JsonEncodedStructuredValueSchema]);

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

const LocalizeCompletionSchema = Type.Object(
	{
		stage: Type.Literal("LOCALIZE"),
		candidates: Type.Array(LocalizeCandidateSchema, { minItems: 1, maxItems: 16 }),
		exclusions: TextListSchema,
	},
	{ additionalProperties: false },
);

const PlanCompletionSchema = Type.Object(
	{
		stage: Type.Literal("PLAN"),
		minimal_change_steps: TextListSchema,
		risks: TextListSchema,
		targeted_test_argv: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
			minItems: 1,
			maxItems: 32,
		}),
	},
	{ additionalProperties: false },
);

const ImplementCompletionSchema = Type.Object(
	{
		stage: Type.Literal("IMPLEMENT"),
		change_summary: TextListSchema,
	},
	{ additionalProperties: false },
);

const RefineCompletionSchema = Type.Object(
	{
		stage: Type.Literal("REFINE"),
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
		exclusions: WireTextListSchema,
	},
	{ additionalProperties: false },
);

const PlanCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("PLAN"),
		minimal_change_steps: WireTextListSchema,
		risks: WireTextListSchema,
		targeted_test_argv: Type.Union([
			Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 1, maxItems: 32 }),
			JsonEncodedStructuredValueSchema,
		]),
	},
	{ additionalProperties: false },
);

const ImplementCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("IMPLEMENT"),
		change_summary: WireTextListSchema,
	},
	{ additionalProperties: false },
);

const RefineCompletionToolSchema = Type.Object(
	{
		stage: Type.Literal("REFINE"),
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
			Type.Literal("REFINE"),
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
		exclusions: Type.Optional(WireTextListSchema),
	},
	{ additionalProperties: true },
);

const PlanCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("PLAN"),
		minimal_change_steps: Type.Optional(WireTextListSchema),
		risks: Type.Optional(WireTextListSchema),
		targeted_test_argv: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 1, maxItems: 32 }), JsonEncodedStructuredValueSchema])),
	},
	{ additionalProperties: true },
);

const ImplementCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("IMPLEMENT"),
		change_summary: Type.Optional(WireTextListSchema),
	},
	{ additionalProperties: true },
);

const RefineCompletionWireSchema = Type.Object(
	{
		stage: Type.Literal("REFINE"),
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
	},
	{ additionalProperties: true },
);

const STAGE_COMPLETION_WIRE_SCHEMAS = {
	UNDERSTAND: UnderstandCompletionWireSchema,
	LOCALIZE: LocalizeCompletionWireSchema,
	PLAN: PlanCompletionWireSchema,
	IMPLEMENT: ImplementCompletionWireSchema,
	REFINE: RefineCompletionWireSchema,
	SELF_REVIEW: SelfReviewCompletionWireSchema,
} as const;

const STAGE_COMPLETION_ARTIFACT_REQUIREMENTS: Record<RepoFixStage, string> = {
	UNDERSTAND: 'For UNDERSTAND call stage_complete with exactly {"stage":"UNDERSTAND","problem_summary":"...","expected_behavior":["..."],"constraints":["..."],"acceptance_evidence":["..."]}.',
	LOCALIZE: 'For LOCALIZE call stage_complete with exactly {"stage":"LOCALIZE","candidates":[{"path":"src/file.ts","symbol":"target","evidence":"why this code is relevant"}],"exclusions":["..."]}.',
	PLAN: 'For PLAN call stage_complete with exactly {"stage":"PLAN","minimal_change_steps":["..."],"risks":["..."],"targeted_test_argv":["npm","test"]}.',
	IMPLEMENT: 'For IMPLEMENT call stage_complete with exactly {"stage":"IMPLEMENT","change_summary":["..."]}.',
	REFINE: 'For REFINE call stage_complete with exactly {"stage":"REFINE","feedback_assessment":"...","revision_summary":["..."]}.',
	SELF_REVIEW: 'For SELF_REVIEW call stage_complete with exactly {"stage":"SELF_REVIEW","diff_checklist":["..."],"remaining_risks":["..."]}.',
};

export const StageCompletionSchema = Type.Union([
	UnderstandCompletionSchema,
	LocalizeCompletionSchema,
	PlanCompletionSchema,
	ImplementCompletionSchema,
	RefineCompletionSchema,
	SelfReviewCompletionSchema,
]);

export const STAGE_COMPLETION_SCHEMAS = {
	UNDERSTAND: UnderstandCompletionSchema,
	LOCALIZE: LocalizeCompletionSchema,
	PLAN: PlanCompletionSchema,
	IMPLEMENT: ImplementCompletionSchema,
	REFINE: RefineCompletionSchema,
	SELF_REVIEW: SelfReviewCompletionSchema,
} as const;

const STAGE_COMPLETION_TOOL_SCHEMAS = {
	UNDERSTAND: UnderstandCompletionToolSchema,
	LOCALIZE: LocalizeCompletionToolSchema,
	PLAN: PlanCompletionToolSchema,
	IMPLEMENT: ImplementCompletionToolSchema,
	REFINE: RefineCompletionToolSchema,
	SELF_REVIEW: SelfReviewCompletionToolSchema,
} as const;

export const StageCompletionToolSchema = Type.Union([
	UnderstandCompletionToolSchema,
	LocalizeCompletionToolSchema,
	PlanCompletionToolSchema,
	ImplementCompletionToolSchema,
	RefineCompletionToolSchema,
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

const completionValidator = Compile(StageCompletionSchema);

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
				["minimal_change_steps", "risks", "targeted_test_argv"],
				["minimal_change_steps", "risks"],
			);
		case "IMPLEMENT":
			return normalizeStructuredFields(value, ["change_summary"], ["change_summary"]);
		case "REFINE":
			return normalizeStructuredFields(value, ["revision_summary"], ["revision_summary"]);
		case "SELF_REVIEW":
			return normalizeStructuredFields(value, ["diff_checklist", "remaining_risks"], ["diff_checklist", "remaining_risks"]);
		default:
			return value;
	}
}

function stageTools(config: RepoFixWorkflowConfig, stage: RepoFixStage): readonly RepoFixToolName[] {
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
		case "REFINE":
			return config.allow_refine_repo_exec
				? ["repo_read", "repo_search", "repo_edit", "repo_exec", "repo_diff", ...completion]
				: ["repo_read", "repo_search", "repo_edit", "repo_diff", ...completion];
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
		if (!completionValidator.Check(value)) {
			throw new Error(`stage_complete payload violates the v1 stage schema. ${stageCompletionArtifactRequirement(this.active)}`);
		}
		const completion = value as StageCompletion;
		if (completion.stage !== this.active) {
			throw new Error(`stage_complete declared ${completion.stage} while ${this.active} is active`);
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
