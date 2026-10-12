import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createPiGeneralSession, type PiGeneralSessionResult } from "../src/agent/pi-general.ts";
import { createRepoFixSession, type RepoFixSessionResult } from "../src/agent/repofix.ts";
import { getRepoFixWorkflowConfig, type RepoFixConfigId } from "../src/agent/repofix-config.ts";
import type { RepoToolTransport } from "../src/controller/client.ts";
import { runM7FormalRun } from "../src/m7/formal-runner.ts";
import type { RuntimeController, RuntimePatchSnapshot } from "../src/runner/controller-runtime.ts";
import { type M4DevWorkflowDependencies, runM4DevWorkflow } from "../src/runner/m4-dev-workflow.ts";
import { KnownProviderUsageBatchFailure } from "../src/runner/pre-provider-failure.ts";
import {
	FileTaskEnvironmentLockSource,
	type PublicTaskSource,
	type TaskEnvironmentBinding,
} from "../src/runner/task-source.ts";
import type { RepoToolRequest, RepoToolResponse } from "../src/sandbox/protocol.ts";
import { successfulToolResult } from "./runtime-tool-fixture.ts";

const BASE_COMMIT = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b";

class FakePublicTaskSource implements PublicTaskSource {
	async load(instanceId: string, environment: TaskEnvironmentBinding) {
		const task = {
			schema_version: "v1" as const,
			record_type: "dataset_task" as const,
			dataset_revision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
			instance_id: instanceId,
			repo: "axios/axios",
			problem_statement: "Repair the controlled Axios defect.",
			base_commit: BASE_COMMIT,
			language: "JavaScript/TypeScript" as const,
		};
		const recordBytes = new TextEncoder().encode(JSON.stringify(task));
		return {
			task,
			recordBytes,
			recordSha256: createHash("sha256").update(recordBytes).digest("hex"),
			manifest: {
				schema_version: "v1" as const,
				manifest_id: "public-task-v1-m4-dev-test",
				dataset_lock_id: environment.lock.dataset_lock_id,
				task_environment_lock_id: environment.lockId,
				task: {
					instance_id: task.instance_id,
					repo: task.repo,
					problem_statement: task.problem_statement,
					base_commit: task.base_commit,
					language: task.language,
				},
				worker_image_id: environment.lock.worker_image.local_image_id,
				resource_profile: { ...environment.lock.resource_profile },
				split: "dev" as const,
				created_at: "2026-07-20T00:00:00.000Z",
				manifest_sha256: "a".repeat(64),
			},
		};
	}
}

class RecordingTransport implements RepoToolTransport {
	readonly requests: RepoToolRequest[] = [];

	async execute(request: RepoToolRequest): Promise<RepoToolResponse> {
		this.requests.push(request);
		return {
			tool: request.tool,
			result: successfulToolResult(
				request,
				request.tool === "repo_exec" ? "targeted test failed" : "ok",
				request.tool === "repo_exec" ? 1 : 0,
				12,
			),
		};
	}
}

class FakeController implements RuntimeController {
	readonly transport = new RecordingTransport();
	readonly calls: string[] = [];
	private patchNumber = 0;
	private readonly environment: TaskEnvironmentBinding;

	constructor(environment: TaskEnvironmentBinding) {
		this.environment = environment;
	}

	async preflight() {
		this.calls.push("preflight");
		return {
			task_environment_lock_id: this.environment.lockId,
			task_environment_lock_sha256: this.environment.lockSha256,
			candidate_sha256: this.environment.candidateSha256,
			base_commit: BASE_COMMIT,
		};
	}

	async prepare() {
		this.calls.push("prepare");
		return { leaseId: "lease-m4-dev" };
	}

	toolTransport(): RepoToolTransport {
		return this.transport;
	}

	async snapshot(): Promise<RuntimePatchSnapshot> {
		this.calls.push("snapshot");
		// SELF_REVIEW must preserve the already verified V2 tree.
		const patch = new TextEncoder().encode(
			`diff --git a/src/a.js b/src/a.js\n# ${Math.min(this.patchNumber++, 2)}\n`,
		);
		return {
			snapshotId: `snapshot-${this.patchNumber}`,
			patch,
			patchSha256: createHash("sha256").update(patch).digest("hex"),
			baseCommit: BASE_COMMIT,
			baseTree: { algorithm: "git-sha1", value: "b".repeat(40) },
			candidateTree: { algorithm: "git-sha1", value: "c".repeat(40) },
			files: [{ path: "src/a.js", status: "modified" }],
			policy: { status: "pass", violations: [] },
			createdAt: "2026-07-20T00:00:01.000Z",
		};
	}

	async destroy() {
		this.calls.push("destroy");
		return { clean: true };
	}

	async verificationCatalog() {
		this.calls.push("catalog");
		return {
			catalogId: "catalog-test",
			sourceSha256: "a".repeat(64),
			entries: [{ candidateId: "verify-test", description: "fixture test" }],
		};
	}

	async verifyCatalogEntry() {
		this.calls.push("verify");
		const observation = {
			status: "test_failed" as const,
			reasonCode: null,
			safeHint: null,
			exitCode: 1,
			stdout: "targeted test failed",
			stderr: "",
			truncated: false,
			timedOut: false,
			durationMs: 12,
		};
		return { catalogId: "catalog-test", candidateId: "verify-test", ...observation, baseline: observation };
	}

	async startEvaluation(): Promise<never> {
		throw new Error("M4 Dev workflow must not start official evaluation before M5");
	}

	async getJob(): Promise<never> {
		throw new Error("not used");
	}

	async getArtifacts(): Promise<never> {
		throw new Error("not used");
	}

	async acknowledge(): Promise<never> {
		throw new Error("not used");
	}

	async abort() {
		this.calls.push("abort");
		return { clean: true };
	}
}

function completion(stage: string) {
	switch (stage) {
		case "UNDERSTAND":
			return {
				stage,
				problem_summary: "summary",
				expected_behavior: ["behavior"],
				constraints: ["constraint"],
				acceptance_evidence: ["evidence"],
			};
		case "LOCALIZE":
			return {
				stage,
				candidates: [{ path: "src/a.js", symbol: "target", evidence: "evidence" }],
				exclusions: ["none"],
			};
		case "PLAN":
			return {
				stage,
				minimal_change_steps: ["change"],
				risks: ["risk"],
				obligations: [{ id: "fix", code_scope: "src/a.ts", required_change: "repair", evidence: "source" }],
				preservation_invariants: [
					{
						id: "preserve",
						scope: "src/a.ts",
						preserved_behavior: "existing callers",
						counterexample: "regression",
						evidence: "source",
					},
				],
				state_transition_checks: ["inspect transition"],
				verification_candidate_id: "verify-test",
			};
		case "IMPLEMENT":
			return {
				stage,
				change_summary: ["changed source"],
				obligation_dispositions: [{ id: "fix", status: "implemented", evidence: "diff" }],
			};
		case "REFINE_1":
		case "REFINE_2":
			return { stage, feedback_assessment: "reviewed", revision_summary: ["refined"] };
		case "SELF_REVIEW":
			return {
				stage,
				diff_checklist: ["inspected"],
				remaining_risks: ["none"],
				risk_disposition: ["reviewed"],
				obligation_dispositions: [{ id: "fix", status: "implemented", evidence: "diff" }],
				preservation_dispositions: [{ id: "preserve", status: "verified", evidence: "diff" }],
			};
		default:
			throw new Error(`Unexpected stage ${stage}`);
	}
}

function withVerifiedUsage(message: ReturnType<typeof fauxAssistantMessage>) {
	return {
		...message,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function registry(harness: Harness): ModelRegistry {
	const model = harness.getModel();
	const value = ModelRegistry.inMemory(harness.authStorage);
	value.registerProvider(model.provider, {
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
	return value;
}

const harnesses: Harness[] = [];

/** Create isolated faux sessions while sharing only the supplied Controller. */
function dependencies(
	harness: Harness,
	environment: TaskEnvironmentBinding,
	controller: RuntimeController,
): M4DevWorkflowDependencies {
	let id = 0;
	return {
		controller,
		publicTaskSource: new FakePublicTaskSource(),
		environmentLockSource: { load: async () => environment },
		createPiGeneralSession: (options): Promise<PiGeneralSessionResult> =>
			createPiGeneralSession({
				...options,
				model: harness.getModel(),
				authStorage: harness.authStorage,
				modelRegistry: registry(harness),
				thinkingLevel: "off",
			}),
		createRepoFixSession: (options): Promise<RepoFixSessionResult> =>
			createRepoFixSession({
				...options,
				config: getRepoFixWorkflowConfig(options.configId),
				model: harness.getModel(),
				authStorage: harness.authStorage,
				modelRegistry: registry(harness),
				thinkingLevel: "off",
			}),
		modelSpecSha256: "b".repeat(64),
		now: () => new Date(`2026-07-20T00:00:${String(id++).padStart(2, "0")}.000Z`),
		randomId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("M4 Dev workflow runner", () => {
	it.each(["runtime_queue_timeout", "runtime_backend_error"])(
		"cleans preparation failure %s before a lease is returned",
		async (failure) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const environment = await new FileTaskEnvironmentLockSource().load("axios__axios-5892");
			const controller = new FakeController(environment);
			controller.prepare = async () => {
				controller.calls.push("prepare");
				throw new Error(failure);
			};
			const summary = await runM4DevWorkflow(
				{
					artifactsRoot: join(harness.tempDir, "artifacts"),
					instanceId: "axios__axios-5892",
					configId: "pi-general",
				},
				dependencies(harness, environment, controller),
			);
			expect(summary.terminal_status).toBe("failed");
			expect(summary.worker_lease_id).toBeNull();
			expect(controller.calls).toEqual(["preflight", "prepare", "abort"]);
			expect(await readFile(join(summary.run_directory, "error.json"), "utf8")).toContain(failure);
		},
	);

	it.each([false, true])(
		"cleans failed evaluation admission and preserves known usage when cleanup fails=%s",
		async (cleanupFails) => {
			vi.stubEnv("DEEPSEEK_API_KEY", "faux-key");
			vi.stubEnv("DEEPSEEK_API_KEY_FILE", undefined);
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([withVerifiedUsage(fauxAssistantMessage("done"))]);
			const environment = await new FileTaskEnvironmentLockSource().load("axios__axios-5892");
			const controller = new FakeController(environment);
			controller.startEvaluation = async () => {
				controller.calls.push("evaluate");
				throw new Error("runtime_queue_timeout");
			};
			controller.abort = async () => {
				controller.calls.push("abort");
				if (cleanupFails) throw new Error("cleanup_failed");
				return { clean: true };
			};
			const error = await runM7FormalRun(
				{
					artifactsRoot: join(harness.tempDir, "artifacts"),
					formalRunsRoot: join(harness.tempDir, "formal"),
					experimentId: "experiment-test",
					runId: "run-test",
					attemptId: "attempt-test",
					instanceId: "axios__axios-5892",
					configId: "pi-general",
					replicate: 1,
					maxModelTurns: 2,
				},
				{ ...dependencies(harness, environment, controller), sleep: async () => undefined },
			).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(KnownProviderUsageBatchFailure);
			if (!(error instanceof KnownProviderUsageBatchFailure)) throw error;
			expect(error.message).toBe("runtime_queue_timeout");
			const events = (
				await readFile(join(harness.tempDir, "artifacts/m4-dev/runs/run-test/token-ledger.jsonl"), "utf8")
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event_type: string; accounted_tokens: number | null });
			const settled = events.filter((event) => event.event_type === "reservation_settled");
			expect(settled).toHaveLength(1);
			expect(error.accountedTokens).toBe(settled.reduce((total, event) => total + (event.accounted_tokens ?? 0), 0));
			expect(error.accountedTokens).toBeGreaterThan(0);
			expect(controller.calls).toEqual(["preflight", "prepare", "snapshot", "destroy", "evaluate", "abort"]);
		},
	);

	it.each([
		["pi-general", ["done"]],
		["repofix-full", ["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT", "REFINE_1", "REFINE_2", "SELF_REVIEW"]],
		["repofix-no-localize", ["UNDERSTAND", "PLAN", "IMPLEMENT", "REFINE_1", "REFINE_2", "SELF_REVIEW"]],
		[
			"repofix-no-verify-feedback",
			["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT", "REFINE_1", "REFINE_2", "SELF_REVIEW"],
		],
	] as const)(
		"executes %s through the prepared Dev worker and preserves its workflow evidence",
		async (configId, stages) => {
			const harness = await createHarness();
			harnesses.push(harness);
			if (configId === "pi-general") {
				harness.setResponses([withVerifiedUsage(fauxAssistantMessage(stages[0]!))]);
			} else {
				harness.setResponses(
					stages.map((stage) =>
						withVerifiedUsage(
							fauxAssistantMessage(fauxToolCall("stage_complete", completion(stage)), { stopReason: "toolUse" }),
						),
					),
				);
			}
			const environment = await new FileTaskEnvironmentLockSource().load("axios__axios-5892");
			const controller = new FakeController(environment);
			const result = await runM4DevWorkflow(
				{
					artifactsRoot: join(harness.tempDir, "artifacts"),
					instanceId: "axios__axios-5892",
					configId: configId as RepoFixConfigId,
				},
				dependencies(harness, environment, controller),
			);
			expect(result.terminal_status).toBe("completed");
			expect(controller.calls).toEqual(
				configId === "pi-general"
					? ["preflight", "prepare", "abort"]
					: [
							"preflight",
							"prepare",
							"catalog",
							"snapshot",
							"verify",
							"snapshot",
							"verify",
							"snapshot",
							"verify",
							"snapshot",
							"abort",
						],
			);
			const trajectory = JSON.parse(await readFile(join(result.run_directory, "trajectory.json"), "utf8"));
			expect(trajectory.length).toBeGreaterThan(0);
			expect(await readFile(join(result.run_directory, "token-ledger.jsonl"), "utf8")).toContain(
				"reservation_settled",
			);
			if (configId === "pi-general") {
				expect(result.p0_patch_sha256).toBeNull();
				expect(result.p1_patch_sha256).toBeNull();
			} else {
				expect(result.p0_patch_sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(result.p1_patch_sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(result.controlled_verification_sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(result.controlled_verification_sha256s).toHaveLength(3);
				expect(controller.transport.requests.filter((request) => request.tool === "repo_exec")).toHaveLength(0);
				expect(await readFile(join(result.run_directory, "controlled-verify-v0.json"), "utf8")).toContain(
					"targeted test failed",
				);
			}
		},
	);
});
