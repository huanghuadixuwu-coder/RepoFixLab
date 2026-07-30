import { createHash } from "node:crypto";
import type { RepoFixConfigId } from "../agent/repofix-config.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { ExperimentPlan } from "../contracts/experiment-plan.ts";
import { canonicalContractSha256 } from "../contracts/run-contracts.ts";
import { type BatchRunAssignment, createBatchRunSpecs } from "../runner/batch-runner.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";
import { type M6EvaluationCohorts, verifyM6EvaluationCohorts } from "./cohorts.ts";

export const M6_PROTOCOL_REVISION = "repofixlab-protocol-1.3" as const;
export const M6_EXECUTION_ORDER_SEED = "repofixlab-m6-interleaved-order-v1" as const;
export const M6_DATASET_LOCK_ID = "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6" as const;
export const M6_STATISTICS_PROTOCOL = {
	wilson_confidence_level: 0.95,
	repo_cluster_paired_bootstrap_replicates: 10_000,
	repo_cluster_paired_bootstrap_seed: "repofixlab-v1-repo-bootstrap-10000",
	mcnemar_test: "two-sided-exact",
	report_repository_breakdown: true,
	report_leave_one_repository_out: true,
} as const;
export const M6_ADOPTION_PROTOCOL = {
	minimum_practical_delta_percentage_points: 10,
	maximum_accounted_token_ratio: 2,
	maximum_latency_ratio: 2,
	maximum_p2p_regression_delta: 0,
} as const;

export interface M6TaskEnvironmentLockReference {
	readonly instance_id: string;
	readonly lock_id: string;
	readonly seal_sha256: string;
	readonly file_sha256: string;
	readonly worker_image_id: string;
	readonly evaluator_image_id: string;
}

export interface M6FrozenModelReference {
	readonly provider: "zhipu-standard";
	readonly model_id: "glm-4.5-air";
	readonly model_spec_sha256: string;
	readonly pricing_spec_sha256: string;
	readonly temperature: number;
	readonly max_output_tokens: number;
	readonly max_model_turns: number;
	readonly max_tool_calls: number;
	readonly max_wall_time_ms: number;
	readonly provider_retry_policy: "orchestrator_only";
	readonly overflow_auto_recovery: false;
}

export interface M6TokenEstimatorReference {
	readonly version: string;
	readonly multiplier: number;
	readonly framing_margin_tokens: number;
	readonly maximum_request_actual_tokens: 147_456;
	readonly calibration_evidence_sha256: string;
}

export interface M6ExperimentLock {
	readonly schema_version: "v1";
	readonly lock_type: "experiment";
	readonly protocol_revision: typeof M6_PROTOCOL_REVISION;
	readonly experiment_id: string;
	readonly plan_sha256: string;
	readonly code_revision_sha256: string;
	readonly dataset_lock: { readonly lock_id: string; readonly seal_sha256: string };
	readonly official_image_source_lock: { readonly lock_id: string; readonly seal_sha256: string };
	readonly m3_assignment_sha256: string;
	readonly m6_cohort_sha256: string;
	readonly task_environment_locks: readonly M6TaskEnvironmentLockReference[];
	readonly model: M6FrozenModelReference;
	readonly token_admission_estimator: M6TokenEstimatorReference;
	readonly execution_order_seed: typeof M6_EXECUTION_ORDER_SEED;
	readonly logical_runs: readonly BatchRunSpec[];
	readonly statistics: typeof M6_STATISTICS_PROTOCOL;
	readonly adoption: typeof M6_ADOPTION_PROTOCOL;
	readonly experiment_lock_sha256: string;
}

export interface M6ExperimentLockInput {
	readonly plan: ExperimentPlan;
	readonly cohorts: M6EvaluationCohorts;
	readonly code_revision_sha256: string;
	readonly dataset_lock: M6ExperimentLock["dataset_lock"];
	readonly official_image_source_lock: M6ExperimentLock["official_image_source_lock"];
	readonly task_environment_locks: readonly M6TaskEnvironmentLockReference[];
	readonly model: M6FrozenModelReference;
	readonly token_admission_estimator: M6TokenEstimatorReference;
}

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
}

function isInstanceId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
}

function isImageId(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isCanonicalReferences(
	value: unknown,
	expectedInstances: readonly string[],
): value is readonly M6TaskEnvironmentLockReference[] {
	return (
		Array.isArray(value) &&
		value.length === expectedInstances.length &&
		value.every((reference, index) => {
			const previous = value[index - 1];
			return (
				typeof reference === "object" &&
				reference !== null &&
				!Array.isArray(reference) &&
				JSON.stringify(Object.keys(reference as object).sort()) ===
					JSON.stringify([
						"evaluator_image_id",
						"file_sha256",
						"instance_id",
						"lock_id",
						"seal_sha256",
						"worker_image_id",
					]) &&
				isInstanceId((reference as M6TaskEnvironmentLockReference).instance_id) &&
				(reference as M6TaskEnvironmentLockReference).instance_id === expectedInstances[index] &&
				(previous === undefined ||
					previous.instance_id < (reference as M6TaskEnvironmentLockReference).instance_id) &&
				isIdentifier((reference as M6TaskEnvironmentLockReference).lock_id) &&
				isSha256((reference as M6TaskEnvironmentLockReference).seal_sha256) &&
				isSha256((reference as M6TaskEnvironmentLockReference).file_sha256) &&
				isImageId((reference as M6TaskEnvironmentLockReference).worker_image_id) &&
				isImageId((reference as M6TaskEnvironmentLockReference).evaluator_image_id) &&
				(reference as M6TaskEnvironmentLockReference).worker_image_id !==
					(reference as M6TaskEnvironmentLockReference).evaluator_image_id
			);
		})
	);
}

function semanticSubset(value: M6ExperimentLock): Omit<M6ExperimentLock, "experiment_lock_sha256"> {
	const { experiment_lock_sha256: _experimentLockSha256, ...semantic } = value;
	return semantic;
}

function cohortAssignments(plan: ExperimentPlan, cohorts: M6EvaluationCohorts): readonly BatchRunAssignment[] {
	const knownGroups = new Set(plan.matrix.map((group) => group.group_id));
	const expectedGroups = ["main", "ablation-no-localize", "ablation-no-verify-feedback", "stability-additional"];
	if (knownGroups.size !== expectedGroups.length || expectedGroups.some((groupId) => !knownGroups.has(groupId))) {
		throw new Error("M6 experiment lock requires the registered four-group formal matrix");
	}
	return [
		{ group_id: "main", instance_ids: cohorts.main_test_instance_ids },
		{ group_id: "ablation-no-localize", instance_ids: cohorts.ablation_instance_ids },
		{ group_id: "ablation-no-verify-feedback", instance_ids: cohorts.ablation_instance_ids },
		{ group_id: "stability-additional", instance_ids: cohorts.stability_instance_ids },
	];
}

function orderedRunSpecs(specs: readonly BatchRunSpec[]): readonly BatchRunSpec[] {
	return specs.slice().sort((left, right) => {
		const leftScore = canonicalHash({ seed: M6_EXECUTION_ORDER_SEED, run_id: left.run_id });
		const rightScore = canonicalHash({ seed: M6_EXECUTION_ORDER_SEED, run_id: right.run_id });
		return leftScore.localeCompare(rightScore) || left.run_id.localeCompare(right.run_id);
	});
}

function hasRegisteredFormalRunCounts(runs: readonly BatchRunSpec[]): boolean {
	const counts = runs.reduce<Record<string, number>>((result, run) => {
		result[run.group_id] = (result[run.group_id] ?? 0) + 1;
		return result;
	}, {});
	return (
		counts.main === 34 &&
		counts["ablation-no-localize"] === 8 &&
		counts["ablation-no-verify-feedback"] === 8 &&
		counts["stability-additional"] === 24 &&
		Object.keys(counts).length === 4
	);
}

function assertModel(value: M6FrozenModelReference): void {
	if (
		value.provider !== "zhipu-standard" ||
		value.model_id !== "glm-4.5-air" ||
		!isSha256(value.model_spec_sha256) ||
		!isSha256(value.pricing_spec_sha256) ||
		value.temperature !== 0.2 ||
		value.max_output_tokens !== 16_384 ||
		value.max_model_turns !== 64 ||
		value.max_tool_calls !== 100 ||
		value.max_wall_time_ms !== 1_800_000 ||
		value.provider_retry_policy !== "orchestrator_only" ||
		value.overflow_auto_recovery !== false
	) {
		throw new Error("M6 frozen model reference does not satisfy the registered protocol");
	}
}

function assertTokenEstimator(value: M6TokenEstimatorReference): void {
	if (
		!isIdentifier(value.version) ||
		!Number.isFinite(value.multiplier) ||
		value.multiplier < 1 ||
		!Number.isSafeInteger(value.framing_margin_tokens) ||
		value.framing_margin_tokens < 0 ||
		value.maximum_request_actual_tokens !== 147_456 ||
		!isSha256(value.calibration_evidence_sha256)
	) {
		throw new Error("M6 TokenAdmissionEstimator reference is malformed");
	}
}

function isBatchRunSpec(value: unknown): value is BatchRunSpec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const spec = value as BatchRunSpec;
	return (
		JSON.stringify(Object.keys(spec).sort()) ===
			JSON.stringify(["config_id", "group_id", "instance_id", "replicate", "run_id"]) &&
		isIdentifier(spec.run_id) &&
		isIdentifier(spec.group_id) &&
		isInstanceId(spec.instance_id) &&
		(
			[
				"pi-general",
				"repofix-full",
				"repofix-no-localize",
				"repofix-no-verify-feedback",
			] as readonly RepoFixConfigId[]
		).includes(spec.config_id) &&
		Number.isSafeInteger(spec.replicate) &&
		spec.replicate >= 1
	);
}

export function createM6ExperimentLock(input: M6ExperimentLockInput): M6ExperimentLock {
	const cohorts = verifyM6EvaluationCohorts(input.cohorts);
	if (input.plan.task_selection.status !== "frozen")
		throw new Error("M6 experiment lock requires frozen task selection");
	const expectedInstances = [...input.plan.task_selection.instance_ids].sort();
	if (
		!isSha256(input.code_revision_sha256) ||
		!isIdentifier(input.dataset_lock.lock_id) ||
		!isSha256(input.dataset_lock.seal_sha256) ||
		!isIdentifier(input.official_image_source_lock.lock_id) ||
		!isSha256(input.official_image_source_lock.seal_sha256) ||
		!isCanonicalReferences(input.task_environment_locks, expectedInstances)
	) {
		throw new Error("M6 experiment lock references are malformed or incomplete");
	}
	if (input.dataset_lock.lock_id !== M6_DATASET_LOCK_ID) {
		throw new Error("M6 experiment lock DatasetLock identity is not the sealed M3 source");
	}
	assertModel(input.model);
	assertTokenEstimator(input.token_admission_estimator);
	const planSha256 = canonicalContractSha256(input.plan);
	const logicalRuns = orderedRunSpecs(createBatchRunSpecs(input.plan, cohortAssignments(input.plan, cohorts)));
	if (logicalRuns.length !== 74 || new Set(logicalRuns.map((run) => run.run_id)).size !== 74) {
		throw new Error("M6 formal matrix must expand to exactly 74 logical runs");
	}
	const draft: Omit<M6ExperimentLock, "experiment_lock_sha256"> = {
		schema_version: "v1",
		lock_type: "experiment",
		protocol_revision: M6_PROTOCOL_REVISION,
		experiment_id: input.plan.experiment_id,
		plan_sha256: planSha256,
		code_revision_sha256: input.code_revision_sha256,
		dataset_lock: input.dataset_lock,
		official_image_source_lock: input.official_image_source_lock,
		m3_assignment_sha256: cohorts.m3_assignment_sha256,
		m6_cohort_sha256: cohorts.cohort_sha256,
		task_environment_locks: input.task_environment_locks,
		model: input.model,
		token_admission_estimator: input.token_admission_estimator,
		execution_order_seed: M6_EXECUTION_ORDER_SEED,
		logical_runs: logicalRuns,
		statistics: M6_STATISTICS_PROTOCOL,
		adoption: M6_ADOPTION_PROTOCOL,
	};
	return verifyM6ExperimentLock({ ...draft, experiment_lock_sha256: canonicalHash(draft) });
}

export function verifyM6ExperimentLock(value: unknown): M6ExperimentLock {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("M6 experiment lock must be an object");
	}
	const lock = value as Record<string, unknown>;
	const expectedFields = [
		"adoption",
		"code_revision_sha256",
		"dataset_lock",
		"execution_order_seed",
		"experiment_id",
		"experiment_lock_sha256",
		"lock_type",
		"logical_runs",
		"m3_assignment_sha256",
		"m6_cohort_sha256",
		"model",
		"official_image_source_lock",
		"plan_sha256",
		"protocol_revision",
		"schema_version",
		"statistics",
		"task_environment_locks",
		"token_admission_estimator",
	];
	if (JSON.stringify(Object.keys(lock).sort()) !== JSON.stringify(expectedFields)) {
		throw new Error("M6 experiment lock fields must match the v1 contract");
	}
	if (
		lock.schema_version !== "v1" ||
		lock.lock_type !== "experiment" ||
		lock.protocol_revision !== M6_PROTOCOL_REVISION ||
		lock.execution_order_seed !== M6_EXECUTION_ORDER_SEED ||
		!isIdentifier(lock.experiment_id) ||
		!isSha256(lock.plan_sha256) ||
		!isSha256(lock.code_revision_sha256) ||
		!isSha256(lock.m3_assignment_sha256) ||
		!isSha256(lock.m6_cohort_sha256) ||
		!isSha256(lock.experiment_lock_sha256) ||
		!Array.isArray(lock.logical_runs) ||
		lock.logical_runs.length !== 74 ||
		!lock.logical_runs.every(isBatchRunSpec) ||
		new Set(lock.logical_runs.map((run) => run.run_id)).size !== 74 ||
		!hasRegisteredFormalRunCounts(lock.logical_runs) ||
		stableStringify(lock.statistics) !== stableStringify(M6_STATISTICS_PROTOCOL) ||
		stableStringify(lock.adoption) !== stableStringify(M6_ADOPTION_PROTOCOL)
	) {
		throw new Error("M6 experiment lock is malformed");
	}
	const typed = lock as unknown as M6ExperimentLock;
	if (
		typed.dataset_lock === null ||
		typed.official_image_source_lock === null ||
		typeof typed.dataset_lock !== "object" ||
		typeof typed.official_image_source_lock !== "object" ||
		!isIdentifier(typed.dataset_lock.lock_id) ||
		!isSha256(typed.dataset_lock.seal_sha256) ||
		!isIdentifier(typed.official_image_source_lock.lock_id) ||
		!isSha256(typed.official_image_source_lock.seal_sha256) ||
		typed.task_environment_locks.length !== 26 ||
		!isCanonicalReferences(
			typed.task_environment_locks,
			typed.task_environment_locks.map((item) => item.instance_id).sort(),
		) ||
		!typed.logical_runs.every((run) =>
			typed.task_environment_locks.some((lockReference) => lockReference.instance_id === run.instance_id),
		) ||
		stableStringify(orderedRunSpecs(typed.logical_runs)) !== stableStringify(typed.logical_runs)
	) {
		throw new Error("M6 experiment lock bindings are malformed");
	}
	assertModel(typed.model);
	assertTokenEstimator(typed.token_admission_estimator);
	if (canonicalHash(semanticSubset(typed)) !== typed.experiment_lock_sha256) {
		throw new Error("M6 experiment lock SHA-256 does not match canonical content");
	}
	return typed;
}
