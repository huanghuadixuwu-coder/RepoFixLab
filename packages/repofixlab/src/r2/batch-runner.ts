import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExperimentPlan } from "../contracts/experiment-plan.ts";
import {
	verifyEvaluationResult,
	verifyRunManifest,
	verifyRunResult,
} from "../contracts/run-contracts.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import { createBatchRunSpecs, executeBatch, type BatchExecutionSummary } from "../runner/batch-runner.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";
import { createDefaultM7FormalRunDependencies, runM7FormalRun } from "../m7/formal-runner.ts";

export const R2_PROTOCOL_REVISION = "repofixlab-r2-v6";
export const R2_ARTIFACT_DIRECTORY = "r2-v6";
export const R2_PER_RUN_ADMISSION_CAP_TOKENS = 5_000_000;
export const R2_MAX_MODEL_TURNS = 128;
export const R2_TASK_COUNT = 26;
export const R2_FULL_MATRIX_RUN_COUNT = 78;
export const R2_COMPLETED_FULL_INSTANCE_IDS = ["immutable-js__immutable-js-2005"] as const;
export const R2_CONTROLLER_IDENTITY_RECOVERY_INSTANCE_IDS = [
	"mrdoob__three.js-26589",
	"preactjs__preact-4245",
	"preactjs__preact-4316",
] as const;
export const R2_SEMANTIC_WORKFLOW_REMEDIATION_INSTANCE_IDS = [
	"preactjs__preact-3062",
	"preactjs__preact-3345",
	"preactjs__preact-3567",
	"preactjs__preact-4316",
] as const;
export const R2_SEMANTIC_WORKFLOW_FOLLOWUP_INSTANCE_IDS = [
	"preactjs__preact-3345",
	"preactjs__preact-3567",
	"preactjs__preact-4316",
] as const;
export const R2_SELF_REVIEW_RECOVERY_INSTANCE_IDS = ["preactjs__preact-3345"] as const;

export const R2_PHASES = ["full", "no-localize", "no-verify-feedback"] as const;
export type R2Phase = (typeof R2_PHASES)[number];
export const R2_RECOVERY_COHORTS = [
	"controller-identity-3",
	"semantic-workflow-4",
	"semantic-workflow-followup-3",
	"self-review-recovery-3345-1",
] as const;
export type R2RecoveryCohort = (typeof R2_RECOVERY_COHORTS)[number];

const R2_EXECUTION_ARTIFACT_DIRECTORY_PATTERN = /^r2-v6(?:-[a-z0-9]+)*$/;
const R2_IMMUTABLE_TARGET_SOURCE_RUN_ID = "r2-immutable-2005-target-r3-v3";

const PHASE_CONFIG: Readonly<Record<R2Phase, BatchRunSpec["config_id"]>> = {
	full: "repofix-full",
	"no-localize": "repofix-no-localize",
	"no-verify-feedback": "repofix-no-verify-feedback",
};

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function r2PhaseFromEnvironment(environment: NodeJS.ProcessEnv = process.env): R2Phase {
	const value = environment.REPOFIX_R2_PHASE ?? "full";
	if ((R2_PHASES as readonly string[]).includes(value)) return value as R2Phase;
	throw new Error("REPOFIX_R2_PHASE must be full, no-localize, or no-verify-feedback");
}

export function r2RecoveryCohortFromEnvironment(environment: NodeJS.ProcessEnv = process.env): R2RecoveryCohort | null {
	const value = environment.REPOFIX_R2_RECOVERY_COHORT;
	if (value === undefined || value.length === 0) return null;
	if ((R2_RECOVERY_COHORTS as readonly string[]).includes(value)) return value as R2RecoveryCohort;
	throw new Error("REPOFIX_R2_RECOVERY_COHORT must name a supported targeted recovery cohort when set");
}

/**
 * An execution root isolates repaired reruns from immutable historical
 * artifacts. It changes storage only: the frozen plan and logical run IDs
 * remain bound to the R2 protocol.
 */
export function r2ExecutionArtifactDirectoryFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
	const value = environment.REPOFIX_R2_EXECUTION_ARTIFACT_DIRECTORY ?? R2_ARTIFACT_DIRECTORY;
	if (R2_EXECUTION_ARTIFACT_DIRECTORY_PATTERN.test(value)) return value;
	throw new Error("REPOFIX_R2_EXECUTION_ARTIFACT_DIRECTORY must be r2-v6 or an r2-v6-* lowercase suffix");
}

function assertR2Plan(plan: ExperimentPlan): asserts plan is ExperimentPlan & {
	readonly task_selection: Extract<ExperimentPlan["task_selection"], { readonly status: "frozen" }>;
} {
	if (
		plan.experiment_id !== R2_PROTOCOL_REVISION ||
		plan.runtime_status !== "m7_formal_available" ||
		plan.task_selection.status !== "frozen" ||
		plan.task_selection.declared_task_count !== R2_TASK_COUNT ||
		plan.budget.per_run_accounted_admission_cap_tokens !== R2_PER_RUN_ADMISSION_CAP_TOKENS ||
		plan.budget.total_accounted_admission_cap_tokens !== R2_FULL_MATRIX_RUN_COUNT * R2_PER_RUN_ADMISSION_CAP_TOKENS ||
		plan.matrix.length !== 1
	) {
		throw new Error("R2 plan binding is invalid");
	}
	const [group] = plan.matrix;
	if (
		group === undefined ||
		group.group_id !== "posthoc-diagnostic" ||
		group.task_count !== R2_TASK_COUNT ||
		!sameOrderedValues(group.config_ids, ["repofix-full", "repofix-no-localize", "repofix-no-verify-feedback"]) ||
		group.replicates !== 1
	) {
		throw new Error("R2 frozen matrix is invalid");
	}
}

export function createR2RunSpecs(plan: ExperimentPlan, phase: R2Phase): readonly BatchRunSpec[] {
	assertR2Plan(plan);
	const all = createBatchRunSpecs(plan, [
		{ group_id: "posthoc-diagnostic", instance_ids: plan.task_selection.instance_ids },
	]);
	if (all.length !== R2_FULL_MATRIX_RUN_COUNT) throw new Error("R2 frozen matrix must contain exactly 78 logical runs");
	const selected = all.filter((spec) => spec.config_id === PHASE_CONFIG[phase]);
	if (selected.length !== R2_TASK_COUNT) throw new Error(`R2 ${phase} phase must contain exactly 26 logical runs`);
	return selected;
}

/**
 * A completed targeted result is retained as an immutable reference rather
 * than relabelled with a new logical run ID. Only the remaining Full tasks
 * receive new Provider execution in this continuation.
 */
export function createR2PendingRunSpecs(plan: ExperimentPlan, phase: R2Phase): readonly BatchRunSpec[] {
	const specs = createR2RunSpecs(plan, phase);
	if (phase !== "full") return specs;
	const completed = new Set<string>(R2_COMPLETED_FULL_INSTANCE_IDS);
	const pending = specs.filter((spec) => !completed.has(spec.instance_id));
	if (pending.length !== R2_TASK_COUNT - completed.size) {
		throw new Error("R2 Full continuation did not exclude exactly the independently completed target");
	}
	return pending;
}

/**
 * The only permitted R2 repair cohort. These runs are recorded separately
 * from the original Full batch because its three results were invalidated by
 * Controller identity reuse, not by a model decision.
 */
export function createR2ControllerIdentityRecoverySpecs(plan: ExperimentPlan): readonly BatchRunSpec[] {
	const full = createR2RunSpecs(plan, "full");
	const selected = full.filter((spec) => R2_CONTROLLER_IDENTITY_RECOVERY_INSTANCE_IDS.includes(
		spec.instance_id as (typeof R2_CONTROLLER_IDENTITY_RECOVERY_INSTANCE_IDS)[number],
	));
	if (selected.length !== R2_CONTROLLER_IDENTITY_RECOVERY_INSTANCE_IDS.length) {
		throw new Error("R2 Controller identity recovery cohort binding is invalid");
	}
	if (
		!sameOrderedValues(
			selected.map((spec) => spec.instance_id),
			R2_CONTROLLER_IDENTITY_RECOVERY_INSTANCE_IDS,
		)
	) {
		throw new Error("R2 Controller identity recovery cohort ordering drifted");
	}
	return selected;
}

/**
 * The four official unresolved outcomes with valid evaluator evidence are a
 * workflow-remediation cohort. It is intentionally separate from the three
 * Controller identity failures: no historical result is invalidated or
 * overwritten by this targeted rerun.
 */
export function createR2SemanticWorkflowRemediationSpecs(plan: ExperimentPlan): readonly BatchRunSpec[] {
	const full = createR2RunSpecs(plan, "full");
	const selected = full.filter((spec) => R2_SEMANTIC_WORKFLOW_REMEDIATION_INSTANCE_IDS.includes(
		spec.instance_id as (typeof R2_SEMANTIC_WORKFLOW_REMEDIATION_INSTANCE_IDS)[number],
	));
	if (selected.length !== R2_SEMANTIC_WORKFLOW_REMEDIATION_INSTANCE_IDS.length) {
		throw new Error("R2 semantic workflow remediation cohort binding is invalid");
	}
	if (
		!sameOrderedValues(
			selected.map((spec) => spec.instance_id),
			R2_SEMANTIC_WORKFLOW_REMEDIATION_INSTANCE_IDS,
		)
	) {
		throw new Error("R2 semantic workflow remediation cohort ordering drifted");
	}
	return selected;
}

/**
 * This follow-up is intentionally restricted to the three valid official
 * unresolved semantic cases after the four-task remediation cohort. The
 * resolved preact-3062 run remains immutable evidence and is not rerun.
 */
export function createR2SemanticWorkflowFollowupSpecs(plan: ExperimentPlan): readonly BatchRunSpec[] {
	const full = createR2RunSpecs(plan, "full");
	const selected = full.filter((spec) => R2_SEMANTIC_WORKFLOW_FOLLOWUP_INSTANCE_IDS.includes(
		spec.instance_id as (typeof R2_SEMANTIC_WORKFLOW_FOLLOWUP_INSTANCE_IDS)[number],
	));
	if (selected.length !== R2_SEMANTIC_WORKFLOW_FOLLOWUP_INSTANCE_IDS.length) {
		throw new Error("R2 semantic workflow follow-up cohort binding is invalid");
	}
	if (
		!sameOrderedValues(
			selected.map((spec) => spec.instance_id),
			R2_SEMANTIC_WORKFLOW_FOLLOWUP_INSTANCE_IDS,
		)
	) {
		throw new Error("R2 semantic workflow follow-up cohort ordering drifted");
	}
	return selected;
}

/**
 * A single-task rerun isolates the self-review completion-contract repair
 * without mutating the prior three-task follow-up evidence.
 */
export function createR2SelfReviewRecoverySpecs(plan: ExperimentPlan): readonly BatchRunSpec[] {
	const full = createR2RunSpecs(plan, "full");
	const selected = full.filter((spec) => R2_SELF_REVIEW_RECOVERY_INSTANCE_IDS.includes(
		spec.instance_id as (typeof R2_SELF_REVIEW_RECOVERY_INSTANCE_IDS)[number],
	));
	if (selected.length !== R2_SELF_REVIEW_RECOVERY_INSTANCE_IDS.length) {
		throw new Error("R2 self-review recovery cohort binding is invalid");
	}
	if (!sameOrderedValues(selected.map((spec) => spec.instance_id), R2_SELF_REVIEW_RECOVERY_INSTANCE_IDS)) {
		throw new Error("R2 self-review recovery cohort ordering drifted");
	}
	return selected;
}

async function writeImmutable(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporary, path);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		const existing = await readFile(path, "utf8");
		if (existing !== content) throw new Error(`Immutable artifact conflict: ${path}`);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

async function writeR2CompletedTargetReference(
	artifactsRoot: string,
	root: string,
	fullSpecs: readonly BatchRunSpec[],
): Promise<void> {
	const instanceId = R2_COMPLETED_FULL_INSTANCE_IDS[0];
	if (instanceId === undefined) throw new Error("R2 completed target list is empty");
	const logicalRun = fullSpecs.find((spec) => spec.instance_id === instanceId);
	if (logicalRun === undefined) throw new Error("R2 completed target is not in the frozen Full task set");
	const sourceRoot = join(artifactsRoot, R2_ARTIFACT_DIRECTORY, "runs", R2_IMMUTABLE_TARGET_SOURCE_RUN_ID);
	const [sourceResultValue, sourceManifestValue, sourceEvaluationValue] = await Promise.all([
		readFile(join(sourceRoot, "result.json"), "utf8"),
		readFile(join(sourceRoot, "run.json"), "utf8"),
		readFile(join(sourceRoot, "evaluation-normalized.json"), "utf8"),
	]);
	const sourceResult = verifyRunResult(JSON.parse(sourceResultValue) as unknown);
	const sourceManifest = verifyRunManifest(JSON.parse(sourceManifestValue) as unknown);
	const sourceEvaluation = verifyEvaluationResult(JSON.parse(sourceEvaluationValue) as unknown);
	if (
		sourceManifest.experiment_id !== R2_PROTOCOL_REVISION ||
		sourceManifest.config_id !== "repofix-full" ||
		sourceManifest.instance_id !== instanceId ||
		sourceManifest.replicate !== logicalRun.replicate ||
		sourceManifest.budget.max_model_turns !== R2_MAX_MODEL_TURNS ||
		sourceManifest.budget.max_tool_calls !== null ||
		sourceResult.run_id !== R2_IMMUTABLE_TARGET_SOURCE_RUN_ID ||
		sourceResult.manifest_sha256 !== sourceManifest.manifest_sha256 ||
		sourceResult.terminal_status !== "completed" ||
		!sourceResult.resolved ||
		sourceResult.evaluation_result_sha256 !== sourceEvaluation.evaluation_sha256 ||
		sourceEvaluation.run_id !== R2_IMMUTABLE_TARGET_SOURCE_RUN_ID ||
		sourceEvaluation.instance_id !== instanceId ||
		!sourceEvaluation.resolved
	) {
		throw new Error("R2 completed target reference does not bind to the valid immutable-js official result");
	}
	await writeImmutable(
		join(root, "completed-targets.json"),
		stableStringify({
			schema_version: "v1",
			record_type: "r2_completed_target_reference",
			completion_status: "completed",
			logical_run: logicalRun,
			source: {
				run_id: sourceResult.run_id,
				artifact_root: join(R2_ARTIFACT_DIRECTORY, "runs", R2_IMMUTABLE_TARGET_SOURCE_RUN_ID),
				result_sha256: sourceResult.result_sha256,
				manifest_sha256: sourceManifest.manifest_sha256,
				evaluation_sha256: sourceEvaluation.evaluation_sha256,
			},
			inclusion: "carried_forward_targeted_evidence_not_direct_batch_result",
		}),
	);
}

async function writeR2ControllerIdentityRecoveryDeclaration(
	root: string,
	specs: readonly BatchRunSpec[],
): Promise<void> {
	await writeImmutable(
		join(root, "recovery-cohort.json"),
		stableStringify({
			schema_version: "v1",
			record_type: "r2_controller_identity_recovery",
			cohort: "controller-identity-3",
			logical_runs: specs,
			supersedes: {
				execution_artifact_directory: "r2-v6-r3",
				phase: "full",
				classification: "infrastructure_failure",
				reason: "controller_durable_operation_identity_reused_across_executions",
			},
			result_handling: "report_separately_then_substitute_only_in_a_labelled_corrected_r2_full_aggregate",
		}),
	);
}

async function writeR2SemanticWorkflowRemediationDeclaration(
	root: string,
	specs: readonly BatchRunSpec[],
): Promise<void> {
	await writeImmutable(
		join(root, "recovery-cohort.json"),
		stableStringify({
			schema_version: "v1",
			record_type: "r2_semantic_workflow_remediation",
			cohort: "semantic-workflow-4",
			logical_runs: specs,
			prior_evidence: {
				execution_artifact_directories: ["r2-v6-r3", "r2-v6-r4"],
				classification: "official_unresolved_with_valid_evaluation",
				instances: R2_SEMANTIC_WORKFLOW_REMEDIATION_INSTANCE_IDS,
			},
			result_handling: "report_separately_as_targeted_workflow_remediation; never overwrite_or_relabel_prior_r2_results",
		}),
	);
}

async function writeR2SemanticWorkflowFollowupDeclaration(
	root: string,
	specs: readonly BatchRunSpec[],
): Promise<void> {
	await writeImmutable(
		join(root, "recovery-cohort.json"),
		stableStringify({
			schema_version: "v1",
			record_type: "r2_semantic_workflow_followup",
			cohort: "semantic-workflow-followup-3",
			logical_runs: specs,
			prior_evidence: {
				execution_artifact_directories: ["r2-v6-r3", "r2-v6-r4", "r2-v6-r5"],
				classification: "official_unresolved_after_semantic_workflow_remediation",
				instances: R2_SEMANTIC_WORKFLOW_FOLLOWUP_INSTANCE_IDS,
			},
			result_handling: "report_separately_as_targeted_workflow_followup; never overwrite_or_relabel_prior_r2_results",
		}),
	);
}

async function writeR2SelfReviewRecoveryDeclaration(
	root: string,
	specs: readonly BatchRunSpec[],
): Promise<void> {
	await writeImmutable(
		join(root, "recovery-cohort.json"),
		stableStringify({
			schema_version: "v1",
			record_type: "r2_self_review_recovery",
			cohort: "self-review-recovery-3345-1",
			logical_runs: specs,
			prior_evidence: {
				execution_artifact_directories: ["r2-v6-r9", "r2-v6-r10", "r2-v6-r11"],
				classification: "workflow_completion_contract_recovery_after_schema_feedback_repair",
				instances: R2_SELF_REVIEW_RECOVERY_INSTANCE_IDS,
				failure_reason: "self_review_omitted_plan_invariant_is_recoverable; r10_plan_id_pattern_rejection_lacked_field_feedback; r11_completion_retry_was_short_circuited_after_budget_stop",
			},
			result_handling: "report_separately_as_single_task_workflow_recovery; never overwrite_or_relabel_prior_r2_results",
		}),
	);
}

export async function runR2Batch(
	plan: ExperimentPlan,
	artifactsRoot: string,
	controllerUrl: string,
	phase: R2Phase = r2PhaseFromEnvironment(),
): Promise<BatchExecutionSummary> {
	const recoveryCohort = r2RecoveryCohortFromEnvironment();
	if (recoveryCohort !== null && phase !== "full") {
		throw new Error("R2 Controller identity recovery is defined only for the Full configuration");
	}
	const fullSpecs = createR2RunSpecs(plan, phase);
	const specs =
		recoveryCohort === null
			? createR2PendingRunSpecs(plan, phase)
			: recoveryCohort === "controller-identity-3"
				? createR2ControllerIdentityRecoverySpecs(plan)
			: recoveryCohort === "semantic-workflow-4"
				? createR2SemanticWorkflowRemediationSpecs(plan)
				: recoveryCohort === "semantic-workflow-followup-3"
					? createR2SemanticWorkflowFollowupSpecs(plan)
					: createR2SelfReviewRecoverySpecs(plan);
	const executionArtifactDirectory = r2ExecutionArtifactDirectoryFromEnvironment();
	const executionArtifactsRoot = join(artifactsRoot, executionArtifactDirectory);
	const dependencies = createDefaultM7FormalRunDependencies(controllerUrl);
	await Promise.all(
		[...new Set(specs.map((spec) => spec.instance_id))].map(async (instanceId) => {
			const environment = await dependencies.environmentLockSource.load(instanceId);
			await dependencies.publicTaskSource.load(instanceId, environment);
		}),
	);
	const batchDirectory = recoveryCohort ?? phase;
	const root = join(executionArtifactsRoot, batchDirectory);
	if (recoveryCohort === null && phase === "full") await writeR2CompletedTargetReference(artifactsRoot, root, fullSpecs);
	if (recoveryCohort === "controller-identity-3") await writeR2ControllerIdentityRecoveryDeclaration(root, specs);
	if (recoveryCohort === "semantic-workflow-4") await writeR2SemanticWorkflowRemediationDeclaration(root, specs);
	if (recoveryCohort === "semantic-workflow-followup-3") await writeR2SemanticWorkflowFollowupDeclaration(root, specs);
	if (recoveryCohort === "self-review-recovery-3345-1") await writeR2SelfReviewRecoveryDeclaration(root, specs);
	return executeBatch(
		root,
		specs,
		{
			execute: (spec, attemptId, hooks) =>
				runM7FormalRun(
					{
						artifactsRoot: executionArtifactsRoot,
						formalRunsRoot: join(executionArtifactsRoot, "runs"),
						experimentId: plan.experiment_id,
						runId: spec.run_id,
						attemptId,
						instanceId: spec.instance_id,
						configId: spec.config_id,
						replicate: spec.replicate,
						maxModelTurns: R2_MAX_MODEL_TURNS,
						hooks,
					},
					dependencies,
				),
		},
		{
			execution_namespace: `r2-${executionArtifactDirectory}-${batchDirectory}`,
			stop_on_pre_provider_failure: true,
			budget_admission: {
				ledger_path: join(executionArtifactsRoot, "_control", "r2-global-budget.json"),
				cap_tokens: specs.length * R2_PER_RUN_ADMISSION_CAP_TOKENS,
				per_run_reservation_tokens: R2_PER_RUN_ADMISSION_CAP_TOKENS,
			},
		},
	);
}
