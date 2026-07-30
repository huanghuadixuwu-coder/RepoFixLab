import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { RepoFixConfigId } from "../agent/repofix-config.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import {
	type EvaluationResult,
	type RunResult,
	verifyEvaluationResult,
	verifyRunResult,
} from "../contracts/run-contracts.ts";

const M8_METHOD_REVISION = "repofixlab-m8-v1.1" as const;
const EXPECTED_OBSERVATION_COUNT = 74;
const BOOTSTRAP_SAMPLES = 10_000;
const BOOTSTRAP_SEED = 0x5a17c0de;
const Z_95 = 1.959963984540054;

type M7ObservationStatus = "retained_64_turn" | "continued_128_turn" | "continuation_failed";
type M7MaxModelTurns = 64 | 128;
type JsonRecord = Record<string, unknown>;

interface M7ObservationRecord {
	readonly source_run_id: string;
	readonly continuation_run_id: string | null;
	readonly group_id: string;
	readonly instance_id: string;
	readonly config_id: RepoFixConfigId;
	readonly replicate: number;
	readonly max_model_turns: M7MaxModelTurns;
	readonly status: M7ObservationStatus;
	readonly terminal_reason: string;
	readonly resolved: boolean | null;
	readonly result_sha256: string | null;
}

interface M7ContinuationInput {
	readonly report_sha256: string;
	readonly status: "pass";
	readonly expected_original_run_count: number;
	readonly terminal_observation_count: number;
	readonly comparison_scope: "turn_limit_stratified_no_cross_stratum_pairing";
	readonly observations: readonly M7ObservationRecord[];
}

interface M7SecurityRunInput {
	readonly source_run_id: string;
	readonly execution_run_id: string;
	readonly max_model_turns: M7MaxModelTurns;
	readonly status: M7ObservationStatus;
	readonly blocked_operation_count: number;
	readonly policy_violation_count: number;
	readonly sandbox_escape_attempt_count: number;
	readonly unblocked_sandbox_escape_attempt_count: number;
}

interface M7SecurityInput {
	readonly report_sha256: string;
	readonly status: "pass";
	readonly audited_run_count: number;
	readonly unblocked_sandbox_escape_attempt_count: number;
	readonly security: {
		readonly evidence_run_count: number;
		readonly evidence_missing_run_ids: readonly string[];
		readonly blocked_operation_count: number;
		readonly policy_violation_count: number;
		readonly sandbox_escape_attempt_count: number;
	};
	readonly runs: readonly M7SecurityRunInput[];
}

export interface M8AnalysisObservation {
	readonly source_run_id: string;
	readonly execution_run_id: string;
	readonly group_id: string;
	readonly instance_id: string;
	readonly repository: string;
	readonly config_id: RepoFixConfigId;
	readonly replicate: number;
	readonly max_model_turns: M7MaxModelTurns;
	readonly status: M7ObservationStatus;
	readonly terminal_reason: string;
	readonly result: RunResult | null;
	readonly evaluation: EvaluationResult | null;
	readonly usage: M8Usage;
}

interface M8Usage {
	readonly evidence_source: "run_result" | "failed_token_ledger";
	readonly evidence_sha256: string;
	readonly accounted_tokens: number;
	readonly provider_actual_tokens: number;
	readonly model_turns: number;
	readonly cost_complete: boolean;
	readonly estimated_cost_cny_nano: number | null;
}

export interface M8SecuritySummary {
	readonly report_sha256: string;
	readonly blocked_operation_count: number;
	readonly policy_violation_count: number;
	readonly sandbox_escape_attempt_count: number;
	readonly unblocked_sandbox_escape_attempt_count: number;
}

interface WilsonInterval {
	readonly confidence_level: 0.95;
	readonly lower: number;
	readonly upper: number;
}

interface M8ConfigurationSummary {
	readonly max_model_turns: M7MaxModelTurns;
	readonly config_id: RepoFixConfigId;
	readonly planned_count: number;
	readonly official_evaluation_count: number;
	readonly usage_evidence_count: number;
	readonly wall_time_evidence_count: number;
	readonly official_resolved_count: number;
	readonly official_unresolved_count: number;
	readonly agent_terminal_without_evaluation_count: number;
	readonly intention_to_treat_resolved_rate: number;
	readonly intention_to_treat_wilson_95: WilsonInterval | null;
	readonly evaluated_resolved_rate: number | null;
	readonly accounted_tokens: number;
	readonly provider_actual_tokens: number | null;
	readonly cost_complete: boolean;
	readonly estimated_cost_cny_nano: number | null;
	readonly wall_time_ms: { readonly p50: number | null; readonly p90: number | null; readonly total: number };
	readonly model_turns: number;
}

interface M8PairedComparison {
	readonly max_model_turns: M7MaxModelTurns;
	readonly group_id: "main";
	readonly comparison: "repofix-full_minus_pi-general";
	readonly matched_pair_count: number;
	readonly incomplete_pair_count: number;
	readonly repofix_full_resolved_count: number;
	readonly pi_general_resolved_count: number;
	readonly resolved_rate_difference: number;
	readonly repofix_only_resolved_count: number;
	readonly pi_only_resolved_count: number;
	readonly mcnemar_exact_two_sided_p_value: number | null;
	readonly repository_bootstrap_95: {
		readonly repository_count: number;
		readonly samples: number;
		readonly seed: number;
		readonly lower: number;
		readonly upper: number;
	} | null;
	readonly leave_one_repository_out: readonly {
		readonly excluded_repository: string;
		readonly matched_pair_count: number;
		readonly resolved_rate_difference: number | null;
	}[];
}

interface M8FailureRootCause {
	readonly category:
		| "agent_no_final_snapshot"
		| "candidate_patch_not_applied"
		| "evaluator_timeout"
		| "fail_to_pass_failure"
		| "pass_to_pass_regression"
		| "official_unresolved_other";
	readonly count: number;
	readonly sample_source_run_ids: readonly string[];
}

export interface M8AnalysisReport {
	readonly schema_version: "v1";
	readonly report_type: "m8_analysis";
	readonly status: "pass";
	readonly method_revision: typeof M8_METHOD_REVISION;
	readonly source: {
		readonly m7_continuation_report_sha256: string;
		readonly m7_security_audit_report_sha256: string;
		readonly comparison_scope: "turn_limit_stratified_no_cross_stratum_pairing";
		readonly unreconciled_source_provider_request_excluded_from_usage: true;
	};
	readonly population: {
		readonly planned_logical_run_count: number;
		readonly official_evaluation_count: number;
		readonly official_resolved_count: number;
		readonly official_unresolved_count: number;
		readonly agent_terminal_without_evaluation_count: number;
		readonly intention_to_treat_resolved_rate: number;
		readonly intention_to_treat_wilson_95: WilsonInterval;
		readonly evaluated_resolved_rate: number;
		readonly accounted_tokens: number;
		readonly provider_actual_tokens: number;
		readonly cost_complete: boolean;
		readonly estimated_cost_cny_nano: number | null;
	};
	readonly configurations: readonly M8ConfigurationSummary[];
	readonly paired_comparisons: readonly M8PairedComparison[];
	readonly evaluator_tests: {
		readonly fail_to_pass: { readonly passed: number; readonly total: number; readonly rate: number | null };
		readonly pass_to_pass: { readonly passed: number; readonly total: number; readonly rate: number | null };
	};
	readonly stability: readonly {
		readonly max_model_turns: M7MaxModelTurns;
		readonly config_id: RepoFixConfigId;
		readonly replicate_group_count: number;
		readonly complete_replicate_group_count: number;
		readonly unstable_replicate_group_count: number;
	}[];
	readonly safety: M8SecuritySummary;
	readonly failure_root_causes: readonly M8FailureRootCause[];
	readonly conclusion_boundaries: readonly string[];
	readonly report_sha256: string;
}

export interface M8AnalysisSourcePaths {
	readonly continuation_report_path: string;
	readonly security_audit_report_path: string;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function expectSha256(value: unknown, label: string): string {
	const text = expectString(value, label);
	if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} must be a lowercase SHA-256`);
	return text;
}

function expectCount(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${label} must be a non-negative safe integer`);
	return value;
}

function expectConfigId(value: unknown, label: string): RepoFixConfigId {
	if (
		value === "pi-general" ||
		value === "repofix-full" ||
		value === "repofix-no-localize" ||
		value === "repofix-no-verify-feedback"
	)
		return value;
	throw new Error(`${label} is not a RepoFixLab configuration ID`);
}

function expectTurns(value: unknown, label: string): M7MaxModelTurns {
	if (value === 64 || value === 128) return value;
	throw new Error(`${label} must be 64 or 128`);
}

function expectObservationStatus(value: unknown, label: string): M7ObservationStatus {
	if (value === "retained_64_turn" || value === "continued_128_turn" || value === "continuation_failed") return value;
	throw new Error(`${label} is invalid`);
}

function verifyReportHash(value: JsonRecord, label: string): string {
	const reportSha256 = expectSha256(value.report_sha256, `${label}.report_sha256`);
	const { report_sha256: _ignored, ...unsigned } = value;
	if (sha256(unsigned) !== reportSha256) throw new Error(`${label} canonical SHA-256 is invalid`);
	return reportSha256;
}

function parseM7ContinuationInput(value: unknown): M7ContinuationInput {
	if (!isRecord(value)) throw new Error("M7 continuation report must be an object");
	const reportSha256 = verifyReportHash(value, "M7 continuation report");
	if (value.schema_version !== "v1" || value.report_type !== "m7_continuation_report" || value.status !== "pass") {
		throw new Error("M7 continuation report is not a passing v1 continuation report");
	}
	if (value.comparison_scope !== "turn_limit_stratified_no_cross_stratum_pairing") {
		throw new Error("M7 continuation report comparison scope is invalid");
	}
	if (!Array.isArray(value.observations)) throw new Error("M7 continuation observations must be an array");
	const observations = value.observations.map((item, index): M7ObservationRecord => {
		if (!isRecord(item)) throw new Error(`M7 continuation observation ${index} must be an object`);
		const continuationRunId = item.continuation_run_id;
		const resultSha256 = item.result_sha256;
		const resolved = item.resolved;
		if (continuationRunId !== null && typeof continuationRunId !== "string")
			throw new Error(`M7 continuation observation ${index}.continuation_run_id is invalid`);
		if (resultSha256 !== null && typeof resultSha256 !== "string")
			throw new Error(`M7 continuation observation ${index}.result_sha256 is invalid`);
		if (resolved !== null && typeof resolved !== "boolean")
			throw new Error(`M7 continuation observation ${index}.resolved is invalid`);
		return {
			source_run_id: expectString(item.source_run_id, `M7 continuation observation ${index}.source_run_id`),
			continuation_run_id: continuationRunId,
			group_id: expectString(item.group_id, `M7 continuation observation ${index}.group_id`),
			instance_id: expectString(item.instance_id, `M7 continuation observation ${index}.instance_id`),
			config_id: expectConfigId(item.config_id, `M7 continuation observation ${index}.config_id`),
			replicate: expectCount(item.replicate, `M7 continuation observation ${index}.replicate`),
			max_model_turns: expectTurns(item.max_model_turns, `M7 continuation observation ${index}.max_model_turns`),
			status: expectObservationStatus(item.status, `M7 continuation observation ${index}.status`),
			terminal_reason: expectString(item.terminal_reason, `M7 continuation observation ${index}.terminal_reason`),
			resolved,
			result_sha256:
				resultSha256 === null
					? null
					: expectSha256(resultSha256, `M7 continuation observation ${index}.result_sha256`),
		};
	});
	return {
		report_sha256: reportSha256,
		status: "pass",
		expected_original_run_count: expectCount(
			value.expected_original_run_count,
			"M7 continuation report.expected_original_run_count",
		),
		terminal_observation_count: expectCount(
			value.terminal_observation_count,
			"M7 continuation report.terminal_observation_count",
		),
		comparison_scope: "turn_limit_stratified_no_cross_stratum_pairing",
		observations,
	};
}

function parseM7SecurityInput(value: unknown): M7SecurityInput {
	if (!isRecord(value)) throw new Error("M7 security audit must be an object");
	const reportSha256 = verifyReportHash(value, "M7 security audit");
	if (value.schema_version !== "v1" || value.report_type !== "m7_security_audit" || value.status !== "pass") {
		throw new Error("M7 security audit is not a passing v1 security audit");
	}
	if (!isRecord(value.security) || !Array.isArray(value.runs))
		throw new Error("M7 security audit evidence is malformed");
	const evidenceMissingRunIds = value.security.evidence_missing_run_ids;
	if (!Array.isArray(evidenceMissingRunIds) || !evidenceMissingRunIds.every((item) => typeof item === "string")) {
		throw new Error("M7 security audit evidence_missing_run_ids is invalid");
	}
	const security = {
		evidence_run_count: expectCount(
			value.security.evidence_run_count,
			"M7 security audit.security.evidence_run_count",
		),
		evidence_missing_run_ids: evidenceMissingRunIds,
		blocked_operation_count: expectCount(
			value.security.blocked_operation_count,
			"M7 security audit.security.blocked_operation_count",
		),
		policy_violation_count: expectCount(
			value.security.policy_violation_count,
			"M7 security audit.security.policy_violation_count",
		),
		sandbox_escape_attempt_count: expectCount(
			value.security.sandbox_escape_attempt_count,
			"M7 security audit.security.sandbox_escape_attempt_count",
		),
	};
	const runs = value.runs.map((item, index): M7SecurityRunInput => {
		if (!isRecord(item)) throw new Error(`M7 security audit run ${index} must be an object`);
		return {
			source_run_id: expectString(item.source_run_id, `M7 security audit run ${index}.source_run_id`),
			execution_run_id: expectString(item.execution_run_id, `M7 security audit run ${index}.execution_run_id`),
			max_model_turns: expectTurns(item.max_model_turns, `M7 security audit run ${index}.max_model_turns`),
			status: expectObservationStatus(item.status, `M7 security audit run ${index}.status`),
			blocked_operation_count: expectCount(
				item.blocked_operation_count,
				`M7 security audit run ${index}.blocked_operation_count`,
			),
			policy_violation_count: expectCount(
				item.policy_violation_count,
				`M7 security audit run ${index}.policy_violation_count`,
			),
			sandbox_escape_attempt_count: expectCount(
				item.sandbox_escape_attempt_count,
				`M7 security audit run ${index}.sandbox_escape_attempt_count`,
			),
			unblocked_sandbox_escape_attempt_count: expectCount(
				item.unblocked_sandbox_escape_attempt_count,
				`M7 security audit run ${index}.unblocked_sandbox_escape_attempt_count`,
			),
		};
	});
	return {
		report_sha256: reportSha256,
		status: "pass",
		audited_run_count: expectCount(value.audited_run_count, "M7 security audit.audited_run_count"),
		unblocked_sandbox_escape_attempt_count: expectCount(
			value.unblocked_sandbox_escape_attempt_count,
			"M7 security audit.unblocked_sandbox_escape_attempt_count",
		),
		security,
		runs,
	};
}

function repositoryFor(instanceId: string): string {
	const separator = instanceId.indexOf("__");
	return separator > 0 ? instanceId.slice(0, separator) : "unknown";
}

function safeArtifactPath(artifactsRoot: string, relativePath: string): string {
	if (relativePath.length === 0 || relativePath.includes("\u0000"))
		throw new Error("M8 input artifact path is invalid");
	const root = resolve(artifactsRoot);
	const candidate = resolve(root, relativePath);
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
		throw new Error("M8 input artifact path escapes the artifacts root");
	return candidate;
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function usageFromResult(result: RunResult): M8Usage {
	if (result.usage.provider_actual_tokens === null)
		throw new Error(`M8 run result usage is incomplete: ${result.run_id}`);
	return {
		evidence_source: "run_result",
		evidence_sha256: result.result_sha256,
		accounted_tokens: result.usage.accounted_tokens,
		provider_actual_tokens: result.usage.provider_actual_tokens,
		model_turns: result.usage.model_turns,
		cost_complete: result.usage.cost_complete,
		estimated_cost_cny_nano: result.usage.estimated_cost_cny_nano,
	};
}

function nullableCount(value: unknown, label: string): number | null {
	if (value === null) return null;
	return expectCount(value, label);
}

async function loadFailedTokenLedger(artifactsRoot: string, runId: string): Promise<M8Usage> {
	const ledgerPath = safeArtifactPath(artifactsRoot, `m4-dev/runs/${runId}/token-ledger.jsonl`);
	const bytes = await readFile(ledgerPath);
	const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().split("\n");
	if (lines.length === 0 || (lines.length === 1 && lines[0] === ""))
		throw new Error(`M8 failed token ledger is empty: ${runId}`);
	const reservations = new Map<string, number>();
	let accountedTokens = 0;
	let providerActualTokens = 0;
	let modelTurns = 0;
	for (const [index, line] of lines.entries()) {
		const value = JSON.parse(line) as unknown;
		if (!isRecord(value) || value.schema_version !== "v1" || value.run_id !== runId) {
			throw new Error(`M8 failed token ledger binding is invalid: ${runId}:${index}`);
		}
		const eventType = value.event_type;
		const requestId = expectString(value.request_id, `M8 failed token ledger request_id ${runId}:${index}`);
		const reservationTokens = nullableCount(
			value.reservation_tokens,
			`M8 failed token ledger reservation_tokens ${runId}:${index}`,
		);
		if (eventType === "reservation_open") {
			if (reservationTokens === null || reservations.has(requestId))
				throw new Error(`M8 failed token ledger open reservation is invalid: ${runId}:${index}`);
			reservations.set(requestId, reservationTokens);
			continue;
		}
		if (eventType !== "reservation_settled") {
			throw new Error(`M8 failed token ledger contains unverified or rejected usage: ${runId}:${index}`);
		}
		const reserved = reservations.get(requestId);
		const settledTokens = nullableCount(
			value.accounted_tokens,
			`M8 failed token ledger accounted_tokens ${runId}:${index}`,
		);
		const providerTotalTokens = nullableCount(
			value.provider_total_tokens,
			`M8 failed token ledger provider_total_tokens ${runId}:${index}`,
		);
		if (
			reserved === undefined ||
			reservationTokens !== reserved ||
			settledTokens === null ||
			providerTotalTokens === null ||
			settledTokens !== providerTotalTokens ||
			settledTokens > reserved
		) {
			throw new Error(`M8 failed token ledger settlement is invalid: ${runId}:${index}`);
		}
		reservations.delete(requestId);
		accountedTokens += settledTokens;
		providerActualTokens += providerTotalTokens;
		modelTurns += 1;
	}
	if (reservations.size !== 0) throw new Error(`M8 failed token ledger has open reservations: ${runId}`);
	return {
		evidence_source: "failed_token_ledger",
		evidence_sha256: createHash("sha256").update(bytes).digest("hex"),
		accounted_tokens: accountedTokens,
		provider_actual_tokens: providerActualTokens,
		model_turns: modelTurns,
		cost_complete: false,
		estimated_cost_cny_nano: null,
	};
}

async function loadObservations(
	artifactsRoot: string,
	continuation: M7ContinuationInput,
): Promise<readonly M8AnalysisObservation[]> {
	const observations: M8AnalysisObservation[] = [];
	for (const observation of continuation.observations) {
		const executionRunId = observation.continuation_run_id ?? observation.source_run_id;
		const runRoot = observation.max_model_turns === 64 ? "m7-v1.7.2" : "m7-v1.7.3";
		if (observation.status === "continuation_failed") {
			if (
				observation.resolved !== null ||
				observation.result_sha256 !== null ||
				observation.continuation_run_id === null
			) {
				throw new Error(`M7 failed continuation observation is malformed: ${observation.source_run_id}`);
			}
			observations.push({
				source_run_id: observation.source_run_id,
				execution_run_id: executionRunId,
				group_id: observation.group_id,
				instance_id: observation.instance_id,
				repository: repositoryFor(observation.instance_id),
				config_id: observation.config_id,
				replicate: observation.replicate,
				max_model_turns: observation.max_model_turns,
				status: observation.status,
				terminal_reason: observation.terminal_reason,
				result: null,
				evaluation: null,
				usage: await loadFailedTokenLedger(artifactsRoot, executionRunId),
			});
			continue;
		}
		const result = verifyRunResult(
			await readJson(safeArtifactPath(artifactsRoot, `${runRoot}/results/${executionRunId}.json`)),
		);
		const evaluation = verifyEvaluationResult(
			await readJson(
				safeArtifactPath(artifactsRoot, `${runRoot}/runs/${executionRunId}/evaluation-normalized.json`),
			),
		);
		if (
			result.run_id !== executionRunId ||
			result.result_sha256 !== observation.result_sha256 ||
			result.resolved !== observation.resolved ||
			result.termination_reason !== observation.terminal_reason ||
			evaluation.run_id !== result.run_id ||
			evaluation.attempt_id !== result.attempt_id ||
			evaluation.evaluation_sha256 !== result.evaluation_result_sha256 ||
			evaluation.resolved !== result.resolved
		) {
			throw new Error(`M7 official evaluation binding drifted: ${observation.source_run_id}`);
		}
		observations.push({
			source_run_id: observation.source_run_id,
			execution_run_id: executionRunId,
			group_id: observation.group_id,
			instance_id: observation.instance_id,
			repository: repositoryFor(observation.instance_id),
			config_id: observation.config_id,
			replicate: observation.replicate,
			max_model_turns: observation.max_model_turns,
			status: observation.status,
			terminal_reason: observation.terminal_reason,
			result,
			evaluation,
			usage: usageFromResult(result),
		});
	}
	return observations.sort((left, right) => left.source_run_id.localeCompare(right.source_run_id));
}

function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * p) - 1] ?? null;
}

function rate(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

function wilson95(successes: number, total: number): WilsonInterval | null {
	if (total === 0) return null;
	const proportion = successes / total;
	const zSquared = Z_95 * Z_95;
	const denominator = 1 + zSquared / total;
	const center = (proportion + zSquared / (2 * total)) / denominator;
	const margin =
		(Z_95 * Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (4 * total * total))) / denominator;
	return { confidence_level: 0.95, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function configurationSummaries(observations: readonly M8AnalysisObservation[]): readonly M8ConfigurationSummary[] {
	const configIds = ["pi-general", "repofix-full", "repofix-no-localize", "repofix-no-verify-feedback"] as const;
	return ([64, 128] as const).flatMap((maxModelTurns) =>
		configIds.flatMap((configId) => {
			const members = observations.filter(
				(item) => item.max_model_turns === maxModelTurns && item.config_id === configId,
			);
			if (members.length === 0) return [];
			const results = members.flatMap((item) => (item.result === null ? [] : [item.result]));
			const resolved = results.filter((result) => result.resolved).length;
			const costComplete = members.every((item) => item.usage.cost_complete);
			return [
				{
					max_model_turns: maxModelTurns,
					config_id: configId,
					planned_count: members.length,
					official_evaluation_count: results.length,
					usage_evidence_count: members.length,
					wall_time_evidence_count: results.length,
					official_resolved_count: resolved,
					official_unresolved_count: results.length - resolved,
					agent_terminal_without_evaluation_count: members.length - results.length,
					intention_to_treat_resolved_rate: resolved / members.length,
					intention_to_treat_wilson_95: wilson95(resolved, members.length),
					evaluated_resolved_rate: rate(resolved, results.length),
					accounted_tokens: members.reduce((total, item) => total + item.usage.accounted_tokens, 0),
					provider_actual_tokens: members.reduce((total, item) => total + item.usage.provider_actual_tokens, 0),
					cost_complete: costComplete,
					estimated_cost_cny_nano: costComplete
						? results.reduce((total, result) => total + (result.usage.estimated_cost_cny_nano ?? 0), 0)
						: null,
					wall_time_ms: {
						p50: percentile(
							results.map((result) => result.wall_time_ms),
							0.5,
						),
						p90: percentile(
							results.map((result) => result.wall_time_ms),
							0.9,
						),
						total: results.reduce((total, result) => total + result.wall_time_ms, 0),
					},
					model_turns: members.reduce((total, item) => total + item.usage.model_turns, 0),
				},
			];
		}),
	);
}

interface PairOutcome {
	readonly repository: string;
	readonly piGeneralResolved: boolean;
	readonly repofixFullResolved: boolean;
}

function pairKey(observation: M8AnalysisObservation): string {
	return `${observation.group_id}\u0000${observation.instance_id}\u0000${observation.replicate}`;
}

function exactMcNemarPValue(treatmentWins: number, baselineWins: number): number | null {
	const discordant = treatmentWins + baselineWins;
	if (discordant === 0) return null;
	const lowerBound = Math.min(treatmentWins, baselineWins);
	let mass = 2 ** -discordant;
	let cumulative = mass;
	for (let index = 1; index <= lowerBound; index += 1) {
		mass *= (discordant - index + 1) / index;
		cumulative += mass;
	}
	return Math.min(1, 2 * cumulative);
}

function bootstrapRepositoryInterval(pairs: readonly PairOutcome[]): M8PairedComparison["repository_bootstrap_95"] {
	const repositories = [...new Set(pairs.map((pair) => pair.repository))].sort();
	if (repositories.length === 0) return null;
	const byRepository = new Map(
		repositories.map((repository) => [repository, pairs.filter((pair) => pair.repository === repository)]),
	);
	let state = BOOTSTRAP_SEED >>> 0;
	const values: number[] = [];
	for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
		let piGeneral = 0;
		let repofixFull = 0;
		let count = 0;
		for (let draw = 0; draw < repositories.length; draw += 1) {
			state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
			const repository = repositories[Math.floor((state / 2 ** 32) * repositories.length)]!;
			for (const pair of byRepository.get(repository) ?? []) {
				piGeneral += Number(pair.piGeneralResolved);
				repofixFull += Number(pair.repofixFullResolved);
				count += 1;
			}
		}
		if (count > 0) values.push((repofixFull - piGeneral) / count);
	}
	return {
		repository_count: repositories.length,
		samples: BOOTSTRAP_SAMPLES,
		seed: BOOTSTRAP_SEED,
		lower: percentile(values, 0.025) ?? 0,
		upper: percentile(values, 0.975) ?? 0,
	};
}

function pairedComparisons(observations: readonly M8AnalysisObservation[]): readonly M8PairedComparison[] {
	return ([64, 128] as const).map((maxModelTurns) => {
		const candidates = observations.filter(
			(item) =>
				item.max_model_turns === maxModelTurns &&
				item.group_id === "main" &&
				(item.config_id === "pi-general" || item.config_id === "repofix-full"),
		);
		const byKey = new Map<
			string,
			{ piGeneral: M8AnalysisObservation | null; repofixFull: M8AnalysisObservation | null }
		>();
		for (const observation of candidates) {
			const key = pairKey(observation);
			const current = byKey.get(key) ?? { piGeneral: null, repofixFull: null };
			if (observation.config_id === "pi-general") {
				if (current.piGeneral !== null) throw new Error(`M8 paired comparison has duplicate Pi baseline: ${key}`);
				current.piGeneral = observation;
			} else {
				if (current.repofixFull !== null)
					throw new Error(`M8 paired comparison has duplicate RepoFix treatment: ${key}`);
				current.repofixFull = observation;
			}
			byKey.set(key, current);
		}
		const pairs: PairOutcome[] = [];
		let incompletePairCount = 0;
		for (const value of byKey.values()) {
			if (
				value.piGeneral?.result === null ||
				value.repofixFull?.result === null ||
				value.piGeneral === null ||
				value.repofixFull === null
			) {
				incompletePairCount += 1;
				continue;
			}
			pairs.push({
				repository: value.piGeneral.repository,
				piGeneralResolved: value.piGeneral.result.resolved,
				repofixFullResolved: value.repofixFull.result.resolved,
			});
		}
		const piGeneralResolved = pairs.filter((pair) => pair.piGeneralResolved).length;
		const repofixFullResolved = pairs.filter((pair) => pair.repofixFullResolved).length;
		const repofixOnlyResolved = pairs.filter((pair) => !pair.piGeneralResolved && pair.repofixFullResolved).length;
		const piOnlyResolved = pairs.filter((pair) => pair.piGeneralResolved && !pair.repofixFullResolved).length;
		const repositories = [...new Set(pairs.map((pair) => pair.repository))].sort();
		return {
			max_model_turns: maxModelTurns,
			group_id: "main" as const,
			comparison: "repofix-full_minus_pi-general" as const,
			matched_pair_count: pairs.length,
			incomplete_pair_count: incompletePairCount,
			repofix_full_resolved_count: repofixFullResolved,
			pi_general_resolved_count: piGeneralResolved,
			resolved_rate_difference: pairs.length === 0 ? 0 : (repofixFullResolved - piGeneralResolved) / pairs.length,
			repofix_only_resolved_count: repofixOnlyResolved,
			pi_only_resolved_count: piOnlyResolved,
			mcnemar_exact_two_sided_p_value: exactMcNemarPValue(repofixOnlyResolved, piOnlyResolved),
			repository_bootstrap_95: bootstrapRepositoryInterval(pairs),
			leave_one_repository_out: repositories.map((excludedRepository) => {
				const remaining = pairs.filter((pair) => pair.repository !== excludedRepository);
				return {
					excluded_repository: excludedRepository,
					matched_pair_count: remaining.length,
					resolved_rate_difference:
						remaining.length === 0
							? null
							: (remaining.filter((pair) => pair.repofixFullResolved).length -
									remaining.filter((pair) => pair.piGeneralResolved).length) /
								remaining.length,
				};
			}),
		};
	});
}

function evaluatorTestSummary(observations: readonly M8AnalysisObservation[]): M8AnalysisReport["evaluator_tests"] {
	let failToPassPassed = 0;
	let failToPassTotal = 0;
	let passToPassPassed = 0;
	let passToPassTotal = 0;
	for (const observation of observations) {
		const evaluation = observation.evaluation;
		if (evaluation === null) continue;
		failToPassPassed += evaluation.fail_to_pass.success.length;
		failToPassTotal += evaluation.fail_to_pass.success.length + evaluation.fail_to_pass.failure.length;
		passToPassPassed += evaluation.pass_to_pass.success.length;
		passToPassTotal += evaluation.pass_to_pass.success.length + evaluation.pass_to_pass.failure.length;
	}
	return {
		fail_to_pass: { passed: failToPassPassed, total: failToPassTotal, rate: rate(failToPassPassed, failToPassTotal) },
		pass_to_pass: { passed: passToPassPassed, total: passToPassTotal, rate: rate(passToPassPassed, passToPassTotal) },
	};
}

function stabilitySummary(observations: readonly M8AnalysisObservation[]): M8AnalysisReport["stability"] {
	const configIds = ["pi-general", "repofix-full", "repofix-no-localize", "repofix-no-verify-feedback"] as const;
	return ([64, 128] as const).flatMap((maxModelTurns) =>
		configIds.flatMap((configId) => {
			const members = observations.filter(
				(item) => item.max_model_turns === maxModelTurns && item.config_id === configId,
			);
			if (members.length === 0) return [];
			const groups = new Map<string, M8AnalysisObservation[]>();
			for (const member of members) {
				const current = groups.get(member.instance_id) ?? [];
				current.push(member);
				groups.set(member.instance_id, current);
			}
			const replicateGroups = [...groups.values()].filter((group) => group.length > 1);
			const complete = replicateGroups.filter((group) => group.every((item) => item.result !== null));
			return [
				{
					max_model_turns: maxModelTurns,
					config_id: configId,
					replicate_group_count: replicateGroups.length,
					complete_replicate_group_count: complete.length,
					unstable_replicate_group_count: complete.filter(
						(group) => new Set(group.map((item) => item.result?.resolved)).size > 1,
					).length,
				},
			];
		}),
	);
}

function rootCause(observation: M8AnalysisObservation): M8FailureRootCause["category"] | null {
	if (observation.result === null) return "agent_no_final_snapshot";
	if (observation.result.resolved) return null;
	const evaluation = observation.evaluation;
	if (evaluation === null) throw new Error(`M8 official evaluation is missing: ${observation.source_run_id}`);
	if (evaluation.candidate_patch_apply_status !== "applied") return "candidate_patch_not_applied";
	if (evaluation.timed_out) return "evaluator_timeout";
	if (evaluation.fail_to_pass.failure.length > 0) return "fail_to_pass_failure";
	if (evaluation.pass_to_pass.failure.length > 0) return "pass_to_pass_regression";
	return "official_unresolved_other";
}

function failureRootCauses(observations: readonly M8AnalysisObservation[]): readonly M8FailureRootCause[] {
	const grouped = new Map<M8FailureRootCause["category"], string[]>();
	for (const observation of observations) {
		const category = rootCause(observation);
		if (category === null) continue;
		const current = grouped.get(category) ?? [];
		current.push(observation.source_run_id);
		grouped.set(category, current);
	}
	return [...grouped.entries()]
		.map(([category, sourceRunIds]) => ({
			category,
			count: sourceRunIds.length,
			sample_source_run_ids: sourceRunIds.sort().slice(0, 3),
		}))
		.sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}

function validateSecurityBinding(
	observations: readonly M8AnalysisObservation[],
	security: M7SecurityInput,
): M8SecuritySummary {
	if (
		security.audited_run_count !== EXPECTED_OBSERVATION_COUNT ||
		security.security.evidence_run_count !== EXPECTED_OBSERVATION_COUNT ||
		security.security.evidence_missing_run_ids.length !== 0 ||
		security.unblocked_sandbox_escape_attempt_count !== 0 ||
		security.security.policy_violation_count !== 0
	) {
		throw new Error("M7 security audit did not satisfy the M8 safety admission gate");
	}
	const securityBySourceRunId = new Map(security.runs.map((run) => [run.source_run_id, run]));
	if (securityBySourceRunId.size !== observations.length)
		throw new Error("M7 security audit has duplicate or missing source run identities");
	for (const observation of observations) {
		const audit = securityBySourceRunId.get(observation.source_run_id);
		if (
			audit === undefined ||
			audit.execution_run_id !== observation.execution_run_id ||
			audit.max_model_turns !== observation.max_model_turns ||
			audit.status !== observation.status ||
			audit.unblocked_sandbox_escape_attempt_count !== 0
		) {
			throw new Error(`M7 security audit binding drifted: ${observation.source_run_id}`);
		}
	}
	return {
		report_sha256: security.report_sha256,
		blocked_operation_count: security.security.blocked_operation_count,
		policy_violation_count: security.security.policy_violation_count,
		sandbox_escape_attempt_count: security.security.sandbox_escape_attempt_count,
		unblocked_sandbox_escape_attempt_count: security.unblocked_sandbox_escape_attempt_count,
	};
}

export function createM8Analysis(
	observations: readonly M8AnalysisObservation[],
	continuationReportSha256: string,
	security: M8SecuritySummary,
): M8AnalysisReport {
	if (
		observations.length !== EXPECTED_OBSERVATION_COUNT ||
		new Set(observations.map((item) => item.source_run_id)).size !== observations.length
	) {
		throw new Error("M8 analysis requires exactly 74 uniquely identified terminal observations");
	}
	const results = observations.flatMap((observation) => (observation.result === null ? [] : [observation.result]));
	const resolved = results.filter((result) => result.resolved).length;
	const officialUnresolved = results.length - resolved;
	const agentFailures = observations.length - results.length;
	const accountedTokens = observations.reduce((total, observation) => total + observation.usage.accounted_tokens, 0);
	const providerActualTokens = observations.reduce(
		(total, observation) => total + observation.usage.provider_actual_tokens,
		0,
	);
	const costComplete = observations.every((observation) => observation.usage.cost_complete);
	const overallWilson = wilson95(resolved, observations.length);
	if (overallWilson === null) throw new Error("M8 overall Wilson interval is unavailable");
	const unsigned = {
		schema_version: "v1" as const,
		report_type: "m8_analysis" as const,
		status: "pass" as const,
		method_revision: M8_METHOD_REVISION,
		source: {
			m7_continuation_report_sha256: expectSha256(continuationReportSha256, "M8 continuation report SHA-256"),
			m7_security_audit_report_sha256: expectSha256(security.report_sha256, "M8 security audit report SHA-256"),
			comparison_scope: "turn_limit_stratified_no_cross_stratum_pairing" as const,
			unreconciled_source_provider_request_excluded_from_usage: true as const,
		},
		population: {
			planned_logical_run_count: observations.length,
			official_evaluation_count: results.length,
			official_resolved_count: resolved,
			official_unresolved_count: officialUnresolved,
			agent_terminal_without_evaluation_count: agentFailures,
			intention_to_treat_resolved_rate: resolved / observations.length,
			intention_to_treat_wilson_95: overallWilson,
			evaluated_resolved_rate: resolved / results.length,
			accounted_tokens: accountedTokens,
			provider_actual_tokens: providerActualTokens,
			cost_complete: costComplete,
			estimated_cost_cny_nano: costComplete
				? observations.reduce((total, observation) => total + (observation.usage.estimated_cost_cny_nano ?? 0), 0)
				: null,
		},
		configurations: configurationSummaries(observations),
		paired_comparisons: pairedComparisons(observations),
		evaluator_tests: evaluatorTestSummary(observations),
		stability: stabilitySummary(observations),
		safety: security,
		failure_root_causes: failureRootCauses(observations),
		conclusion_boundaries: [
			"The primary denominator is all 74 frozen logical runs; three Agent terminal failures remain in the denominator.",
			"Official repair outcomes are available for 71 runs. The evaluated-only rate is descriptive and must not replace the intention-to-treat rate.",
			"All configuration comparisons are stratified by max_model_turns. The retained 64-turn and continued 128-turn results are never pooled into a fixed-budget head-to-head claim.",
			"M7 uses a 26-task SWE-bench Multilingual JS/TS pool and one fixed model revision; conclusions do not generalize to other languages, models, dates, or task distributions.",
			"CNY is reported only when every included run has complete frozen pricing evidence. Missing cost evidence remains unavailable rather than estimated post hoc.",
		],
	};
	return { ...unsigned, report_sha256: sha256(unsigned) };
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function percent(value: number | null): string {
	return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function createM8Markdown(report: M8AnalysisReport): string {
	const configurationRows = report.configurations
		.map(
			(item) =>
				`| ${item.max_model_turns} | ${item.config_id} | ${item.official_resolved_count}/${item.planned_count} | ${percent(item.intention_to_treat_resolved_rate)} | ${item.official_evaluation_count}/${item.planned_count} | ${item.usage_evidence_count}/${item.planned_count} | ${item.accounted_tokens} | ${item.estimated_cost_cny_nano === null ? "unavailable" : item.estimated_cost_cny_nano} |`,
		)
		.join("\n");
	const comparisonRows = report.paired_comparisons
		.map(
			(item) =>
				`| ${item.max_model_turns} | ${item.matched_pair_count} | ${item.incomplete_pair_count} | ${percent(item.resolved_rate_difference)} | ${item.repofix_only_resolved_count} | ${item.pi_only_resolved_count} | ${item.mcnemar_exact_two_sided_p_value?.toFixed(6) ?? "n/a"} |`,
		)
		.join("\n");
	const failureRows = report.failure_root_causes
		.map((item) => `| ${item.category} | ${item.count} | ${item.sample_source_run_ids.join(", ")} |`)
		.join("\n");
	return `# RepoFixLab M8 Final Analysis\n\n## Scope\n\n- Frozen logical runs: ${report.population.planned_logical_run_count}\n- Official evaluations: ${report.population.official_evaluation_count}\n- Official resolved: ${report.population.official_resolved_count}\n- Resolved / frozen logical runs: ${report.population.official_resolved_count}/${report.population.planned_logical_run_count}\n- Official unresolved: ${report.population.official_unresolved_count}\n- Agent terminal without final snapshot: ${report.population.agent_terminal_without_evaluation_count}\n- Intention-to-treat resolved rate: ${percent(report.population.intention_to_treat_resolved_rate)} (Wilson 95% ${percent(report.population.intention_to_treat_wilson_95.lower)} to ${percent(report.population.intention_to_treat_wilson_95.upper)})\n- Evaluated-only resolved rate: ${percent(report.population.evaluated_resolved_rate)}\n- Accounted Tokens: ${report.population.accounted_tokens}\n- Provider actual Tokens: ${report.population.provider_actual_tokens}\n- CNY: ${report.population.estimated_cost_cny_nano === null ? "unavailable because frozen per-run pricing evidence is incomplete" : report.population.estimated_cost_cny_nano}\n\n## Configuration results, stratified by turn limit\n\n| Max turns | Configuration | Resolved / planned | ITT rate | Official evidence | Usage evidence | Accounted Tokens | CNY nano |\n| ---: | --- | --- | ---: | --- | --- | ---: | --- |\n${configurationRows}\n\n## Main paired comparison: RepoFix-full minus Pi-general\n\n| Max turns | Complete pairs | Incomplete pairs | Difference | RepoFix-only wins | Pi-only wins | McNemar exact p |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${comparisonRows}\n\n## Evaluator and safety evidence\n\n- Fail-to-pass: ${report.evaluator_tests.fail_to_pass.passed}/${report.evaluator_tests.fail_to_pass.total} (${percent(report.evaluator_tests.fail_to_pass.rate)})\n- Pass-to-pass: ${report.evaluator_tests.pass_to_pass.passed}/${report.evaluator_tests.pass_to_pass.total} (${percent(report.evaluator_tests.pass_to_pass.rate)})\n- Blocked operations: ${report.safety.blocked_operation_count}\n- Policy violations: ${report.safety.policy_violation_count}\n- Sandbox-escape attempts: ${report.safety.sandbox_escape_attempt_count}; unblocked: ${report.safety.unblocked_sandbox_escape_attempt_count}\n\n## Failure root causes\n\n| Category | Count | Example source run IDs |\n| --- | ---: | --- |\n${failureRows}\n\n## Conclusion boundaries\n\n${report.conclusion_boundaries.map((boundary) => `- ${boundary}`).join("\n")}\n\n## Evidence bindings\n\n- M7 continuation report SHA-256: \`${report.source.m7_continuation_report_sha256}\`\n- M7 security audit SHA-256: \`${report.source.m7_security_audit_report_sha256}\`\n- M8 analysis SHA-256: \`${report.report_sha256}\`\n`;
}

function createM8Html(report: M8AnalysisReport): string {
	const configurationRows = report.configurations
		.map(
			(item) =>
				`<tr><td>${item.max_model_turns}</td><td>${escapeHtml(item.config_id)}</td><td>${item.official_resolved_count}/${item.planned_count}</td><td>${percent(item.intention_to_treat_resolved_rate)}</td><td>${item.official_evaluation_count}/${item.planned_count}</td><td>${item.usage_evidence_count}/${item.planned_count}</td><td>${item.accounted_tokens}</td></tr>`,
		)
		.join("");
	const comparisonRows = report.paired_comparisons
		.map(
			(item) =>
				`<tr><td>${item.max_model_turns}</td><td>${item.matched_pair_count}</td><td>${item.incomplete_pair_count}</td><td>${percent(item.resolved_rate_difference)}</td><td>${item.repofix_only_resolved_count}</td><td>${item.pi_only_resolved_count}</td><td>${item.mcnemar_exact_two_sided_p_value?.toFixed(6) ?? "n/a"}</td></tr>`,
		)
		.join("");
	const failureRows = report.failure_root_causes
		.map(
			(item) =>
				`<tr><td>${escapeHtml(item.category)}</td><td>${item.count}</td><td>${escapeHtml(item.sample_source_run_ids.join(", "))}</td></tr>`,
		)
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RepoFixLab M8 analysis</title></head><body><main><h1>RepoFixLab M8 final analysis</h1><p>Frozen runs: ${report.population.planned_logical_run_count}; official resolved: ${report.population.official_resolved_count}/${report.population.planned_logical_run_count}; intention-to-treat rate: ${percent(report.population.intention_to_treat_resolved_rate)}; official evaluations: ${report.population.official_evaluation_count}; Provider actual Tokens: ${report.population.provider_actual_tokens}.</p><h2>Configuration results, stratified by turn limit</h2><table><thead><tr><th>Max turns</th><th>Configuration</th><th>Resolved / planned</th><th>ITT rate</th><th>Official evidence</th><th>Usage evidence</th><th>Accounted Tokens</th></tr></thead><tbody>${configurationRows}</tbody></table><h2>Main paired comparison: RepoFix-full minus Pi-general</h2><table><thead><tr><th>Max turns</th><th>Complete pairs</th><th>Incomplete pairs</th><th>Difference</th><th>RepoFix-only wins</th><th>Pi-only wins</th><th>McNemar exact p</th></tr></thead><tbody>${comparisonRows}</tbody></table><h2>Failure root causes</h2><table><thead><tr><th>Category</th><th>Count</th><th>Example source run IDs</th></tr></thead><tbody>${failureRows}</tbody></table><h2>Safety</h2><p>Blocked operations: ${report.safety.blocked_operation_count}; policy violations: ${report.safety.policy_violation_count}; sandbox escape attempts: ${report.safety.sandbox_escape_attempt_count}; unblocked attempts: ${report.safety.unblocked_sandbox_escape_attempt_count}.</p><h2>Conclusion boundaries</h2><ul>${report.conclusion_boundaries.map((boundary) => `<li>${escapeHtml(boundary)}</li>`).join("")}</ul><p>M8 SHA-256: <code>${report.report_sha256}</code></p></main></body></html>`;
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
		if ((await readFile(path, "utf8")) !== content) throw new Error(`Immutable M8 report conflict: ${path}`);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function publishM8Analysis(
	artifactsRoot: string,
	sourcePaths: M8AnalysisSourcePaths,
): Promise<{
	readonly report: M8AnalysisReport;
	readonly json_path: string;
	readonly markdown_path: string;
	readonly html_path: string;
}> {
	const root = resolve(artifactsRoot);
	const continuation = parseM7ContinuationInput(
		await readJson(safeArtifactPath(root, sourcePaths.continuation_report_path)),
	);
	if (
		continuation.expected_original_run_count !== EXPECTED_OBSERVATION_COUNT ||
		continuation.terminal_observation_count !== EXPECTED_OBSERVATION_COUNT
	) {
		throw new Error("M7 continuation report does not cover the fixed 74-run M8 population");
	}
	const securityInput = parseM7SecurityInput(
		await readJson(safeArtifactPath(root, sourcePaths.security_audit_report_path)),
	);
	const observations = await loadObservations(root, continuation);
	const security = validateSecurityBinding(observations, securityInput);
	const report = createM8Analysis(observations, continuation.report_sha256, security);
	const reportRoot = join(root, "m8", "report");
	const jsonPath = join(reportRoot, `analysis-${report.report_sha256}.json`);
	const markdownPath = join(reportRoot, `analysis-${report.report_sha256}.md`);
	const htmlPath = join(reportRoot, `analysis-${report.report_sha256}.html`);
	await Promise.all([
		writeImmutable(jsonPath, stableStringify(report)),
		writeImmutable(markdownPath, createM8Markdown(report)),
		writeImmutable(htmlPath, createM8Html(report)),
	]);
	return { report, json_path: jsonPath, markdown_path: markdownPath, html_path: htmlPath };
}
