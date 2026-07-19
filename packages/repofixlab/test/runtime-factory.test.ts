import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256 } from "../src/runner/pricing.ts";
import {
	type AdmissionGatedSession,
	createFrozenModelRuntime,
	FROZEN_MODEL_BASE_URL,
	FROZEN_MODEL_ID,
	FROZEN_MODEL_PROVIDER,
	installRunAdmissionGate,
	RUN_ADMISSION_BUDGET_ERROR,
} from "../src/runner/runtime-factory.ts";

const directories: string[] = [];

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("frozen model runtime", () => {
	it("registers the exact production model without persisting its key", () => {
		const runtime = createFrozenModelRuntime("test-secret", undefined, false);
		expect(runtime.model).toMatchObject({
			provider: FROZEN_MODEL_PROVIDER,
			id: FROZEN_MODEL_ID,
			baseUrl: FROZEN_MODEL_BASE_URL,
			api: "openai-completions",
			reasoning: true,
			contextWindow: 131_072,
			maxTokens: 16_384,
		});
		expect(runtime.modelSpecSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(runtime.pricingSpecSha256).toBe(FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256);
		expect(runtime.model.cost).toEqual({ input: 1.2, output: 8, cacheRead: 0.24, cacheWrite: 0 });
		expect(JSON.stringify(runtime.model)).not.toContain("test-secret");
	});

	it("prefers a bounded secret file and rejects conflicting environment input", async () => {
		const directory = mkdtempSync(join(tmpdir(), "repofixlab-key-"));
		directories.push(directory);
		const keyPath = join(directory, "zhipu-key");
		writeFileSync(keyPath, "file-secret\n", { encoding: "utf8", mode: 0o600 });
		const runtime = createFrozenModelRuntime(undefined, keyPath, false);
		expect(runtime.model.provider).toBe(FROZEN_MODEL_PROVIDER);
		expect(await runtime.modelRegistry.getApiKeyForProvider(FROZEN_MODEL_PROVIDER)).toBe("file-secret");
		expect(() => createFrozenModelRuntime("different-secret", keyPath, false)).toThrow(/disagree/);
	});

	it("fails admission when neither secret source is configured", () => {
		expect(() => createFrozenModelRuntime(undefined, undefined, false)).toThrow(/required/);
	});

	it("denies the next provider request after accounted usage reaches the cap", async () => {
		const runtime = createFrozenModelRuntime("test-secret", undefined, false);
		let providerCalls = 0;
		const accounted = {
			...fauxAssistantMessage("tool requested"),
			api: runtime.model.api,
			provider: runtime.model.provider,
			model: runtime.model.id,
			usage: {
				input: 199_999,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 200_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const session: AdmissionGatedSession = {
			agent: {
				streamFn: () => {
					providerCalls += 1;
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message: accounted });
					stream.end(accounted);
					return stream;
				},
			},
		};
		installRunAdmissionGate(session, { accountedTokens: 200_000, modelTurns: 100, toolCalls: 500 });
		const context = { systemPrompt: "", messages: [], tools: [] };
		const firstStream = await session.agent.streamFn(runtime.model, context);
		await firstStream.result();
		const blockedStream = await session.agent.streamFn(runtime.model, { ...context, messages: [accounted] });
		const blocked = await blockedStream.result();
		expect(providerCalls).toBe(1);
		expect(blocked.stopReason).toBe("error");
		expect(blocked.errorMessage).toBe(RUN_ADMISSION_BUDGET_ERROR);
	});

	it("keeps model and tool limits while disabling only the Token admission cap", async () => {
		const runtime = createFrozenModelRuntime("test-secret", undefined, false);
		let providerCalls = 0;
		const session: AdmissionGatedSession = {
			agent: {
				streamFn: () => {
					providerCalls += 1;
					const message = fauxAssistantMessage("continued");
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			},
		};
		installRunAdmissionGate(session, { accountedTokens: null, modelTurns: 100, toolCalls: 500 });
		const prior = {
			...fauxAssistantMessage("prior"),
			api: runtime.model.api,
			provider: runtime.model.provider,
			model: runtime.model.id,
			usage: {
				input: 300_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 300_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const stream = await session.agent.streamFn(runtime.model, { systemPrompt: "", messages: [prior], tools: [] });
		await stream.result();
		expect(providerCalls).toBe(1);
	});
});
