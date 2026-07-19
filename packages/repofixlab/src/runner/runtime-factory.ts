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
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import { FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256 } from "./pricing.ts";

export const FROZEN_MODEL_PROVIDER = "zhipu-standard";
export const FROZEN_MODEL_ID = "glm-4.5-air";
export const FROZEN_MODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const FROZEN_TEMPERATURE = 0.2;
export const RUN_ADMISSION_BUDGET_ERROR = "repofixlab_accounted_admission_cap_reached";

export const FROZEN_MODEL_SPEC = {
	provider: FROZEN_MODEL_PROVIDER,
	model_id: FROZEN_MODEL_ID,
	api: "openai-completions",
	base_url: FROZEN_MODEL_BASE_URL,
	reasoning: true,
	thinking_level: "high",
	temperature: FROZEN_TEMPERATURE,
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

export interface FrozenModelRuntime {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model<Api>;
	readonly modelSpecSha256: string;
	readonly pricingSpecSha256: string;
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

export function createFrozenModelRuntime(
	apiKey?: string,
	apiKeyFile?: string,
	useEnvironment = true,
): FrozenModelRuntime {
	const configuredApiKey = apiKey ?? (useEnvironment ? process.env.ZHIPU_API_KEY : undefined);
	const configuredApiKeyFile = apiKeyFile ?? (useEnvironment ? process.env.ZHIPU_API_KEY_FILE : undefined);
	let fileApiKey: string | undefined;
	if (configuredApiKeyFile !== undefined) {
		const stats = lstatSync(configuredApiKeyFile);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16_384)
			throw new Error("ZHIPU_API_KEY_FILE must be a small regular non-symlink file");
		fileApiKey = readFileSync(realpathSync(configuredApiKeyFile), "utf8").trim();
		if (fileApiKey.length === 0) throw new Error("ZHIPU_API_KEY_FILE contains no API key");
	}
	const environmentApiKey = configuredApiKey?.trim();
	if (fileApiKey !== undefined && environmentApiKey !== undefined && fileApiKey !== environmentApiKey) {
		throw new Error("ZHIPU_API_KEY_FILE and ZHIPU_API_KEY disagree");
	}
	const resolvedApiKey = fileApiKey ?? environmentApiKey;
	if (resolvedApiKey === undefined || resolvedApiKey.length === 0) {
		throw new Error("ZHIPU_API_KEY is required for a non-dry-run experiment");
	}
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(FROZEN_MODEL_PROVIDER, resolvedApiKey);
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(FROZEN_MODEL_PROVIDER, {
		name: "Zhipu Standard",
		baseUrl: FROZEN_MODEL_BASE_URL,
		apiKey: "$ZHIPU_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: FROZEN_MODEL_ID,
				name: "GLM-4.5-Air",
				reasoning: true,
				input: ["text"],
				cost: { input: 1.2, output: 8, cacheRead: 0.24, cacheWrite: 0 },
				contextWindow: 131_072,
				maxTokens: 16_384,
				compat: FROZEN_MODEL_SPEC.compat,
			},
		],
	});
	const model = modelRegistry.find(FROZEN_MODEL_PROVIDER, FROZEN_MODEL_ID);
	if (model === undefined) throw new Error("Frozen model registration failed");
	return {
		authStorage,
		modelRegistry,
		model,
		modelSpecSha256: canonicalContractSha256(FROZEN_MODEL_SPEC),
		pricingSpecSha256: FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256,
	};
}

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
		stream(model, context, { ...streamOptions, temperature: FROZEN_TEMPERATURE, maxTokens: 16_384 });
	return result;
}

export function runtimeIdentityFromSession(
	session: PiGeneralSessionResult["session"],
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

export function installRunAdmissionGate(
	session: AdmissionGatedSession,
	limits: { readonly accountedTokens: number | null; readonly modelTurns: number; readonly toolCalls: number },
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
			toolCalls < limits.toolCalls
		) {
			return stream(model, context, streamOptions);
		}
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
			errorMessage: RUN_ADMISSION_BUDGET_ERROR,
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		const blocked = createAssistantMessageEventStream();
		blocked.push({ type: "error", reason: "error", error });
		return blocked;
	};
}

function canonicalRawTextSha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
