import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createPiGeneralSession, type PiGeneralSessionResult } from "../src/agent/pi-general.ts";
import { verifyEvaluationResult } from "../src/contracts/run-contracts.ts";
import type { RepoToolTransport } from "../src/controller/client.ts";
import { HttpRuntimeController } from "../src/runner/controller-runtime.ts";
import type { RepoToolRequest, RepoToolResponse } from "../src/sandbox/protocol.ts";

const RUN_DOCKER_E2E = process.env.REPOFIXLAB_RUN_M1_DOCKER_E2E === "1";
const CONTROLLER_URL = process.env.REPOFIX_CONTROLLER_URL ?? "http://controller:8000";
const INSTANCE_ID = "axios__axios-5892";
const TEST_TIMEOUT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 250;

interface TaskEnvironmentBinding {
	readonly candidate_id: string;
	readonly candidate_sha256: string;
	readonly instance_id: string;
	readonly lock_id: string;
	readonly seal_sha256: string;
}

class RecordingTransport implements RepoToolTransport {
	readonly requests: RepoToolRequest[] = [];
	readonly responses: RepoToolResponse[] = [];
	private readonly delegate: RepoToolTransport;

	constructor(delegate: RepoToolTransport) {
		this.delegate = delegate;
	}

	async execute(request: RepoToolRequest, signal?: AbortSignal): Promise<RepoToolResponse> {
		this.requests.push(request);
		const response = await this.delegate.execute(request, signal);
		this.responses.push(response);
		return response;
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

function loadTaskEnvironmentBinding(): TaskEnvironmentBinding {
	const path = fileURLToPath(
		new URL("../configs/runtime/axios-5892/task-environment-lock.json", import.meta.url),
	);
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	assert(value !== null && typeof value === "object" && !Array.isArray(value));
	const record = value as Record<string, unknown>;
	const fields = ["candidate_id", "candidate_sha256", "instance_id", "lock_id", "seal_sha256"] as const;
	for (const field of fields) {
		assert.equal(typeof record[field], "string", `TaskEnvironmentLock ${field} must be a string`);
	}
	return record as unknown as TaskEnvironmentBinding;
}

function artifactContent(
	artifacts: Awaited<ReturnType<HttpRuntimeController["getArtifacts"]>>["artifacts"],
	name: string,
): Uint8Array {
	const artifact = artifacts.find((candidate) => candidate.name === name);
	assert(artifact, `Evaluator artifact set is missing ${name}`);
	return artifact.content;
}

async function waitForTerminalEvaluation(
	controller: HttpRuntimeController,
	attemptId: string,
	jobId: string,
): Promise<Awaited<ReturnType<HttpRuntimeController["getJob"]>>> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (true) {
		const status = await controller.getJob(attemptId, jobId);
		if (status.status === "completed" || status.status === "failed") return status;
		assert(Date.now() < deadline, "Evaluator did not reach a terminal state before the E2E deadline");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
	}
}

describe("M1 faux Pi real Docker lifecycle", () => {
	it.runIf(RUN_DOCKER_E2E)(
		"runs through a fresh strict unresolved Evaluator and verifies zero managed residuals",
		async () => {
			const suffix = crypto.randomUUID().replaceAll("-", "");
			const attemptId = `attempt-faux-e2e-${suffix}`;
			const runId = `run-faux-e2e-${suffix}`;
			const binding = loadTaskEnvironmentBinding();
			assert.equal(binding.instance_id, INSTANCE_ID);
			const controller = new HttpRuntimeController({
				controllerUrl: CONTROLLER_URL,
				timeoutMs: TEST_TIMEOUT_MS,
			});
			let preflightAdmitted = false;
			let acknowledged = false;
			let harness: Harness | undefined;
			let sessionResult: PiGeneralSessionResult | undefined;

			try {
				const preflight = await controller.preflight(
					attemptId,
					`${attemptId}:preflight`,
					binding.candidate_id,
					INSTANCE_ID,
				);
				preflightAdmitted = true;
				assert.deepEqual(
					{
						lockId: preflight.task_environment_lock_id,
						lockSha256: preflight.task_environment_lock_sha256,
						candidateSha256: preflight.candidate_sha256,
					},
					{
						lockId: binding.lock_id,
						lockSha256: binding.seal_sha256,
						candidateSha256: binding.candidate_sha256,
					},
				);

				const prepared = await controller.prepare(
					attemptId,
					`${attemptId}:prepare`,
					binding.candidate_id,
					INSTANCE_ID,
				);
				const transport = new RecordingTransport(controller.toolTransport(attemptId));
				harness = await createHarness();
				sessionResult = await createPiGeneralSession({
					leaseId: prepared.leaseId,
					attemptDirectory: `${harness.tempDir}/attempt`,
					cwd: harness.tempDir,
					model: harness.getModel(),
					authStorage: harness.authStorage,
					modelRegistry: createFauxModelRegistry(harness),
					transport,
					thinkingLevel: "off",
				});
				harness.setResponses([
					fauxAssistantMessage(
						[
							fauxToolCall("repo_list", { path: "." }),
							fauxToolCall("repo_exec", {
								argv: ["git", "status", "--short"],
								timeout_ms: 5_000,
							}),
							fauxToolCall("repo_edit", {
								path: "repofixlab-faux-e2e.txt",
								content: "RepoFixLab faux Pi Docker E2E\n",
							}),
							fauxToolCall("repo_diff", {}),
						],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("faux repair trajectory complete"),
				]);
				await sessionResult.session.prompt("Exercise the locked repair environment without solving the hidden issue.");
				assert.deepEqual(
					transport.requests.map((request) => request.tool),
					["repo_list", "repo_exec", "repo_edit", "repo_diff"],
				);
				assert.equal(transport.responses.length, 4);
				assert(transport.responses.every((response) => response.result.exit_code === 0));
				assert.match(transport.responses[3]?.result.stdout ?? "", /repofixlab-faux-e2e\.txt/);

				const snapshot = await controller.snapshot(
					attemptId,
					`${attemptId}:snapshot`,
					prepared.leaseId,
				);
				assert.equal(snapshot.baseCommit, preflight.base_commit);
				assert.equal(snapshot.policy.status, "pass");
				assert(snapshot.patch.byteLength > 0);
				assert(
					snapshot.files.some((file) => file.path === "repofixlab-faux-e2e.txt" && file.status === "added"),
				);

				const workerCleanup = await controller.destroy(
					attemptId,
					`${attemptId}:destroy`,
					prepared.leaseId,
				);
				assert.equal(workerCleanup.clean, true, "Worker destroy must prove zero managed residual resources");

				const job = await controller.startEvaluation(
					attemptId,
					`${attemptId}:evaluate`,
					runId,
					snapshot.snapshotId,
				);
				const jobStatus = await waitForTerminalEvaluation(controller, attemptId, job.jobId);
				assert.equal(jobStatus.status, "completed");
				assert.equal(jobStatus.resolved, false);
				assert.equal(jobStatus.errorClass, null);

				const artifactSet = await controller.getArtifacts(attemptId, job.jobId);
				assert.deepEqual(
					artifactSet.artifacts.map((artifact) => artifact.name).sort(),
					["evaluation.json", "evaluator.log", "patch-apply.json"],
				);
				const evaluation = verifyEvaluationResult(
					JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							artifactContent(artifactSet.artifacts, "evaluation.json"),
						),
					),
				);
				assert.equal(evaluation.job_id, job.jobId);
				assert.equal(evaluation.run_id, runId);
				assert.equal(evaluation.attempt_id, attemptId);
				assert.equal(evaluation.instance_id, INSTANCE_ID);
				assert.equal(evaluation.candidate_patch_sha256, snapshot.patchSha256);
				assert.equal(evaluation.status, "completed");
				assert.equal(evaluation.resolved, false);
				assert.equal(evaluation.candidate_patch_apply_status, "applied");
				assert.equal(evaluation.test_patch_apply_status, "applied");
				assert.equal(evaluation.test_executed, true);
				assert.equal(evaluation.test_collected, true);

				const evaluatorCleanup = await controller.acknowledge(
					attemptId,
					`${attemptId}:ack`,
					job.jobId,
					artifactSet.artifactSetSha256,
				);
				assert.equal(evaluatorCleanup.clean, true, "Evaluator ACK must prove zero managed residual resources");
				acknowledged = true;
			} finally {
				sessionResult?.session.dispose();
				harness?.cleanup();
				if (preflightAdmitted && !acknowledged) {
					const cleanup = await controller.abort(attemptId, `${attemptId}:abort`);
					assert.equal(cleanup.clean, true, "Failed E2E attempts must abort with zero managed residual resources");
				}
			}
		},
		TEST_TIMEOUT_MS,
	);
});
