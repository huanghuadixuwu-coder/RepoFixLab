import { type EvaluationResult, type RunResult, verifyEvaluationResult } from "../contracts/run-contracts.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";

export interface SecurityMetricEvidence {
	readonly blocked_operation_count: number;
	readonly policy_violation_count: number;
	readonly sandbox_escape_attempt_count: number;
}

export interface RunMetricEvidence {
	readonly run_id: string;
	readonly evaluation: EvaluationResult | null;
	readonly security: SecurityMetricEvidence | null;
}

export interface ExperimentMetrics {
	readonly schema_version: "v1";
	readonly metric_type: "experiment_metrics";
	readonly failure_categories: Readonly<Record<string, number>>;
	readonly tests: {
		readonly evaluation_evidence_run_count: number;
		readonly evaluation_evidence_missing_run_ids: readonly string[];
		readonly fail_to_pass: { readonly passed: number; readonly total: number; readonly rate: number | null };
		readonly pass_to_pass: { readonly passed: number; readonly total: number; readonly rate: number | null };
	};
	readonly stability: readonly {
		readonly config_id: BatchRunSpec["config_id"];
		readonly replicate_group_count: number;
		readonly complete_replicate_group_count: number;
		readonly unstable_replicate_group_count: number;
	}[];
	readonly security: {
		readonly evidence_run_count: number;
		readonly evidence_missing_run_ids: readonly string[];
		readonly blocked_operation_count: number;
		readonly policy_violation_count: number;
		readonly sandbox_escape_attempt_count: number;
	};
}

function assertCount(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function rate(passed: number, total: number): number | null {
	return total === 0 ? null : passed / total;
}

function failureCategory(result: RunResult): string {
	switch (result.termination_reason) {
		case "official_unresolved":
		case "no_patch":
			return "repair_unresolved";
		case "model_error":
			return "model";
		case "tool_error":
			return "tool";
		case "budget_exhausted":
			return "budget";
		case "wall_time_exceeded":
			return "wall_time";
		case "policy_violation":
			return "policy";
		case "infrastructure_error":
			return "infrastructure";
		case "evaluation_error":
			return "evaluation";
		case "user_abort":
			return "user_abort";
		case "official_resolved":
			return "resolved";
	}
}

function evidenceByRun(
	specs: readonly BatchRunSpec[],
	evidence: Readonly<Record<string, RunMetricEvidence>>,
): ReadonlyMap<string, RunMetricEvidence> {
	const expected = new Set(specs.map((spec) => spec.run_id));
	for (const [runId, value] of Object.entries(evidence)) {
		if (!expected.has(runId) || value.run_id !== runId)
			throw new Error("Metric evidence is not bound to a registered run");
		if (value.evaluation !== null) verifyEvaluationResult(value.evaluation);
		if (value.security !== null) {
			assertCount(value.security.blocked_operation_count, "blocked_operation_count");
			assertCount(value.security.policy_violation_count, "policy_violation_count");
			assertCount(value.security.sandbox_escape_attempt_count, "sandbox_escape_attempt_count");
		}
	}
	return new Map(Object.entries(evidence));
}

export function createExperimentMetrics(
	specs: readonly BatchRunSpec[],
	results: Readonly<Record<string, RunResult>>,
	evidence: Readonly<Record<string, RunMetricEvidence>> = {},
): ExperimentMetrics {
	const evidenceMap = evidenceByRun(specs, evidence);
	const failureCategories: Record<string, number> = {};
	for (const result of Object.values(results)) {
		const category = failureCategory(result);
		failureCategories[category] = (failureCategories[category] ?? 0) + 1;
	}
	let f2pPassed = 0;
	let f2pTotal = 0;
	let p2pPassed = 0;
	let p2pTotal = 0;
	const evaluationEvidenceRunIds: string[] = [];
	const securityEvidenceRunIds: string[] = [];
	let blockedOperationCount = 0;
	let policyViolationCount = 0;
	let sandboxEscapeAttemptCount = 0;
	for (const spec of specs) {
		const item = evidenceMap.get(spec.run_id);
		if (item?.evaluation !== null && item?.evaluation !== undefined) {
			evaluationEvidenceRunIds.push(spec.run_id);
			f2pPassed += item.evaluation.fail_to_pass.success.length;
			f2pTotal += item.evaluation.fail_to_pass.success.length + item.evaluation.fail_to_pass.failure.length;
			p2pPassed += item.evaluation.pass_to_pass.success.length;
			p2pTotal += item.evaluation.pass_to_pass.success.length + item.evaluation.pass_to_pass.failure.length;
		}
		if (item?.security !== null && item?.security !== undefined) {
			securityEvidenceRunIds.push(spec.run_id);
			blockedOperationCount += item.security.blocked_operation_count;
			policyViolationCount += item.security.policy_violation_count;
			sandboxEscapeAttemptCount += item.security.sandbox_escape_attempt_count;
		}
	}
	const stabilityByConfig = new Map<
		BatchRunSpec["config_id"],
		Map<string, { expected_replicates: number; observed_outcomes: boolean[] }>
	>();
	for (const spec of specs) {
		const result = results[spec.run_id];
		let byLogicalTask = stabilityByConfig.get(spec.config_id);
		if (byLogicalTask === undefined) {
			byLogicalTask = new Map();
			stabilityByConfig.set(spec.config_id, byLogicalTask);
		}
		const values = byLogicalTask.get(spec.instance_id) ?? { expected_replicates: 0, observed_outcomes: [] };
		values.expected_replicates += 1;
		if (result !== undefined) values.observed_outcomes.push(result.resolved);
		byLogicalTask.set(spec.instance_id, values);
	}
	const stability = [...stabilityByConfig.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([configId, groups]) => {
			const replicateGroups = [...groups.values()].filter((values) => values.expected_replicates > 1);
			return {
				config_id: configId,
				replicate_group_count: replicateGroups.length,
				complete_replicate_group_count: replicateGroups.filter(
					(values) => values.observed_outcomes.length === values.expected_replicates,
				).length,
				unstable_replicate_group_count: replicateGroups.filter(
					(values) =>
						values.observed_outcomes.length === values.expected_replicates &&
						new Set(values.observed_outcomes).size > 1,
				).length,
			};
		});
	const evaluationSet = new Set(evaluationEvidenceRunIds);
	const securitySet = new Set(securityEvidenceRunIds);
	return {
		schema_version: "v1",
		metric_type: "experiment_metrics",
		failure_categories: Object.fromEntries(
			Object.entries(failureCategories).sort(([left], [right]) => left.localeCompare(right)),
		),
		tests: {
			evaluation_evidence_run_count: evaluationEvidenceRunIds.length,
			evaluation_evidence_missing_run_ids: specs
				.map((spec) => spec.run_id)
				.filter((runId) => !evaluationSet.has(runId))
				.sort(),
			fail_to_pass: { passed: f2pPassed, total: f2pTotal, rate: rate(f2pPassed, f2pTotal) },
			pass_to_pass: { passed: p2pPassed, total: p2pTotal, rate: rate(p2pPassed, p2pTotal) },
		},
		stability,
		security: {
			evidence_run_count: securityEvidenceRunIds.length,
			evidence_missing_run_ids: specs
				.map((spec) => spec.run_id)
				.filter((runId) => !securitySet.has(runId))
				.sort(),
			blocked_operation_count: blockedOperationCount,
			policy_violation_count: policyViolationCount,
			sandbox_escape_attempt_count: sandboxEscapeAttemptCount,
		},
	};
}
