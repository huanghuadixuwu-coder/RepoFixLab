import { join, resolve } from "node:path";
import {
	type AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { RepoToolTransport } from "../controller/client.ts";
import { createRepoTools, RepoToolOutputBudget } from "../sandbox/repo-tools.ts";
import {
	createStageCompleteTool,
	isRepoFixToolName,
	REPOFIX_STAGE_COMPLETE_TOOL_NAME,
	REPOFIX_TOOL_NAMES,
	RepoFixStageMachine,
	stageCompletionArtifactRequirement,
	stageCompletionWireSchema,
	type StageCompletion,
} from "./repofix-fsm.ts";
import {
	assertRepoFixWorkflowConfig,
	type RepoFixConfigId,
	type RepoFixStage,
	type RepoFixWorkflowConfig,
} from "./repofix-config.ts";

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
}

export interface RepoFixSessionResult {
	readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly stageMachine: RepoFixStageMachine;
	readonly stageCompletionControl: RepoFixStageCompletionControl;
	readonly repoToolOutputBudget: RepoToolOutputBudget;
}

export interface ControlledVerificationFeedback {
	readonly command_argv: readonly string[];
	readonly exit_code: number | null;
	readonly timed_out: boolean;
	readonly output: string;
}

export interface StageRecovery {
	readonly stage: RepoFixStage;
	readonly trigger: "provider_output_length" | "stage_completion_rejected" | "stage_model_turn_limit";
	readonly maximum_attempts: number;
}

interface RepoFixStageCompletionControl {
	start(stage: RepoFixStage, onStageRecovery: RepoFixWorkflowCallbacks["onStageRecovery"]): void;
	forceCompletion(stage: RepoFixStage, trigger: StageRecovery["trigger"]): Promise<void>;
	recordRejectedCompletion(stage: RepoFixStage): void;
	consumeRejectedCompletion(stage: RepoFixStage): boolean;
	finish(stage: RepoFixStage): void;
}

export interface RepoFixWorkflowCallbacks {
	readonly capturePatch: (checkpoint: "P0" | "P1") => Promise<{ readonly patch_sha256: string }>;
	readonly controlledVerify: (plan: Extract<StageCompletion, { stage: "PLAN" }>) => Promise<ControlledVerificationFeedback>;
	readonly onStageComplete?: (completion: StageCompletion) => Promise<void>;
	readonly onStageRecovery?: (recovery: StageRecovery) => Promise<void>;
}

export interface RepoFixWorkflowResult {
	readonly config_id: RepoFixConfigId;
	readonly completions: readonly StageCompletion[];
	readonly p0_patch_sha256: string;
	readonly p1_patch_sha256: string;
	readonly verification_feedback_delivered: boolean;
}

const MAX_STAGE_MODEL_TURNS_BEFORE_FORCED_COMPLETION = 8;
const MAX_STAGE_COMPLETION_ONLY_ATTEMPTS = 2;

type CompletionOnlyStreamOptions = SimpleStreamOptions & {
	readonly toolChoice?: { readonly type: "function"; readonly function: { readonly name: typeof REPOFIX_STAGE_COMPLETE_TOOL_NAME } };
};

function hasExactRepoFixToolSet(actualNames: string[]): boolean {
	return (
		actualNames.length === REPOFIX_TOOL_NAMES.length &&
		REPOFIX_TOOL_NAMES.every((expectedName) => actualNames.filter((name) => name === expectedName).length === 1)
	);
}

function systemPrompt(config: RepoFixWorkflowConfig): string {
	return [
		"You are RepoFix Agent. Repair the reported defect with the smallest reviewable change.",
		"You operate a controller-enforced finite-state workflow. The current stage is supplied by the user prompt. Use only tools allowed in that stage.",
		"At the end of every stage, call stage_complete exactly once with the required structured artifact. Use native JSON arrays and objects for structured fields, never quoted JSON strings. stage_complete must be the only tool call in that assistant message.",
		"Do not claim a repair is verified. Controlled verification and final official evaluation are performed outside this agent session.",
		"Never modify test/ or tests/, create standalone test files, access secrets, or attempt to discover hidden evaluation data.",
		"repo_edit modifies an existing file only with one exact old_text/new_text replacement. repo_exec accepts argv as a JSON string array and never a shell command string.",
		`Configuration: ${config.config_id}; stages: ${config.stages.join(" → ")}.`,
	].join("\n");
}

function stagePrompt(stage: RepoFixStage, problemStatement: string, feedback?: string): string {
	const base = [
		`Current RepoFix stage: ${stage}.`,
		`Issue:\n${problemStatement}`,
		stageCompletionArtifactRequirement(stage),
		"Complete only this stage, then call stage_complete with its required structured artifact as the sole tool call in your final assistant message.",
	];
	if (stage === "PLAN") {
		base.push("Specify the narrow existing test command as targeted_test_argv, but do not run it now.");
	}
	if (stage === "LOCALIZE") {
		base.push(
			'For LOCALIZE, candidates must be an array of objects with path, symbol, and evidence fields, for example [{"path":"src/file.ts","symbol":"target","evidence":"why this code is relevant"}]. A prose string list is invalid.',
		);
	}
	if (feedback !== undefined) base.push(`Controlled verification feedback:\n${feedback}`);
	return base.join("\n\n");
}

function stageHandoff(machine: RepoFixStageMachine): string | undefined {
	const completed = machine.completedStages.map((stage) => {
		const serialized = JSON.stringify(machine.assertComplete(stage));
		return serialized.length <= 4_096 ? serialized : `${serialized.slice(0, 4_096)}…`;
	});
	if (completed.length === 0) return undefined;
	return `Sealed prior-stage artifacts (use these summaries; do not repeat prior repository exploration):\n${completed.join("\n").slice(0, 12 * 1_024)}`;
}

function verificationPrompt(config: RepoFixWorkflowConfig, feedback: ControlledVerificationFeedback): string {
	if (!config.deliver_verification_feedback) {
		return "A controller-owned verification step completed. This configuration intentionally withholds its output; do not infer that it passed or failed.";
	}
	return [
		`command_argv: ${JSON.stringify(feedback.command_argv)}`,
		`exit_code: ${feedback.exit_code === null ? "null" : feedback.exit_code}`,
		`timed_out: ${feedback.timed_out}`,
		"output:",
		feedback.output.slice(0, 65_536),
	].join("\n");
}

function stageRecoveryPrompt(stage: RepoFixStage, trigger: StageRecovery["trigger"], attempt: number): string {
	const cause =
		trigger === "provider_output_length"
			? "Your previous response reached the frozen provider output limit before the stage completed."
			: "Your previous stage_complete payload was rejected because it did not satisfy the required structured artifact schema.";
	return [
		cause,
		`This is completion-only attempt ${String(attempt)} of ${String(MAX_STAGE_COMPLETION_ONLY_ATTEMPTS)}.`,
		"Do not perform further investigation, execute commands, edit files, or call any repo_* tool.",
		"Use only evidence already obtained and call stage_complete exactly once now with the required current-stage artifact.",
		stageCompletionArtifactRequirement(stage),
		"stage_complete must be the only tool call in your assistant message.",
	].join("\n\n");
}

function lastAssistantStopReason(result: RepoFixSessionResult): string | null {
	for (let index = result.session.messages.length - 1; index >= 0; index -= 1) {
		const message = result.session.messages[index];
		if (message.role === "assistant") return message.stopReason;
	}
	return null;
}

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

function stageCompletionContext(context: Context, stage: RepoFixStage, completionOnly: boolean, historyMessageCount: number): Context {
	const stageCompleteTool = context.tools?.find((tool) => tool.name === REPOFIX_STAGE_COMPLETE_TOOL_NAME);
	if (stageCompleteTool === undefined) {
		throw new Error("RepoFix stage control requires a stage_complete tool definition");
	}
	const stageTool = { ...stageCompleteTool, parameters: stageCompletionWireSchema(stage) };
	const messages = context.messages.map((message, index) => {
		if (index >= historyMessageCount || message.role !== "toolResult" || !message.toolName.startsWith("repo_")) return message;
		return {
			...message,
			content: [{ type: "text" as const, text: "Prior repository tool output is sealed in the trajectory. Use the prior-stage artifact summary instead." }],
		};
	});
	return completionOnly
		? { ...context, messages, tools: [stageTool] }
		: { ...context, messages, tools: context.tools?.map((tool) => (tool.name === stageTool.name ? stageTool : tool)) };
}

function createStageCompletionControl(
	session: RepoFixSessionResult["session"],
	stageMachine: RepoFixStageMachine,
	forceToolChoice: boolean,
): RepoFixStageCompletionControl {
	type ActiveStage = {
		readonly stage: RepoFixStage;
		readonly onStageRecovery: RepoFixWorkflowCallbacks["onStageRecovery"];
		model_turns: number;
		completion_forced: boolean;
		completion_rejected: boolean;
		history_message_count: number;
	};
	const originalStream = session.agent.streamFn;
	let active: ActiveStage | null = null;
	const forceActiveCompletion = async (trigger: StageRecovery["trigger"]): Promise<void> => {
		if (active === null || active.completion_forced) return;
		stageMachine.restrictToCompletion(active.stage);
		active.completion_forced = true;
		await active.onStageRecovery?.({
			stage: active.stage,
			trigger,
			maximum_attempts: MAX_STAGE_COMPLETION_ONLY_ATTEMPTS,
		});
	};
	session.agent.streamFn = async (model, context, streamOptions) => {
		if (active !== null) {
			if (!active.completion_forced && active.model_turns >= MAX_STAGE_MODEL_TURNS_BEFORE_FORCED_COMPLETION) {
				await forceActiveCompletion("stage_model_turn_limit");
			}
			active.model_turns += 1;
			if (active.completion_forced) {
				return originalStream(
					model,
					stageCompletionContext(context, active.stage, true, active.history_message_count),
					completionOnlyStreamOptions(streamOptions, forceToolChoice),
				);
			}
			return originalStream(model, stageCompletionContext(context, active.stage, false, active.history_message_count), streamOptions);
		}
		return originalStream(model, context, streamOptions);
	};
	return {
		start(stage, onStageRecovery): void {
			if (active !== null) throw new Error(`RepoFix stage completion control is already active for ${active.stage}`);
			active = { stage, onStageRecovery, model_turns: 0, completion_forced: false, completion_rejected: false, history_message_count: session.messages.length };
		},
		async forceCompletion(stage, trigger): Promise<void> {
			if (active?.stage !== stage) throw new Error(`RepoFix stage completion control is not active for ${stage}`);
			await forceActiveCompletion(trigger);
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
		finish(stage): void {
			if (active?.stage !== stage) throw new Error(`RepoFix stage completion control cannot finish ${stage}`);
			active = null;
		},
	};
}

function installStageHooks(result: RepoFixSessionResult): void {
	const originalBeforeToolCall = result.session.agent.beforeToolCall;
	const originalAfterToolCall = result.session.agent.afterToolCall;
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
		return originalBeforeToolCall?.(context, signal);
	};
	result.session.agent.afterToolCall = async (context, signal) => {
		const upstream = await originalAfterToolCall?.(context, signal);
		if (context.toolCall.name !== REPOFIX_STAGE_COMPLETE_TOOL_NAME) return upstream;
		if (result.stageMachine.activeStage !== null) {
			result.stageCompletionControl.recordRejectedCompletion(result.stageMachine.activeStage);
		}
		return { ...upstream, terminate: true };
	};
}

export async function createRepoFixSession(options: RepoFixSessionOptions): Promise<RepoFixSessionResult> {
	assertRepoFixWorkflowConfig(options.config);
	if (options.config.workflow_kind !== "repofix") {
		throw new Error("createRepoFixSession requires a RepoFix configuration, not pi-general");
	}
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
		customTools: [...createRepoTools(options.leaseId, options.transport, repoToolOutputBudget), createStageCompleteTool(stageMachine)],
	});
	const actualToolNames = session.getAllTools().map((tool) => tool.name);
	if (!hasExactRepoFixToolSet(actualToolNames)) {
		session.dispose();
		throw new Error(`RepoFix tool registry mismatch: received ${actualToolNames.join(",")}`);
	}
	session.setActiveToolsByName([...REPOFIX_TOOL_NAMES]);
	const stageCompletionControl = createStageCompletionControl(
		session,
		stageMachine,
		options.forceStageCompletionToolChoice ?? true,
	);
	const result: RepoFixSessionResult = { session, sessionManager, settingsManager, stageMachine, stageCompletionControl, repoToolOutputBudget };
	installStageHooks(result);
	return result;
}

export async function runRepoFixWorkflow(
	result: RepoFixSessionResult,
	problemStatement: string,
	callbacks: RepoFixWorkflowCallbacks,
): Promise<RepoFixWorkflowResult> {
	const config = result.stageMachine.workflowConfig;
	let p0PatchSha256: string | null = null;
	let p1PatchSha256: string | null = null;
	let verificationFeedback: ControlledVerificationFeedback | null = null;
	let planCompletion: Extract<StageCompletion, { stage: "PLAN" }> | null = null;
	for (const stage of config.stages) {
		result.stageMachine.start(stage);
		result.repoToolOutputBudget.startStage(stage);
		const feedback = stage === "REFINE" && verificationFeedback !== null ? verificationPrompt(config, verificationFeedback) : undefined;
		result.stageCompletionControl.start(stage, callbacks.onStageRecovery);
		let completion: StageCompletion | null = null;
		let rejectedCompletion = false;
		try {
			const prompt = [stagePrompt(stage, problemStatement, feedback), stageHandoff(result.stageMachine)]
				.filter((value): value is string => value !== undefined)
				.join("\n\n");
			await result.session.prompt(prompt);
			let initialRecoveryTrigger: StageRecovery["trigger"] | null = null;
			if (lastAssistantStopReason(result) === "length") {
				initialRecoveryTrigger = "provider_output_length";
			} else if (result.stageCompletionControl.consumeRejectedCompletion(stage)) {
				rejectedCompletion = true;
				initialRecoveryTrigger = "stage_completion_rejected";
			}
			if (!result.stageMachine.isComplete(stage) && initialRecoveryTrigger !== null) {
				await result.stageCompletionControl.forceCompletion(stage, initialRecoveryTrigger);
				for (let attempt = 1; attempt <= MAX_STAGE_COMPLETION_ONLY_ATTEMPTS; attempt += 1) {
					await result.session.prompt(stageRecoveryPrompt(stage, initialRecoveryTrigger, attempt));
					const retryableByLength = lastAssistantStopReason(result) === "length";
					const retryableByRejectedCompletion = result.stageCompletionControl.consumeRejectedCompletion(stage);
					if (retryableByRejectedCompletion) rejectedCompletion = true;
					const retryable = retryableByLength || retryableByRejectedCompletion;
					if (result.stageMachine.isComplete(stage) || !retryable) break;
				}
			}
			if (!result.stageMachine.isComplete(stage) && rejectedCompletion) {
				throw new Error(`stage_completion_contract_failure: ${stage}`);
			}
			completion = result.stageMachine.assertComplete(stage);
		} finally {
			result.stageCompletionControl.finish(stage);
		}
		if (completion === null) throw new Error(`RepoFix stage ${stage} did not complete`);
		await callbacks.onStageComplete?.(completion);
		if (completion.stage === "PLAN") planCompletion = completion;
		if (stage === "IMPLEMENT") {
			p0PatchSha256 = (await callbacks.capturePatch("P0")).patch_sha256;
			if (planCompletion === null) throw new Error("IMPLEMENT reached without a completed PLAN artifact");
			verificationFeedback = await callbacks.controlledVerify(planCompletion);
		}
		if (stage === "SELF_REVIEW") {
			p1PatchSha256 = (await callbacks.capturePatch("P1")).patch_sha256;
		}
	}
	if (!result.stageMachine.isFinished() || p0PatchSha256 === null || p1PatchSha256 === null || verificationFeedback === null) {
		throw new Error("RepoFix workflow did not reach both snapshot checkpoints and controlled verification");
	}
	return {
		config_id: config.config_id,
		completions: result.stageMachine.completedStages.map((stage) => result.stageMachine.assertComplete(stage)),
		p0_patch_sha256: p0PatchSha256,
		p1_patch_sha256: p1PatchSha256,
		verification_feedback_delivered: config.deliver_verification_feedback,
	};
}
