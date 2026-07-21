import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import {
	createRepoFixConfigurationDiffReport,
	getRepoFixWorkflowConfig,
	REPOFIX_CONFIG_IDS,
} from "../src/agent/repofix-config.ts";
import { createRepoFixSession, runRepoFixWorkflow, type RepoFixSessionResult } from "../src/agent/repofix.ts";
import type { RepoToolTransport } from "../src/controller/client.ts";
import type { RepoToolRequest, RepoToolResponse } from "../src/sandbox/protocol.ts";

class RecordingTransport implements RepoToolTransport {
	readonly requests: RepoToolRequest[] = [];

	async execute(request: RepoToolRequest): Promise<RepoToolResponse> {
		this.requests.push(request);
		return {
			tool: request.tool,
			result: {
				tool: request.tool,
				exit_code: 0,
				stdout: "ok",
				stderr: "",
				truncated: false,
				timed_out: false,
				duration_ms: 1,
			},
		};
	}
}

const harnesses: Harness[] = [];
const sessions: RepoFixSessionResult[] = [];

afterEach(() => {
	while (sessions.length > 0) sessions.pop()?.session.dispose();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function createRegistry(harness: Harness): ModelRegistry {
	const model = harness.getModel();
	const registry = ModelRegistry.inMemory(harness.authStorage);
	registry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: harness.faux.api,
		models: harness.faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	return registry;
}

async function createSession(
	configId: "repofix-full" | "repofix-no-localize" | "repofix-no-verify-feedback",
	options: { readonly forceStageCompletionToolChoice?: boolean } = {},
) {
	const harness = await createHarness();
	harnesses.push(harness);
	const transport = new RecordingTransport();
	const session = await createRepoFixSession({
		leaseId: "lease-test",
		attemptDirectory: join(harness.tempDir, "attempt"),
		cwd: harness.tempDir,
		model: harness.getModel(),
		authStorage: harness.authStorage,
		modelRegistry: createRegistry(harness),
		transport,
		config: getRepoFixWorkflowConfig(configId),
		thinkingLevel: "off",
		forceStageCompletionToolChoice: options.forceStageCompletionToolChoice,
	});
	sessions.push(session);
	return { harness, session, transport };
}

function completion(stage: string) {
	switch (stage) {
		case "UNDERSTAND":
			return { stage, problem_summary: "summary", expected_behavior: ["behavior"], constraints: ["constraint"], acceptance_evidence: ["evidence"] };
		case "LOCALIZE":
			return { stage, candidates: [{ path: "src/a.ts", symbol: "target", evidence: "evidence" }], exclusions: ["excluded"] };
		case "PLAN":
			return { stage, minimal_change_steps: ["change"], risks: ["risk"], targeted_test_argv: ["npm", "test"] };
		case "IMPLEMENT":
			return { stage, change_summary: ["changed source"] };
		case "REFINE":
			return { stage, feedback_assessment: "reviewed controlled output", revision_summary: ["refined source"] };
		case "SELF_REVIEW":
			return { stage, diff_checklist: ["diff inspected"], remaining_risks: ["none known"] };
		default:
			throw new Error(`Unexpected stage ${stage}`);
	}
}

function stageResponses(stages: readonly string[]) {
	return stages.map((stage) =>
		fauxAssistantMessage(fauxToolCall("stage_complete", completion(stage)), { stopReason: "toolUse" }),
	);
}

describe("RepoFix M4 workflow", () => {
	it("runs the full Pi-backed FSM, freezes P0/P1, and delivers controller verification feedback", async () => {
		const { harness, session } = await createSession("repofix-full");
		harness.setResponses(stageResponses(["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]));
		const checkpoints: string[] = [];
		const completed: string[] = [];
		const result = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => {
				checkpoints.push(checkpoint);
				return { patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) };
			},
			controlledVerify: async (plan) => {
				expect(plan.targeted_test_argv).toEqual(["npm", "test"]);
				return { command_argv: ["npm", "test"], exit_code: 1, timed_out: false, output: "targeted test failed" };
			},
			onStageComplete: async (value) => {
				completed.push(value.stage);
			},
		});
		expect(result.p0_patch_sha256).toBe("a".repeat(64));
		expect(result.p1_patch_sha256).toBe("b".repeat(64));
		expect(result.verification_feedback_delivered).toBe(true);
		expect(completed).toEqual(["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]);
		expect(checkpoints).toEqual(["P0", "P1"]);
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("uses configuration flags to skip localization and withhold verification output without duplicating the workflow", async () => {
		const { harness, session } = await createSession("repofix-no-localize");
		harness.setResponses(stageResponses(["UNDERSTAND", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]));
		const noLocalize = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "c".repeat(64) : "d".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
		});
		expect(noLocalize.completions.map((value) => value.stage)).not.toContain("LOCALIZE");
		expect(harness.faux.state.callCount).toBe(5);

		const withheld = await createSession("repofix-no-verify-feedback");
		const prompts: string[] = [];
		withheld.harness.setResponses([
			...stageResponses(["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT"]),
			(context) => {
				prompts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(fauxToolCall("stage_complete", completion("REFINE")), { stopReason: "toolUse" });
			},
			...stageResponses(["SELF_REVIEW"]),
		]);
		const noFeedback = await runRepoFixWorkflow(withheld.session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "e".repeat(64) : "f".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 1, timed_out: false, output: "private failure detail" }),
		});
		expect(noFeedback.verification_feedback_delivered).toBe(false);
		expect(prompts.join("\n")).toContain("intentionally withholds its output");
		expect(prompts.join("\n")).not.toContain("private failure detail");
	});

	it("blocks an entire tool-call batch when stage_complete is mixed with another tool", async () => {
		const { harness, session, transport } = await createSession("repofix-full");
		session.stageMachine.start("UNDERSTAND");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("stage_complete", completion("UNDERSTAND")),
					fauxToolCall("repo_read", { path: "src/a.ts" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" }),
		]);
		await session.session.prompt("Complete the current stage.");
		expect(session.stageMachine.assertComplete("UNDERSTAND").stage).toBe("UNDERSTAND");
		expect(transport.requests).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("normalizes provider JSON-string structured completion fields before strict stage validation", async () => {
		const { harness, session } = await createSession("repofix-full");
		session.stageMachine.start("UNDERSTAND");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("stage_complete", {
					stage: "UNDERSTAND",
					problem_summary: "summary",
					expected_behavior: '["behavior"]',
					constraints: '["constraint"]',
					acceptance_evidence: '["evidence"]',
				}),
				{ stopReason: "toolUse" },
			),
		]);
		await session.session.prompt("Complete the current stage.");
		expect(session.stageMachine.assertComplete("UNDERSTAND")).toEqual(completion("UNDERSTAND"));
	});

	it("normalizes a provider plain-text list field before strict stage validation", async () => {
		const { harness, session } = await createSession("repofix-full");
		session.stageMachine.start("UNDERSTAND");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("stage_complete", {
					stage: "UNDERSTAND",
					problem_summary: "summary",
					expected_behavior: "behavior",
					constraints: "constraint",
					acceptance_evidence: "evidence",
				}),
				{ stopReason: "toolUse" },
			),
		]);
		await session.session.prompt("Complete the current stage.");
		expect(session.stageMachine.assertComplete("UNDERSTAND")).toEqual(completion("UNDERSTAND"));
	});

	it("advertises the active stage artifact fields before a completion attempt", async () => {
		const { harness, session } = await createSession("repofix-full");
		let understandSchema: Record<string, unknown> | null = null;
		let understandPrompt = "";
		harness.setResponses([
			(context) => {
				const tool = context.tools?.find((candidate) => candidate.name === "stage_complete");
				understandSchema = tool?.parameters as Record<string, unknown>;
				understandPrompt = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" });
			},
			...stageResponses(["LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]),
		]);
		await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
		});
		expect(understandSchema).toMatchObject({
			properties: {
				stage: { const: "UNDERSTAND" },
				problem_summary: { minLength: 1 },
				expected_behavior: {},
				constraints: {},
				acceptance_evidence: {},
			},
		});
		expect(understandPrompt).toContain('For UNDERSTAND call stage_complete with exactly {\\"stage\\":\\"UNDERSTAND\\"');
	});

	it("normalizes JSON-encoded localization candidates before strict stage validation", async () => {
		const { harness, session } = await createSession("repofix-full");
		session.stageMachine.start("UNDERSTAND");
		session.stageMachine.complete(completion("UNDERSTAND"));
		session.stageMachine.start("LOCALIZE");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("stage_complete", {
					stage: "LOCALIZE",
					candidates: '["{\\\"path\\\":\\\"src/a.ts\\\",\\\"symbol\\\":\\\"target\\\",\\\"evidence\\\":\\\"evidence\\\"}"]',
					exclusions: '["excluded"]',
				}),
				{ stopReason: "toolUse" },
			),
		]);
		await session.session.prompt("Complete the current stage.");
		expect(session.stageMachine.assertComplete("LOCALIZE")).toEqual(completion("LOCALIZE"));
	});

	it("bounds a rejected LOCALIZE artifact and recovers with a schema-correct completion", async () => {
		const { harness, session } = await createSession("repofix-full");
		const recoveries: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("stage_complete", {
					stage: "LOCALIZE",
					candidates: '["Modify the prop normalization logic"]',
					exclusions: ["none"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("LOCALIZE")), { stopReason: "toolUse" }),
			...stageResponses(["PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]),
		]);
		const result = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
			onStageRecovery: async (recovery) => {
				recoveries.push(`${recovery.stage}:${recovery.trigger}:${String(recovery.maximum_attempts)}`);
			},
		});
		expect(result.completions.map((value) => value.stage)).toHaveLength(6);
		expect(recoveries).toEqual(["LOCALIZE:stage_completion_rejected:2"]);
		expect(harness.faux.state.callCount).toBe(7);
	});

	it("fails after the initial malformed completion and two local corrections without executing repository tools", async () => {
		const { harness, session, transport } = await createSession("repofix-full");
		const malformedLocalize = fauxAssistantMessage(
			fauxToolCall("stage_complete", {
				stage: "LOCALIZE",
				candidates: ["modify the prop normalization logic"],
				exclusions: ["none"],
			}),
			{ stopReason: "toolUse" },
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" }),
			malformedLocalize,
			malformedLocalize,
			malformedLocalize,
		]);
		await expect(
			runRepoFixWorkflow(session, "Fix the defect.", {
				capturePatch: async () => ({ patch_sha256: "a".repeat(64) }),
				controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
			}),
		).rejects.toThrow("stage_completion_contract_failure: LOCALIZE");
		expect(harness.faux.state.callCount).toBe(4);
		expect(transport.requests).toEqual([]);
	});

	it("blocks repo_exec in the no-verify-feedback refine stage", async () => {
		const { harness, session, transport } = await createSession("repofix-no-verify-feedback");
		for (const stage of ["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT"] as const) {
			session.stageMachine.start(stage);
			session.stageMachine.complete(completion(stage));
		}
		session.stageMachine.start("REFINE");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("repo_exec", { argv: ["npm", "test"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("REFINE")), { stopReason: "toolUse" }),
		]);
		await session.session.prompt("Refine the patch.");
		expect(session.stageMachine.assertComplete("REFINE").stage).toBe("REFINE");
		expect(transport.requests).toEqual([]);
	});

	it("fails closed when a provider turn ends before the active stage is structurally completed", async () => {
		const { harness, session } = await createSession("repofix-full");
		harness.setResponses([fauxAssistantMessage("I am done", { stopReason: "stop" })]);
		await expect(
			runRepoFixWorkflow(session, "Fix the defect.", {
				capturePatch: async () => ({ patch_sha256: "a".repeat(64) }),
				controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
			}),
		).rejects.toThrow(/did not complete/);
	});

	it("permits one completion-only recovery after a provider output-length stop", async () => {
		const { harness, session, transport } = await createSession("repofix-full");
		const recoveries: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("Partial investigation", { stopReason: "length" }),
			fauxAssistantMessage(fauxToolCall("repo_read", { path: "src/a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" }),
			...stageResponses(["LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]),
		]);
		const result = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
			onStageRecovery: async (recovery) => {
				recoveries.push(`${recovery.stage}:${recovery.trigger}:${String(recovery.maximum_attempts)}`);
			},
		});
		expect(result.completions.map((value) => value.stage)).toHaveLength(6);
		expect(recoveries).toEqual(["UNDERSTAND:provider_output_length:2"]);
		expect(transport.requests).toEqual([]);
		expect(harness.faux.state.callCount).toBe(8);
	});

	it("retries a completion-only response once after a second provider output-length stop", async () => {
		const { harness, session } = await createSession("repofix-full");
		harness.setResponses([
			fauxAssistantMessage("Partial investigation", { stopReason: "length" }),
			fauxAssistantMessage("Still incomplete", { stopReason: "length" }),
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" }),
			...stageResponses(["LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]),
		]);
		const result = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
		});
		expect(result.completions.map((value) => value.stage)).toHaveLength(6);
		expect(harness.faux.state.callCount).toBe(8);
	});

	it("forces stage completion after the bounded stage exploration budget", async () => {
		const { harness, session } = await createSession("repofix-full");
		const recoveries: string[] = [];
		harness.setResponses([
			...Array.from({ length: 8 }, () => fauxAssistantMessage(fauxToolCall("repo_read", { path: "src/a.ts" }), { stopReason: "toolUse" })),
			fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" }),
			...stageResponses(["LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]),
		]);
		const result = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
			onStageRecovery: async (recovery) => {
				recoveries.push(`${recovery.stage}:${recovery.trigger}`);
			},
		});
		expect(result.completions.map((value) => value.stage)).toHaveLength(6);
		expect(recoveries).toEqual(["UNDERSTAND:stage_model_turn_limit"]);
		expect(harness.faux.state.callCount).toBe(14);
	});

	it("uses the completion-only tool set without tool_choice for thinking providers that reject it", async () => {
		const { harness, session } = await createSession("repofix-full", { forceStageCompletionToolChoice: false });
		const forcedTools: string[][] = [];
		const forcedToolChoices: unknown[] = [];
		harness.setResponses([
			...Array.from({ length: 8 }, () => fauxAssistantMessage(fauxToolCall("repo_read", { path: "src/a.ts" }), { stopReason: "toolUse" })),
			(context, streamOptions) => {
				forcedTools.push(context.tools?.map((tool) => tool.name) ?? []);
				forcedToolChoices.push((streamOptions as { readonly toolChoice?: unknown } | undefined)?.toolChoice);
				return fauxAssistantMessage(fauxToolCall("stage_complete", completion("UNDERSTAND")), { stopReason: "toolUse" });
			},
			...stageResponses(["LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]),
		]);
		const result = await runRepoFixWorkflow(session, "Fix the defect.", {
			capturePatch: async (checkpoint) => ({ patch_sha256: checkpoint === "P0" ? "a".repeat(64) : "b".repeat(64) }),
			controlledVerify: async () => ({ command_argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "pass" }),
		});
		expect(result.completions.map((value) => value.stage)).toHaveLength(6);
		expect(forcedTools).toEqual([["stage_complete"]]);
		expect(forcedToolChoices).toEqual([undefined]);
	});

	it("emits a deterministic configuration-difference report", () => {
		const report = createRepoFixConfigurationDiffReport({
			model_spec_sha256: "a".repeat(64),
			tool_schema_sha256: "b".repeat(64),
		});
		expect(report.configurations.map((value) => value.config_id)).toEqual(REPOFIX_CONFIG_IDS);
		expect(report.configurations.find((value) => value.config_id === "repofix-no-localize")?.variable_values.include_localize_stage).toBe(false);
		expect(report.configurations.find((value) => value.config_id === "repofix-no-verify-feedback")?.variable_values.allow_refine_repo_exec).toBe(false);
		expect(report.report_sha256).toMatch(/^[a-f0-9]{64}$/);
	});
});
