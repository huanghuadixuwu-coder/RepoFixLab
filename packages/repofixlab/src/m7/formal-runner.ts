import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createArtifactIndex,
	createAttempt,
	createRunManifest,
	createRunResult,
	type RunResult,
} from "../contracts/run-contracts.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { RepoFixConfigId } from "../agent/repofix-config.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import {
	createDefaultM4DevWorkflowDependencies,
	M4PreProviderInputError,
	runM4DevWorkflow,
	type M4DevWorkflowDependencies,
	type M4DevWorkflowSummary,
} from "../runner/m4-dev-workflow.ts";
import { KnownProviderUsageBatchFailure, PreProviderBatchFailure } from "../runner/pre-provider-failure.ts";
import { createDeepSeekV4FlashRuntime, runtimeIdentityFromSession } from "../runner/runtime-factory.ts";
import { DirectoryTaskEnvironmentLockSource, FilePublicTaskSource } from "../runner/task-source.ts";
import { normalizeM6OfficialEvaluation } from "./evaluation-adapter.ts";

const MAX_POLLS = 7_200;
const POLL_INTERVAL_MS = 1_000;
const M7_PER_RUN_CAP = 5_000_000;
const M7_TASK_ENVIRONMENT_LOCK_ROOT = fileURLToPath(new URL("../../configs/runtime/m6-26-task-v1", import.meta.url));
const M7_RUNTIME_CONFIG_ROOT = fileURLToPath(new URL("../../configs/runtime", import.meta.url));

export interface M7FormalRunOptions {
	readonly artifactsRoot: string;
	readonly formalRunsRoot: string;
	readonly experimentId: string;
	readonly runId: string;
	readonly attemptId: string;
	readonly instanceId: string;
	readonly configId: RepoFixConfigId;
	readonly replicate: number;
	readonly maxModelTurns: number;
	readonly hooks?: { readonly agentFinished: () => Promise<void>; readonly evaluating: () => Promise<void> };
}

export interface M7FormalRunDependencies extends M4DevWorkflowDependencies {
	readonly sleep: (milliseconds: number) => Promise<void>;
}

function usageFromLedger(content: string): RunResult["usage"] {
	let accounted = 0;
	let actual = 0;
	let complete = true;
	let modelTurns = 0;
	const openReservations = new Set<string>();
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		const event = JSON.parse(line) as { event_type: string; request_id: string; accounted_tokens: number | null; provider_total_tokens: number | null };
		if (event.event_type === "reservation_open") {
			openReservations.add(event.request_id);
			continue;
		}
		if (event.event_type === "reservation_settled") {
			if (event.accounted_tokens === null || event.provider_total_tokens === null) throw new Error("Settled token usage is incomplete");
			if (!openReservations.delete(event.request_id)) throw new Error("Settled token usage has no matching reservation");
			accounted += event.accounted_tokens;
			actual += event.provider_total_tokens;
			modelTurns += 1;
		} else if (event.event_type === "reservation_charged_unverified" || event.event_type === "budget_protocol_invalid") {
			if (event.accounted_tokens === null) throw new Error("Unverified token charge is malformed");
			if (!openReservations.delete(event.request_id)) throw new Error("Unverified token charge has no matching reservation");
			accounted += event.accounted_tokens;
			complete = false;
		}
	}
	if (openReservations.size !== 0) complete = false;
	return {
		accounted_tokens: accounted,
		provider_actual_tokens: complete ? actual : null,
		usage_complete: complete,
		cost_complete: false,
		estimated_cost_cny_nano: null,
		model_turns: modelTurns,
		tool_calls: 0,
	};
}

function evaluatorArtifactPath(name: string, index: number): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error("Unsafe Evaluator artifact name");
	return `evaluator/${String(index + 1).padStart(3, "0")}-${name}`;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : "M7 pre-provider setup failed").slice(0, 2_000);
}

function hasProviderReservation(content: string): boolean {
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		const value = JSON.parse(line) as { event_type?: unknown };
		if (
			value.event_type === "reservation_open" ||
			value.event_type === "reservation_settled" ||
			value.event_type === "reservation_charged_unverified" ||
			value.event_type === "budget_protocol_invalid"
		) return true;
	}
	return false;
}

export async function runM7FormalRun(options: M7FormalRunOptions, dependencies: M7FormalRunDependencies): Promise<RunResult> {
	let environment: Awaited<ReturnType<M4DevWorkflowDependencies["environmentLockSource"]["load"]>>;
	let publicTask: Awaited<ReturnType<M4DevWorkflowDependencies["publicTaskSource"]["load"]>>;
	let runtime: ReturnType<typeof createDeepSeekV4FlashRuntime>;
	let identity: ReturnType<typeof runtimeIdentityFromSession>;
	try {
		environment = await dependencies.environmentLockSource.load(options.instanceId);
		publicTask = await dependencies.publicTaskSource.load(options.instanceId, environment);
		runtime = createDeepSeekV4FlashRuntime();
		const manifestSession =
			options.configId === "pi-general"
				? await dependencies.createPiGeneralSession({
					leaseId: "lease-manifest",
					attemptDirectory: "/tmp/m7-manifest",
					cwd: "/testbed",
					transport: dependencies.controller.toolTransport(options.attemptId),
				})
				: await dependencies.createRepoFixSession({
					leaseId: "lease-manifest",
					attemptDirectory: "/tmp/m7-manifest",
					cwd: "/testbed",
					transport: dependencies.controller.toolTransport(options.attemptId),
					configId: options.configId,
				});
		try {
			identity = runtimeIdentityFromSession(manifestSession.session, runtime.modelSpecSha256);
		} finally {
			manifestSession.session.dispose();
		}
	} catch (error) {
		throw new PreProviderBatchFailure(errorMessage(error));
	}
	const startedAt = dependencies.now().toISOString();
	const manifest = createRunManifest({
		schema_version: "v1", manifest_type: "run_manifest", manifest_id: `manifest-${options.runId}`,
		experiment_id: options.experimentId, run_id: options.runId, config_id: options.configId,
		instance_id: options.instanceId, replicate: options.replicate,
		public_task_manifest_id: publicTask.manifest.manifest_id, public_task_manifest_sha256: publicTask.manifest.manifest_sha256,
		task_environment_lock_id: environment.lockId, task_environment_lock_sha256: environment.lockSha256,
		model: { provider: "deepseek", model_id: "deepseek-v4-flash", model_spec_sha256: runtime.modelSpecSha256, pricing_spec_sha256: runtime.pricingSpecSha256, system_prompt_sha256: identity.systemPromptSha256, tool_schema_sha256: identity.toolSchemaSha256 },
		budget: { accounted_admission_cap_tokens: M7_PER_RUN_CAP, max_model_turns: options.maxModelTurns, max_tool_calls: null, max_wall_time_ms: 1_800_000 }, created_at: startedAt,
	});
	const root = resolve(options.formalRunsRoot, options.runId);
	const store = await ArtifactStore.createNew(`${root}.staging`);
	await store.writeNew("run.json", stableStringify(manifest), { mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" });
	let m4: M4DevWorkflowSummary;
	try {
		m4 = await runM4DevWorkflow({ artifactsRoot: options.artifactsRoot, instanceId: options.instanceId, configId: options.configId, accountedAdmissionCapTokens: M7_PER_RUN_CAP, tokenAdmissionEstimator: { version: "m6-deepseek-v4-flash-v1", multiplier: 1.351, framing_margin_tokens: 4096 }, maxModelTurns: options.maxModelTurns, runId: options.runId, attemptId: options.attemptId, retainWorkerForFormalEvaluation: true }, dependencies);
	} catch (error) {
		if (error instanceof M4PreProviderInputError) throw new PreProviderBatchFailure(errorMessage(error));
		throw error;
	}
	await store.writeNew("agent-summary.json", stableStringify(m4), { mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" });
	const m4Ledger = await readFile(resolve(m4.run_directory, "token-ledger.jsonl")).catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (m4Ledger === null) {
		if (m4.terminal_status !== "completed") throw new PreProviderBatchFailure("M7 Agent failed before creating a Provider token ledger");
		throw new Error("M7 Agent completed without a Provider token ledger");
	}
	const ledgerContent = new TextDecoder("utf-8", { fatal: true }).decode(m4Ledger);
	await store.writeNew("token-ledger.jsonl", m4Ledger, { mediaType: "application/x-ndjson", sensitivity: "internal", generatedBy: "orchestrator" });
	const usage = usageFromLedger(ledgerContent);
	if (m4.terminal_status !== "completed" && !hasProviderReservation(ledgerContent)) {
		throw new PreProviderBatchFailure("M7 Agent failed before its first Provider reservation");
	}
	if (usage.model_turns === 0 && !hasProviderReservation(ledgerContent)) {
		throw new PreProviderBatchFailure("M7 Agent completed without sending a Provider request");
	}
	if (!usage.usage_complete || usage.model_turns === 0) {
		throw new Error("M7 Agent usage is incomplete or lacks a settled Provider response");
	}
	try {
		if (m4.terminal_status !== "completed" || m4.worker_lease_id === null || m4.final_snapshot_id === null || m4.p1_patch_sha256 === null) throw new Error("M7 Agent did not produce a retained final snapshot");
		await options.hooks?.agentFinished();
		const destroyed = await dependencies.controller.destroy(options.attemptId, `${options.attemptId}:destroy`, m4.worker_lease_id);
		if (!destroyed.clean) throw new Error("M7 Worker cleanup reported residual resources");
		await options.hooks?.evaluating();
		const job = await dependencies.controller.startEvaluation(options.attemptId, `${options.attemptId}:evaluate`, options.runId, m4.final_snapshot_id);
		let status = await dependencies.controller.getJob(options.attemptId, job.jobId);
		for (let polls = 0; (status.status === "queued" || status.status === "running") && polls < MAX_POLLS; polls += 1) { await dependencies.sleep(POLL_INTERVAL_MS); status = await dependencies.controller.getJob(options.attemptId, job.jobId); }
		if (status.status === "queued" || status.status === "running") throw new Error("M7 official evaluation polling limit exceeded");
		const artifacts = await dependencies.controller.getArtifacts(options.attemptId, job.jobId);
		for (const [index, artifact] of artifacts.artifacts.entries()) await store.writeNew(evaluatorArtifactPath(artifact.name, index), artifact.content, { mediaType: artifact.name.endsWith(".json") ? "application/json" : "text/plain", sensitivity: "private", generatedBy: "evaluator" });
		const evaluationArtifact = artifacts.artifacts.find((artifact) => artifact.name === "evaluation.json");
		if (evaluationArtifact === undefined) throw new Error("M7 evaluator did not return evaluation.json");
		const finishedAt = dependencies.now().toISOString();
		const evaluation = normalizeM6OfficialEvaluation(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evaluationArtifact.content)),
			{ runId: options.runId, attemptId: options.attemptId, jobId: job.jobId, instanceId: options.instanceId, baseCommit: publicTask.task.base_commit, candidatePatchSha256: m4.p1_patch_sha256, finishedAt },
		);
		await store.writeNew("evaluation-normalized.json", stableStringify(evaluation), { mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" });
		const acknowledged = await dependencies.controller.acknowledge(options.attemptId, `${options.attemptId}:ack`, job.jobId, artifacts.artifactSetSha256);
		if (!acknowledged.clean) throw new Error("M7 Evaluator cleanup reported residual resources");
		if (evaluation.status !== "completed") throw new Error(evaluation.error_class ?? "Official evaluation failed");
		const attempt = createAttempt({ schema_version: "v1", record_type: "attempt", attempt_id: options.attemptId, run_id: options.runId, attempt_number: 1, status: "completed", started_at: startedAt, finished_at: finishedAt, worker_lease_id: m4.worker_lease_id, evaluator_job_id: job.jobId, termination_reason: "agent_completed", accounted_tokens: usage.accounted_tokens, provider_actual_tokens: usage.provider_actual_tokens, usage_complete: usage.usage_complete });
		await store.writeNew("attempt.json", stableStringify(attempt), { mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" });
		const index = createArtifactIndex({ schema_version: "v1", index_type: "artifact_index", run_id: options.runId, attempt_id: options.attemptId, artifacts: store.listArtifacts().map((artifact, index) => ({ name: `artifact-${String(index + 1).padStart(4, "0")}`, path: artifact.path, media_type: artifact.mediaType, bytes: artifact.bytes, sha256: artifact.sha256, sensitivity: artifact.sensitivity, generated_by: artifact.generatedBy })), created_at: finishedAt });
		const result = createRunResult({ schema_version: "v1", result_type: "run", run_id: options.runId, attempt_id: options.attemptId, manifest_sha256: manifest.manifest_sha256, terminal_status: "completed", termination_reason: evaluation.resolved ? "official_resolved" : "official_unresolved", resolved: evaluation.resolved, started_at: startedAt, finished_at: finishedAt, wall_time_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), usage, attempt_sha256: attempt.attempt_sha256, patch_snapshot_sha256: m4.p1_patch_sha256, evaluation_result_sha256: evaluation.evaluation_sha256, artifact_index_sha256: index.index_sha256, failure: null });
		await store.writeNew("artifact-index.json", stableStringify(index), { mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" });
		await store.writeNew("result.json", stableStringify(result), { mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" });
		await store.publishTo(root);
		return result;
	} catch (error) {
		if (error instanceof KnownProviderUsageBatchFailure) throw error;
		throw new KnownProviderUsageBatchFailure(errorMessage(error), usage.accounted_tokens);
	}
}

export function createDefaultM7FormalRunDependencies(controllerUrl: string): M7FormalRunDependencies {
	const runtime = createDeepSeekV4FlashRuntime();
	return {
		...createDefaultM4DevWorkflowDependencies(controllerUrl, runtime),
		publicTaskSource: new FilePublicTaskSource(undefined, "test"),
		environmentLockSource: new DirectoryTaskEnvironmentLockSource(
			process.env.REPOFIX_M7_TASK_ENVIRONMENT_LOCK_ROOT ?? M7_TASK_ENVIRONMENT_LOCK_ROOT,
			{ root_path: M7_RUNTIME_CONFIG_ROOT, relative_path: "axios-5892/dataset-lock.json" },
		),
		sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
	};
}
