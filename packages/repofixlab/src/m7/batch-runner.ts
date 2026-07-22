import { join } from "node:path";
import type { ExperimentPlan } from "../contracts/experiment-plan.ts";
import type { RunResult } from "../contracts/run-contracts.ts";
import type { RunMetricEvidence } from "../metrics/experiment-metrics.ts";
import { createBatchRunSpecs, executeBatch, type BatchExecutionSummary } from "../runner/batch-runner.ts";
import { BatchStateStore, type BatchRunSpec, type BatchRunState } from "../runner/batch-state.ts";
import { GlobalBudgetLedger } from "../runner/global-budget-ledger.ts";
import { verifyM6EvaluationCohorts, type M6EvaluationCohorts } from "../m6/cohorts.ts";
import { createDefaultM7FormalRunDependencies, runM7FormalRun } from "./formal-runner.ts";
import { loadM7FormalMetricEvidence } from "./formal-metric-evidence.ts";
import { createM7SecurityAuditReport } from "./security-audit.ts";

export const M7_PER_RUN_ADMISSION_CAP_TOKENS = 5_000_000;
export const M7_MAX_MODEL_TURNS = 128;
export const M7_PROTOCOL_REVISION = "repofixlab-m7-v1.7.3";
export const M7_ARTIFACT_DIRECTORY = "m7-v1.7.3";
export const M7_CONTINUATION_SOURCE_DIRECTORY = "m7-v1.7.2";
const M7_FULL_MATRIX_RUN_COUNT = 74;
const M7_CONTINUATION_RUN_COUNT = 61;
const M7_SOURCE_TOTAL_ADMISSION_CAP_TOKENS = M7_FULL_MATRIX_RUN_COUNT * M7_PER_RUN_ADMISSION_CAP_TOKENS;

type M7FrozenExperimentPlan = ExperimentPlan & {
	readonly task_selection: Extract<ExperimentPlan["task_selection"], { readonly status: "frozen" }>;
};

function assertM7Plan(plan: ExperimentPlan): asserts plan is M7FrozenExperimentPlan {
	if (
		plan.experiment_id !== M7_PROTOCOL_REVISION ||
		plan.runtime_status !== "m7_formal_available" ||
		plan.task_selection.status !== "frozen" ||
		plan.task_selection.declared_task_count !== 26 ||
		plan.budget.per_run_accounted_admission_cap_tokens !== M7_PER_RUN_ADMISSION_CAP_TOKENS ||
		plan.budget.total_accounted_admission_cap_tokens !== M7_SOURCE_TOTAL_ADMISSION_CAP_TOKENS
	) throw new Error("M7 plan binding is not the protocol 1.7.3 continuation configuration");
}

async function loadM7ReportEvidence(
	batchRoot: string,
	specs: readonly BatchRunSpec[],
	results: Readonly<Record<string, RunResult>>,
): Promise<Readonly<Record<string, RunMetricEvidence>>> {
	const evaluationEvidence = await loadM7FormalMetricEvidence(batchRoot, specs, results);
	const securityAudit = await createM7SecurityAuditReport(join(batchRoot, ".."));
	if (securityAudit.status !== "pass") throw new Error("M7 security audit did not pass; refusing to publish aggregate evidence");
	const securityByRunId = new Map(securityAudit.runs.map((run) => [run.execution_run_id, run]));
	const merged: Record<string, RunMetricEvidence> = {};
	for (const spec of specs) {
		const evaluation = evaluationEvidence[spec.run_id];
		if (evaluation === undefined) continue;
		const security = securityByRunId.get(spec.run_id);
		if (security === undefined) throw new Error(`M7 security evidence is missing: ${spec.run_id}`);
		merged[spec.run_id] = {
			run_id: spec.run_id,
			evaluation: evaluation.evaluation,
			security: {
				blocked_operation_count: security.blocked_operation_count,
				policy_violation_count: security.policy_violation_count,
				sandbox_escape_attempt_count: security.sandbox_escape_attempt_count,
			},
		};
	}
	return merged;
}

export async function finalizeM7ContinuationSource(sourceRoot: string): Promise<BatchStateStore> {
	const sourceStore = await BatchStateStore.open(sourceRoot);
	const inFlight = sourceStore.values.filter((state) => state.status !== "queued" && state.status !== "completed" && state.status !== "failed");
	if (inFlight.length === 0) return sourceStore;
	if (inFlight.length !== 1 || inFlight[0]?.status !== "running" || inFlight[0].attempt_id === null) {
		throw new Error("M7 continuation source has an unsupported non-terminal recovery state");
	}
	const ledger = await GlobalBudgetLedger.open(
		join(sourceRoot, "_control", "m7-global-budget.json"),
		M7_SOURCE_TOTAL_ADMISSION_CAP_TOKENS,
	);
	if (
		ledger.snapshot.reconciliation_required ||
		ledger.snapshot.reserved_tokens !== M7_PER_RUN_ADMISSION_CAP_TOKENS
	) {
		throw new Error("M7 continuation source budget cannot safely finalize its interrupted Provider request");
	}
	await ledger.chargeUnverified(M7_PER_RUN_ADMISSION_CAP_TOKENS);
	const interrupted = inFlight[0];
	await sourceStore.transition(
		interrupted.run_id,
		"failed",
		interrupted.attempt_id,
		"interrupted_unreconciled_provider_request",
	);
	return BatchStateStore.open(sourceRoot);
}

function continuationKey(spec: Pick<BatchRunSpec, "group_id" | "instance_id" | "config_id" | "replicate">): string {
	return `${spec.group_id}\u0000${spec.instance_id}\u0000${spec.config_id}\u0000${spec.replicate}`;
}

export function selectM7ContinuationSpecs(
	specs: readonly BatchRunSpec[],
	sourceStates: readonly BatchRunState[],
): readonly BatchRunSpec[] {
	if (specs.length !== M7_FULL_MATRIX_RUN_COUNT || sourceStates.length !== M7_FULL_MATRIX_RUN_COUNT) {
		throw new Error("M7 continuation requires the complete frozen 74-run source matrix");
	}
	const sourceByKey = new Map(sourceStates.map((state) => [continuationKey(state), state]));
	if (sourceByKey.size !== sourceStates.length) throw new Error("M7 continuation source contains duplicate logical identities");
	const selected = specs.filter((spec) => sourceByKey.get(continuationKey(spec))?.status !== "completed");
	if (selected.length !== M7_CONTINUATION_RUN_COUNT) {
		throw new Error(`M7 continuation requires exactly ${M7_CONTINUATION_RUN_COUNT} failed, interrupted, or queued source runs`);
	}
	return selected;
}

export async function runM7Batch(
	plan: ExperimentPlan,
	cohortsValue: unknown,
	artifactsRoot: string,
	controllerUrl: string,
): Promise<BatchExecutionSummary> {
	assertM7Plan(plan);
	const cohorts: M6EvaluationCohorts = verifyM6EvaluationCohorts(cohortsValue);
	const specs = createBatchRunSpecs(plan, [
		{ group_id: "main", instance_ids: cohorts.main_test_instance_ids },
		{ group_id: "ablation-no-localize", instance_ids: cohorts.ablation_instance_ids },
		{ group_id: "ablation-no-verify-feedback", instance_ids: cohorts.ablation_instance_ids },
		{ group_id: "stability-additional", instance_ids: cohorts.stability_instance_ids },
	]);
	if (specs.length !== M7_FULL_MATRIX_RUN_COUNT) throw new Error("M7 frozen cohort matrix must contain exactly 74 logical runs");
	const sourceStore = await finalizeM7ContinuationSource(join(artifactsRoot, M7_CONTINUATION_SOURCE_DIRECTORY));
	const continuationSpecs = selectM7ContinuationSpecs(specs, sourceStore.values);
	const dependencies = createDefaultM7FormalRunDependencies(controllerUrl);
	await Promise.all(
		[...new Set(continuationSpecs.map((spec) => spec.instance_id))].map(async (instanceId) => {
			const environment = await dependencies.environmentLockSource.load(instanceId);
			await dependencies.publicTaskSource.load(instanceId, environment);
		}),
	);
	const batchRoot = join(artifactsRoot, M7_ARTIFACT_DIRECTORY);
	return executeBatch(
		batchRoot,
		continuationSpecs,
		{
			execute: (spec, attemptId, hooks) =>
				runM7FormalRun({
					artifactsRoot,
					formalRunsRoot: join(batchRoot, "runs"),
					experimentId: plan.experiment_id,
					runId: spec.run_id,
					attemptId,
					instanceId: spec.instance_id,
				configId: spec.config_id,
				replicate: spec.replicate,
				maxModelTurns: M7_MAX_MODEL_TURNS,
					hooks,
				}, dependencies),
		},
		{
			budget_admission: {
				ledger_path: join(batchRoot, "_control", "m7-global-budget.json"),
				cap_tokens: continuationSpecs.length * M7_PER_RUN_ADMISSION_CAP_TOKENS,
				per_run_reservation_tokens: M7_PER_RUN_ADMISSION_CAP_TOKENS,
			},
			report_evidence_loader: loadM7ReportEvidence,
		},
	);
}
