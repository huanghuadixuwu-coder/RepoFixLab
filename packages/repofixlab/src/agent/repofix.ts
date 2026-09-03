/**
 * RepoFix Agent session and seven-stage workflow orchestrator.
 *
 * This module:
 * - Creates an isolated Pi session with only RepoFix repository tools
 * - Prompts each configured stage in strict order
 * - Enforces stage-specific tools and structured `stage_complete` artifacts
 * - Runs controlled verification checkpoints between implementation refinements
 * - Returns completion, patch, and verification identities to the outer runner
 *
 * It does not perform official evaluation or allow the model to declare
 * `resolved`; those decisions remain outside the Agent session.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
	type AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RepoToolTransport } from "../controller/client.ts";
import type { RepoFixMemoryRuntime } from "../memory/assembler.ts";
import { createRepoTools, MODEL_VISIBLE_STAGE_OUTPUT_LIMIT, RepoToolOutputBudget } from "../sandbox/repo-tools.ts";
import { injectPlanSkill, loadPlanSkill, type PlanSkillBundle, type PlanSkillPolicyId } from "./plan-skill.ts";
import {
	assertRepoFixWorkflowConfig,
	type RepoFixConfigId,
	type RepoFixStage,
	type RepoFixWorkflowConfig,
} from "./repofix-config.ts";
import {
	createStageCompleteTool,
	isRepoFixToolName,
	REPOFIX_STAGE_COMPLETE_TOOL_NAME,
	REPOFIX_TOOL_NAMES,
	RepoFixStageMachine,
	type StageCompletion,
	stageCompletionArtifactRequirement,
	stageCompletionWireSchema,
} from "./repofix-fsm.ts";

/** Dependencies and isolation controls required to create one RepoFix Agent session. */
export interface RepoFixSessionOptions {
	readonly leaseId: string;
	readonly attemptDirectory: string;
	readonly cwd: string;
	readonly model: NonNullable<CreateAgentSessionOptions["model"]>;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly transport: RepoToolTransport;
	readonly config: RepoFixWorkflowConfig;
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	/** Some providers reject tool_choice while thinking is enabled. */
	readonly forceStageCompletionToolChoice?: boolean;
	readonly memory?: RepoFixMemoryRuntime;
	readonly planSkillPolicy?: PlanSkillPolicyId;
}

/** Live session objects and workflow controls owned by one RepoFix attempt. */
export type RepoFixProviderStream = (
	model: Model<Api>,
	context: Context,
	streamOptions?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface RepoFixSessionResult {
	readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly stageMachine: RepoFixStageMachine;
	readonly stageCompletionControl: RepoFixStageCompletionControl;
	readonly repoToolOutputBudget: RepoToolOutputBudget;
	/** Direct Provider stream captured before RepoFix stage-control wrapping. */
	readonly providerStream: RepoFixProviderStream;
	readonly memory?: RepoFixMemoryRuntime;
	readonly planSkill: PlanSkillBundle | null;
	/** Assemble memory first, then add the PLAN-only instruction before token admission. */
	readonly prepareProviderContext: (context: Context, requestId: string) => Promise<Context>;
}

/** Sanitized Controller-owned verification result that may be shown to refinement stages. */
export interface ControlledVerificationFeedback {
	readonly catalog_id: string;
	readonly candidate_id: string;
	readonly status: "passed" | "test_failed" | "command_invalid" | "environment_failure" | "timed_out";
	readonly reason_code: string | null;
	readonly safe_hint: string | null;
	readonly exit_code: number | null;
	readonly timed_out: boolean;
	readonly baseline_status: "passed" | "test_failed" | "command_invalid" | "environment_failure" | "timed_out";
	readonly baseline_exit_code: number | null;
	readonly baseline_timed_out: boolean;
	readonly output: string;
}

/** Frozen verification candidates the PLAN stage may select by ID. */
export interface ControlledVerificationCatalog {
	readonly catalog_id: string;
	readonly candidates: readonly { readonly candidate_id: string; readonly description: string }[];
}

/** Bounded completion-only recovery event for an unfinished stage. */
export interface StageRecovery {
	readonly stage: RepoFixStage;
	readonly trigger:
		| "provider_output_length"
		| "repository_output_budget_exhausted"
		| "stage_completion_rejected"
		| "stage_completion_missing";
	readonly maximum_attempts: number;
}

/**
 * Internal evidence only. These events never feed back into the model prompt
 * or alter the stage machine; a forensic run uses them to distinguish useful
 * repository work from control-plane churn.
 */
export type RepoFixTrajectoryEvent =
	| {
			readonly schema_version: "v1";
			readonly event_type: "stage_started";
			readonly stage: RepoFixStage;
			readonly completed_stages: readonly RepoFixStage[];
			readonly stage_prompt_chars: number;
			readonly stage_prompt_sha256: string;
			readonly sealed_handoff_chars: number;
			readonly sealed_handoff_sha256: string | null;
			readonly plan_skill_id: string | null;
			readonly plan_skill_sha256: string | null;
	  }
	| {
			readonly schema_version: "v1";
			readonly event_type: "provider_request";
			readonly stage: RepoFixStage;
			readonly request_id: string | null;
			readonly stage_model_turn: number;
			readonly completion_only: boolean;
			readonly allowed_tools: readonly string[];
			readonly context_message_count: number;
			readonly context_chars: number;
			readonly sealed_repository_tool_results: number;
			readonly current_stage_repository_tool_results: number;
			readonly provider_context_sha256: string;
	  }
	| {
			readonly schema_version: "v1";
			readonly event_type: "repository_tool_requested";
			readonly stage: RepoFixStage;
			readonly repository_tool_calls: number;
			readonly tool_name: string;
	  }
	| {
			readonly schema_version: "v1";
			readonly event_type: "stage_checkpoint";
			readonly stage: RepoFixStage;
			readonly checkpoint: "model_turns" | "repository_tool_calls";
			readonly observed: number;
	  }
	| {
			readonly schema_version: "v1";
			readonly event_type: "completion_mode_entered";
			readonly stage: RepoFixStage;
			readonly trigger: StageRecovery["trigger"];
			readonly model_turns: number;
			readonly repository_tool_calls: number;
	  }
	| {
			readonly schema_version: "v1";
			readonly event_type: "stage_completed";
			readonly stage: RepoFixStage;
			readonly completion_sha256: string;
			readonly stage_wall_ms: number;
	  };

interface RepoFixStageCompletionControl {
	/** Begin accounting and tool control for one active stage. */
	start(
		stage: RepoFixStage,
		onStageRecovery: RepoFixWorkflowCallbacks["onStageRecovery"],
		onTrajectoryEvent: RepoFixWorkflowCallbacks["onTrajectoryEvent"],
	): void;
	/** Enter completion-only mode after a supported recovery trigger. */
	forceCompletion(stage: RepoFixStage, trigger: StageRecovery["trigger"]): Promise<void>;
	/** Record a repository-tool request and emit checkpoint evidence when reached. */
	registerRepositoryToolCall(stage: RepoFixStage, toolName: string): Promise<void>;
	/** Mark that a `stage_complete` call failed strict artifact validation. */
	recordRejectedCompletion(stage: RepoFixStage): void;
	/** Consume the active stage's rejected-completion marker once. */
	consumeRejectedCompletion(stage: RepoFixStage): boolean;
	/** Consume the request to stop after the current model turn once. */
	consumeStopAfterTurn(): boolean;
	/** Bind the next Provider request to token-ledger and trajectory evidence. */
	setProviderRequestId(requestId: string): void;
	/** Compose memory and the stable PLAN instruction before Provider token admission. */
	prepareProviderContext(context: Context, requestId: string): Promise<Context>;
	/** Release completion control after the active stage finishes or aborts. */
	finish(stage: RepoFixStage): void;
}

/** Outer-runner callbacks for snapshots, controlled verification, and forensic evidence. */
export interface RepoFixWorkflowCallbacks {
	readonly verificationCatalog: ControlledVerificationCatalog;
	readonly capturePatch: (checkpoint: "P0" | "V1" | "V2" | "P1") => Promise<{ readonly patch_sha256: string }>;
	readonly controlledVerify: (
		plan: Extract<StageCompletion, { stage: "PLAN" }>,
		checkpoint: "V0" | "V1" | "V2",
	) => Promise<ControlledVerificationFeedback>;
	readonly onStageComplete?: (completion: StageCompletion) => Promise<void>;
	readonly onStageRecovery?: (recovery: StageRecovery) => Promise<void>;
	readonly onTrajectoryEvent?: (event: RepoFixTrajectoryEvent) => Promise<void>;
}

/** Stable identities and stage artifacts returned by one complete RepoFix workflow. */
export interface RepoFixWorkflowResult {
	readonly config_id: RepoFixConfigId;
	readonly completions: readonly StageCompletion[];
	readonly p0_patch_sha256: string;
	readonly v1_patch_sha256: string;
	readonly v2_patch_sha256: string;
	readonly p1_patch_sha256: string;
	readonly verification_count: number;
	readonly verification_feedback_delivered: boolean;
}

/** Checkpoint thresholds that record evidence without imposing hard stage limits. */
const STAGE_MODEL_TURN_CHECKPOINT = 8;
const STAGE_REPOSITORY_TOOL_CALL_CHECKPOINT = 8;
const MAX_STAGE_COMPLETION_ONLY_ATTEMPTS = 2;

/** Provider stream options used only when recovery forces the completion tool. */
type CompletionOnlyStreamOptions = SimpleStreamOptions & {
	readonly toolChoice?: {
		readonly type: "function";
		readonly function: { readonly name: typeof REPOFIX_STAGE_COMPLETE_TOOL_NAME };
	};
};

/** Verify the session exposes each fixed RepoFix tool exactly once. */
function hasExactRepoFixToolSet(actualNames: string[]): boolean {
	return (
		actualNames.length === REPOFIX_TOOL_NAMES.length &&
		REPOFIX_TOOL_NAMES.every((expectedName) => actualNames.filter((name) => name === expectedName).length === 1)
	);
}

/** Build the invariant system prompt shared by all RepoFix stages. */
function systemPrompt(config: RepoFixWorkflowConfig): string {
	return [
		"You are RepoFix Agent. Repair the reported defect with the smallest reviewable change.",
		"You operate a controller-enforced finite-state workflow. The current stage is supplied by the user prompt. Use only tools allowed in that stage.",
		"At the end of every stage, call stage_complete exactly once with the required structured artifact. Use native JSON arrays and objects for structured fields, never quoted JSON strings. stage_complete must be the only tool call in that assistant message.",
		"Do not claim a repair is verified. Controlled verification and final official evaluation are performed outside this agent session.",
		"Never modify test/ or tests/, create standalone test files, access secrets, or attempt to discover hidden evaluation data.",
		"Inspect package scripts and existing test conventions before selecting a Controller-provided verification candidate. Never guess flags or invent a command.",
		"A narrow reported symptom is not evidence for a global rule. Before changing a shared branch, identify neighboring inputs and record the behavior that must remain unchanged.",
		"When code invokes user callbacks, traverses cleanup handlers, or commits deferred state, reason about success, error, and re-entry ordering. Establish required state before invoking re-entrant user code; aggregate traversal errors only after required cleanup work is complete.",
		"A known credible regression risk cannot be accepted merely because it is uncommon. Each preservation invariant needs a concrete counterexample; narrow the change or obtain repository evidence that discharges it.",
		"Every PLAN obligation must receive an IMPLEMENT and SELF_REVIEW disposition. A planned code site may not silently disappear from the final diff. A blocked obligation or unverified preservation invariant means the repair is incomplete.",
		"Repository output has a fixed per-stage evidence budget. When it is exhausted, stop exploring and complete the current artifact from the evidence already visible; another repo_* call cannot reveal additional model-visible evidence.",
		"Use repo_read pagination with start_line and line_count, and repo_search pagination with cursor and max_results, when evidence does not fit in one response.",
		"repo_edit modifies an existing file only with one exact old_text/new_text replacement. RepoFix does not execute arbitrary verification commands; the Controller owns that boundary.",
		`Configuration: ${config.config_id}; stages: ${config.stages.join(" → ")}.`,
	].join("\n");
}

/** Build one stage prompt with its artifact contract and optional verification feedback. */
function stagePrompt(
	stage: RepoFixStage,
	problemStatement: string,
	feedback?: string,
	verificationCatalog?: ControlledVerificationCatalog,
): string {
	const base = [
		`Current RepoFix stage: ${stage}.`,
		`Issue:\n${problemStatement}`,
		stageCompletionArtifactRequirement(stage),
		"Complete only this stage, then call stage_complete with its required structured artifact as the sole tool call in your final assistant message.",
	];
	if (stage === "PLAN") {
		const candidates = verificationCatalog?.candidates ?? [];
		base.push(
			candidates.length === 0
				? 'No Controller-preflighted verification candidate is available. Set verification_candidate_id to "unavailable"; the Controller will record a structured diagnostic and the workflow will continue.'
				: `Choose exactly one Controller-preflighted verification_candidate_id; do not invent an argv. Available candidates:\n${candidates.map((candidate) => `- ${candidate.candidate_id}: ${candidate.description}`).join("\n")}`,
		);
		base.push(
			"PLAN must record stable obligation ids for every required code site and stable invariant ids for every preservation_invariant with a concrete observable counterexample. state_transition_checks must cover success, error, and re-entry ordering for callback/cleanup/deferred-state code, or state why that class is inapplicable using repository evidence.",
		);
	}
	if (stage === "LOCALIZE") {
		base.push(
			'For LOCALIZE, candidates must be an array of objects with path, symbol, and evidence fields, for example [{"path":"src/file.ts","symbol":"target","evidence":"why this code is relevant"}]. A prose string list is invalid.',
		);
	}
	if (stage === "IMPLEMENT") {
		base.push(
			"The PLAN handoff is authoritative for what and where to change. Its target code excerpts are supplied from L2 memory as executable edit material. Edit directly; do not read the same repository content again unless the exact text required for the edit is absent or the current repository revision conflicts with it.",
		);
	}
	if (stage === "REFINE_1" || stage === "REFINE_2") {
		base.push(
			"Reconcile every PLAN obligation and preservation counterexample with the current diff. If controlled verification is unavailable or non-comparative, do not treat matching baseline failure or partial green output as correctness; use repository evidence and narrow any unproven broad behavior change.",
		);
	}
	if (stage === "SELF_REVIEW") {
		base.push(
			"risk_disposition must account for every credible PLAN risk. preservation_dispositions must use each PLAN invariant id exactly once, even when several invariants have the same scope; obligation_dispositions must account for every PLAN obligation. 'rare', 'partial tests passed', or 'baseline also failed' is not sufficient evidence.",
		);
	}
	if (feedback !== undefined) base.push(`Controlled verification feedback:\n${feedback}`);
	return base.join("\n\n");
}

const MAX_STAGE_HANDOFF_CHARS = 12 * 1_024;
const MAX_HANDOFF_TEXT_CHARS = 240;
const MAX_HANDOFF_ARRAY_ITEMS = 3;

/** Bounded prior-stage artifact summary carried into the next stage. */
type HandoffEntry = {
	readonly stage: RepoFixStage;
	readonly artifact_sha256: string;
	readonly summary: unknown;
	readonly truncated: boolean;
};

/** Truncate one handoff string without exceeding its field budget. */
function truncateHandoffText(value: string): string {
	return value.length <= MAX_HANDOFF_TEXT_CHARS ? value : `${value.slice(0, MAX_HANDOFF_TEXT_CHARS - 1)}…`;
}

/** Recursively summarize artifact fields for a bounded inter-stage handoff. */
function summarizeHandoffValue(value: unknown): unknown {
	if (typeof value === "string") return truncateHandoffText(value);
	if (Array.isArray(value)) {
		return {
			items: value.slice(0, MAX_HANDOFF_ARRAY_ITEMS).map(summarizeHandoffValue),
			omitted_items: Math.max(value.length - MAX_HANDOFF_ARRAY_ITEMS, 0),
		};
	}
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, summarizeHandoffValue(entry)]),
	);
}

/** Serialize prior validated artifacts into a bounded, hash-bound stage handoff. */
function stageHandoff(machine: RepoFixStageMachine): string | undefined {
	const entries: HandoffEntry[] = machine.completedStages.map((stage) => {
		const completion = machine.assertComplete(stage);
		return {
			stage,
			artifact_sha256: sha256(JSON.stringify(completion)),
			summary: summarizeHandoffValue(completion),
			truncated: false,
		};
	});
	if (entries.length === 0) return undefined;
	const serialize = (): string => JSON.stringify({ prior_stage_artifacts: entries });
	while (serialize().length > MAX_STAGE_HANDOFF_CHARS) {
		let largestIndex = -1;
		let largestChars = 0;
		for (const [index, entry] of entries.entries()) {
			if (entry.truncated) continue;
			const chars = JSON.stringify(entry.summary).length;
			if (chars > largestChars) {
				largestIndex = index;
				largestChars = chars;
			}
		}
		if (largestIndex < 0) throw new Error("RepoFix handoff exceeds its bounded serialization budget");
		const entry = entries[largestIndex];
		entries[largestIndex] = {
			...entry,
			summary: { note: "Artifact retained by hash; detailed fields omitted from this bounded handoff." },
			truncated: true,
		};
	}
	return `Sealed prior-stage artifacts (use these summaries; do not repeat prior repository exploration):\n${serialize()}`;
}

/** Compute a UTF-8 SHA-256 identity for prompts, handoffs, and artifacts. */
function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Emit forensic trajectory evidence without allowing observer failure to alter execution. */
async function emitTrajectory(
	callback: RepoFixWorkflowCallbacks["onTrajectoryEvent"] | undefined,
	event: RepoFixTrajectoryEvent,
): Promise<void> {
	try {
		await callback?.(event);
	} catch {
		// Forensic evidence must never change the agent's execution path.
	}
}

/** Count sealed prior-stage and current-stage repository tool results in model context. */
function countRepositoryToolResults(
	context: Context,
	historyMessageCount: number,
): {
	readonly sealed: number;
	readonly currentStage: number;
} {
	let sealed = 0;
	let currentStage = 0;
	for (const [index, message] of context.messages.entries()) {
		if (message.role !== "toolResult" || !message.toolName.startsWith("repo_")) continue;
		if (index < historyMessageCount) sealed += 1;
		else currentStage += 1;
	}
	return { sealed, currentStage };
}

/** Format bounded Controller verification feedback for a refinement prompt. */
function verificationPrompt(config: RepoFixWorkflowConfig, feedback: ControlledVerificationFeedback): string {
	if (!config.deliver_verification_feedback) {
		return "A controller-owned verification step completed. This configuration intentionally withholds its output; do not infer that it passed or failed.";
	}
	const nonComparative =
		feedback.baseline_status !== "passed"
			? "The baseline did not pass this controlled command. This result is non-comparative evidence: do not infer that an identical candidate failure proves the patch correct."
			: undefined;
	return [
		`catalog_id: ${feedback.catalog_id}`,
		`candidate_id: ${feedback.candidate_id}`,
		`status: ${feedback.status}`,
		`reason_code: ${feedback.reason_code ?? "null"}`,
		`safe_hint: ${feedback.safe_hint ?? "null"}`,
		`exit_code: ${feedback.exit_code === null ? "null" : feedback.exit_code}`,
		`timed_out: ${feedback.timed_out}`,
		`baseline_status: ${feedback.baseline_status}`,
		`baseline_exit_code: ${feedback.baseline_exit_code === null ? "null" : feedback.baseline_exit_code}`,
		`baseline_timed_out: ${feedback.baseline_timed_out}`,
		"output:",
		feedback.output.slice(0, 8 * 1_024),
		nonComparative,
	]
		.filter((value): value is string => value !== undefined)
		.join("\n");
}

/** Build the completion-only prompt for one bounded stage recovery attempt. */
function stageRecoveryPrompt(stage: RepoFixStage, trigger: StageRecovery["trigger"], attempt: number): string {
	const cause =
		trigger === "provider_output_length"
			? "Your previous response reached the frozen provider output limit before the stage completed."
			: trigger === "repository_output_budget_exhausted"
				? "The fixed model-visible repository-output budget for this stage is exhausted. Further repo_* calls cannot provide new visible evidence."
				: trigger === "stage_completion_rejected"
					? "Your previous stage_complete payload was rejected because it did not satisfy the required structured artifact schema."
					: "Your previous response ended without a valid stage_complete artifact.";
	return [
		cause,
		`This is completion-only attempt ${String(attempt)} of ${String(MAX_STAGE_COMPLETION_ONLY_ATTEMPTS)}.`,
		"Do not perform further investigation, execute commands, edit files, or call any repo_* tool.",
		"Use only evidence already obtained and call stage_complete exactly once now with the required current-stage artifact.",
		stageCompletionArtifactRequirement(stage),
		"stage_complete must be the only tool call in your assistant message.",
	].join("\n\n");
}

/** Return the most recent assistant stop reason from the Pi session. */
function lastAssistantStopReason(result: RepoFixSessionResult): string | null {
	for (let index = result.session.messages.length - 1; index >= 0; index -= 1) {
		const message = result.session.messages[index];
		if (message.role === "assistant") return message.stopReason;
	}
	return null;
}

/** Optionally force provider tool choice to the sole completion tool. */
function completionOnlyStreamOptions(
	streamOptions: SimpleStreamOptions | undefined,
	forceToolChoice: boolean,
): CompletionOnlyStreamOptions {
	if (!forceToolChoice) return { ...streamOptions };
	return {
		...streamOptions,
		toolChoice: { type: "function", function: { name: REPOFIX_STAGE_COMPLETE_TOOL_NAME } },
	};
}

/** Seal prior repository output and narrow tools for the current provider request. */
function stageCompletionContext(
	context: Context,
	stage: RepoFixStage,
	completionOnly: boolean,
	historyMessageCount: number,
	planSkill: PlanSkillBundle | null,
): Context {
	const stageCompleteTool = context.tools?.find((tool) => tool.name === REPOFIX_STAGE_COMPLETE_TOOL_NAME);
	if (stageCompleteTool === undefined) {
		throw new Error("RepoFix stage control requires a stage_complete tool definition");
	}
	const stageTool = { ...stageCompleteTool, parameters: stageCompletionWireSchema(stage) };
	const messages = context.messages.map((message, index) => {
		if (index >= historyMessageCount || message.role !== "toolResult" || !message.toolName.startsWith("repo_"))
			return message;
		return {
			...message,
			content: [
				{
					type: "text" as const,
					text: "Prior repository tool output is sealed in the trajectory. Use the prior-stage artifact summary instead.",
				},
			],
		};
	});
	const prepared =
		stage === "PLAN" && planSkill !== null
			? injectPlanSkill({ ...context, messages }, planSkill, historyMessageCount + 1)
			: { ...context, messages };
	return completionOnly
		? { ...prepared, tools: [stageTool] }
		: {
				...prepared,
				tools: context.tools?.map((tool) => (tool.name === stageTool.name ? stageTool : tool)),
			};
}

/** Wrap the Pi stream with per-stage accounting and completion-only recovery control. */
function createStageCompletionControl(
	session: RepoFixSessionResult["session"],
	stageMachine: RepoFixStageMachine,
	forceToolChoice: boolean,
	memory: RepoFixMemoryRuntime | undefined,
	planSkill: PlanSkillBundle | null,
): RepoFixStageCompletionControl {
	type ActiveStage = {
		readonly stage: RepoFixStage;
		readonly onStageRecovery: RepoFixWorkflowCallbacks["onStageRecovery"];
		readonly onTrajectoryEvent: RepoFixWorkflowCallbacks["onTrajectoryEvent"];
		model_turns: number;
		repository_tool_calls: number;
		model_turn_checkpoint_recorded: boolean;
		repository_tool_checkpoint_recorded: boolean;
		completion_forced: boolean;
		stop_after_current_turn: boolean;
		completion_rejected: boolean;
		history_message_count: number;
		request_id: string | null;
	};
	const originalStream = session.agent.streamFn;
	let active: ActiveStage | null = null;
	const forceActiveCompletion = async (trigger: StageRecovery["trigger"]): Promise<void> => {
		if (active === null || active.completion_forced) return;
		stageMachine.restrictToCompletion(active.stage);
		active.completion_forced = true;
		active.stop_after_current_turn = true;
		session.setActiveToolsByName([REPOFIX_STAGE_COMPLETE_TOOL_NAME]);
		await emitTrajectory(active.onTrajectoryEvent, {
			schema_version: "v1",
			event_type: "completion_mode_entered",
			stage: active.stage,
			trigger,
			model_turns: active.model_turns,
			repository_tool_calls: active.repository_tool_calls,
		});
		await active.onStageRecovery?.({
			stage: active.stage,
			trigger,
			maximum_attempts: MAX_STAGE_COMPLETION_ONLY_ATTEMPTS,
		});
	};
	session.agent.streamFn = async (model, context, streamOptions) => {
		if (active !== null) {
			active.model_turns += 1;
			if (!active.model_turn_checkpoint_recorded && active.model_turns >= STAGE_MODEL_TURN_CHECKPOINT) {
				active.model_turn_checkpoint_recorded = true;
				await emitTrajectory(active.onTrajectoryEvent, {
					schema_version: "v1",
					event_type: "stage_checkpoint",
					stage: active.stage,
					checkpoint: "model_turns",
					observed: active.model_turns,
				});
			}
			const repositoryToolResults = countRepositoryToolResults(context, active.history_message_count);
			const providerContext = stageCompletionContext(
				context,
				active.stage,
				active.completion_forced,
				active.history_message_count,
				planSkill,
			);
			await emitTrajectory(active.onTrajectoryEvent, {
				schema_version: "v1",
				event_type: "provider_request",
				stage: active.stage,
				request_id: active.request_id,
				stage_model_turn: active.model_turns,
				completion_only: active.completion_forced,
				allowed_tools: [...stageMachine.allowedTools()],
				context_message_count: providerContext.messages.length,
				context_chars: JSON.stringify(providerContext).length,
				sealed_repository_tool_results: repositoryToolResults.sealed,
				current_stage_repository_tool_results: repositoryToolResults.currentStage,
				provider_context_sha256: sha256(JSON.stringify(providerContext)),
			});
			if (active.completion_forced) {
				return originalStream(model, providerContext, completionOnlyStreamOptions(streamOptions, forceToolChoice));
			}
			return originalStream(model, providerContext, streamOptions);
		}
		return originalStream(model, context, streamOptions);
	};
	return {
		start(stage, onStageRecovery, onTrajectoryEvent): void {
			if (active !== null) throw new Error(`RepoFix stage completion control is already active for ${active.stage}`);
			session.setActiveToolsByName([...stageMachine.allowedTools()]);
			active = {
				stage,
				onStageRecovery,
				onTrajectoryEvent,
				model_turns: 0,
				repository_tool_calls: 0,
				model_turn_checkpoint_recorded: false,
				repository_tool_checkpoint_recorded: false,
				completion_forced: false,
				stop_after_current_turn: false,
				completion_rejected: false,
				history_message_count: memory === undefined ? session.messages.length : 0,
				request_id: null,
			};
		},
		async forceCompletion(stage, trigger): Promise<void> {
			if (active?.stage !== stage) throw new Error(`RepoFix stage completion control is not active for ${stage}`);
			await forceActiveCompletion(trigger);
		},
		async registerRepositoryToolCall(stage, toolName): Promise<void> {
			if (active?.stage !== stage) return;
			active.repository_tool_calls += 1;
			await emitTrajectory(active.onTrajectoryEvent, {
				schema_version: "v1",
				event_type: "repository_tool_requested",
				stage,
				repository_tool_calls: active.repository_tool_calls,
				tool_name: toolName,
			});
			if (
				!active.repository_tool_checkpoint_recorded &&
				active.repository_tool_calls >= STAGE_REPOSITORY_TOOL_CALL_CHECKPOINT
			) {
				active.repository_tool_checkpoint_recorded = true;
				await emitTrajectory(active.onTrajectoryEvent, {
					schema_version: "v1",
					event_type: "stage_checkpoint",
					stage,
					checkpoint: "repository_tool_calls",
					observed: active.repository_tool_calls,
				});
			}
		},
		recordRejectedCompletion(stage): void {
			if (active?.stage !== stage) return;
			active.completion_rejected = true;
		},
		consumeRejectedCompletion(stage): boolean {
			if (active?.stage !== stage) return false;
			const rejected = active.completion_rejected;
			active.completion_rejected = false;
			return rejected;
		},
		consumeStopAfterTurn(): boolean {
			if (active?.stop_after_current_turn !== true) return false;
			active.stop_after_current_turn = false;
			return true;
		},
		setProviderRequestId(requestId): void {
			if (active === null) throw new Error("RepoFix provider request identity requires an active stage");
			active.request_id = requestId;
		},
		async prepareProviderContext(context, requestId): Promise<Context> {
			if (active === null) throw new Error("RepoFix Provider context preparation requires an active stage");
			const prepared = memory === undefined ? context : await memory.prepareProviderContext(context, requestId);
			return active.stage === "PLAN" && planSkill !== null
				? injectPlanSkill(prepared, planSkill, active.history_message_count + 1)
				: prepared;
		},
		finish(stage): void {
			if (active?.stage !== stage) throw new Error(`RepoFix stage completion control cannot finish ${stage}`);
			active = null;
		},
	};
}

/** Install hooks that enforce the active stage's tools, budgets, and stop conditions. */
function installStageHooks(result: RepoFixSessionResult): void {
	const originalBeforeToolCall = result.session.agent.beforeToolCall;
	const originalAfterToolCall = result.session.agent.afterToolCall;
	const originalShouldStopAfterTurn = result.session.agent.shouldStopAfterTurn;
	result.session.agent.beforeToolCall = async (context, signal) => {
		const calls = context.assistantMessage.content.filter((content) => content.type === "toolCall");
		if (calls.some((call) => call.name === REPOFIX_STAGE_COMPLETE_TOOL_NAME) && calls.length !== 1) {
			return { block: true, reason: "stage_complete must be the only tool call in its assistant message" };
		}
		if (!isRepoFixToolName(context.toolCall.name)) {
			return { block: true, reason: `Unknown RepoFix tool: ${context.toolCall.name}` };
		}
		if (!result.stageMachine.allowedTools().includes(context.toolCall.name)) {
			return {
				block: true,
				reason: `${context.toolCall.name} is not allowed during ${result.stageMachine.activeStage}`,
			};
		}
		if (context.toolCall.name.startsWith("repo_") && result.stageMachine.activeStage !== null) {
			await result.stageCompletionControl.registerRepositoryToolCall(
				result.stageMachine.activeStage,
				context.toolCall.name,
			);
		}
		return originalBeforeToolCall?.(context, signal);
	};
	result.session.agent.afterToolCall = async (context, signal) => {
		const upstream = await originalAfterToolCall?.(context, signal);
		if (context.toolCall.name.startsWith("repo_") && result.stageMachine.activeStage !== null) {
			await result.memory?.appendToolEvidence({
				tool_call_id: context.toolCall.id,
				tool_name: context.toolCall.name,
				normalized_input: context.args,
				controller_result: context.result.details,
			});
		}
		if (
			context.toolCall.name.startsWith("repo_") &&
			result.stageMachine.activeStage !== null &&
			result.repoToolOutputBudget.snapshot.visible_chars >= MODEL_VISIBLE_STAGE_OUTPUT_LIMIT
		) {
			await result.stageCompletionControl.forceCompletion(
				result.stageMachine.activeStage,
				"repository_output_budget_exhausted",
			);
		}
		if (context.toolCall.name !== REPOFIX_STAGE_COMPLETE_TOOL_NAME) return upstream;
		if (result.stageMachine.activeStage !== null) {
			result.stageCompletionControl.recordRejectedCompletion(result.stageMachine.activeStage);
		}
		return { ...upstream, terminate: true };
	};
	result.session.agent.shouldStopAfterTurn = async (context, signal) => {
		if (await originalShouldStopAfterTurn?.(context, signal)) return true;
		return result.stageCompletionControl.consumeStopAfterTurn();
	};
}

/** Create an isolated Pi session exposing exactly the fixed RepoFix tool registry. */
export async function createRepoFixSession(options: RepoFixSessionOptions): Promise<RepoFixSessionResult> {
	assertRepoFixWorkflowConfig(options.config);
	if (options.config.workflow_kind !== "repofix") {
		throw new Error("createRepoFixSession requires a RepoFix configuration, not pi-general");
	}
	const planSkill = await loadPlanSkill(options.planSkillPolicy ?? "disabled");
	const attemptDirectory = resolve(options.attemptDirectory);
	const cwd = resolve(options.cwd);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, provider: { maxRetries: 0 } },
	});
	const sessionManager = SessionManager.create(cwd, attemptDirectory);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(attemptDirectory, "pi-agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: systemPrompt(options.config),
		appendSystemPrompt: [],
	});
	await resourceLoader.reload();
	const stageMachine = new RepoFixStageMachine(options.config);
	const repoToolOutputBudget = new RepoToolOutputBudget();
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(attemptDirectory, "pi-agent"),
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		resourceLoader,
		settingsManager,
		sessionManager,
		noTools: "builtin",
		tools: [...REPOFIX_TOOL_NAMES],
		customTools: [
			...createRepoTools(options.leaseId, options.transport, repoToolOutputBudget),
			createStageCompleteTool(stageMachine),
		],
	});
	const actualToolNames = session.getAllTools().map((tool) => tool.name);
	if (!hasExactRepoFixToolSet(actualToolNames)) {
		session.dispose();
		throw new Error(`RepoFix tool registry mismatch: received ${actualToolNames.join(",")}`);
	}
	session.setActiveToolsByName([...REPOFIX_TOOL_NAMES]);
	const providerStream = session.agent.streamFn;
	const stageCompletionControl = createStageCompletionControl(
		session,
		stageMachine,
		options.forceStageCompletionToolChoice ?? true,
		options.memory,
		planSkill,
	);
	const result: RepoFixSessionResult = {
		session,
		sessionManager,
		settingsManager,
		stageMachine,
		stageCompletionControl,
		repoToolOutputBudget,
		providerStream,
		memory: options.memory,
		planSkill,
		prepareProviderContext: (context, requestId) => stageCompletionControl.prepareProviderContext(context, requestId),
	};
	installStageHooks(result);
	return result;
}

/** Execute configured stages, snapshots, and controlled verification in strict order. */
export async function runRepoFixWorkflow(
	result: RepoFixSessionResult,
	problemStatement: string,
	callbacks: RepoFixWorkflowCallbacks,
): Promise<RepoFixWorkflowResult> {
	const config = result.stageMachine.workflowConfig;
	let p0PatchSha256: string | null = null;
	let v1PatchSha256: string | null = null;
	let v2PatchSha256: string | null = null;
	let p1PatchSha256: string | null = null;
	const verificationFeedback: ControlledVerificationFeedback[] = [];
	let planCompletion: Extract<StageCompletion, { stage: "PLAN" }> | null = null;
	for (const [stageIndex, stage] of config.stages.entries()) {
		const stageStarted = performance.now();
		result.stageMachine.start(stage);
		result.repoToolOutputBudget.startStage(stage);
		result.memory?.startStage(stage, stageIndex + 1, result.session.messages.length);
		const feedback =
			stage === "REFINE_1" && verificationFeedback[0] !== undefined
				? verificationPrompt(config, verificationFeedback[0])
				: stage === "REFINE_2" && verificationFeedback[1] !== undefined
					? verificationPrompt(config, verificationFeedback[1])
					: stage === "SELF_REVIEW" && verificationFeedback[2] !== undefined
						? verificationPrompt(config, verificationFeedback[2])
						: undefined;
		result.stageCompletionControl.start(stage, callbacks.onStageRecovery, callbacks.onTrajectoryEvent);
		let completion: StageCompletion | null = null;
		let rejectedCompletion = false;
		try {
			const handoff = result.memory === undefined ? stageHandoff(result.stageMachine) : undefined;
			const prompt = [
				stagePrompt(
					stage,
					problemStatement,
					feedback,
					stage === "PLAN" ? callbacks.verificationCatalog : undefined,
				),
				handoff,
			]
				.filter((value): value is string => value !== undefined)
				.join("\n\n");
			await emitTrajectory(callbacks.onTrajectoryEvent, {
				schema_version: "v1",
				event_type: "stage_started",
				stage,
				completed_stages: [...result.stageMachine.completedStages],
				stage_prompt_chars: prompt.length,
				stage_prompt_sha256: sha256(prompt),
				sealed_handoff_chars: handoff?.length ?? 0,
				sealed_handoff_sha256: handoff === undefined ? null : sha256(handoff),
				plan_skill_id: stage === "PLAN" ? (result.planSkill?.skill_id ?? null) : null,
				plan_skill_sha256: stage === "PLAN" ? (result.planSkill?.sha256 ?? null) : null,
			});
			await result.session.prompt(prompt);
			let initialRecoveryTrigger: StageRecovery["trigger"] | null = null;
			if (lastAssistantStopReason(result) === "length") {
				initialRecoveryTrigger = "provider_output_length";
			} else if (result.stageCompletionControl.consumeRejectedCompletion(stage)) {
				rejectedCompletion = true;
				initialRecoveryTrigger = "stage_completion_rejected";
			} else if (!result.stageMachine.isComplete(stage)) {
				initialRecoveryTrigger = "stage_completion_missing";
			}
			if (!result.stageMachine.isComplete(stage) && initialRecoveryTrigger !== null) {
				await result.stageCompletionControl.forceCompletion(stage, initialRecoveryTrigger);
				for (let attempt = 1; attempt <= MAX_STAGE_COMPLETION_ONLY_ATTEMPTS; attempt += 1) {
					await result.session.prompt(stageRecoveryPrompt(stage, initialRecoveryTrigger, attempt));
					const retryableByRejectedCompletion = result.stageCompletionControl.consumeRejectedCompletion(stage);
					if (retryableByRejectedCompletion) rejectedCompletion = true;
					if (result.stageMachine.isComplete(stage)) break;
				}
			}
			if (!result.stageMachine.isComplete(stage)) {
				throw new Error(
					rejectedCompletion
						? `stage_completion_contract_failure: ${stage}`
						: `stage_completion_missing_after_recovery: ${stage}`,
				);
			}
			completion = result.stageMachine.assertComplete(stage);
		} finally {
			result.stageCompletionControl.finish(stage);
		}
		if (completion === null) throw new Error(`RepoFix stage ${stage} did not complete`);
		await result.memory?.completeStage(result.session.messages, completion);
		await emitTrajectory(callbacks.onTrajectoryEvent, {
			schema_version: "v1",
			event_type: "stage_completed",
			stage,
			completion_sha256: sha256(JSON.stringify(completion)),
			stage_wall_ms: Math.max(0, Math.ceil(performance.now() - stageStarted)),
		});
		await callbacks.onStageComplete?.(completion);
		if (completion.stage === "PLAN") planCompletion = completion;
		if (stage === "IMPLEMENT") {
			p0PatchSha256 = (await callbacks.capturePatch("P0")).patch_sha256;
			if (planCompletion === null) throw new Error("IMPLEMENT reached without a completed PLAN artifact");
			verificationFeedback.push(await callbacks.controlledVerify(planCompletion, "V0"));
		}
		if (stage === "REFINE_1") {
			v1PatchSha256 = (await callbacks.capturePatch("V1")).patch_sha256;
			if (planCompletion === null) throw new Error("REFINE_1 reached without a completed PLAN artifact");
			verificationFeedback.push(await callbacks.controlledVerify(planCompletion, "V1"));
		}
		if (stage === "REFINE_2") {
			v2PatchSha256 = (await callbacks.capturePatch("V2")).patch_sha256;
			if (planCompletion === null) throw new Error("REFINE_2 reached without a completed PLAN artifact");
			verificationFeedback.push(await callbacks.controlledVerify(planCompletion, "V2"));
		}
		if (stage === "SELF_REVIEW") {
			p1PatchSha256 = (await callbacks.capturePatch("P1")).patch_sha256;
			if (v2PatchSha256 === null || p1PatchSha256 !== v2PatchSha256)
				throw new Error("SELF_REVIEW changed the final patch after V2 verification");
		}
	}
	if (
		!result.stageMachine.isFinished() ||
		p0PatchSha256 === null ||
		v1PatchSha256 === null ||
		v2PatchSha256 === null ||
		p1PatchSha256 === null ||
		verificationFeedback.length !== 3
	) {
		throw new Error("RepoFix workflow did not reach the V0/V1/V2 controlled verification checkpoints");
	}
	return {
		config_id: config.config_id,
		completions: result.stageMachine.completedStages.map((stage) => result.stageMachine.assertComplete(stage)),
		p0_patch_sha256: p0PatchSha256,
		v1_patch_sha256: v1PatchSha256,
		v2_patch_sha256: v2PatchSha256,
		p1_patch_sha256: p1PatchSha256,
		verification_count: verificationFeedback.length,
		verification_feedback_delivered: config.deliver_verification_feedback,
	};
}
