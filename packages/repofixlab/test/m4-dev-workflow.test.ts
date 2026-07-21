import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createPiGeneralSession, type PiGeneralSessionResult } from "../src/agent/pi-general.ts";
import { createRepoFixSession, type RepoFixSessionResult } from "../src/agent/repofix.ts";
import { getRepoFixWorkflowConfig, type RepoFixConfigId } from "../src/agent/repofix-config.ts";
import type { RepoToolTransport } from "../src/controller/client.ts";
import type {
	RuntimeController,
	RuntimePatchSnapshot,
} from "../src/runner/controller-runtime.ts";
import { runM4DevWorkflow } from "../src/runner/m4-dev-workflow.ts";
import { FileTaskEnvironmentLockSource, type PublicTaskSource, type TaskEnvironmentBinding } from "../src/runner/task-source.ts";
import type { RepoToolRequest, RepoToolResponse } from "../src/sandbox/protocol.ts";

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
			result: {
				tool: request.tool,
				exit_code: request.tool === "repo_exec" ? 1 : 0,
				stdout: request.tool === "repo_exec" ? "targeted test failed" : "ok",
				stderr: "",
				truncated: false,
				timed_out: false,
				duration_ms: 12,
			},
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
		const patch = new TextEncoder().encode(`diff --git a/src/a.js b/src/a.js\n# ${this.patchNumber++}\n`);
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

	async startEvaluation() {
		throw new Error("M4 Dev workflow must not start official evaluation before M5");
	}

	async getJob() {
		throw new Error("not used");
	}

	async getArtifacts() {
		throw new Error("not used");
	}

	async acknowledge() {
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
			return { stage, problem_summary: "summary", expected_behavior: ["behavior"], constraints: ["constraint"], acceptance_evidence: ["evidence"] };
		case "LOCALIZE":
			return { stage, candidates: [{ path: "src/a.js", symbol: "target", evidence: "evidence" }], exclusions: ["none"] };
		case "PLAN":
			return { stage, minimal_change_steps: ["change"], risks: ["risk"], targeted_test_argv: ["npm", "test"] };
		case "IMPLEMENT":
			return { stage, change_summary: ["changed source"] };
		case "REFINE":
			return { stage, feedback_assessment: "reviewed", revision_summary: ["refined"] };
		case "SELF_REVIEW":
			return { stage, diff_checklist: ["inspected"], remaining_risks: ["none"] };
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

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("M4 Dev workflow runner", () => {
	it.each([
		["pi-general", ["done"]],
		["repofix-full", ["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]],
		["repofix-no-localize", ["UNDERSTAND", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]],
		["repofix-no-verify-feedback", ["UNDERSTAND", "LOCALIZE", "PLAN", "IMPLEMENT", "REFINE", "SELF_REVIEW"]],
	] as const)("executes %s through the prepared Dev worker and preserves its workflow evidence", async (configId, stages) => {
		const harness = await createHarness();
		harnesses.push(harness);
		if (configId === "pi-general") {
			harness.setResponses([withVerifiedUsage(fauxAssistantMessage(stages[0]!))]);
		} else {
			harness.setResponses(
				stages.map((stage) =>
					withVerifiedUsage(fauxAssistantMessage(fauxToolCall("stage_complete", completion(stage)), { stopReason: "toolUse" })),
				),
			);
		}
		const environment = await new FileTaskEnvironmentLockSource().load("axios__axios-5892");
		const controller = new FakeController(environment);
		let id = 0;
		const result = await runM4DevWorkflow(
			{
				artifactsRoot: join(harness.tempDir, "artifacts"),
				instanceId: "axios__axios-5892",
				configId: configId as RepoFixConfigId,
			},
			{
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
			},
		);
		expect(result.terminal_status).toBe("completed");
		expect(controller.calls).toEqual(configId === "pi-general" ? ["preflight", "prepare", "abort"] : ["preflight", "prepare", "snapshot", "snapshot", "abort"]);
		const trajectory = JSON.parse(await readFile(join(result.run_directory, "trajectory.json"), "utf8"));
		expect(trajectory.length).toBeGreaterThan(0);
		expect(await readFile(join(result.run_directory, "token-ledger.jsonl"), "utf8")).toContain("reservation_settled");
		if (configId === "pi-general") {
			expect(result.p0_patch_sha256).toBeNull();
			expect(result.p1_patch_sha256).toBeNull();
		} else {
			expect(result.p0_patch_sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(result.p1_patch_sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(result.controlled_verification_sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(controller.transport.requests.filter((request) => request.tool === "repo_exec")).toHaveLength(1);
			expect(await readFile(join(result.run_directory, "controlled-verify.json"), "utf8")).toContain("targeted test failed");
		}
	});
});
