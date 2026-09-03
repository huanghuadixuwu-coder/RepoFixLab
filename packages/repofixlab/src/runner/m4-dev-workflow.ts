/**
 * Single-attempt RepoFix and Pi-general execution workflow.
 *
 * This module:
 * - Binds sealed task inputs to a Controller-owned worker.
 * - Creates the selected model session under Orchestrator-owned limits.
 * - Captures patch checkpoints and controlled-verification evidence.
 * - Publishes an immutable attempt directory for later formal evaluation.
 *
 * Trust boundary:
 * - The Orchestrator owns model credentials, session state, budgets, and
 *   artifacts.
 * - The Controller owns trusted Docker, repository, snapshot, and controlled
 *   verification operations and never selects the model or budget.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-ai/compat";
import type { PiGeneralSessionResult } from "../agent/pi-general.ts";
import type { PlanSkillPolicyId } from "../agent/plan-skill.ts";
import {
	type ControlledVerificationFeedback,
	type RepoFixSessionResult,
	type RepoFixTrajectoryEvent,
	runRepoFixWorkflow,
	type StageRecovery,
} from "../agent/repofix.ts";
import {
	createRepoFixConfigurationDiffReport,
	getRepoFixWorkflowConfig,
	type RepoFixConfigId,
} from "../agent/repofix-config.ts";
import type { StageCompletion } from "../agent/repofix-fsm.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import { createLayeredMemoryPolicy, type RepoFixMemoryPolicyId } from "../contracts/memory.ts";
import { createPatchSnapshot, type PatchSnapshot } from "../contracts/run-contracts.ts";
import type { RepoToolTransport } from "../controller/client.ts";
import { RepoFixContextAssembler, type RepoFixMemoryMetrics, RepoFixMemoryRuntime } from "../memory/assembler.ts";
import { RepoFixMemoryStore } from "../memory/store.ts";
import type { RepoToolOutputBudgetSnapshot } from "../sandbox/repo-tools.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import {
	HttpRuntimeController,
	type RuntimeController,
	type RuntimePatchSnapshot,
	type RuntimeVerificationResult,
} from "./controller-runtime.ts";
import {
	createFrozenModelRuntime,
	createFrozenPiGeneralSession,
	createFrozenRepoFixSession,
	type FrozenModelRuntime,
	installRunAdmissionGate,
	runtimeIdentityFromSession,
} from "./runtime-factory.ts";
import {
	FilePublicTaskSource,
	FileTaskEnvironmentLockSource,
	type PublicTaskSource,
	type TaskEnvironmentLockSource,
} from "./task-source.ts";
import {
	createTokenAdmissionEstimator,
	createTokenSupervisedStream,
	FsyncTokenLedgerSink,
	installTokenSupervisor,
	type TokenAdmissionEstimatorSpec,
	TokenReservationLedger,
} from "./token-supervisor.ts";

const LOGICAL_AGENT_CWD = "/testbed";
const DEFAULT_PER_RUN_ADMISSION_CAP = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
// The model-turn ceiling is the run-level termination boundary. RepoFix stage
// checkpoints remain observational so they cannot cut off repository work.
const FROZEN_MAX_MODEL_TURNS = 64;
export const M4_DEV_TOKEN_ESTIMATOR = {
	version: "m4-dev-v1",
	multiplier: 1.25,
	framing_margin_tokens: 512,
} as const;

type PiSessionFactory = (options: {
	readonly leaseId: string;
	readonly attemptDirectory: string;
	readonly cwd: string;
	readonly transport: RepoToolTransport;
}) => Promise<PiGeneralSessionResult>;

type RepoFixSessionFactory = (options: {
	readonly leaseId: string;
	readonly attemptDirectory: string;
	readonly cwd: string;
	readonly transport: RepoToolTransport;
	readonly configId: Exclude<RepoFixConfigId, "pi-general">;
	readonly memory?: RepoFixMemoryRuntime;
	readonly planSkillPolicy?: PlanSkillPolicyId;
}) => Promise<RepoFixSessionResult>;

export interface M4DevWorkflowDependencies {
	readonly controller: RuntimeController;
	readonly publicTaskSource: PublicTaskSource;
	readonly environmentLockSource: TaskEnvironmentLockSource;
	readonly createPiGeneralSession: PiSessionFactory;
	readonly createRepoFixSession: RepoFixSessionFactory;
	readonly modelSpecSha256: string;
	readonly now: () => Date;
	readonly randomId: () => string;
}

export interface M4DevWorkflowOptions {
	readonly artifactsRoot: string;
	readonly instanceId: string;
	readonly configId: RepoFixConfigId;
	readonly accountedAdmissionCapTokens?: number;
	readonly tokenAdmissionEstimator?: TokenAdmissionEstimatorSpec;
	readonly memoryPolicy?: RepoFixMemoryPolicyId;
	readonly planSkillPolicy?: PlanSkillPolicyId;
	/** Formal continuations may raise this uniformly for their own frozen cohort. */
	readonly maxModelTurns?: number;
	/** M7 supplies its immutable logical identities instead of allocating Dev-only IDs. */
	readonly runId?: string;
	readonly attemptId?: string;
	/**
	 * Retain a policy-passing final snapshot for the caller to evaluate in a
	 * fresh Evaluator. This is deliberately opt-in: the Dev workflow continues
	 * to abort its worker by default.
	 */
	readonly retainWorkerForFormalEvaluation?: boolean;
}

export interface M4DevWorkflowSummary {
	readonly schema_version: "v1";
	readonly summary_type: "m4_dev_workflow";
	readonly run_id: string;
	readonly attempt_id: string;
	readonly instance_id: string;
	readonly config_id: RepoFixConfigId;
	readonly terminal_status: "completed" | "failed";
	readonly run_directory: string;
	readonly p0_patch_sha256: string | null;
	readonly v1_patch_sha256: string | null;
	readonly v2_patch_sha256: string | null;
	readonly p1_patch_sha256: string | null;
	readonly final_snapshot_id: string | null;
	readonly worker_lease_id: string | null;
	readonly controlled_verification_sha256: string | null;
	readonly controlled_verification_sha256s: readonly string[];
	/** Present only for the RepoFix configuration; pi-general has no RepoFix context controller. */
	readonly repofix_context_budget?: RepoToolOutputBudgetSnapshot;
	/** Emitted by memory-aware M4 runs; absent from older v1 summaries. */
	readonly memory_policy?: RepoFixMemoryPolicyId;
	readonly plan_skill_policy?: PlanSkillPolicyId;
	readonly plan_skill_sha256?: string | null;
	readonly repofix_memory_metrics?: RepoFixMemoryMetrics;
	readonly agent_wall_ms?: number;
}

/** A failure before the first Provider reservation is safe to report without token reconciliation. */
export class M4PreProviderInputError extends Error {
	/** Mark an input or readiness failure known to occur before Provider admission. */
	constructor(message: string) {
		super(message);
		this.name = "M4PreProviderInputError";
	}
}

/** Convert an unknown failure into a bounded message safe for persisted evidence. */
function safeMessage(error: unknown): string {
	return (error instanceof Error ? error.message : "Unknown M4 Dev workflow failure").slice(0, 2_000);
}

/** Remove non-JSON runtime values before writing a session trajectory. */
function jsonSerializable(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** Map a named patch checkpoint to its immutable artifact filename. */
function snapshotArtifactPath(label: "P0" | "V1" | "V2" | "P1"): string {
	return `${label.toLowerCase()}.patch`;
}

/**
 * Persist raw Controller patch bytes and the hash-bound snapshot contract for
 * one P0, V1, V2, or P1 checkpoint.
 */
async function persistSnapshot(
	store: ArtifactStore,
	runId: string,
	attemptId: string,
	label: "P0" | "V1" | "V2" | "P1",
	raw: RuntimePatchSnapshot,
): Promise<PatchSnapshot> {
	const patch = await store.writeNew(snapshotArtifactPath(label), raw.patch, {
		mediaType: "text/x-diff",
		sensitivity: "internal",
		generatedBy: "controller",
	});
	if (patch.sha256 !== raw.patchSha256) throw new Error(`${label} patch SHA-256 drifted while persisting evidence`);
	const snapshot = createPatchSnapshot({
		schema_version: "v1",
		snapshot_type: "patch",
		snapshot_id: raw.snapshotId,
		run_id: runId,
		attempt_id: attemptId,
		label,
		base_commit: raw.baseCommit,
		base_tree: raw.baseTree,
		candidate_tree: raw.candidateTree,
		patch_sha256: raw.patchSha256,
		patch_bytes: raw.patch.byteLength,
		files: [...raw.files],
		policy: {
			status: raw.policy.status,
			violations: [...raw.policy.violations],
		},
		created_at: raw.createdAt,
	});
	await store.writeNew(`${label.toLowerCase()}-snapshot.json`, stableStringify(snapshot), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	return snapshot;
}

/** Convert a full Controller verification result into bounded model feedback. */
function toControlledFeedback(response: RuntimeVerificationResult): ControlledVerificationFeedback {
	const rawOutput = ["stdout:", response.stdout, "stderr:", response.stderr].join("\n");
	return {
		catalog_id: response.catalogId,
		candidate_id: response.candidateId,
		status: response.status,
		reason_code: response.reasonCode,
		safe_hint: response.safeHint,
		exit_code: response.exitCode,
		timed_out: response.timedOut,
		baseline_status: response.baseline.status,
		baseline_exit_code: response.baseline.exitCode,
		baseline_timed_out: response.baseline.timedOut,
		output: rawOutput.length <= 8 * 1_024 ? rawOutput : rawOutput.slice(-8 * 1_024),
	};
}

/** Validate that the run cap can admit at least one frozen output reservation. */
function assertCap(value: number): void {
	if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_OUTPUT_TOKENS + 1) {
		throw new Error("M4 Dev accounted admission cap must exceed one frozen provider output reservation");
	}
}

/** Validate the run-level model-turn termination limit. */
function assertModelTurnLimit(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error("M4 Dev max model turns must be a positive safe integer");
}

/** Persist a completed RepoFix stage and its repository-output budget snapshot. */
async function writeStageEvidence(
	store: ArtifactStore,
	completion: StageCompletion,
	contextBudget: RepoToolOutputBudgetSnapshot,
): Promise<void> {
	await store.writeNew(`stages/${completion.stage.toLowerCase()}.json`, stableStringify(completion), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "agent",
	});
	await store.writeNew(
		`stages/${completion.stage.toLowerCase()}.context-budget.json`,
		stableStringify(contextBudget),
		{
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		},
	);
}

/** Persist evidence that the workflow recovered a missing stage-completion call. */
async function writeStageRecoveryEvidence(store: ArtifactStore, recovery: StageRecovery): Promise<void> {
	await store.writeNew(`stages/${recovery.stage.toLowerCase()}.recovery.json`, stableStringify(recovery), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
}

/**
 * Execute one Pi-general or RepoFix attempt against a Controller-owned worker.
 *
 * The workflow loads sealed task inputs before Provider admission, prepares
 * and probes the worker, creates the frozen session, supervises token and turn
 * limits, and persists trajectories plus P0/V1/V2/P1 evidence. RepoFix
 * verification uses only Controller-owned catalog operations; the model
 * cannot supply arbitrary verification commands.
 *
 * This is not the official benchmark evaluator. The formal runner owns
 * queueing, retries, final evaluation, recovery, and aggregate reporting.
 */
export async function runM4DevWorkflow(
	options: M4DevWorkflowOptions,
	dependencies: M4DevWorkflowDependencies,
): Promise<M4DevWorkflowSummary> {
	const admissionCap = options.accountedAdmissionCapTokens ?? DEFAULT_PER_RUN_ADMISSION_CAP;
	assertCap(admissionCap);
	const maxModelTurns = options.maxModelTurns ?? FROZEN_MAX_MODEL_TURNS;
	assertModelTurnLimit(maxModelTurns);
	getRepoFixWorkflowConfig(options.configId);
	const memoryPolicyId = options.memoryPolicy ?? "legacy-context-v1";
	const planSkillPolicy = options.planSkillPolicy ?? "disabled";
	if (options.configId === "pi-general" && memoryPolicyId !== "legacy-context-v1") {
		throw new M4PreProviderInputError("Layered RepoFix memory cannot be enabled for pi-general");
	}
	if (options.configId === "pi-general" && planSkillPolicy !== "disabled") {
		throw new M4PreProviderInputError("RepoFix PLAN skill cannot be enabled for pi-general");
	}
	const layeredMemoryPolicy =
		memoryPolicyId === "layered-memory-v1" ? createLayeredMemoryPolicy(dependencies.modelSpecSha256) : null;
	const runId = options.runId ?? `m4-dev-${dependencies.randomId()}`;
	const attemptId = options.attemptId ?? `attempt-${dependencies.randomId()}`;
	let environment: Awaited<ReturnType<TaskEnvironmentLockSource["load"]>>;
	let publicTask: Awaited<ReturnType<PublicTaskSource["load"]>>;
	try {
		environment = await dependencies.environmentLockSource.load(options.instanceId);
		publicTask = await dependencies.publicTaskSource.load(options.instanceId, environment);
		if (publicTask.task.base_commit.length !== 40) throw new Error("Public task base commit is invalid");
	} catch (error) {
		throw new M4PreProviderInputError(safeMessage(error));
	}
	const runDirectory = resolve(options.artifactsRoot, "m4-dev", "runs", runId);
	const stagingDirectory = resolve(options.artifactsRoot, "m4-dev", "runs", `.staging-${runId}`);
	const store = await ArtifactStore.createNew(stagingDirectory);
	let leaseId: string | null = null;
	let workerReleased = false;
	let sessionDirectory: string | null = null;
	let piSession: PiGeneralSessionResult | null = null;
	let repoFixSession: RepoFixSessionResult | null = null;
	let memoryRuntime: RepoFixMemoryRuntime | null = null;
	let p0PatchSha256: string | null = null;
	let v1PatchSha256: string | null = null;
	let v2PatchSha256: string | null = null;
	let p1PatchSha256: string | null = null;
	let finalSnapshotId: string | null = null;
	let controlledVerificationSha256: string | null = null;
	const controlledVerificationSha256s: string[] = [];
	const repofixTrajectoryEvents: RepoFixTrajectoryEvent[] = [];
	let repofixTrajectoryPersisted = false;
	let terminalStatus: "completed" | "failed" = "failed";
	let agentStarted: number | null = null;
	let agentWallMs: number | null = null;
	/** Write the RepoFix control trajectory once after at least one event exists. */
	const persistRepoFixTrajectory = async (): Promise<void> => {
		if (repofixTrajectoryPersisted || repofixTrajectoryEvents.length === 0) return;
		await store.writeNew(
			"repofix-control-trajectory.json",
			stableStringify({
				schema_version: "v1" as const,
				trajectory_type: "repofix_control",
				run_id: runId,
				attempt_id: attemptId,
				instance_id: options.instanceId,
				events: repofixTrajectoryEvents.map((event, index) => ({
					sequence: index + 1,
					...event,
				})),
			}),
			{
				mediaType: "application/json",
				sensitivity: "internal",
				generatedBy: "orchestrator",
			},
		);
		repofixTrajectoryPersisted = true;
	};
	try {
		await store.writeNew(
			"memory-policy.json",
			stableStringify({
				schema_version: "v1",
				memory_policy: memoryPolicyId,
				l3_enabled: false,
			}),
			{
				mediaType: "application/json",
				sensitivity: "internal",
				generatedBy: "orchestrator",
			},
		);
		await store.writeNew("public-task.json", stableStringify(publicTask.manifest), {
			mediaType: "application/json",
			sensitivity: "public",
			generatedBy: "orchestrator",
		});
		await store.writeNew("public-task-record.json", publicTask.recordBytes, {
			mediaType: "application/json",
			sensitivity: "public",
			generatedBy: "orchestrator",
		});
		await store.writeNew("task-environment-lock.json", environment.lockBytes, {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		const preflight = await dependencies.controller.preflight(
			attemptId,
			`${attemptId}:preflight`,
			environment.candidateId,
			options.instanceId,
		);
		if (
			preflight.task_environment_lock_id !== environment.lockId ||
			preflight.task_environment_lock_sha256 !== environment.lockSha256 ||
			preflight.candidate_sha256 !== environment.candidateSha256 ||
			preflight.base_commit !== publicTask.task.base_commit
		) {
			throw new Error("Controller preflight binding differs from M4 Dev task inputs");
		}
		await store.writeNew("controller-preflight.json", stableStringify(preflight), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "controller",
		});
		leaseId = (
			await dependencies.controller.prepare(
				attemptId,
				`${attemptId}:prepare`,
				environment.candidateId,
				options.instanceId,
			)
		).leaseId;
		const transport = dependencies.controller.toolTransport(attemptId);
		try {
			const probe = await transport.execute({
				leaseId,
				operationId: `${attemptId}:worker-probe`,
				tool: "repo_list",
				input: {},
			});
			if (probe.tool !== "repo_list") throw new Error("Controller worker probe returned the wrong tool result");
			await store.writeNew(
				"controller-worker-probe.json",
				stableStringify({
					schema_version: "v1",
					evidence_type: "controller_worker_probe",
					attempt_id: attemptId,
					lease_id: leaseId,
					tool: probe.tool,
					status: "ready",
				}),
				{
					mediaType: "application/json",
					sensitivity: "internal",
					generatedBy: "controller",
				},
			);
		} catch (error) {
			throw new M4PreProviderInputError(`Controller worker probe failed: ${safeMessage(error)}`);
		}
		sessionDirectory = await mkdtemp(join(tmpdir(), "repofixlab-m4-dev-"));
		const ledgerPath = store.resolvePath("token-ledger.jsonl");
		const ledgerSink = new FsyncTokenLedgerSink(ledgerPath);
		try {
			const ledger = new TokenReservationLedger(
				{
					per_run_accounted_cap_tokens: admissionCap,
					project_accounted_cap_tokens: admissionCap,
				},
				ledgerSink,
			);
			const estimator = createTokenAdmissionEstimator(options.tokenAdmissionEstimator ?? M4_DEV_TOKEN_ESTIMATOR);
			let requestSequence = 0;
			/** Install reservation-based Provider admission on the active Pi session. */
			const installSupervisor = (
				session: PiGeneralSessionResult["session"] | RepoFixSessionResult["session"],
				prepareContext?: (context: Context, requestId: string) => Promise<Context>,
				stageId?: () => string | null,
				onRequestId?: (requestId: string) => void,
			): void => {
				installTokenSupervisor(session, {
					ledger,
					run_id: runId,
					max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
					estimate_input_tokens:
						layeredMemoryPolicy === null
							? (context) => estimator.estimate(context)
							: () => layeredMemoryPolicy.context_window - DEFAULT_MAX_OUTPUT_TOKENS,
					estimate_base_input_tokens: (context) => estimator.baseEstimate(context),
					next_request_id: () => `${attemptId}:provider:${String(requestSequence++).padStart(4, "0")}`,
					request_kind: "agent",
					stage_id: stageId,
					prepare_context: prepareContext,
					on_request_id: onRequestId,
				});
			};
			if (options.configId === "pi-general") {
				piSession = await dependencies.createPiGeneralSession({
					leaseId,
					attemptDirectory: join(sessionDirectory, "session"),
					cwd: LOGICAL_AGENT_CWD,
					transport,
				});
				installSupervisor(piSession.session);
				installRunAdmissionGate(piSession.session, {
					accountedTokens: null,
					modelTurns: maxModelTurns,
					toolCalls: null,
				});
				agentStarted = performance.now();
				await piSession.session.prompt(publicTask.task.problem_statement);
			} else {
				const repoFixConfigId = options.configId;
				const loadVerificationCatalog = dependencies.controller.verificationCatalog?.bind(dependencies.controller);
				const runCatalogVerification = dependencies.controller.verifyCatalogEntry?.bind(dependencies.controller);
				if (loadVerificationCatalog === undefined || runCatalogVerification === undefined) {
					throw new Error("Controller does not implement the R2 verification catalog contract");
				}
				const verificationCatalog = await loadVerificationCatalog(
					attemptId,
					`${attemptId}:verification-catalog`,
					leaseId,
				);
				await store.writeNew(
					"verification-catalog.json",
					stableStringify({
						schema_version: "v2" as const,
						evidence_type: "verification_catalog",
						catalog_id: verificationCatalog.catalogId,
						source_sha256: verificationCatalog.sourceSha256,
						entries: verificationCatalog.entries.map((entry) => ({
							candidate_id: entry.candidateId,
							description: entry.description,
						})),
					}),
					{
						mediaType: "application/json",
						sensitivity: "internal",
						generatedBy: "controller",
					},
				);
				if (layeredMemoryPolicy !== null) {
					const memoryStore = new RepoFixMemoryStore(store, options.instanceId, attemptId);
					memoryRuntime = new RepoFixMemoryRuntime(
						memoryStore,
						new RepoFixContextAssembler(memoryStore, layeredMemoryPolicy),
					);
					await memoryRuntime.initialize(publicTask.task.problem_statement);
				}
				repoFixSession = await dependencies.createRepoFixSession({
					leaseId,
					attemptDirectory: join(sessionDirectory, "session"),
					cwd: LOGICAL_AGENT_CWD,
					transport,
					configId: repoFixConfigId,
					memory: memoryRuntime ?? undefined,
					planSkillPolicy,
				});
				if (memoryRuntime !== null && layeredMemoryPolicy !== null) {
					const activeLayeredMemoryPolicy = layeredMemoryPolicy;
					const activeRepoFixSession = repoFixSession;
					const model = activeRepoFixSession.session.model;
					if (model === undefined) throw new Error("RepoFix memory condenser requires the active frozen model");
					memoryRuntime.setCondenser(async (request) => {
						const stream = createTokenSupervisedStream(activeRepoFixSession.providerStream, {
							ledger,
							run_id: runId,
							max_output_tokens: request.summary_max_tokens,
							estimate_input_tokens: () => activeLayeredMemoryPolicy.context_window - request.summary_max_tokens,
							estimate_base_input_tokens: (context) => estimator.baseEstimate(context),
							next_request_id: () => `${attemptId}:provider:${String(requestSequence++).padStart(4, "0")}`,
							request_kind: "condenser",
							stage_id: request.stage_id,
						});
						const output = await stream(model, request.context, {
							maxTokens: request.summary_max_tokens,
						});
						const message = await output.result();
						if (message.stopReason === "error" || message.stopReason === "aborted") {
							throw new Error(message.errorMessage ?? "Condenser Provider request failed");
						}
						if (message.content.some((item) => item.type === "toolCall")) {
							throw new Error("Condenser returned a tool call");
						}
						const summary = message.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n")
							.trim();
						if (summary.length === 0) throw new Error("Condenser returned no summary text");
						return summary;
					});
				}
				const identity = runtimeIdentityFromSession(repoFixSession.session, dependencies.modelSpecSha256);
				await store.writeNew(
					"configuration-diff.json",
					stableStringify(
						createRepoFixConfigurationDiffReport({
							model_spec_sha256: identity.modelSpecSha256,
							system_prompt_sha256: identity.systemPromptSha256,
							tool_schema_sha256: identity.toolSchemaSha256,
						}),
					),
					{
						mediaType: "application/json",
						sensitivity: "internal",
						generatedBy: "orchestrator",
					},
				);
				installSupervisor(
					repoFixSession.session,
					repoFixSession.prepareProviderContext,
					() => repoFixSession?.stageMachine.activeStage ?? null,
					(requestId) => repoFixSession?.stageCompletionControl.setProviderRequestId(requestId),
				);
				installRunAdmissionGate(repoFixSession.session, {
					accountedTokens: null,
					modelTurns: maxModelTurns,
					toolCalls: null,
				});
				agentStarted = performance.now();
				await runRepoFixWorkflow(repoFixSession, publicTask.task.problem_statement, {
					verificationCatalog: {
						catalog_id: verificationCatalog.catalogId,
						candidates: verificationCatalog.entries.map((entry) => ({
							candidate_id: entry.candidateId,
							description: entry.description,
						})),
					},
					onStageComplete: (completion) => {
						if (repoFixSession === null)
							throw new Error("RepoFix session is unavailable while recording stage evidence");
						return writeStageEvidence(store, completion, repoFixSession.repoToolOutputBudget.snapshot);
					},
					onStageRecovery: (recovery) => writeStageRecoveryEvidence(store, recovery),
					onTrajectoryEvent: async (event) => {
						repofixTrajectoryEvents.push(event);
					},
					capturePatch: async (checkpoint) => {
						const activeLeaseId = leaseId;
						if (activeLeaseId === null) throw new Error("M4 Dev worker lease disappeared before snapshot");
						const snapshot = await persistSnapshot(
							store,
							runId,
							attemptId,
							checkpoint,
							await dependencies.controller.snapshot(
								attemptId,
								`${attemptId}:${checkpoint.toLowerCase()}-snapshot`,
								activeLeaseId,
							),
						);
						if (checkpoint === "P0") p0PatchSha256 = snapshot.patch_sha256;
						else if (checkpoint === "V1") v1PatchSha256 = snapshot.patch_sha256;
						else if (checkpoint === "V2") v2PatchSha256 = snapshot.patch_sha256;
						else {
							p1PatchSha256 = snapshot.patch_sha256;
							finalSnapshotId = snapshot.snapshot_id;
						}
						return { patch_sha256: snapshot.patch_sha256 };
					},
					controlledVerify: async (plan, checkpoint) => {
						const activeLeaseId = leaseId;
						if (activeLeaseId === null)
							throw new Error("M4 Dev worker lease disappeared before controlled verification");
						const response = await runCatalogVerification(
							attemptId,
							`${attemptId}:controlled-verify-${checkpoint.toLowerCase()}`,
							activeLeaseId,
							verificationCatalog.catalogId,
							plan.verification_candidate_id,
						);
						const feedback = toControlledFeedback(response);
						const evidence = {
							schema_version: "v2" as const,
							evidence_type: "controlled_verification",
							checkpoint,
							catalog_id: verificationCatalog.catalogId,
							candidate_id: plan.verification_candidate_id,
							result: {
								catalog_id: response.catalogId,
								candidate_id: response.candidateId,
								status: response.status,
								reason_code: response.reasonCode,
								safe_hint: response.safeHint,
								exit_code: response.exitCode,
								stdout: response.stdout,
								stderr: response.stderr,
								truncated: response.truncated,
								timed_out: response.timedOut,
								duration_ms: response.durationMs,
								baseline: {
									status: response.baseline.status,
									reason_code: response.baseline.reasonCode,
									safe_hint: response.baseline.safeHint,
									exit_code: response.baseline.exitCode,
									stdout: response.baseline.stdout,
									stderr: response.baseline.stderr,
									truncated: response.baseline.truncated,
									timed_out: response.baseline.timedOut,
									duration_ms: response.baseline.durationMs,
								},
							},
						};
						const artifact = await store.writeNew(
							`controlled-verify-${checkpoint.toLowerCase()}.json`,
							stableStringify(evidence),
							{
								mediaType: "application/json",
								sensitivity: "internal",
								generatedBy: "controller",
							},
						);
						if (checkpoint === "V0") controlledVerificationSha256 = artifact.sha256;
						controlledVerificationSha256s.push(artifact.sha256);
						return feedback;
					},
				});
				await persistRepoFixTrajectory();
			}
			if (options.retainWorkerForFormalEvaluation && finalSnapshotId === null) {
				const activeLeaseId = leaseId;
				if (activeLeaseId === null) throw new Error("M4 Dev worker lease disappeared before final snapshot");
				const snapshot = await persistSnapshot(
					store,
					runId,
					attemptId,
					"P1",
					await dependencies.controller.snapshot(attemptId, `${attemptId}:final-snapshot`, activeLeaseId),
				);
				p1PatchSha256 = snapshot.patch_sha256;
				finalSnapshotId = snapshot.snapshot_id;
			}
		} finally {
			ledgerSink.close();
		}
		await store.registerClosedFile("token-ledger.jsonl", {
			mediaType: "application/x-ndjson",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		const completedSession = repoFixSession?.session ?? piSession?.session;
		if (completedSession === undefined) throw new Error("M4 Dev session was not created");
		await store.writeNew("trajectory.json", stableStringify(jsonSerializable(completedSession.messages)), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "agent",
		});
		terminalStatus = "completed";
	} catch (error) {
		await persistRepoFixTrajectory().catch(() => undefined);
		const failedSession = repoFixSession?.session ?? piSession?.session;
		if (failedSession !== undefined) {
			await store
				.writeNew("failed-trajectory.json", stableStringify(jsonSerializable(failedSession.messages)), {
					mediaType: "application/json",
					sensitivity: "internal",
					generatedBy: "agent",
				})
				.catch(() => undefined);
		}
		await store
			.writeNew(
				"error.json",
				stableStringify({
					schema_version: "v1",
					error_type: "m4_dev_workflow_failure",
					message: safeMessage(error),
					at: dependencies.now().toISOString(),
				}),
				{
					mediaType: "application/json",
					sensitivity: "internal",
					generatedBy: "orchestrator",
				},
			)
			.catch(() => undefined);
	} finally {
		if (agentStarted !== null && agentWallMs === null) {
			agentWallMs = Math.max(0, Math.ceil(performance.now() - agentStarted));
		}
		piSession?.session.dispose();
		repoFixSession?.session.dispose();
		if (sessionDirectory !== null)
			await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
		const retainForFormalEvaluation =
			options.retainWorkerForFormalEvaluation === true &&
			terminalStatus === "completed" &&
			leaseId !== null &&
			finalSnapshotId !== null;
		if (leaseId !== null && !retainForFormalEvaluation) {
			// M4 is a Dev-only workflow: P0/P1 evidence is already persisted locally
			// and no official evaluation follows. destroy() intentionally retains a
			// policy-passing snapshot for M5 evaluation, so abort() is the correct
			// terminal cleanup operation here and releases the single controller slot.
			try {
				workerReleased = (await dependencies.controller.abort(attemptId, `${attemptId}:abort`)).clean;
			} catch {
				workerReleased = false;
			}
		}
		if (retainForFormalEvaluation) workerReleased = true;
	}
	if (!workerReleased) terminalStatus = "failed";
	const summary: M4DevWorkflowSummary = {
		schema_version: "v1",
		summary_type: "m4_dev_workflow",
		run_id: runId,
		attempt_id: attemptId,
		instance_id: options.instanceId,
		config_id: options.configId,
		terminal_status: terminalStatus,
		run_directory: runDirectory,
		p0_patch_sha256: p0PatchSha256,
		v1_patch_sha256: v1PatchSha256,
		v2_patch_sha256: v2PatchSha256,
		p1_patch_sha256: p1PatchSha256,
		final_snapshot_id: finalSnapshotId,
		worker_lease_id: options.retainWorkerForFormalEvaluation === true && finalSnapshotId !== null ? leaseId : null,
		controlled_verification_sha256: controlledVerificationSha256,
		controlled_verification_sha256s: controlledVerificationSha256s,
		memory_policy: memoryPolicyId,
		plan_skill_policy: planSkillPolicy,
		plan_skill_sha256: repoFixSession?.planSkill?.sha256 ?? null,
		...(agentWallMs === null ? {} : { agent_wall_ms: agentWallMs }),
		...(repoFixSession === null
			? {}
			: {
					repofix_context_budget: repoFixSession.repoToolOutputBudget.snapshot,
				}),
		...(memoryRuntime === null ? {} : { repofix_memory_metrics: memoryRuntime.metrics }),
	};
	if (memoryRuntime !== null) {
		await store.writeNew("memory-metrics.json", stableStringify(memoryRuntime.metrics), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
	}
	await store.writeNew("m4-dev-summary.json", stableStringify(summary), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await store.publishTo(runDirectory);
	return summary;
}

/**
 * Construct production Controller, task-source, and frozen-session
 * dependencies while keeping Provider credentials inside the Orchestrator.
 */
export function createDefaultM4DevWorkflowDependencies(
	controllerUrl: string,
	runtime: FrozenModelRuntime = createFrozenModelRuntime(),
): M4DevWorkflowDependencies {
	return {
		controller: new HttpRuntimeController({ controllerUrl }),
		publicTaskSource: new FilePublicTaskSource(),
		environmentLockSource: new FileTaskEnvironmentLockSource(),
		createPiGeneralSession: (options) => createFrozenPiGeneralSession(runtime, options),
		createRepoFixSession: (options) =>
			createFrozenRepoFixSession(runtime, {
				leaseId: options.leaseId,
				attemptDirectory: options.attemptDirectory,
				cwd: options.cwd,
				transport: options.transport,
				config: getRepoFixWorkflowConfig(options.configId),
				memory: options.memory,
				planSkillPolicy: options.planSkillPolicy,
			}),
		modelSpecSha256: runtime.modelSpecSha256,
		now: () => new Date(),
		randomId: () => crypto.randomUUID(),
	};
}
