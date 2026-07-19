import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createPiGeneralSession, type PiGeneralSessionResult } from "../src/agent/pi-general.ts";
import type { RepoToolTransport } from "../src/controller/client.ts";
import {
	REPO_TOOL_NAMES,
	type RepoToolName,
	type RepoToolRequest,
	type RepoToolResponse,
} from "../src/sandbox/protocol.ts";

class RecordingRepoToolTransport implements RepoToolTransport {
	readonly requests: RepoToolRequest[] = [];
	readonly executionOrder: string[] = [];
	failTool: RepoToolRequest["tool"] | undefined;
	readonly results: Partial<Record<RepoToolName, RepoToolResponse["result"]>> = {};

	async execute(request: RepoToolRequest, signal?: AbortSignal): Promise<RepoToolResponse> {
		this.requests.push(request);
		this.executionOrder.push(`start:${request.tool}`);
		if (request.tool === "repo_read") {
			await new Promise<void>((resolvePromise, reject) => {
				const timer = setTimeout(resolvePromise, 20);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		}
		if (request.tool === this.failTool) {
			throw new Error("sandbox exploded");
		}
		this.executionOrder.push(`end:${request.tool}`);

		const stdout =
			request.tool === "repo_read"
				? "export const value = 1;"
				: request.tool === "repo_diff"
					? "diff --git a/src/a.ts b/src/a.ts"
					: "ok";
		return {
			tool: request.tool,
			result: this.results[request.tool] ?? {
				tool: request.tool,
				exit_code: 0,
				stdout,
				stderr: "",
				truncated: false,
				timed_out: false,
				duration_ms: 1,
			},
		};
	}
}

function createFauxModelRegistry(harness: Harness): ModelRegistry {
	const model = harness.getModel();
	const registry = ModelRegistry.inMemory(harness.authStorage);
	registry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: harness.faux.api,
		models: harness.faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	return registry;
}

describe("pi-general session factory", () => {
	const harnesses: Harness[] = [];
	const sessions: PiGeneralSessionResult[] = [];

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.session.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSession(
		transport: RepoToolTransport,
	): Promise<{ harness: Harness; result: PiGeneralSessionResult }> {
		const harness = await createHarness();
		harnesses.push(harness);
		const attemptDirectory = join(harness.tempDir, "attempt");
		const result = await createPiGeneralSession({
			leaseId: "lease-test-1",
			attemptDirectory,
			cwd: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: createFauxModelRegistry(harness),
			transport,
			thinkingLevel: "off",
		});
		sessions.push(result);
		return { harness, result };
	}

	async function runRepoExecResult(
		toolResult: RepoToolResponse["result"],
	): Promise<{ text: string; details: unknown }> {
		const transport = new RecordingRepoToolTransport();
		transport.results.repo_exec = toolResult;
		const { harness, result } = await createSession(transport);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("repo_exec", { argv: ["test-command"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("observed command result"),
		]);

		await result.session.prompt("run the command");

		const message = result.session.messages.find((candidate) => candidate.role === "toolResult");
		if (message?.role !== "toolResult") {
			throw new Error("repo_exec did not produce a Pi tool result");
		}
		return { text: getMessageText(message), details: message.details };
	}

	it("runs the real Pi tool-call loop with the exact six-tool set and sequential execution", async () => {
		const transport = new RecordingRepoToolTransport();
		const { harness, result } = await createSession(transport);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("repo_read", { path: "src/a.ts" }), fauxToolCall("repo_diff", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await result.session.prompt("repair the issue");

		expect(result.session.getAllTools().map((tool) => tool.name)).toEqual(REPO_TOOL_NAMES);
		expect(result.session.getActiveToolNames()).toEqual(REPO_TOOL_NAMES);
		expect(transport.executionOrder).toEqual([
			"start:repo_read",
			"end:repo_read",
			"start:repo_diff",
			"end:repo_diff",
		]);
		expect(transport.requests.map((request) => request.leaseId)).toEqual(["lease-test-1", "lease-test-1"]);
		expect(transport.requests.every((request) => request.operationId.startsWith("tool:"))).toBe(true);
		expect(result.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		const sessionFile = result.sessionManager.getSessionFile();
		if (sessionFile === undefined) {
			throw new Error("pi-general session did not allocate a session file");
		}
		expect(resolve(sessionFile).startsWith(`${resolve(harness.tempDir, "attempt")}${sep}`)).toBe(true);
		expect(existsSync(sessionFile)).toBe(true);
	});

	it("shows a failed command's exit code and both output streams to the model", async () => {
		const details: RepoToolResponse["result"] = {
			tool: "repo_exec",
			exit_code: 2,
			stdout: "partial output",
			stderr: "fatal error",
			truncated: false,
			timed_out: false,
			duration_ms: 9,
		};
		const visible = await runRepoExecResult(details);

		expect(visible.text).toBe(
			[
				"tool: repo_exec",
				"exit_code: 2",
				"timed_out: false",
				"truncated: false",
				"model_output_truncated: false",
				"duration_ms: 9",
				"stdout:",
				"partial output",
				"stderr:",
				"fatal error",
			].join("\n"),
		);
		expect(visible.details).toEqual(details);
	});

	it("shows stderr when a command has no stdout", async () => {
		const visible = await runRepoExecResult({
			tool: "repo_exec",
			exit_code: 0,
			stdout: "",
			stderr: "warning only",
			truncated: false,
			timed_out: false,
			duration_ms: 4,
		});

		expect(visible.text).toContain("stdout:\n<empty>\nstderr:\nwarning only");
		expect(visible.text).toContain("exit_code: 0");
	});

	it("shows timeout and truncation terminal state to the model", async () => {
		const visible = await runRepoExecResult({
			tool: "repo_exec",
			exit_code: null,
			stdout: "still running",
			stderr: "killed after deadline",
			truncated: true,
			timed_out: true,
			duration_ms: 120_000,
		});

		expect(visible.text).toContain("exit_code: null");
		expect(visible.text).toContain("timed_out: true");
		expect(visible.text).toContain("truncated: true");
		expect(visible.text).toContain("stderr:\nkilled after deadline");
	});

	it("bounds combined model-visible streams without changing structured details", async () => {
		const stdout = "x".repeat(65_536);
		const details: RepoToolResponse["result"] = {
			tool: "repo_exec",
			exit_code: 0,
			stdout,
			stderr: "must not exceed the presentation limit",
			truncated: false,
			timed_out: false,
			duration_ms: 3,
		};
		const visible = await runRepoExecResult(details);

		expect(visible.text).toContain("model_output_truncated: true");
		expect(visible.text).not.toContain(details.stderr);
		expect(visible.text.length).toBeLessThan(66_000);
		expect(visible.details).toEqual(details);
	});

	it("disables compaction and both Pi retry layers for provider errors", async () => {
		const { harness, result } = await createSession(new RecordingRepoToolTransport());
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
		]);

		await result.session.prompt("repair the issue");

		expect(result.settingsManager.getCompactionEnabled()).toBe(false);
		expect(result.settingsManager.getRetryEnabled()).toBe(false);
		expect(result.settingsManager.getProviderRetrySettings().maxRetries).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
		const lastMessage = result.session.messages[result.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("error");
			expect(lastMessage.errorMessage).toBe("overloaded_error");
		}
	});

	it("turns a transport exception into a Pi tool error and continues the loop", async () => {
		const transport = new RecordingRepoToolTransport();
		transport.failTool = "repo_read";
		const { harness, result } = await createSession(transport);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("repo_read", { path: "src/a.ts" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("handled the tool failure"),
		]);

		await result.session.prompt("repair the issue");

		const toolResult = result.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(getMessageText(toolResult)).toContain("sandbox exploded");
		}
		expect(getMessageText(result.session.messages[result.session.messages.length - 1])).toBe(
			"handled the tool failure",
		);
	});

	it("aborts an in-flight provider response and persists the aborted assistant state", async () => {
		const { harness, result } = await createSession(new RecordingRepoToolTransport());
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const sawMessageUpdate = new Promise<void>((resolvePromise) => {
			const unsubscribe = result.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolvePromise();
				}
			});
		});

		const promptPromise = result.session.prompt("repair the issue");
		await sawMessageUpdate;
		await result.session.abort();
		await promptPromise;

		const lastMessage = result.session.messages[result.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});

	it("cannot enable built-in or unknown tools and never dispatches them to the transport", async () => {
		const transport = new RecordingRepoToolTransport();
		const { harness, result } = await createSession(transport);
		result.session.setActiveToolsByName([...REPO_TOOL_NAMES, "read", "bash", "unknown_tool"]);
		expect(result.session.getActiveToolNames()).toEqual(REPO_TOOL_NAMES);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }), fauxToolCall("unknown_tool", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("unknown tools rejected"),
		]);
		await result.session.prompt("try unavailable tools");

		expect(transport.requests).toEqual([]);
		const toolResults = result.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((message) => message.isError)).toBe(true);
	});

	it("does not load extensions, skills, prompts, themes, or instruction files", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const attemptDirectory = join(harness.tempDir, "attempt");
		const agentDirectory = join(attemptDirectory, "pi-agent");
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL");
		writeFileSync(join(agentDirectory, "CLAUDE.md"), "GLOBAL_CONTEXT_SENTINEL");
		writeFileSync(join(agentDirectory, "SYSTEM.md"), "SYSTEM_PROMPT_SENTINEL");

		const result = await createPiGeneralSession({
			leaseId: "lease-test-1",
			attemptDirectory,
			cwd: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: createFauxModelRegistry(harness),
			transport: new RecordingRepoToolTransport(),
		});
		sessions.push(result);

		expect(result.session.resourceLoader.getExtensions().extensions).toEqual([]);
		expect(result.session.resourceLoader.getSkills().skills).toEqual([]);
		expect(result.session.resourceLoader.getPrompts().prompts).toEqual([]);
		expect(result.session.resourceLoader.getThemes().themes).toEqual([]);
		expect(result.session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
		expect(result.session.systemPrompt).not.toContain("PROJECT_CONTEXT_SENTINEL");
		expect(result.session.systemPrompt).not.toContain("GLOBAL_CONTEXT_SENTINEL");
		expect(result.session.systemPrompt).not.toContain("SYSTEM_PROMPT_SENTINEL");
		expect(result.session.systemPrompt).toContain("old_text");
		expect(result.session.systemPrompt).toContain("argv must always be a JSON string array");
		expect(result.session.systemPrompt).toContain("Treat runtime types and available APIs as evidence");
		expect(result.session.systemPrompt).toContain("Do not guess unsupported npm flags");
	});
});
