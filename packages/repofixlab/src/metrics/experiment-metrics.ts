import type { RepoFixMemoryPolicyId } from "../contracts/memory.ts";
import {
	canonicalContractSha256,
	type EvaluationResult,
	type RunResult,
	verifyEvaluationResult,
} from "../contracts/run-contracts.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";
import type { M4DevWorkflowSummary } from "../runner/m4-dev-workflow.ts";

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

export interface MemoryPolicyProviderUsage {
	readonly complete: boolean;
	readonly agent: { readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number };
	readonly condenser: { readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number };
}

export interface MemoryPolicyRunObservation {
	readonly run_id: string;
	readonly instance_id: string;
	readonly memory_policy: RepoFixMemoryPolicyId;
	readonly usage: MemoryPolicyProviderUsage;
	readonly agent_wall_ms: number | null;
	readonly task_wall_ms: number;
	readonly resolved: boolean;
	readonly memory_local_ms: number;
	readonly l2_bytes: number;
	readonly compression_trigger_count: number;
}

export interface MemoryPolicyComparison {
	readonly schema_version: "v1";
	readonly metric_type: "memory_policy_comparison";
	readonly rows: readonly {
		readonly instance_id: string;
		readonly legacy_tokens: number | null;
		readonly memory_tokens: number | null;
		readonly token_difference: number | null;
		readonly legacy_time_ms: number;
		readonly memory_time_ms: number;
		readonly time_difference_ms: number;
		readonly legacy_resolved: boolean;
		readonly memory_resolved: boolean;
		readonly memory_local_ms: number;
		readonly memory_l2_bytes: number;
		readonly compression_trigger_count: number;
	}[];
	readonly total: {
		readonly legacy_tokens: number | null;
		readonly memory_tokens: number | null;
		readonly token_difference: number | null;
		readonly legacy_time_ms: number;
		readonly memory_time_ms: number;
		readonly time_difference_ms: number;
		readonly legacy_resolved_count: number;
		readonly memory_resolved_count: number;
		readonly memory_local_ms: number;
		readonly memory_l2_bytes: number;
		readonly compression_trigger_count: number;
	};
	readonly comparison_sha256: string;
}

function assertCount(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

/** Reconcile actual Provider tokens by request kind without double counting. */
export function parseMemoryPolicyTokenLedger(content: string): MemoryPolicyProviderUsage {
	const totals = {
		agent: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		condenser: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	};
	const open = new Map<string, "agent" | "condenser">();
	let complete = true;
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		const event = JSON.parse(line) as {
			readonly event_type?: string;
			readonly request_id?: string;
			readonly request_kind?: "agent" | "condenser";
			readonly provider_prompt_tokens?: number | null;
			readonly provider_completion_tokens?: number | null;
			readonly provider_total_tokens?: number | null;
		};
		if (typeof event.request_id !== "string") throw new Error("Memory comparison ledger event lacks request_id");
		const kind = event.request_kind ?? "agent";
		if (event.event_type === "reservation_open") {
			if (open.has(event.request_id))
				throw new Error("Memory comparison ledger contains a duplicate open reservation");
			open.set(event.request_id, kind);
		} else if (event.event_type === "reservation_settled") {
			if (open.get(event.request_id) !== kind) throw new Error("Memory comparison ledger settlement is not paired");
			open.delete(event.request_id);
			const input = event.provider_prompt_tokens;
			const output = event.provider_completion_tokens;
			const total = event.provider_total_tokens;
			if (
				input === null ||
				input === undefined ||
				output === null ||
				output === undefined ||
				total === null ||
				total === undefined ||
				input + output !== total
			) {
				throw new Error("Memory comparison ledger settlement has invalid Provider usage");
			}
			totals[kind].input_tokens += input;
			totals[kind].output_tokens += output;
			totals[kind].total_tokens += total;
		} else if (
			event.event_type === "reservation_charged_unverified" ||
			event.event_type === "budget_protocol_invalid"
		) {
			if (open.get(event.request_id) !== kind) throw new Error("Memory comparison ledger charge is not paired");
			open.delete(event.request_id);
			complete = false;
		}
	}
	if (open.size > 0) complete = false;
	return { complete, ...totals };
}

/** Join one formal result, its M4 summary, and its exact token ledger. */
export function createMemoryPolicyRunObservation(
	result: RunResult,
	m4: M4DevWorkflowSummary,
	tokenLedger: string,
): MemoryPolicyRunObservation {
	if (result.run_id !== m4.run_id) throw new Error("Memory comparison result and M4 summary run IDs differ");
	const memoryPolicy = m4.memory_policy;
	if (memoryPolicy === undefined) throw new Error("Memory comparison M4 summary lacks memory_policy");
	const memory = m4.repofix_memory_metrics;
	return {
		run_id: result.run_id,
		instance_id: m4.instance_id,
		memory_policy: memoryPolicy,
		usage: parseMemoryPolicyTokenLedger(tokenLedger),
		agent_wall_ms: m4.agent_wall_ms ?? null,
		task_wall_ms: result.wall_time_ms,
		resolved: result.resolved,
		memory_local_ms:
			memory === undefined ? 0 : memory.memory_store_ms + memory.memory_assemble_ms + memory.token_count_ms,
		l2_bytes: memory?.l2_bytes ?? 0,
		compression_trigger_count: memory?.compression_trigger_count ?? 0,
	};
}

function actualTokens(observation: MemoryPolicyRunObservation): number | null {
	return observation.usage.complete
		? observation.usage.agent.total_tokens + observation.usage.condenser.total_tokens
		: null;
}

function completeTotal(values: readonly (number | null)[]): number | null {
	return values.some((value) => value === null)
		? null
		: values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** Build the fixed five-task, two-policy paired comparison. */
export function createMemoryPolicyComparison(
	observations: readonly MemoryPolicyRunObservation[],
): MemoryPolicyComparison {
	const instanceIds = [...new Set(observations.map((observation) => observation.instance_id))].sort();
	if (observations.length !== 10 || instanceIds.length !== 5) {
		throw new Error("Memory comparison requires exactly five tasks and ten observations");
	}
	const rows = instanceIds.map((instanceId) => {
		const members = observations.filter((observation) => observation.instance_id === instanceId);
		const legacy = members.find((observation) => observation.memory_policy === "legacy-context-v1");
		const memory = members.find((observation) => observation.memory_policy === "layered-memory-v1");
		if (members.length !== 2 || legacy === undefined || memory === undefined) {
			throw new Error(`Memory comparison task ${instanceId} does not contain one run per policy`);
		}
		const legacyTokens = actualTokens(legacy);
		const memoryTokens = actualTokens(memory);
		return {
			instance_id: instanceId,
			legacy_tokens: legacyTokens,
			memory_tokens: memoryTokens,
			token_difference: legacyTokens === null || memoryTokens === null ? null : memoryTokens - legacyTokens,
			legacy_time_ms: legacy.task_wall_ms,
			memory_time_ms: memory.task_wall_ms,
			time_difference_ms: memory.task_wall_ms - legacy.task_wall_ms,
			legacy_resolved: legacy.resolved,
			memory_resolved: memory.resolved,
			memory_local_ms: memory.memory_local_ms,
			memory_l2_bytes: memory.l2_bytes,
			compression_trigger_count: memory.compression_trigger_count,
		};
	});
	const legacyTokens = completeTotal(rows.map((row) => row.legacy_tokens));
	const memoryTokens = completeTotal(rows.map((row) => row.memory_tokens));
	const unsigned = {
		schema_version: "v1" as const,
		metric_type: "memory_policy_comparison" as const,
		rows,
		total: {
			legacy_tokens: legacyTokens,
			memory_tokens: memoryTokens,
			token_difference: legacyTokens === null || memoryTokens === null ? null : memoryTokens - legacyTokens,
			legacy_time_ms: rows.reduce((total, row) => total + row.legacy_time_ms, 0),
			memory_time_ms: rows.reduce((total, row) => total + row.memory_time_ms, 0),
			time_difference_ms: rows.reduce((total, row) => total + row.time_difference_ms, 0),
			legacy_resolved_count: rows.filter((row) => row.legacy_resolved).length,
			memory_resolved_count: rows.filter((row) => row.memory_resolved).length,
			memory_local_ms: rows.reduce((total, row) => total + row.memory_local_ms, 0),
			memory_l2_bytes: rows.reduce((total, row) => total + row.memory_l2_bytes, 0),
			compression_trigger_count: rows.reduce((total, row) => total + row.compression_trigger_count, 0),
		},
	};
	return { ...unsigned, comparison_sha256: canonicalContractSha256(unsigned) };
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
