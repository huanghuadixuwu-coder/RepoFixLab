import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Type } from "typebox";
import { streamSimple, type AssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { stableStringify } from "../contracts/canonical-json.ts";
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import {
	DEEPSEEK_V4_FLASH_MODEL_ID,
	DEEPSEEK_V4_FLASH_MODEL_PROVIDER,
	DEEPSEEK_V4_FLASH_MODEL_SPEC,
	createDeepSeekV4FlashRuntime,
	FROZEN_TEMPERATURE,
	type FrozenModelRuntime,
} from "../runner/runtime-factory.ts";
import {
	createTokenAdmissionEstimator,
	FsyncTokenLedgerSink,
	installTokenSupervisor,
	TokenReservationLedger,
	type TokenSupervisedSession,
} from "../runner/token-supervisor.ts";
import { M6_CALIBRATION_PROTOCOL_REVISION } from "./calibration-cohort.ts";

export const M6_PROVIDER_SMOKE_MAX_TOKENS = 10_000;
const SMOKE_MAX_OUTPUT_TOKENS = 2_048;
const SMOKE_TIMEOUT_MS = 120_000;
const SMOKE_ESTIMATOR = {
	version: "m6-smoke-provisional-v1",
	multiplier: 1.25,
	framing_margin_tokens: 256,
} as const;

export interface M6ProviderSmokeReport {
	readonly schema_version: "v1";
	readonly report_type: "m6_provider_smoke";
	readonly protocol_revision: typeof M6_CALIBRATION_PROTOCOL_REVISION;
	readonly run_id: string;
	readonly started_at: string;
	readonly finished_at: string;
	readonly status: "pass" | "fail";
	readonly model: {
		readonly provider: typeof DEEPSEEK_V4_FLASH_MODEL_PROVIDER;
		readonly model_id: typeof DEEPSEEK_V4_FLASH_MODEL_ID;
		readonly model_spec_sha256: string;
		readonly pricing_spec_sha256: string;
		readonly temperature: typeof FROZEN_TEMPERATURE;
		readonly max_output_tokens: typeof SMOKE_MAX_OUTPUT_TOKENS;
	};
	readonly token_admission: typeof SMOKE_ESTIMATOR;
	readonly checks: {
		readonly text: boolean;
		readonly tool_call: boolean;
		readonly streaming_usage: boolean;
		readonly timeout_control: boolean;
	};
	readonly calls: readonly {
		readonly name: "text" | "tool";
		readonly stop_reason: AssistantMessage["stopReason"];
		readonly response_status: number | null;
		readonly event_types: readonly string[];
		readonly usage_complete: boolean;
	}[];
	readonly token_ledger_sha256: string;
	readonly accounted_tokens: number;
	readonly error: string | null;
}

function usageIsComplete(message: AssistantMessage): boolean {
	const usage = message.usage;
	return (
		[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		) &&
		usage.totalTokens === usage.input + usage.output + usage.cacheRead + usage.cacheWrite
	);
}

function textFrom(message: AssistantMessage): string {
	return message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
}

function safeMessage(error: unknown): string {
	return (error instanceof Error ? error.message : "Unknown provider smoke failure")
		.replace(/((?:authorization|bearer|api[_ -]?key)\s*[:=]?\s*)\S+/gi, "$1[REDACTED]")
		.replace(/(?<![A-Za-z0-9])[A-Za-z0-9]{24,}\.[A-Za-z0-9_-]{6,}(?![A-Za-z0-9])/g, "[REDACTED]")
		.slice(0, 2_000);
}

function assertSmokeCallSucceeded(name: "text" | "tool", message: AssistantMessage): void {
	if (message.stopReason !== "error") return;
	throw new Error(`M6 ${name} smoke provider error: ${message.errorMessage ?? "unknown error"}`);
}

async function runSmokeCall(
	session: TokenSupervisedSession,
	model: FrozenModelRuntime["model"],
	name: "text" | "tool",
	context: Context,
): Promise<{
	readonly message: AssistantMessage;
	readonly responseStatus: number | null;
	readonly eventTypes: readonly string[];
}> {
	let responseStatus: number | null = null;
	const source = await session.agent.streamFn(model, context, {
		temperature: FROZEN_TEMPERATURE,
		maxTokens: SMOKE_MAX_OUTPUT_TOKENS,
		timeoutMs: SMOKE_TIMEOUT_MS,
		signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
		onResponse: (response) => {
			responseStatus = response.status;
		},
	});
	const eventTypes: string[] = [];
	let final: AssistantMessage | null = null;
	for await (const event of source) {
		eventTypes.push(event.type);
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	if (final === null) throw new Error(`M6 ${name} smoke ended without a terminal event`);
	return { message: final, responseStatus, eventTypes };
}

/**
 * Performs the paid, low-volume provider compatibility gate before calibration.
 * It records only protocol and usage evidence, never prompt text, model text, or credentials.
 */
export async function runM6ProviderSmoke(options: {
	readonly artifacts_root: string;
	readonly project_cap_tokens?: number;
	readonly now?: () => Date;
	readonly random_id?: () => string;
	readonly runtime?: FrozenModelRuntime;
}): Promise<M6ProviderSmokeReport> {
	const now = options.now ?? (() => new Date());
	const randomId = options.random_id ?? randomUUID;
	const runId = `m6-smoke-${randomId()}`;
	const startedAt = now().toISOString();
	const finalDirectory = resolve(options.artifacts_root, "m6-deepseek-flash-provider-smoke", "runs", runId);
	const stagingDirectory = resolve(options.artifacts_root, "m6-deepseek-flash-provider-smoke", "runs", `.staging-${runId}`);
	const store = await ArtifactStore.createNew(stagingDirectory);
	const ledgerPath = store.resolvePath("token-ledger.jsonl");
	const ledgerSink = new FsyncTokenLedgerSink(ledgerPath);
	let ledger: TokenReservationLedger | null = null;
	const calls: M6ProviderSmokeReport["calls"][number][] = [];
	let error: string | null = null;
	let accountedTokens = 0;
	let checks = { text: false, tool_call: false, streaming_usage: false, timeout_control: false };
	try {
		const runtime = options.runtime ?? createDeepSeekV4FlashRuntime();
		const smokeLedger = new TokenReservationLedger(
			{
				per_run_accounted_cap_tokens: options.project_cap_tokens ?? M6_PROVIDER_SMOKE_MAX_TOKENS,
				project_accounted_cap_tokens: options.project_cap_tokens ?? M6_PROVIDER_SMOKE_MAX_TOKENS,
			},
			ledgerSink,
		);
		ledger = smokeLedger;
		const estimator = createTokenAdmissionEstimator(SMOKE_ESTIMATOR);
		let requestSequence = 0;
		const session: TokenSupervisedSession = {
			agent: {
				streamFn: async (model, context, streamOptions) => {
					const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) throw new Error(auth.error);
					if (auth.apiKey === undefined) throw new Error("M6 smoke model authentication has no API key");
					return streamSimple(model, context, {
						...streamOptions,
						apiKey: auth.apiKey,
						headers: auth.headers,
					});
				},
			},
		};
		installTokenSupervisor(session, {
			ledger: smokeLedger,
				run_id: runId,
				max_output_tokens: SMOKE_MAX_OUTPUT_TOKENS,
				estimate_input_tokens: (context) => estimator.estimate(context),
				estimate_base_input_tokens: (context) => estimator.baseEstimate(context),
				next_request_id: () => `${runId}:provider:${String(requestSequence++).padStart(4, "0")}`,
		});
		const textResult = await runSmokeCall(session, runtime.model, "text", {
			systemPrompt: "RepoFixLab M6 provider compatibility smoke. Follow the user instruction exactly.",
			messages: [{ role: "user", content: "Reply with exactly M6_TEXT_SMOKE_OK.", timestamp: Date.now() }],
			tools: [],
		});
		calls.push({
			name: "text",
			stop_reason: textResult.message.stopReason,
			response_status: textResult.responseStatus,
			event_types: textResult.eventTypes,
			usage_complete: usageIsComplete(textResult.message),
		});
		assertSmokeCallSucceeded("text", textResult.message);
		checks = {
			...checks,
			text: textResult.message.stopReason === "stop" && textFrom(textResult.message).trim() === "M6_TEXT_SMOKE_OK",
			streaming_usage: usageIsComplete(textResult.message) && textResult.eventTypes.includes("text_delta"),
			timeout_control: textResult.responseStatus !== null,
		};
		const toolResult = await runSmokeCall(session, runtime.model, "tool", {
			systemPrompt: "RepoFixLab M6 provider compatibility smoke. Follow the user instruction exactly.",
			messages: [
				{
					role: "user",
					content: "Call m6_smoke_echo exactly once with ready=true. Do not write prose.",
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					name: "m6_smoke_echo",
					description: "M6 tool-call compatibility smoke. Invoke it once when requested.",
					parameters: Type.Object({ ready: Type.Literal(true) }),
				},
			],
		});
		calls.push({
			name: "tool",
			stop_reason: toolResult.message.stopReason,
			response_status: toolResult.responseStatus,
			event_types: toolResult.eventTypes,
			usage_complete: usageIsComplete(toolResult.message),
		});
		assertSmokeCallSucceeded("tool", toolResult.message);
		const toolCalls = toolResult.message.content.filter((item) => item.type === "toolCall");
		checks = {
			...checks,
			tool_call:
				toolResult.message.stopReason === "toolUse" &&
				toolCalls.length === 1 &&
				toolCalls[0]!.name === "m6_smoke_echo" &&
				toolCalls[0]!.arguments.ready === true,
			streaming_usage: checks.streaming_usage && usageIsComplete(toolResult.message) && toolResult.eventTypes.includes("toolcall_end"),
			timeout_control: checks.timeout_control && toolResult.responseStatus !== null,
		};
		if (smokeLedger.requiresReconciliation) throw new Error("M6 provider smoke has unverified provider usage");
		accountedTokens = smokeLedger.projectAccounted;
	} catch (caught) {
		error = safeMessage(caught);
	} finally {
		if (ledger !== null) accountedTokens = ledger.projectAccounted;
		ledgerSink.close();
	}
	const tokenLedger = await store.registerClosedFile("token-ledger.jsonl", {
		mediaType: "application/x-ndjson",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	const finishedAt = now().toISOString();
	const report: M6ProviderSmokeReport = {
		schema_version: "v1",
		report_type: "m6_provider_smoke",
		protocol_revision: M6_CALIBRATION_PROTOCOL_REVISION,
		run_id: runId,
		started_at: startedAt,
		finished_at: finishedAt,
		status: error === null && Object.values(checks).every(Boolean) ? "pass" : "fail",
		model: {
			provider: DEEPSEEK_V4_FLASH_MODEL_PROVIDER,
			model_id: DEEPSEEK_V4_FLASH_MODEL_ID,
			model_spec_sha256: canonicalContractSha256(DEEPSEEK_V4_FLASH_MODEL_SPEC),
			pricing_spec_sha256: DEEPSEEK_V4_FLASH_MODEL_SPEC.pricing_spec_sha256,
			temperature: FROZEN_TEMPERATURE,
			max_output_tokens: SMOKE_MAX_OUTPUT_TOKENS,
		},
		token_admission: SMOKE_ESTIMATOR,
		checks,
		calls,
		token_ledger_sha256: tokenLedger.sha256,
		accounted_tokens: accountedTokens,
		error,
	};
	await store.writeNew("provider-smoke-report.json", stableStringify(report), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await store.publishTo(finalDirectory);
	return report;
}
