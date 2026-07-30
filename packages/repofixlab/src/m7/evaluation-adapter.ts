import { canonicalContractSha256, createEvaluationResult, type EvaluationResult } from "../contracts/run-contracts.ts";
import { SWE_BENCH_HARNESS_REVISION } from "../contracts/v1.ts";

interface M7EvaluationBinding {
	readonly runId: string;
	readonly attemptId: string;
	readonly jobId: string;
	readonly instanceId: string;
	readonly baseCommit: string;
	readonly candidatePatchSha256: string;
	readonly finishedAt: string;
}

interface GradeCounts {
	readonly passed: number;
	readonly failed: number;
	readonly total: number;
}

interface M6OfficialGrading {
	readonly schema_version: "v1";
	readonly record_type: "m3_official_log_grade";
	readonly found: boolean;
	readonly instance_id: string;
	readonly resolved: boolean;
	readonly fail_to_pass: GradeCounts;
	readonly pass_to_pass: GradeCounts;
	readonly status_map_sha256: string;
	readonly test_log_sha256: string;
}

interface M6OfficialEvaluation {
	readonly schema_version: "v1";
	readonly result_type: "m6_official_evaluation";
	readonly evaluation_id: string;
	readonly job_id: string;
	readonly run_id: string;
	readonly attempt_id: string;
	readonly instance_id: string;
	readonly base_commit: string;
	readonly harness_mode: "adapted";
	readonly status: "completed" | "failed";
	readonly resolved: boolean;
	readonly candidate_patch_sha256: string;
	readonly candidate_patch_apply_status: "applied" | "not_applicable" | "rejected" | "error";
	readonly test_patch_apply_status: "applied" | "not_run" | "rejected" | "error";
	readonly test_executed: boolean;
	readonly exit_code: number | null;
	readonly timed_out: boolean;
	readonly duration_ms: number;
	readonly official_grading: M6OfficialGrading | null;
	readonly error_class: string | null;
	readonly evaluation_sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
}

function isCommit(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCounts(value: unknown, label: string): GradeCounts {
	if (!isRecord(value) || !hasExactKeys(value, ["failed", "passed", "total"])) {
		throw new Error(`M6 official grading ${label} counts are malformed`);
	}
	if (
		!isNonNegativeInteger(value.passed) ||
		!isNonNegativeInteger(value.failed) ||
		!isNonNegativeInteger(value.total) ||
		value.passed + value.failed !== value.total
	) {
		throw new Error(`M6 official grading ${label} totals are inconsistent`);
	}
	return { passed: value.passed, failed: value.failed, total: value.total };
}

function parseOfficialGrading(value: unknown, instanceId: string): M6OfficialGrading | null {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"fail_to_pass",
			"found",
			"instance_id",
			"pass_to_pass",
			"record_type",
			"resolved",
			"schema_version",
			"status_map_sha256",
			"test_log_sha256",
		]) ||
		value.schema_version !== "v1" ||
		value.record_type !== "m3_official_log_grade" ||
		value.instance_id !== instanceId ||
		typeof value.found !== "boolean" ||
		typeof value.resolved !== "boolean" ||
		!isSha256(value.status_map_sha256) ||
		!isSha256(value.test_log_sha256)
	) {
		throw new Error("M6 official grading does not satisfy the sealed aggregate contract");
	}
	return {
		schema_version: "v1",
		record_type: "m3_official_log_grade",
		found: value.found,
		instance_id: value.instance_id,
		resolved: value.resolved,
		fail_to_pass: parseCounts(value.fail_to_pass, "fail_to_pass"),
		pass_to_pass: parseCounts(value.pass_to_pass, "pass_to_pass"),
		status_map_sha256: value.status_map_sha256,
		test_log_sha256: value.test_log_sha256,
	};
}

function parseM6OfficialEvaluation(value: unknown, binding: M7EvaluationBinding): M6OfficialEvaluation {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"attempt_id",
			"base_commit",
			"candidate_patch_apply_status",
			"candidate_patch_sha256",
			"duration_ms",
			"error_class",
			"evaluation_id",
			"evaluation_sha256",
			"exit_code",
			"harness_mode",
			"instance_id",
			"job_id",
			"official_grading",
			"resolved",
			"result_type",
			"run_id",
			"schema_version",
			"status",
			"test_executed",
			"test_patch_apply_status",
			"timed_out",
		]) ||
		value.schema_version !== "v1" ||
		value.result_type !== "m6_official_evaluation" ||
		!isIdentifier(value.evaluation_id) ||
		value.job_id !== binding.jobId ||
		value.run_id !== binding.runId ||
		value.attempt_id !== binding.attemptId ||
		value.instance_id !== binding.instanceId ||
		value.base_commit !== binding.baseCommit ||
		!isCommit(value.base_commit) ||
		value.harness_mode !== "adapted" ||
		(value.status !== "completed" && value.status !== "failed") ||
		typeof value.resolved !== "boolean" ||
		value.candidate_patch_sha256 !== binding.candidatePatchSha256 ||
		!isSha256(value.candidate_patch_sha256) ||
		!["applied", "not_applicable", "rejected", "error"].includes(String(value.candidate_patch_apply_status)) ||
		!["applied", "not_run", "rejected", "error"].includes(String(value.test_patch_apply_status)) ||
		typeof value.test_executed !== "boolean" ||
		(value.exit_code !== null && (!Number.isSafeInteger(value.exit_code) || typeof value.exit_code !== "number")) ||
		typeof value.timed_out !== "boolean" ||
		!isNonNegativeInteger(value.duration_ms) ||
		(value.error_class !== null &&
			(typeof value.error_class !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(value.error_class))) ||
		!isSha256(value.evaluation_sha256)
	) {
		throw new Error("M6 official evaluation does not satisfy the sealed adapter contract");
	}
	const officialGrading = parseOfficialGrading(value.official_grading, binding.instanceId);
	const { evaluation_sha256: actualHash, ...unsigned } = value;
	if (actualHash !== canonicalContractSha256(unsigned)) {
		throw new Error("M6 official evaluation canonical hash is invalid");
	}
	if (
		value.resolved !== (value.status === "completed" && officialGrading !== null && officialGrading.resolved) ||
		(value.test_executed && officialGrading === null)
	) {
		throw new Error("M6 official evaluation resolution or grading binding drifted");
	}
	return {
		...value,
		candidate_patch_apply_status: value.candidate_patch_apply_status,
		test_patch_apply_status: value.test_patch_apply_status,
		official_grading: officialGrading,
	} as M6OfficialEvaluation;
}

function privatePartition(
	scope: "fail_to_pass" | "pass_to_pass",
	counts: GradeCounts,
): {
	success: string[];
	failure: string[];
} {
	return {
		success: Array.from(
			{ length: counts.passed },
			(_, index) => `private::${scope}::passed::${String(index + 1).padStart(4, "0")}`,
		),
		failure: Array.from(
			{ length: counts.failed },
			(_, index) => `private::${scope}::failed::${String(index + 1).padStart(4, "0")}`,
		),
	};
}

/**
 * Converts the sealed M6 evaluator aggregate into the M7 RunResult contract.
 * Test names and raw test logs remain private; only cardinalities are exposed
 * through deterministic synthetic identifiers for metric aggregation.
 */
export function normalizeM6OfficialEvaluation(value: unknown, binding: M7EvaluationBinding): EvaluationResult {
	const source = parseM6OfficialEvaluation(value, binding);
	const grading = source.official_grading;
	return createEvaluationResult({
		schema_version: "v1",
		result_type: "evaluation",
		evaluation_id: source.evaluation_id,
		job_id: source.job_id,
		run_id: source.run_id,
		attempt_id: source.attempt_id,
		instance_id: source.instance_id,
		harness_mode: "adapted",
		harness_revision: SWE_BENCH_HARNESS_REVISION,
		status: source.status,
		resolved: source.resolved,
		candidate_patch_sha256: source.candidate_patch_sha256,
		candidate_patch_apply_status:
			source.candidate_patch_apply_status === "not_applicable" ? "applied" : source.candidate_patch_apply_status,
		test_patch_apply_status: source.test_patch_apply_status,
		test_executed: source.test_executed,
		test_collected: grading?.found ?? false,
		fail_to_pass:
			grading === null ? { success: [], failure: [] } : privatePartition("fail_to_pass", grading.fail_to_pass),
		pass_to_pass:
			grading === null ? { success: [], failure: [] } : privatePartition("pass_to_pass", grading.pass_to_pass),
		exit_code: source.exit_code,
		timed_out: source.timed_out,
		duration_ms: source.duration_ms,
		test_log: null,
		official_report_sha256: null,
		error_class: source.error_class,
		finished_at: binding.finishedAt,
	});
}
