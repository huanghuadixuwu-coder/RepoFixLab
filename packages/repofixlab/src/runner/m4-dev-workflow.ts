import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PiGeneralSessionResult } from "../agent/pi-general.ts";
import {
	runRepoFixWorkflow,
	type ControlledVerificationFeedback,
	type RepoFixSessionResult,
	type StageRecovery,
} from "../agent/repofix.ts";
import {
	createRepoFixConfigurationDiffReport,
	getRepoFixWorkflowConfig,
	type RepoFixConfigId,
} from "../agent/repofix-config.ts";
import type { StageCompletion } from "../agent/repofix-fsm.ts";
import type { RepoToolOutputBudgetSnapshot } from "../sandbox/repo-tools.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import { createPatchSnapshot, type PatchSnapshot } from "../contracts/run-contracts.ts";
import type { RepoToolTransport } from "../controller/client.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import { HttpRuntimeController, type RuntimeController, type RuntimePatchSnapshot } from "./controller-runtime.ts";
import {
	createFrozenModelRuntime,
	createFrozenPiGeneralSession,
	createFrozenRepoFixSession,
	installRunAdmissionGate,
	runtimeIdentityFromSession,
	type FrozenModelRuntime,
} from "./runtime-factory.ts";
import {
	createTokenAdmissionEstimator,
	FsyncTokenLedgerSink,
	installTokenSupervisor,
	TokenReservationLedger,
	type TokenAdmissionEstimatorSpec,
} from "./token-supervisor.ts";
import {
	FilePublicTaskSource,
	FileTaskEnvironmentLockSource,
	type PublicTaskSource,
	type TaskEnvironmentLockSource,
} from "./task-source.ts";

const LOGICAL_AGENT_CWD = "/testbed";
const DEFAULT_PER_RUN_ADMISSION_CAP = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
// RepoFix has six stages. A stage may use eight exploration turns and one
// controller-forced completion turn, so the global safety limit must exceed
// 6 × 9 = 54 to permit the registered workflow to reach SELF_REVIEW.
const FROZEN_MAX_MODEL_TURNS = 64;
const FROZEN_MAX_TOOL_CALLS = 100;
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
	readonly p1_patch_sha256: string | null;
	readonly final_snapshot_id: string | null;
	readonly worker_lease_id: string | null;
	readonly controlled_verification_sha256: string | null;
	/** Present only for the RepoFix configuration; pi-general has no RepoFix context controller. */
	readonly repofix_context_budget?: RepoToolOutputBudgetSnapshot;
}

/** A failure before the first Provider reservation is safe to report without token reconciliation. */
export class M4PreProviderInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "M4PreProviderInputError";
	}
}

function safeMessage(error: unknown): string {
	return (error instanceof Error ? error.message : "Unknown M4 Dev workflow failure").slice(0, 2_000);
}

function jsonSerializable(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function snapshotArtifactPath(label: "P0" | "P1"): string {
	return label === "P0" ? "p0.patch" : "p1.patch";
}

async function persistSnapshot(
	store: ArtifactStore,
	runId: string,
	attemptId: string,
	label: "P0" | "P1",
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
		policy: { status: raw.policy.status, violations: [...raw.policy.violations] },
		created_at: raw.createdAt,
	});
	await store.writeNew(`${label.toLowerCase()}-snapshot.json`, stableStringify(snapshot), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	return snapshot;
}

function toControlledFeedback(
	commandArgv: readonly string[],
	response: Awaited<ReturnType<RepoToolTransport["execute"]>>,
): ControlledVerificationFeedback {
	if (response.tool !== "repo_exec") throw new Error("Controller returned a non-exec result for controlled verification");
	return {
		command_argv: [...commandArgv],
		exit_code: response.result.exit_code,
		timed_out: response.result.timed_out,
		output: ["stdout:", response.result.stdout, "stderr:", response.result.stderr].join("\n"),
	};
}

function assertCap(value: number): void {
	if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_OUTPUT_TOKENS + 1) {
		throw new Error("M4 Dev accounted admission cap must exceed one frozen provider output reservation");
	}
}

function assertModelTurnLimit(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("M4 Dev max model turns must be a positive safe integer");
}

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
	await store.writeNew(`stages/${completion.stage.toLowerCase()}.context-budget.json`, stableStringify(contextBudget), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
}

async function writeStageRecoveryEvidence(store: ArtifactStore, recovery: StageRecovery): Promise<void> {
	await store.writeNew(`stages/${recovery.stage.toLowerCase()}.recovery.json`, stableStringify(recovery), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
}

/**
 * Executes the M4 Dev workflow against one prepared Controller worker. This
 * is deliberately not an official benchmark runner: M5 owns queueing,
 * attempts, official evaluation, recovery, and aggregate reporting.
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
	let p0PatchSha256: string | null = null;
	let p1PatchSha256: string | null = null;
	let finalSnapshotId: string | null = null;
	let controlledVerificationSha256: string | null = null;
	let terminalStatus: "completed" | "failed" = "failed";
	try {
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
			const installSupervisor = (session: PiGeneralSessionResult["session"] | RepoFixSessionResult["session"]): void => {
				installTokenSupervisor(session, {
					ledger,
					run_id: runId,
					max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
					estimate_input_tokens: (context) => estimator.estimate(context),
					estimate_base_input_tokens: (context) => estimator.baseEstimate(context),
					next_request_id: () => `${attemptId}:provider:${String(requestSequence++).padStart(4, "0")}`,
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
					toolCalls: FROZEN_MAX_TOOL_CALLS,
				});
				await piSession.session.prompt(publicTask.task.problem_statement);
			} else {
				const repoFixConfigId = options.configId;
				repoFixSession = await dependencies.createRepoFixSession({
					leaseId,
					attemptDirectory: join(sessionDirectory, "session"),
					cwd: LOGICAL_AGENT_CWD,
					transport,
					configId: repoFixConfigId,
				});
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
					{ mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" },
				);
				installSupervisor(repoFixSession.session);
				installRunAdmissionGate(repoFixSession.session, {
					accountedTokens: null,
					modelTurns: maxModelTurns,
					toolCalls: FROZEN_MAX_TOOL_CALLS,
				});
				await runRepoFixWorkflow(repoFixSession, publicTask.task.problem_statement, {
					onStageComplete: (completion) => {
						if (repoFixSession === null) throw new Error("RepoFix session is unavailable while recording stage evidence");
						return writeStageEvidence(store, completion, repoFixSession.repoToolOutputBudget.snapshot);
					},
					onStageRecovery: (recovery) => writeStageRecoveryEvidence(store, recovery),
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
						else {
							p1PatchSha256 = snapshot.patch_sha256;
							finalSnapshotId = snapshot.snapshot_id;
						}
						return { patch_sha256: snapshot.patch_sha256 };
					},
					controlledVerify: async (plan) => {
						const activeLeaseId = leaseId;
						if (activeLeaseId === null) throw new Error("M4 Dev worker lease disappeared before controlled verification");
						const response = await transport.execute({
							leaseId: activeLeaseId,
							operationId: `${attemptId}:controlled-verify`,
							tool: "repo_exec",
							input: { argv: [...plan.targeted_test_argv], timeout_ms: 120_000 },
						});
						const feedback = toControlledFeedback(plan.targeted_test_argv, response);
						const evidence = {
							schema_version: "v1" as const,
							evidence_type: "controlled_verification",
							command_argv: [...plan.targeted_test_argv],
							result: response.result,
						};
						const artifact = await store.writeNew("controlled-verify.json", stableStringify(evidence), {
							mediaType: "application/json",
							sensitivity: "internal",
							generatedBy: "controller",
						});
						controlledVerificationSha256 = artifact.sha256;
						return feedback;
					},
				});
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
				{ mediaType: "application/json", sensitivity: "internal", generatedBy: "orchestrator" },
			)
			.catch(() => undefined);
	} finally {
		piSession?.session.dispose();
		repoFixSession?.session.dispose();
		if (sessionDirectory !== null) await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
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
		p1_patch_sha256: p1PatchSha256,
		final_snapshot_id: finalSnapshotId,
		worker_lease_id: options.retainWorkerForFormalEvaluation === true && finalSnapshotId !== null ? leaseId : null,
		controlled_verification_sha256: controlledVerificationSha256,
		...(repoFixSession === null ? {} : { repofix_context_budget: repoFixSession.repoToolOutputBudget.snapshot }),
	};
	await store.writeNew("m4-dev-summary.json", stableStringify(summary), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await store.publishTo(runDirectory);
	return summary;
}

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
			}),
		modelSpecSha256: runtime.modelSpecSha256,
		now: () => new Date(),
		randomId: () => crypto.randomUUID(),
	};
}
