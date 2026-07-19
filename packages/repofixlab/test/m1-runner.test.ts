import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createPiGeneralSession, type PiGeneralSessionResult } from "../src/agent/pi-general.ts";
import { stableStringify } from "../src/contracts/canonical-json.ts";
import { parseExperimentPlan } from "../src/contracts/experiment-plan.ts";
import {
	canonicalContractSha256,
	createEvaluationResult,
	verifyArtifactIndex,
	verifyRunEventChain,
	verifyRunManifest,
	verifyRunResult,
} from "../src/contracts/run-contracts.ts";
import type { RepoToolTransport } from "../src/controller/client.ts";
import type {
	RuntimeArtifact,
	RuntimeArtifactSet,
	RuntimeController,
	RuntimePatchSnapshot,
} from "../src/runner/controller-runtime.ts";
import { FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256 } from "../src/runner/pricing.ts";
import { assertM1Plan, runM1Experiment } from "../src/runner/run-m1.ts";
import type { PublicTaskBinding, PublicTaskSource, TaskEnvironmentBinding } from "../src/runner/task-source.ts";
import { FileTaskEnvironmentLockSource } from "../src/runner/task-source.ts";
import type { RepoToolRequest, RepoToolResponse } from "../src/sandbox/protocol.ts";

const BASE_COMMIT = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b";
const PLAN = parseExperimentPlan(`schema_version: v1
plan_type: experiment_capacity
experiment_id: m1-axios
task_selection:
  status: frozen
  declared_task_count: 1
  instance_ids: [axios__axios-5892]
matrix:
  - group_id: m1-smoke
    task_count: 1
    config_ids: [pi-general]
    replicates: 1
budget:
  per_run_accounted_admission_cap_tokens: null
  total_accounted_admission_cap_tokens: null
runtime_status: m1_single_run_available
`);

class FakePublicTaskSource implements PublicTaskSource {
	async load(instanceId: string, environment: TaskEnvironmentBinding): Promise<PublicTaskBinding> {
		const task = {
			schema_version: "v1" as const,
			record_type: "dataset_task" as const,
			dataset_revision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
			instance_id: instanceId,
			repo: "axios/axios",
			problem_statement: "Fix the Axios decompression regression.",
			base_commit: BASE_COMMIT,
			language: "JavaScript/TypeScript" as const,
		};
		const unsigned = {
			schema_version: "v1" as const,
			manifest_id: "public-task-v1-axios-5892-test",
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
			created_at: environment.lock.created_at,
		};
		const recordBytes = new TextEncoder().encode(stableStringify(task));
		return {
			task,
			manifest: { ...unsigned, manifest_sha256: canonicalContractSha256(unsigned) },
			recordBytes,
			recordSha256: createHash("sha256").update(recordBytes).digest("hex"),
		};
	}
}

class FakeToolTransport implements RepoToolTransport {
	fail = false;

	async execute(request: RepoToolRequest): Promise<RepoToolResponse> {
		if (this.fail) throw new Error("sandbox exploded");
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

interface FakeControllerOptions {
	readonly patch: string;
	readonly artifactsRoot: string;
	readonly ackFails?: boolean;
	readonly preflightFails?: boolean;
	readonly missingEvaluation?: boolean;
	readonly evaluationFails?: boolean;
	readonly evaluationResultFailsButJobCompletes?: boolean;
	readonly toolFails?: boolean;
	readonly postAdmissionArtifactFails?: boolean;
}

class FakeController implements RuntimeController {
	readonly calls: string[] = [];
	readonly transport = new FakeToolTransport();
	private readonly options: FakeControllerOptions;
	private attemptId = "";
	private runId = "";
	private jobId = "job-test";
	private patchSha256 = "";

	constructor(options: FakeControllerOptions) {
		this.options = options;
		this.transport.fail = options.toolFails === true;
	}

	async preflight(attemptId: string): Promise<{
		task_environment_lock_id: string;
		task_environment_lock_sha256: string;
		candidate_sha256: string;
		base_commit: string;
	}> {
		this.calls.push("preflight");
		this.attemptId = attemptId;
		if (this.options.preflightFails) throw new Error("Controller unavailable");
		if (this.options.postAdmissionArtifactFails) {
			const runsRoot = join(this.options.artifactsRoot, "m1-axios", "runs");
			const runDirectory = (await readdir(runsRoot)).find((name) => name.startsWith("run-"));
			if (runDirectory === undefined) throw new Error("Admitted run directory was not published");
			await mkdir(join(runsRoot, runDirectory, "controller-preflight.json"));
		}
		return {
			task_environment_lock_id: "task-environment-v1-axios-5892-e412c03204cb3ae4",
			task_environment_lock_sha256: "e412c03204cb3ae4dfed277216bde5ebe182f5c0179e02e549835c1b6639bc1f",
			candidate_sha256: "4d9ca4a09de47020fedebfb9c6bf97396d52437670edfd68fd49ea126c6ec105",
			base_commit: BASE_COMMIT,
		};
	}

	async prepare(): Promise<{ leaseId: string }> {
		this.calls.push("prepare");
		return { leaseId: "lease-test" };
	}

	toolTransport(): RepoToolTransport {
		return this.transport;
	}

	async snapshot(): Promise<RuntimePatchSnapshot> {
		this.calls.push("snapshot");
		const patch = new TextEncoder().encode(this.options.patch);
		this.patchSha256 = createHash("sha256").update(patch).digest("hex");
		return {
			snapshotId: `snapshot-${this.patchSha256}`,
			patch,
			patchSha256: this.patchSha256,
			baseCommit: BASE_COMMIT,
			baseTree: { algorithm: "git-sha1", value: "b".repeat(40) },
			candidateTree: { algorithm: "git-sha1", value: "c".repeat(40) },
			files: patch.byteLength === 0 ? [] : [{ path: "lib/adapters/http.js", status: "modified" }],
			policy: { status: "pass", violations: [] },
			createdAt: "2026-07-19T00:00:02.000Z",
		};
	}

	async destroy(): Promise<{ clean: boolean }> {
		this.calls.push("destroy");
		return { clean: true };
	}

	async startEvaluation(attemptId: string, _operationId: string, runId: string): Promise<{ jobId: string }> {
		this.calls.push("evaluate");
		this.attemptId = attemptId;
		this.runId = runId;
		return { jobId: this.jobId };
	}

	async getJob(): Promise<{ status: "completed" | "failed"; resolved: boolean; errorClass: string | null }> {
		return this.options.evaluationFails && !this.options.evaluationResultFailsButJobCompletes
			? { status: "failed", resolved: false, errorClass: "harness_failed" }
			: { status: "completed", resolved: false, errorClass: null };
	}

	async getArtifacts(): Promise<RuntimeArtifactSet> {
		this.calls.push("artifacts");
		const log = new TextEncoder().encode("evaluator log\n");
		const report = new TextEncoder().encode("{}\n");
		const logSha256 = createHash("sha256").update(log).digest("hex");
		const evaluation = createEvaluationResult({
			schema_version: "v1",
			result_type: "evaluation",
			evaluation_id: "evaluation-test",
			job_id: this.jobId,
			run_id: this.runId,
			attempt_id: this.attemptId,
			instance_id: "axios__axios-5892",
			harness_mode: "adapted",
			harness_revision: "d".repeat(40),
			status: this.options.evaluationFails ? "failed" : "completed",
			resolved: false,
			candidate_patch_sha256: this.patchSha256,
			candidate_patch_apply_status: "applied",
			test_patch_apply_status: this.options.evaluationFails ? "error" : "applied",
			test_executed: !this.options.evaluationFails,
			test_collected: !this.options.evaluationFails,
			fail_to_pass: { success: [], failure: ["regression"] },
			pass_to_pass: { success: [], failure: [] },
			exit_code: this.options.evaluationFails ? 1 : 0,
			timed_out: false,
			duration_ms: 10,
			test_log: { path: "evaluator/evaluator.log", bytes: log.byteLength, sha256: logSha256 },
			official_report_sha256: null,
			error_class: this.options.evaluationFails ? "harness_failed" : null,
			finished_at: "2026-07-19T00:00:03.000Z",
		});
		const evaluationBytes = new TextEncoder().encode(stableStringify(evaluation));
		const values: RuntimeArtifact[] = [
			{ name: "evaluator.log", content: log, sha256: logSha256 },
			{
				name: "official-report.json",
				content: report,
				sha256: createHash("sha256").update(report).digest("hex"),
			},
		];
		if (!this.options.missingEvaluation) {
			values.push({
				name: "evaluation.json",
				content: evaluationBytes,
				sha256: createHash("sha256").update(evaluationBytes).digest("hex"),
			});
		}
		values.sort((left, right) => left.name.localeCompare(right.name));
		const descriptors = values.map((artifact) => ({
			name: artifact.name,
			sha256: artifact.sha256,
			size_bytes: artifact.content.byteLength,
		}));
		return { artifactSetSha256: canonicalContractSha256(descriptors), artifacts: values };
	}

	async acknowledge(): Promise<{ clean: boolean }> {
		this.calls.push("ack");
		const runDirectory = join(this.options.artifactsRoot, "m1-axios", "runs", this.runId);
		if (!existsSync(join(runDirectory, "controller-artifact-receipt.json"))) {
			throw new Error("ACK happened before the Controller receipt was durable");
		}
		if (existsSync(join(runDirectory, "artifact-index.json"))) {
			throw new Error("ACK happened after the terminal seal");
		}
		if (this.options.ackFails) throw new Error("ACK transport failed");
		return { clean: true };
	}

	async abort(): Promise<{ clean: boolean }> {
		this.calls.push("abort");
		return { clean: true };
	}
}

function fauxRegistry(harness: Harness): ModelRegistry {
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

interface RunCaseOptions extends Omit<FakeControllerOptions, "artifactsRoot"> {
	readonly responses: ReturnType<typeof fauxAssistantMessage>[];
}

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runCase(options: RunCaseOptions) {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses(options.responses);
	const artifactsRoot = join(harness.tempDir, "artifacts");
	const controller = new FakeController({ ...options, artifactsRoot });
	const registry = fauxRegistry(harness);
	let id = 0;
	const summary = await runM1Experiment(
		PLAN,
		{ artifactsRoot },
		{
			controller,
			publicTaskSource: new FakePublicTaskSource(),
			environmentLockSource: new FileTaskEnvironmentLockSource(),
			createSession: (sessionOptions): Promise<PiGeneralSessionResult> =>
				createPiGeneralSession({
					...sessionOptions,
					model: harness.getModel(),
					authStorage: harness.authStorage,
					modelRegistry: registry,
					thinkingLevel: "off",
				}),
			modelSpecSha256: "a".repeat(64),
			pricingSpecSha256: FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256,
			now: () => new Date(`2026-07-19T00:00:${String(id++).padStart(2, "0")}.000Z`),
			randomId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
			sleep: async () => {},
			pollIntervalMs: 1,
			maxPolls: 3,
		},
	);
	const runDirectory = summary.run_directory;
	const manifest = verifyRunManifest(JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")));
	const result = verifyRunResult(JSON.parse(await readFile(join(runDirectory, "result.json"), "utf8")));
	const index = verifyArtifactIndex(JSON.parse(await readFile(join(runDirectory, "artifact-index.json"), "utf8")));
	const events = (await readFile(join(runDirectory, "events.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	verifyRunEventChain(events);
	for (const artifact of index.artifacts) {
		const bytes = await readFile(join(runDirectory, artifact.path));
		expect(bytes.byteLength).toBe(artifact.bytes);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
	}
	expect(index.artifacts.some((artifact) => artifact.path === "report.html")).toBe(true);
	for (const inputPath of [
		"experiment-plan.json",
		"public-task.json",
		"public-task-record.json",
		"dataset-lock.json",
		"pricing-spec.json",
		"task-environment-lock.json",
		...(controller.calls.includes("prepare") ? ["controller-preflight.json"] : []),
	]) {
		expect(index.artifacts.some((artifact) => artifact.path === inputPath)).toBe(true);
	}
	expect(index.artifacts.some((artifact) => artifact.path === "result.json")).toBe(false);
	expect(index.artifacts.some((artifact) => artifact.path === "artifact-index.json")).toBe(false);
	const resultStats = await stat(join(runDirectory, "result.json"), { bigint: true });
	const indexStats = await stat(join(runDirectory, "artifact-index.json"), { bigint: true });
	expect(indexStats.mtimeNs >= resultStats.mtimeNs).toBe(true);
	return { summary, manifest, result, index, controller, providerCalls: harness.faux.state.callCount };
}

describe("M1 Runner terminal lifecycle", () => {
	it("rejects frozen-plan runtime, group, and budget drift", () => {
		expect(() => assertM1Plan({ ...PLAN, runtime_status: "lifecycle_unavailable" })).toThrow(/only admits/);
		expect(() => assertM1Plan({ ...PLAN, matrix: [{ ...PLAN.matrix[0], group_id: "lookalike" }] })).toThrow(
			/only admits/,
		);
		expect(() =>
			assertM1Plan({
				...PLAN,
				budget: { ...PLAN.budget, per_run_accounted_admission_cap_tokens: 1 },
			}),
		).toThrow(/only admits/);
	});

	it("officially evaluates an empty patch as unresolved instead of treating it as no_patch", async () => {
		const value = await runCase({ patch: "", responses: [fauxAssistantMessage("done")] });
		expect(value.summary.termination_reason).toBe("official_unresolved");
		expect(value.result.evaluation_result_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(value.controller.calls).toContain("ack");
		expect(value.controller.calls).not.toContain("abort");
	});

	it("retains evaluation evidence and abort-cleans when ACK fails", async () => {
		const value = await runCase({
			patch: "diff --git a/a b/a\n",
			ackFails: true,
			responses: [fauxAssistantMessage("done")],
		});
		expect(value.result.termination_reason).toBe("infrastructure_error");
		expect(value.result.evaluation_result_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(value.controller.calls.slice(-2)).toEqual(["ack", "abort"]);
	});

	it.each([
		{
			name: "provider error",
			responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })],
			reason: "model_error",
		},
		{
			name: "user abort",
			responses: [fauxAssistantMessage("", { stopReason: "aborted" })],
			reason: "user_abort",
		},
	] as const)("preserves $name while abort-cleaning the admitted attempt", async ({ responses, reason }) => {
		const value = await runCase({ patch: "diff --git a/a b/a\n", responses: [...responses] });
		expect(value.result.termination_reason).toBe(reason);
		expect(value.controller.calls).toContain("abort");
		expect(value.controller.calls).not.toContain("evaluate");
	});

	it("allows a recovered sandbox tool failure to reach official evaluation", async () => {
		const value = await runCase({
			patch: "diff --git a/a b/a\n",
			toolFails: true,
			responses: [
				fauxAssistantMessage(fauxToolCall("repo_read", { path: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("handled"),
			],
		});
		expect(value.result.termination_reason).toBe("official_unresolved");
		expect(value.controller.calls).toContain("snapshot");
		expect(value.controller.calls).toContain("ack");
		expect(value.controller.calls).not.toContain("abort");
	});

	it("uses evaluation_error only for a strict evaluator failed result", async () => {
		const value = await runCase({
			patch: "diff --git a/a b/a\n",
			evaluationFails: true,
			responses: [fauxAssistantMessage("done")],
		});
		expect(value.result.termination_reason).toBe("evaluation_error");
		expect(value.result.evaluation_result_sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("accepts a completed evaluator job with a failed evaluation result", async () => {
		const value = await runCase({
			patch: "diff --git a/a b/a\n",
			evaluationFails: true,
			evaluationResultFailsButJobCompletes: true,
			responses: [fauxAssistantMessage("done")],
		});
		expect(value.result.termination_reason).toBe("evaluation_error");
		expect(value.result.evaluation_result_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(value.controller.calls).toContain("ack");
	});

	it("classifies missing evaluator evidence as infrastructure failure and abort-cleans", async () => {
		const value = await runCase({
			patch: "diff --git a/a b/a\n",
			missingEvaluation: true,
			responses: [fauxAssistantMessage("done")],
		});
		expect(value.result.termination_reason).toBe("infrastructure_error");
		expect(value.result.evaluation_result_sha256).toBeNull();
		expect(value.controller.calls).toContain("abort");
	});

	it("seals a preflight infrastructure failure without claiming cleanup", async () => {
		const value = await runCase({
			patch: "",
			preflightFails: true,
			responses: [fauxAssistantMessage("unused")],
		});
		expect(value.result.termination_reason).toBe("infrastructure_error");
		expect(value.controller.calls).toEqual(["preflight"]);
	});

	it("seals a terminal result when the first post-admission artifact publication fails", async () => {
		const value = await runCase({
			patch: "",
			postAdmissionArtifactFails: true,
			responses: [fauxAssistantMessage("unused")],
		});
		expect(value.result.termination_reason).toBe("infrastructure_error");
		expect(value.controller.calls).toEqual(["preflight", "abort"]);
		expect(value.index.artifacts.some((artifact) => artifact.path === "result.json")).toBe(false);
	});
});
