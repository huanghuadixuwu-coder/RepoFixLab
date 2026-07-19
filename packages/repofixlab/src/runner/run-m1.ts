import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PiGeneralSessionResult } from "../agent/pi-general.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { ExperimentPlan } from "../contracts/experiment-plan.ts";
import {
	type ArtifactIndex,
	type Attempt,
	canonicalContractSha256,
	createArtifactIndex,
	createAttempt,
	createPatchSnapshot,
	createRunManifest,
	createRunResult,
	type EvaluationResult,
	type PatchSnapshot,
	type RunResult,
	verifyEvaluationResult,
} from "../contracts/run-contracts.ts";
import type { RepoToolTransport } from "../controller/client.ts";
import { createStaticRunReport } from "../report/static-report.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import { HttpRuntimeController, type RuntimeController, type RuntimePatchSnapshot } from "./controller-runtime.ts";
import { RunEventJournal } from "./event-journal.ts";
import {
	estimateGlm45AirCost,
	FROZEN_GLM_45_AIR_PRICING_SPEC,
	FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256,
} from "./pricing.ts";
import {
	createFrozenModelRuntime,
	createFrozenPiGeneralSession,
	installRunAdmissionGate,
	RUN_ADMISSION_BUDGET_ERROR,
	runtimeIdentityFromSession,
} from "./runtime-factory.ts";
import {
	FilePublicTaskSource,
	FileTaskEnvironmentLockSource,
	type PublicTaskSource,
	type TaskEnvironmentLockSource,
} from "./task-source.ts";

const M1_INSTANCE_ID = "axios__axios-5892";
const MAX_MODEL_TURNS = 100;
const MAX_TOOL_CALLS = 500;
const MAX_WALL_TIME_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 7_200;
const LOGICAL_AGENT_CWD = "/testbed";

type SessionFactory = (options: {
	readonly leaseId: string;
	readonly attemptDirectory: string;
	readonly cwd: string;
	readonly transport: RepoToolTransport;
}) => Promise<PiGeneralSessionResult>;

export interface M1RunnerDependencies {
	readonly controller: RuntimeController;
	readonly publicTaskSource: PublicTaskSource;
	readonly environmentLockSource: TaskEnvironmentLockSource;
	readonly createSession: SessionFactory;
	readonly modelSpecSha256: string;
	readonly pricingSpecSha256: string;
	readonly now: () => Date;
	readonly randomId: () => string;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly pollIntervalMs: number;
	readonly maxPolls: number;
}

export interface M1RunOptions {
	readonly artifactsRoot: string;
}

export interface M1RunSummary {
	readonly schema_version: "v1";
	readonly summary_type: "m1_run";
	readonly experiment_id: string;
	readonly run_id: string;
	readonly attempt_id: string;
	readonly terminal_status: RunResult["terminal_status"];
	readonly termination_reason: RunResult["termination_reason"];
	readonly resolved: boolean;
	readonly run_directory: string;
	readonly result_sha256: string;
}

type TerminationReason = RunResult["termination_reason"];
type FailureStage = NonNullable<RunResult["failure"]>["stage"];

interface UsageSummary {
	readonly accountedTokens: number;
	readonly providerActualTokens: number | null;
	readonly usageComplete: boolean;
	readonly costComplete: boolean;
	readonly estimatedCostCnyNano: number | null;
	readonly modelTurns: number;
	readonly toolCalls: number;
}

interface TerminalState {
	terminalStatus: RunResult["terminal_status"];
	terminationReason: TerminationReason;
	resolved: boolean;
	failureStage: FailureStage | null;
	failureMessage: string | null;
}

export function assertM1Plan(plan: ExperimentPlan): void {
	const group = plan.matrix[0];
	if (
		plan.experiment_id !== "m1-axios" ||
		plan.runtime_status !== "m1_single_run_available" ||
		plan.task_selection.status !== "frozen" ||
		plan.task_selection.declared_task_count !== 1 ||
		plan.task_selection.instance_ids.length !== 1 ||
		plan.task_selection.instance_ids[0] !== M1_INSTANCE_ID ||
		plan.matrix.length !== 1 ||
		group === undefined ||
		group.group_id !== "m1-smoke" ||
		group.task_count !== 1 ||
		group.config_ids.length !== 1 ||
		group.config_ids[0] !== "pi-general" ||
		group.replicates !== 1 ||
		plan.budget.per_run_accounted_admission_cap_tokens !== null ||
		plan.budget.total_accounted_admission_cap_tokens !== null
	) {
		throw new Error("M1 Runner only admits the frozen axios__axios-5892 pi-general single run");
	}
}

function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "Unknown runtime failure";
	return message.slice(0, 2_000) || "Unknown runtime failure";
}

function jsonSerializable(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function usageFromSession(session: PiGeneralSessionResult["session"]): UsageSummary {
	let accountedTokens = 0;
	let modelTurns = 0;
	let toolCalls = 0;
	let usageComplete = true;
	let costComplete = true;
	let estimatedCostCnyNano = 0;
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		modelTurns += 1;
		accountedTokens += message.usage.totalTokens;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			usageComplete = false;
			costComplete = false;
		}
		const messageCost = estimateGlm45AirCost(message.usage);
		if (!messageCost.complete || messageCost.estimatedCostCnyNano === null) {
			costComplete = false;
		} else {
			estimatedCostCnyNano += messageCost.estimatedCostCnyNano;
			if (!Number.isSafeInteger(estimatedCostCnyNano)) costComplete = false;
		}
		toolCalls += message.content.filter((content) => content.type === "toolCall").length;
	}
	if (!usageComplete) costComplete = false;
	return {
		accountedTokens,
		providerActualTokens: usageComplete ? accountedTokens : null,
		usageComplete,
		costComplete,
		estimatedCostCnyNano: costComplete ? estimatedCostCnyNano : null,
		modelTurns,
		toolCalls,
	};
}

function classifyAgent(
	session: PiGeneralSessionResult["session"],
	usage: UsageSummary,
	admissionCap: number | null,
): TerminalState | null {
	const last = session.messages.at(-1);
	if (last?.role === "assistant" && last.stopReason === "aborted") {
		return failed("aborted", "user_abort", "agent", last.errorMessage ?? "Agent request was aborted");
	}
	if (last?.role === "assistant" && last.stopReason === "error") {
		if (last.errorMessage === RUN_ADMISSION_BUDGET_ERROR)
			return failed(
				"failed",
				"budget_exhausted",
				"agent",
				"The next provider request was denied by the frozen admission budget",
			);
		return failed("failed", "model_error", "agent", last.errorMessage ?? "Model request failed");
	}
	// A tool rejection is preserved in trajectory.json, but it is not terminal by itself:
	// the model can correct its request and complete a repair in a later turn. Only the
	// final agent state, safety limits, and the official evaluator decide run terminality.
	if (admissionCap !== null && usage.accountedTokens >= admissionCap && last?.role === "toolResult") {
		return failed(
			"failed",
			"budget_exhausted",
			"agent",
			"The next provider request was denied by the frozen admission budget",
		);
	}
	if (
		(admissionCap !== null && usage.accountedTokens > admissionCap) ||
		usage.modelTurns > MAX_MODEL_TURNS ||
		usage.toolCalls > MAX_TOOL_CALLS
	) {
		return failed("failed", "budget_exhausted", "agent", "The frozen run budget was exceeded");
	}
	return null;
}

function failed(
	status: "failed" | "aborted",
	reason: TerminationReason,
	stage: FailureStage,
	message: string,
): TerminalState {
	return {
		terminalStatus: status,
		terminationReason: reason,
		resolved: false,
		failureStage: stage,
		failureMessage: message.slice(0, 2_000),
	};
}

function completed(resolved: boolean): TerminalState {
	return {
		terminalStatus: "completed",
		terminationReason: resolved ? "official_resolved" : "official_unresolved",
		resolved,
		failureStage: null,
		failureMessage: null,
	};
}

function attemptReason(reason: TerminationReason): Attempt["termination_reason"] {
	if (reason === "official_resolved" || reason === "official_unresolved" || reason === "no_patch")
		return "agent_completed";
	return reason;
}

function mediaType(name: string): string {
	if (name.endsWith(".json")) return "application/json";
	if (name.endsWith(".log") || name.endsWith(".txt")) return "text/plain";
	return "application/octet-stream";
}

function artifactPath(name: string, index: number): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error("Evaluator artifact name is unsafe");
	return `evaluator/${String(index + 1).padStart(3, "0")}-${name}`;
}

async function inspectRuntimeIdentity(
	dependencies: M1RunnerDependencies,
	attemptId: string,
): Promise<{ modelSpecSha256: string; systemPromptSha256: string; toolSchemaSha256: string }> {
	const directory = await mkdtemp(join(tmpdir(), "repofixlab-admission-"));
	let result: PiGeneralSessionResult | undefined;
	try {
		result = await dependencies.createSession({
			leaseId: "lease-manifest",
			attemptDirectory: join(directory, "session"),
			cwd: LOGICAL_AGENT_CWD,
			transport: dependencies.controller.toolTransport(attemptId),
		});
		return runtimeIdentityFromSession(result.session, dependencies.modelSpecSha256);
	} finally {
		result?.session.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

async function persistPatch(
	store: ArtifactStore,
	runId: string,
	attemptId: string,
	raw: RuntimePatchSnapshot,
): Promise<PatchSnapshot> {
	const patchArtifact = await store.writeNew("candidate.patch", raw.patch, {
		mediaType: "text/x-diff",
		sensitivity: "internal",
		generatedBy: "controller",
	});
	if (patchArtifact.sha256 !== raw.patchSha256) throw new Error("Persisted patch SHA-256 drifted");
	const snapshot = createPatchSnapshot({
		schema_version: "v1",
		snapshot_type: "patch",
		snapshot_id: raw.snapshotId,
		run_id: runId,
		attempt_id: attemptId,
		label: "candidate",
		base_commit: raw.baseCommit,
		base_tree: raw.baseTree,
		candidate_tree: raw.candidateTree,
		patch_sha256: raw.patchSha256,
		patch_bytes: raw.patch.byteLength,
		files: [...raw.files],
		policy: { status: raw.policy.status, violations: [...raw.policy.violations] },
		created_at: raw.createdAt,
	});
	await store.writeNew("patch-snapshot.json", stableStringify(snapshot), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	return snapshot;
}

function evaluationFromArtifact(
	content: Uint8Array,
	runId: string,
	attemptId: string,
	instanceId: string,
	patchSha256: string,
	jobId: string,
): EvaluationResult {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
	} catch {
		throw new Error("evaluation.json is not valid UTF-8 JSON");
	}
	const result = verifyEvaluationResult(value);
	if (
		result.run_id !== runId ||
		result.attempt_id !== attemptId ||
		result.instance_id !== instanceId ||
		result.candidate_patch_sha256 !== patchSha256 ||
		result.job_id !== jobId
	)
		throw new Error("evaluation.json binding drifted from the run");
	return result;
}

export async function runM1Experiment(
	plan: ExperimentPlan,
	options: M1RunOptions,
	dependencies: M1RunnerDependencies,
): Promise<M1RunSummary> {
	assertM1Plan(plan);
	const runId = `run-${dependencies.randomId()}`;
	const attemptId = `attempt-${dependencies.randomId()}`;
	const environment = await dependencies.environmentLockSource.load(M1_INSTANCE_ID);
	const publicTask = await dependencies.publicTaskSource.load(M1_INSTANCE_ID, environment);
	if (publicTask.task.base_commit.length !== 40) throw new Error("Public task base commit is invalid");
	if (dependencies.pricingSpecSha256 !== FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256)
		throw new Error("Runner pricing specification differs from the frozen M1 binding");
	const identity = await inspectRuntimeIdentity(dependencies, attemptId);
	const startedAt = dependencies.now().toISOString();
	const manifest = createRunManifest({
		schema_version: "v1",
		manifest_type: "run_manifest",
		manifest_id: `manifest-${runId}`,
		experiment_id: plan.experiment_id,
		run_id: runId,
		config_id: "pi-general",
		instance_id: M1_INSTANCE_ID,
		replicate: 1,
		public_task_manifest_id: publicTask.manifest.manifest_id,
		public_task_manifest_sha256: publicTask.manifest.manifest_sha256,
		task_environment_lock_id: environment.lockId,
		task_environment_lock_sha256: environment.lockSha256,
		model: {
			provider: "zhipu-standard",
			model_id: "glm-4.5-air",
			model_spec_sha256: identity.modelSpecSha256,
			pricing_spec_sha256: dependencies.pricingSpecSha256,
			system_prompt_sha256: identity.systemPromptSha256,
			tool_schema_sha256: identity.toolSchemaSha256,
		},
		budget: {
			accounted_admission_cap_tokens: plan.budget.per_run_accounted_admission_cap_tokens,
			max_model_turns: MAX_MODEL_TURNS,
			max_tool_calls: MAX_TOOL_CALLS,
			max_wall_time_ms: MAX_WALL_TIME_MS,
		},
		created_at: startedAt,
	});
	const runDirectory = resolve(options.artifactsRoot, plan.experiment_id, "runs", runId);
	const stagingDirectory = resolve(options.artifactsRoot, plan.experiment_id, "runs", `.staging-${runId}`);
	let admittedStore: ArtifactStore | null = null;
	let admittedJournal: RunEventJournal | null = null;
	try {
		const store = await ArtifactStore.createNew(stagingDirectory);
		admittedStore = store;
		await store.writeNew("experiment-plan.json", stableStringify(plan), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await store.writeNew("public-task.json", stableStringify(publicTask.manifest), {
			mediaType: "application/json",
			sensitivity: "public",
			generatedBy: "orchestrator",
		});
		const publicRecordArtifact = await store.writeNew("public-task-record.json", publicTask.recordBytes, {
			mediaType: "application/json",
			sensitivity: "public",
			generatedBy: "orchestrator",
		});
		if (publicRecordArtifact.sha256 !== publicTask.recordSha256)
			throw new Error("Persisted public task record SHA-256 drifted");
		const environmentArtifact = await store.writeNew("task-environment-lock.json", environment.lockBytes, {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		if (environmentArtifact.sha256 !== environment.lockFileSha256)
			throw new Error("Persisted TaskEnvironmentLock file SHA-256 drifted");
		const datasetArtifact = await store.writeNew("dataset-lock.json", environment.datasetLockBytes, {
			mediaType: "application/json",
			sensitivity: "public",
			generatedBy: "orchestrator",
		});
		if (datasetArtifact.sha256 !== environment.datasetLockFileSha256)
			throw new Error("Persisted DatasetLock file SHA-256 drifted");
		await store.writeNew("pricing-spec.json", stableStringify(FROZEN_GLM_45_AIR_PRICING_SPEC), {
			mediaType: "application/json",
			sensitivity: "public",
			generatedBy: "orchestrator",
		});
		await store.writeNew("run.json", stableStringify(manifest), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await store.publishTo(runDirectory);
		const journal = new RunEventJournal(runId, attemptId, await store.createAppendOnlyFile("events.jsonl"));
		admittedJournal = journal;
		await journal.append({
			at: dependencies.now().toISOString(),
			stage: "orchestrator",
			event_type: "manifest_loaded",
			status: "success",
			operation_id: null,
			subject: manifest.manifest_id,
			message: null,
			parameters_sha256: manifest.manifest_sha256,
			result_sha256: null,
			artifact_sha256: null,
		});
		await journal.append({
			at: dependencies.now().toISOString(),
			stage: "orchestrator",
			event_type: "attempt_started",
			status: "info",
			operation_id: null,
			subject: attemptId,
			message: null,
			parameters_sha256: null,
			result_sha256: null,
			artifact_sha256: null,
		});
	} catch (error) {
		await admittedJournal?.close().catch(() => undefined);
		await rm(admittedStore?.rootPath ?? stagingDirectory, { recursive: true, force: true });
		throw error;
	}
	if (admittedStore === null || admittedJournal === null)
		throw new Error("Runner admission reached an impossible uncommitted state");
	const store = admittedStore;
	const journal = admittedJournal;

	let leaseId: string | null = null;
	let jobId: string | null = null;
	let patchSnapshot: PatchSnapshot | null = null;
	let evaluation: EvaluationResult | null = null;
	let sessionResult: PiGeneralSessionResult | null = null;
	let usage: UsageSummary = {
		accountedTokens: 0,
		providerActualTokens: null,
		usageComplete: false,
		costComplete: false,
		estimatedCostCnyNano: null,
		modelTurns: 0,
		toolCalls: 0,
	};
	let terminal: TerminalState | null = null;
	let snapshotRaw: RuntimePatchSnapshot | null = null;
	let workerDestroyed = false;
	let sessionDirectory: string | null = null;
	let preflightAdmitted = false;
	let evaluatorAcknowledged = false;
	let currentStage: FailureStage = "orchestrator";

	try {
		const preflightOperation = `${attemptId}:preflight`;
		const preflight = await dependencies.controller.preflight(
			attemptId,
			preflightOperation,
			environment.candidateId,
			M1_INSTANCE_ID,
		);
		preflightAdmitted = true;
		if (
			preflight.task_environment_lock_id !== environment.lockId ||
			preflight.task_environment_lock_sha256 !== environment.lockSha256 ||
			preflight.candidate_sha256 !== environment.candidateSha256 ||
			preflight.base_commit !== publicTask.task.base_commit
		)
			throw new Error("Controller preflight binding differs from admitted task inputs");
		await store.writeNew(
			"controller-preflight.json",
			stableStringify({
				schema_version: "v1",
				receipt_type: "controller_preflight",
				attempt_id: attemptId,
				operation_id: preflightOperation,
				candidate_id: environment.candidateId,
				instance_id: M1_INSTANCE_ID,
				...preflight,
				verified_at: dependencies.now().toISOString(),
			}),
			{ mediaType: "application/json", sensitivity: "internal", generatedBy: "controller" },
		);
		const prepared = await dependencies.controller.prepare(
			attemptId,
			`${attemptId}:prepare`,
			environment.candidateId,
			M1_INSTANCE_ID,
		);
		leaseId = prepared.leaseId;
		await journal.append({
			at: dependencies.now().toISOString(),
			stage: "orchestrator",
			event_type: "worker_prepared",
			status: "success",
			operation_id: `${attemptId}:prepare`,
			subject: leaseId,
			message: null,
			parameters_sha256: environment.candidateSha256,
			result_sha256: null,
			artifact_sha256: null,
		});

		currentStage = "agent";
		sessionDirectory = await mkdtemp(join(tmpdir(), "repofixlab-attempt-"));
		sessionResult = await dependencies.createSession({
			leaseId,
			attemptDirectory: join(sessionDirectory, "session"),
			cwd: LOGICAL_AGENT_CWD,
			transport: dependencies.controller.toolTransport(attemptId),
		});
		const liveIdentity = runtimeIdentityFromSession(sessionResult.session, dependencies.modelSpecSha256);
		if (canonicalContractSha256(liveIdentity) !== canonicalContractSha256(identity))
			throw new Error("Live Pi session identity drifted from the admitted manifest");
		installRunAdmissionGate(sessionResult.session, {
			accountedTokens: plan.budget.per_run_accounted_admission_cap_tokens,
			modelTurns: MAX_MODEL_TURNS,
			toolCalls: MAX_TOOL_CALLS,
		});
		let wallTimedOut = false;
		const timer = setTimeout(() => {
			wallTimedOut = true;
			void sessionResult?.session.abort();
		}, MAX_WALL_TIME_MS);
		try {
			await sessionResult.session.prompt(publicTask.task.problem_statement);
		} finally {
			clearTimeout(timer);
		}
		usage = usageFromSession(sessionResult.session);
		await store.writeNew("trajectory.json", stableStringify(jsonSerializable(sessionResult.session.messages)), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "agent",
		});
		terminal = wallTimedOut
			? failed("failed", "wall_time_exceeded", "agent", "The frozen wall-time budget was exceeded")
			: classifyAgent(sessionResult.session, usage, plan.budget.per_run_accounted_admission_cap_tokens);
		await journal.append({
			at: dependencies.now().toISOString(),
			stage: "agent",
			event_type: "agent_finished",
			status: terminal === null ? "success" : "error",
			operation_id: null,
			subject: "pi-general",
			message: terminal?.failureMessage ?? null,
			parameters_sha256: null,
			result_sha256: canonicalContractSha256(jsonSerializable(sessionResult.session.messages)),
			artifact_sha256: null,
		});

		currentStage = "snapshot";
		snapshotRaw = await dependencies.controller.snapshot(attemptId, `${attemptId}:snapshot`, leaseId);
		patchSnapshot = await persistPatch(store, runId, attemptId, snapshotRaw);
		await journal.append({
			at: dependencies.now().toISOString(),
			stage: "snapshot",
			event_type: "patch_snapshotted",
			status: "success",
			operation_id: `${attemptId}:snapshot`,
			subject: snapshotRaw.snapshotId,
			message: null,
			parameters_sha256: null,
			result_sha256: patchSnapshot.snapshot_sha256,
			artifact_sha256: snapshotRaw.patchSha256,
		});

		currentStage = "cleanup";
		const cleanup = await dependencies.controller.destroy(attemptId, `${attemptId}:destroy`, leaseId);
		workerDestroyed = cleanup.clean;
		await journal.append({
			at: dependencies.now().toISOString(),
			stage: "cleanup",
			event_type: "worker_destroyed",
			status: cleanup.clean ? "success" : "error",
			operation_id: `${attemptId}:destroy`,
			subject: leaseId,
			message: cleanup.clean ? null : "Worker cleanup reported residual resources",
			parameters_sha256: null,
			result_sha256: null,
			artifact_sha256: null,
		});
		if (!cleanup.clean)
			terminal = failed("failed", "infrastructure_error", "cleanup", "Worker cleanup reported residual resources");
		if (terminal === null && snapshotRaw.policy.status === "fail")
			terminal = failed("failed", "policy_violation", "snapshot", "Candidate patch violated the snapshot policy");

		if (terminal === null) {
			currentStage = "official_evaluate";
			const job = await dependencies.controller.startEvaluation(
				attemptId,
				`${attemptId}:evaluate`,
				runId,
				snapshotRaw.snapshotId,
			);
			jobId = job.jobId;
			await journal.append({
				at: dependencies.now().toISOString(),
				stage: "official_evaluate",
				event_type: "evaluation_started",
				status: "info",
				operation_id: `${attemptId}:evaluate`,
				subject: jobId,
				message: null,
				parameters_sha256: snapshotRaw.patchSha256,
				result_sha256: null,
				artifact_sha256: null,
			});
			let jobStatus = await dependencies.controller.getJob(attemptId, jobId);
			let polls = 1;
			while (jobStatus.status === "queued" || jobStatus.status === "running") {
				if (polls >= dependencies.maxPolls) throw new Error("Official evaluation polling limit was exceeded");
				await dependencies.sleep(dependencies.pollIntervalMs);
				jobStatus = await dependencies.controller.getJob(attemptId, jobId);
				polls += 1;
			}
			const artifactSet = await dependencies.controller.getArtifacts(attemptId, jobId);
			await store.writeNew(
				"controller-artifact-receipt.json",
				stableStringify({
					schema_version: "v1",
					response_type: "runtime_job_artifacts",
					attempt_id: attemptId,
					job_id: jobId,
					status: "ready",
					artifact_set_sha256: artifactSet.artifactSetSha256,
					artifacts: artifactSet.artifacts.map((artifact) => ({
						name: artifact.name,
						sha256: artifact.sha256,
						size_bytes: artifact.content.byteLength,
						content_base64: Buffer.from(artifact.content).toString("base64"),
					})),
				}),
				{ mediaType: "application/json", sensitivity: "private", generatedBy: "controller" },
			);
			for (const [index, artifact] of artifactSet.artifacts.entries()) {
				await store.writeNew(artifactPath(artifact.name, index), artifact.content, {
					mediaType: mediaType(artifact.name),
					sensitivity: "private",
					generatedBy: "evaluator",
				});
			}
			const evaluationArtifact = artifactSet.artifacts.find((artifact) => artifact.name === "evaluation.json");
			if (evaluationArtifact === undefined) throw new Error("Evaluator artifact set is missing evaluation.json");
			evaluation = evaluationFromArtifact(
				evaluationArtifact.content,
				runId,
				attemptId,
				M1_INSTANCE_ID,
				snapshotRaw.patchSha256,
				jobId,
			);
			if (jobStatus.status === "failed" && evaluation.status === "completed")
				throw new Error("Evaluation job failed while evaluation.json claimed completion");
			try {
				const evaluatorCleanup = await dependencies.controller.acknowledge(
					attemptId,
					`${attemptId}:ack`,
					jobId,
					artifactSet.artifactSetSha256,
				);
				if (!evaluatorCleanup.clean) throw new Error("Evaluator cleanup reported residual resources");
				evaluatorAcknowledged = true;
				await journal.append({
					at: dependencies.now().toISOString(),
					stage: "official_evaluate",
					event_type: "evaluation_finished",
					status: evaluation.status === "completed" ? "success" : "error",
					operation_id: `${attemptId}:ack`,
					subject: jobId,
					message: evaluation.error_class,
					parameters_sha256: artifactSet.artifactSetSha256,
					result_sha256: evaluation.evaluation_sha256,
					artifact_sha256: evaluationArtifact.sha256,
				});
				terminal =
					evaluation.status === "completed"
						? completed(evaluation.resolved)
						: failed(
								"failed",
								"evaluation_error",
								"official_evaluate",
								evaluation.error_class ?? "Official evaluation failed",
							);
			} catch (error) {
				terminal = failed(
					"failed",
					"infrastructure_error",
					"cleanup",
					`Evaluator ACK failed: ${safeMessage(error)}`,
				);
			}
		}
	} catch (error) {
		terminal = failed("failed", "infrastructure_error", currentStage, safeMessage(error));
		await store
			.writeNew(
				"error.json",
				stableStringify({
					schema_version: "v1",
					error_type: "run_failure",
					stage: currentStage,
					message: terminal.failureMessage,
					at: dependencies.now().toISOString(),
				}),
				{ mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" },
			)
			.catch(() => undefined);
		await journal
			.append({
				at: dependencies.now().toISOString(),
				stage: currentStage,
				event_type: "failure",
				status: "error",
				operation_id: null,
				subject: terminal.terminationReason,
				message: terminal.failureMessage,
				parameters_sha256: null,
				result_sha256: null,
				artifact_sha256: null,
			})
			.catch(() => undefined);
	} finally {
		sessionResult?.session.dispose();
		if (sessionDirectory !== null)
			await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
		if (leaseId !== null && snapshotRaw === null) {
			try {
				snapshotRaw = await dependencies.controller.snapshot(attemptId, `${attemptId}:recovery-snapshot`, leaseId);
				patchSnapshot = await persistPatch(store, runId, attemptId, snapshotRaw);
			} catch {
				// The primary structured failure remains authoritative; recovery is best effort.
			}
		}
		if (leaseId !== null && snapshotRaw !== null && !workerDestroyed) {
			try {
				workerDestroyed = (
					await dependencies.controller.destroy(attemptId, `${attemptId}:recovery-destroy`, leaseId)
				).clean;
			} catch {
				// The terminal report records the primary failure and any already-persisted evidence.
			}
		}
		if (preflightAdmitted && !evaluatorAcknowledged) {
			try {
				const cleanup = await dependencies.controller.abort(attemptId, `${attemptId}:abort`);
				await journal
					.append({
						at: dependencies.now().toISOString(),
						stage: "cleanup",
						event_type: "worker_destroyed",
						status: cleanup.clean ? "success" : "error",
						operation_id: `${attemptId}:abort`,
						subject: attemptId,
						message: cleanup.clean
							? "Attempt abort cleanup verified zero residual resources"
							: "Attempt abort cleanup reported residual resources",
						parameters_sha256: null,
						result_sha256: null,
						artifact_sha256: null,
					})
					.catch(() => undefined);
				if (!cleanup.clean)
					terminal = failed(
						"failed",
						"infrastructure_error",
						"cleanup",
						"cleanup_unverified: attempt abort reported residual resources",
					);
			} catch (error) {
				terminal = failed("failed", "infrastructure_error", "cleanup", `cleanup_unverified: ${safeMessage(error)}`);
				await journal
					.append({
						at: dependencies.now().toISOString(),
						stage: "cleanup",
						event_type: "failure",
						status: "error",
						operation_id: `${attemptId}:abort`,
						subject: attemptId,
						message: terminal.failureMessage,
						parameters_sha256: null,
						result_sha256: null,
						artifact_sha256: null,
					})
					.catch(() => undefined);
			}
		}
	}

	if (terminal === null)
		terminal = failed(
			"failed",
			"infrastructure_error",
			"orchestrator",
			"Runner reached an impossible non-terminal state",
		);
	const finishedAt = dependencies.now().toISOString();
	const attempt = createAttempt({
		schema_version: "v1",
		record_type: "attempt",
		attempt_id: attemptId,
		run_id: runId,
		attempt_number: 1,
		status: terminal.terminalStatus === "completed" ? "completed" : terminal.terminalStatus,
		started_at: startedAt,
		finished_at: finishedAt,
		worker_lease_id: leaseId,
		evaluator_job_id: jobId,
		termination_reason: attemptReason(terminal.terminationReason),
		accounted_tokens: usage.accountedTokens,
		provider_actual_tokens: usage.providerActualTokens,
		usage_complete: usage.usageComplete,
	});
	await store.writeNew("attempt.json", stableStringify(attempt), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await journal.append({
		at: finishedAt,
		stage: "report",
		event_type: "run_finished",
		status: terminal.terminalStatus === "completed" ? "success" : "error",
		operation_id: null,
		subject: terminal.terminationReason,
		message: terminal.failureMessage,
		parameters_sha256: null,
		result_sha256: null,
		artifact_sha256: null,
	});
	await journal.close();

	const resultUsage = {
		accounted_tokens: usage.accountedTokens,
		provider_actual_tokens: usage.providerActualTokens,
		usage_complete: usage.usageComplete,
		cost_complete: usage.costComplete,
		estimated_cost_cny_nano: usage.estimatedCostCnyNano,
		model_turns: usage.modelTurns,
		tool_calls: usage.toolCalls,
	};
	const wallTimeMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
	await store.writeNew(
		"report.html",
		createStaticRunReport(
			manifest,
			{
				terminal_status: terminal.terminalStatus,
				termination_reason: terminal.terminationReason,
				resolved: terminal.resolved,
				wall_time_ms: wallTimeMs,
				usage: resultUsage,
			},
			store.listArtifacts(),
		),
		{ mediaType: "text/html", sensitivity: "public", generatedBy: "orchestrator" },
	);
	const artifacts = store.listArtifacts().map((artifact, index) => ({
		name: `artifact-${String(index + 1).padStart(4, "0")}`,
		path: artifact.path,
		media_type: artifact.mediaType,
		bytes: artifact.bytes,
		sha256: artifact.sha256,
		sensitivity: artifact.sensitivity,
		generated_by: artifact.generatedBy,
	}));
	const index: ArtifactIndex = createArtifactIndex({
		schema_version: "v1",
		index_type: "artifact_index",
		run_id: runId,
		attempt_id: attemptId,
		artifacts,
		created_at: finishedAt,
	});
	const result = createRunResult({
		schema_version: "v1",
		result_type: "run",
		run_id: runId,
		attempt_id: attemptId,
		manifest_sha256: manifest.manifest_sha256,
		terminal_status: terminal.terminalStatus,
		termination_reason: terminal.terminationReason,
		resolved: terminal.resolved,
		started_at: startedAt,
		finished_at: finishedAt,
		wall_time_ms: wallTimeMs,
		usage: resultUsage,
		attempt_sha256: attempt.attempt_sha256,
		patch_snapshot_sha256: patchSnapshot?.snapshot_sha256 ?? null,
		evaluation_result_sha256: evaluation?.evaluation_sha256 ?? null,
		artifact_index_sha256: index.index_sha256,
		failure:
			terminal.failureStage === null || terminal.failureMessage === null
				? null
				: { stage: terminal.failureStage, message: terminal.failureMessage },
	});
	await store.writeNew("result.json", stableStringify(result), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await store.writeNew("artifact-index.json", stableStringify(index), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	return {
		schema_version: "v1",
		summary_type: "m1_run",
		experiment_id: plan.experiment_id,
		run_id: runId,
		attempt_id: attemptId,
		terminal_status: result.terminal_status,
		termination_reason: result.termination_reason,
		resolved: result.resolved,
		run_directory: runDirectory,
		result_sha256: result.result_sha256,
	};
}

export function createDefaultM1RunnerDependencies(controllerUrl: string): M1RunnerDependencies {
	const runtime = createFrozenModelRuntime();
	return {
		controller: new HttpRuntimeController({ controllerUrl }),
		publicTaskSource: new FilePublicTaskSource(),
		environmentLockSource: new FileTaskEnvironmentLockSource(),
		createSession: (options) => createFrozenPiGeneralSession(runtime, options),
		modelSpecSha256: runtime.modelSpecSha256,
		pricingSpecSha256: runtime.pricingSpecSha256,
		now: () => new Date(),
		randomId: () => crypto.randomUUID(),
		sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
		pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
		maxPolls: DEFAULT_MAX_POLLS,
	};
}
