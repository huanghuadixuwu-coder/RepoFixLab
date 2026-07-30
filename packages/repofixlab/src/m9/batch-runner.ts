import { join } from "node:path";
import type { ExperimentPlan } from "../contracts/experiment-plan.ts";
import { loadM7FormalMetricEvidence } from "../m7/formal-metric-evidence.ts";
import { createDefaultM7FormalRunDependencies, runM7FormalRun } from "../m7/formal-runner.ts";
import { type BatchExecutionSummary, createBatchRunSpecs, executeBatch } from "../runner/batch-runner.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";

export const M9_PROTOCOL_REVISION = "repofixlab-m9-v1";
export const M9_ARTIFACT_DIRECTORY = "m9-v1";
export const M9_PER_RUN_ADMISSION_CAP_TOKENS = 5_000_000;
export const M9_MAX_MODEL_TURNS = 128;

export const M9_NEW_MAIN_PAIR_INSTANCE_IDS = [
	"axios__axios-4738",
	"axios__axios-5892",
	"mrdoob__three.js-26589",
	"preactjs__preact-2927",
	"preactjs__preact-3010",
	"preactjs__preact-3062",
	"preactjs__preact-3562",
	"preactjs__preact-4182",
	"preactjs__preact-4245",
] as const;

export const M9_REPOFIX_RECOVERY_INSTANCE_IDS = [
	"preactjs__preact-2757",
	"preactjs__preact-2896",
	"preactjs__preact-3739",
] as const;

const M9_EXPECTED_TASK_COUNT = 26;
const M9_EXPECTED_RUN_COUNT = 21;

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertM9Plan(plan: ExperimentPlan): void {
	if (
		plan.experiment_id !== M9_PROTOCOL_REVISION ||
		plan.runtime_status !== "m7_formal_available" ||
		plan.task_selection.status !== "frozen" ||
		plan.task_selection.declared_task_count !== M9_EXPECTED_TASK_COUNT ||
		plan.budget.per_run_accounted_admission_cap_tokens !== M9_PER_RUN_ADMISSION_CAP_TOKENS ||
		plan.budget.total_accounted_admission_cap_tokens !== M9_EXPECTED_RUN_COUNT * M9_PER_RUN_ADMISSION_CAP_TOKENS ||
		plan.matrix.length !== 2
	)
		throw new Error("M9 plan binding is invalid");
	const [newMainPairs, recovery] = plan.matrix;
	if (
		newMainPairs === undefined ||
		recovery === undefined ||
		newMainPairs.group_id !== "m9-new-main-pairs" ||
		newMainPairs.task_count !== M9_NEW_MAIN_PAIR_INSTANCE_IDS.length ||
		!sameOrderedValues(newMainPairs.config_ids, ["pi-general", "repofix-full"]) ||
		newMainPairs.replicates !== 1 ||
		recovery.group_id !== "m9-repofix-controlled-recovery" ||
		recovery.task_count !== M9_REPOFIX_RECOVERY_INSTANCE_IDS.length ||
		!sameOrderedValues(recovery.config_ids, ["repofix-full"]) ||
		recovery.replicates !== 1
	)
		throw new Error("M9 matrix binding is invalid");
	const selected = new Set(plan.task_selection.instance_ids);
	for (const instanceId of [...M9_NEW_MAIN_PAIR_INSTANCE_IDS, ...M9_REPOFIX_RECOVERY_INSTANCE_IDS]) {
		if (!selected.has(instanceId)) throw new Error(`M9 selected task is not frozen: ${instanceId}`);
	}
}

export function createM9RunSpecs(plan: ExperimentPlan): readonly BatchRunSpec[] {
	assertM9Plan(plan);
	const specs = createBatchRunSpecs(plan, [
		{ group_id: "m9-new-main-pairs", instance_ids: M9_NEW_MAIN_PAIR_INSTANCE_IDS },
		{ group_id: "m9-repofix-controlled-recovery", instance_ids: M9_REPOFIX_RECOVERY_INSTANCE_IDS },
	]);
	if (specs.length !== M9_EXPECTED_RUN_COUNT)
		throw new Error("M9 run matrix must contain exactly 21 new logical runs");
	return specs;
}

export async function runM9Batch(
	plan: ExperimentPlan,
	artifactsRoot: string,
	controllerUrl: string,
): Promise<BatchExecutionSummary> {
	const specs = createM9RunSpecs(plan);
	const dependencies = createDefaultM7FormalRunDependencies(controllerUrl);
	await Promise.all(
		[...new Set(specs.map((spec) => spec.instance_id))].map(async (instanceId) => {
			const environment = await dependencies.environmentLockSource.load(instanceId);
			await dependencies.publicTaskSource.load(instanceId, environment);
		}),
	);
	const batchRoot = join(artifactsRoot, M9_ARTIFACT_DIRECTORY);
	return executeBatch(
		batchRoot,
		specs,
		{
			execute: (spec, attemptId, hooks) =>
				runM7FormalRun(
					{
						artifactsRoot,
						formalRunsRoot: join(batchRoot, "runs"),
						experimentId: plan.experiment_id,
						runId: spec.run_id,
						attemptId,
						instanceId: spec.instance_id,
						configId: spec.config_id,
						replicate: spec.replicate,
						maxModelTurns: M9_MAX_MODEL_TURNS,
						hooks,
					},
					dependencies,
				),
		},
		{
			budget_admission: {
				ledger_path: join(batchRoot, "_control", "m9-global-budget.json"),
				cap_tokens: M9_EXPECTED_RUN_COUNT * M9_PER_RUN_ADMISSION_CAP_TOKENS,
				per_run_reservation_tokens: M9_PER_RUN_ADMISSION_CAP_TOKENS,
			},
			report_evidence_loader: loadM7FormalMetricEvidence,
		},
	);
}
