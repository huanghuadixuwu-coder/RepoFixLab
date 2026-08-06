/**
 * Frozen model and Pi session construction for RepoFix experiments.
 *
 * This module:
 * - Resolves Provider credentials only inside the Node Orchestrator.
 * - Registers exact model, context-window, and pricing specifications.
 * - Creates comparable Pi-general and RepoFix sessions.
 * - Enforces frozen request options and run-level admission limits.
 *
 * Trust boundary:
 * - API keys remain in in-memory Orchestrator auth storage.
 * - The Controller receives repository and container requests, not model
 *   credentials, model selection authority, or token-budget ownership.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	createPiGeneralSession,
	type PiGeneralSessionOptions,
	type PiGeneralSessionResult,
} from "../agent/pi-general.ts";
import { createRepoFixSession, type RepoFixSessionOptions, type RepoFixSessionResult } from "../agent/repofix.ts";
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import { FROZEN_DEEPSEEK_V4_FLASH_PRICING_SPEC_SHA256, FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256 } from "./pricing.ts";

export const FROZEN_MODEL_PROVIDER = "zhipu-standard";
export const FROZEN_MODEL_ID = "glm-4.5-air";
export const FROZEN_MODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const FROZEN_TEMPERATURE = 0.2;
export const FROZEN_PROVIDER_REQUEST_TIMEOUT_MS = 600_000;
export const RUN_ADMISSION_TOKEN_BUDGET_ERROR = "repofixlab_accounted_admission_cap_reached";
export const RUN_ADMISSION_MODEL_TURN_LIMIT_ERROR = "repofixlab_model_turn_limit_reached";
export const RUN_ADMISSION_TOOL_CALL_LIMIT_ERROR = "repofixlab_tool_call_limit_reached";
/** Legacy name retained for callers that specifically classify Token-cap rejections. */
export const RUN_ADMISSION_BUDGET_ERROR = RUN_ADMISSION_TOKEN_BUDGET_ERROR;

export const FROZEN_MODEL_SPEC = {
	provider: FROZEN_MODEL_PROVIDER,
	model_id: FROZEN_MODEL_ID,
	api: "openai-completions",
	base_url: FROZEN_MODEL_BASE_URL,
	reasoning: true,
	thinking_level: "high",
	temperature: FROZEN_TEMPERATURE,
	request_timeout_ms: FROZEN_PROVIDER_REQUEST_TIMEOUT_MS,
	context_window: 131_072,
	max_tokens: 16_384,
	input: ["text"],
	pricing_spec_sha256: FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256,
	registry_cost_semantics: "conservative_upper_bound_only",
	compat: {
		thinkingFormat: "zai",
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
	},
} as const;

export const DEEPSEEK_V4_FLASH_MODEL_PROVIDER = "deepseek";
export const DEEPSEEK_V4_FLASH_MODEL_ID = "deepseek-v4-flash";
export const DEEPSEEK_V4_FLASH_MODEL_BASE_URL = "https://api.deepseek.com";

export const DEEPSEEK_V4_FLASH_MODEL_SPEC = {
	provider: DEEPSEEK_V4_FLASH_MODEL_PROVIDER,
	model_id: DEEPSEEK_V4_FLASH_MODEL_ID,
	api: "openai-completions",
	base_url: DEEPSEEK_V4_FLASH_MODEL_BASE_URL,
	reasoning: true,
	thinking_level: "high",
	temperature: FROZEN_TEMPERATURE,
	request_timeout_ms: FROZEN_PROVIDER_REQUEST_TIMEOUT_MS,
	provider_context_window: 1_000_000,
	provider_max_tokens: 384_000,
	context_window: 131_072,
	max_tokens: 16_384,
	input: ["text"],
	pricing_spec_sha256: FROZEN_DEEPSEEK_V4_FLASH_PRICING_SPEC_SHA256,
	registry_cost_semantics: "conservative_upper_bound_only",
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	},
} as const;

export interface FrozenModelRuntime {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model<Api>;
	readonly modelSpecSha256: string;
	readonly pricingSpecSha256: string;
	readonly forceStageCompletionToolChoice: boolean;
}

export interface AdmissionGatedSession {
	readonly agent: {
		streamFn: (
			model: Model<Api>,
			context: Context,
			streamOptions?: SimpleStreamOptions,
		) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	};
}

interface ModelRuntimeDefinition {
	readonly provider: string;
	readonly providerName: string;
	readonly baseUrl: string;
	readonly apiKeyEnvironmentName: string;
	readonly modelId: string;
	readonly modelName: string;
	readonly modelSpec: unknown;
	readonly pricingSpecSha256: string;
	readonly compat: Model<Api>["compat"];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
	readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	readonly forceStageCompletionToolChoice: boolean;
}

const GLM_45_AIR_RUNTIME: ModelRuntimeDefinition = {
	provider: FROZEN_MODEL_PROVIDER,
	providerName: "Zhipu Standard",
	baseUrl: FROZEN_MODEL_BASE_URL,
	apiKeyEnvironmentName: "ZHIPU_API_KEY",
	modelId: FROZEN_MODEL_ID,
	modelName: "GLM-4.5-Air",
	modelSpec: FROZEN_MODEL_SPEC,
	pricingSpecSha256: FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256,
	compat: FROZEN_MODEL_SPEC.compat,
	contextWindow: 131_072,
	maxTokens: 16_384,
	cost: { input: 1.2, output: 8, cacheRead: 0.24, cacheWrite: 0 },
	forceStageCompletionToolChoice: true,
};

const DEEPSEEK_V4_FLASH_RUNTIME: ModelRuntimeDefinition = {
	provider: DEEPSEEK_V4_FLASH_MODEL_PROVIDER,
	providerName: "DeepSeek",
	baseUrl: DEEPSEEK_V4_FLASH_MODEL_BASE_URL,
	apiKeyEnvironmentName: "DEEPSEEK_API_KEY",
	modelId: DEEPSEEK_V4_FLASH_MODEL_ID,
	modelName: "DeepSeek V4 Flash",
	modelSpec: DEEPSEEK_V4_FLASH_MODEL_SPEC,
	pricingSpecSha256: FROZEN_DEEPSEEK_V4_FLASH_PRICING_SPEC_SHA256,
	compat: DEEPSEEK_V4_FLASH_MODEL_SPEC.compat,
	contextWindow: DEEPSEEK_V4_FLASH_MODEL_SPEC.context_window,
	maxTokens: DEEPSEEK_V4_FLASH_MODEL_SPEC.max_tokens,
	cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
	forceStageCompletionToolChoice: false,
};

/** Create the frozen GLM-4.5-Air runtime used by the primary configuration. */
export function createFrozenModelRuntime(
	apiKey?: string,
	apiKeyFile?: string,
	useEnvironment = true,
): FrozenModelRuntime {
	return createModelRuntime(GLM_45_AIR_RUNTIME, apiKey, apiKeyFile, useEnvironment);
}

/** Create the frozen DeepSeek V4 Flash runtime used by the alternate configuration. */
export function createDeepSeekV4FlashRuntime(
	apiKey?: string,
	apiKeyFile?: string,
	useEnvironment = true,
): FrozenModelRuntime {
	return createModelRuntime(DEEPSEEK_V4_FLASH_RUNTIME, apiKey, apiKeyFile, useEnvironment);
}

/**
 * Resolve one Provider credential, construct in-memory auth and model
 * registries, and register the immutable model definition used by a run.
 */
function createModelRuntime(
	definition: ModelRuntimeDefinition,
	apiKey?: string,
	apiKeyFile?: string,
	useEnvironment = true,
): FrozenModelRuntime {
	const configuredApiKey = apiKey ?? (useEnvironment ? process.env[definition.apiKeyEnvironmentName] : undefined);
	const configuredApiKeyFile =
		apiKeyFile ?? (useEnvironment ? process.env[`${definition.apiKeyEnvironmentName}_FILE`] : undefined);
	let fileApiKey: string | undefined;
	if (configuredApiKeyFile !== undefined) {
		const stats = lstatSync(configuredApiKeyFile);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16_384)
			throw new Error(`${definition.apiKeyEnvironmentName}_FILE must be a small regular non-symlink file`);
		fileApiKey = readFileSync(realpathSync(configuredApiKeyFile), "utf8").trim();
		if (fileApiKey.length === 0) throw new Error(`${definition.apiKeyEnvironmentName}_FILE contains no API key`);
	}
	const environmentApiKey = configuredApiKey?.trim();
	if (fileApiKey !== undefined && environmentApiKey !== undefined && fileApiKey !== environmentApiKey) {
		throw new Error(`${definition.apiKeyEnvironmentName}_FILE and ${definition.apiKeyEnvironmentName} disagree`);
	}
	const resolvedApiKey = fileApiKey ?? environmentApiKey;
	if (resolvedApiKey === undefined || resolvedApiKey.length === 0) {
		throw new Error(`${definition.apiKeyEnvironmentName} is required for a non-dry-run experiment`);
	}
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(definition.provider, resolvedApiKey);
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(definition.provider, {
		name: definition.providerName,
		baseUrl: definition.baseUrl,
		apiKey: `$${definition.apiKeyEnvironmentName}`,
		api: "openai-completions",
		models: [
			{
				id: definition.modelId,
				name: definition.modelName,
				reasoning: true,
				input: ["text"],
				cost: definition.cost,
				contextWindow: definition.contextWindow,
				maxTokens: definition.maxTokens,
				compat: definition.compat,
				...(definition.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: definition.thinkingLevelMap }),
			},
		],
	});
	const model = modelRegistry.find(definition.provider, definition.modelId);
	if (model === undefined) throw new Error("Frozen model registration failed");
	return {
		authStorage,
		modelRegistry,
		model,
		modelSpecSha256: canonicalContractSha256(definition.modelSpec),
		pricingSpecSha256: definition.pricingSpecSha256,
		forceStageCompletionToolChoice: definition.forceStageCompletionToolChoice,
	};
}

/** Create a Pi-general session and wrap it with the frozen Provider options. */
export async function createFrozenPiGeneralSession(
	runtime: FrozenModelRuntime,
	options: Omit<PiGeneralSessionOptions, "model" | "authStorage" | "modelRegistry" | "thinkingLevel">,
): Promise<PiGeneralSessionResult> {
	const result = await createPiGeneralSession({
		...options,
		model: runtime.model,
		authStorage: runtime.authStorage,
		modelRegistry: runtime.modelRegistry,
		thinkingLevel: "high",
	});
	const stream = result.session.agent.streamFn;
	result.session.agent.streamFn = (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) =>
		stream(model, context, frozenProviderStreamOptions(streamOptions));
	return result;
}

/** Create a RepoFix session and wrap it with the frozen Provider options. */
export async function createFrozenRepoFixSession(
	runtime: FrozenModelRuntime,
	options: Omit<RepoFixSessionOptions, "model" | "authStorage" | "modelRegistry" | "thinkingLevel">,
): Promise<RepoFixSessionResult> {
	const result = await createRepoFixSession({
		...options,
		model: runtime.model,
		authStorage: runtime.authStorage,
		modelRegistry: runtime.modelRegistry,
		thinkingLevel: "high",
		forceStageCompletionToolChoice: runtime.forceStageCompletionToolChoice,
	});
	const stream = result.session.agent.streamFn;
	result.session.agent.streamFn = (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) =>
		stream(model, context, frozenProviderStreamOptions(streamOptions));
	const providerStream = result.providerStream;
	return {
		...result,
		providerStream: (model, context, streamOptions) =>
			providerStream(model, context, frozenProviderStreamOptions(streamOptions)),
	};
}

/**
 * Merge caller cancellation with the frozen temperature, output-token limit,
 * request timeout, and timeout signal used for every Provider call.
 */
export function frozenProviderStreamOptions(streamOptions?: SimpleStreamOptions): SimpleStreamOptions {
	const deadline = AbortSignal.timeout(FROZEN_PROVIDER_REQUEST_TIMEOUT_MS);
	const signal = streamOptions?.signal === undefined ? deadline : AbortSignal.any([streamOptions.signal, deadline]);
	return {
		...streamOptions,
		temperature: FROZEN_TEMPERATURE,
		maxTokens: Math.min(16_384, streamOptions?.maxTokens ?? 16_384),
		timeoutMs: FROZEN_PROVIDER_REQUEST_TIMEOUT_MS,
		signal,
	};
}

/**
 * Hash the effective model specification, system prompt, and sorted tool
 * schema so artifacts identify the runtime that actually executed.
 */
export function runtimeIdentityFromSession(
	session: PiGeneralSessionResult["session"] | RepoFixSessionResult["session"],
	modelSpecSha256: string,
): { modelSpecSha256: string; systemPromptSha256: string; toolSchemaSha256: string } {
	const toolDefinitions = session
		.getAllTools()
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
		.sort((left, right) => left.name.localeCompare(right.name));
	return {
		modelSpecSha256,
		systemPromptSha256: canonicalRawTextSha256(session.systemPrompt),
		toolSchemaSha256: canonicalContractSha256(toolDefinitions),
	};
}

/**
 * Block a new Provider turn after any configured accumulated-token,
 * model-turn, or tool-call boundary has been reached.
 */
export function installRunAdmissionGate(
	session: AdmissionGatedSession,
	limits: { readonly accountedTokens: number | null; readonly modelTurns: number; readonly toolCalls: number | null },
): void {
	const stream = session.agent.streamFn;
	session.agent.streamFn = (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => {
		let accountedTokens = 0;
		let modelTurns = 0;
		let toolCalls = 0;
		for (const message of context.messages) {
			if (message.role !== "assistant") continue;
			accountedTokens += message.usage.totalTokens;
			modelTurns += 1;
			toolCalls += message.content.filter((content) => content.type === "toolCall").length;
		}
		if (
			(limits.accountedTokens === null || accountedTokens < limits.accountedTokens) &&
			modelTurns < limits.modelTurns &&
			(limits.toolCalls === null || toolCalls < limits.toolCalls)
		) {
			return stream(model, context, streamOptions);
		}
		const errorMessage =
			limits.accountedTokens !== null && accountedTokens >= limits.accountedTokens
				? RUN_ADMISSION_TOKEN_BUDGET_ERROR
				: modelTurns >= limits.modelTurns
					? RUN_ADMISSION_MODEL_TURN_LIMIT_ERROR
					: RUN_ADMISSION_TOOL_CALL_LIMIT_ERROR;
		const error = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		const blocked = createAssistantMessageEventStream();
		blocked.push({ type: "error", reason: "error", error });
		return blocked;
	};
}

/** Compute the exact UTF-8 SHA-256 used for raw prompt identity evidence. */
function canonicalRawTextSha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
