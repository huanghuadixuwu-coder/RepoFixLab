import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "./schema-generator.ts";
import {
	AXIOS_HARNESS_ADAPTER_SHA256,
	AXIOS_SMOKE_TEST_COMMAND,
	type HarnessEquivalenceReport,
	HarnessEquivalenceReportSchema,
	type HarnessProbeReport,
	HarnessProbeReportSchema,
	type OfficialHarnessSourceLock,
	OfficialHarnessSourceLockSchema,
} from "./v1.ts";

const PROBE_ORDER = ["base", "no_op", "malformed", "gold"] as const;
const EQUIVALENCE_FIELDS = [
	"candidate_patch_sha256",
	"test_patch_sha256",
	"candidate_patch_apply_status",
	"test_patch_apply_status",
	"test_executed",
	"test_collected",
	"test_status_map",
	"collected_tests",
	"skipped_tests",
	"fail_to_pass",
	"pass_to_pass",
	"resolved",
	"timed_out",
	"error_class",
] as const satisfies readonly (keyof HarnessProbeReport)[];

const sourceLockValidator = Compile(OfficialHarnessSourceLockSchema);
const probeReportValidator = Compile(HarnessProbeReportSchema);
const equivalenceReportValidator = Compile(HarnessEquivalenceReportSchema);

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function arraysMatchExactly(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function probeHardGatesPass(report: HarnessProbeReport): boolean {
	const collected = new Set(report.collected_tests);
	const expectedTargets = [
		...report.fail_to_pass.success,
		...report.fail_to_pass.failure,
		...report.pass_to_pass.success,
		...report.pass_to_pass.failure,
	];
	const targetsCollected = expectedTargets.every((name) => collected.has(name));
	const allSkipped =
		report.collected_tests.length > 0 && report.collected_tests.every((name) => report.skipped_tests.includes(name));
	const gradingResolved = report.fail_to_pass.failure.length === 0 && report.pass_to_pass.failure.length === 0;
	return (
		report.candidate_patch_apply_status !== "error" &&
		report.candidate_patch_apply_status !== "rejected" &&
		report.test_patch_apply_status === "applied" &&
		report.test_executed &&
		report.test_collected &&
		targetsCollected &&
		!allSkipped &&
		!report.timed_out &&
		report.error_class === null &&
		gradingResolved
	);
}

export function officialHarnessSourceLockHash(value: Omit<OfficialHarnessSourceLock, "lock_sha256">): string {
	return canonicalHash(value);
}

export function harnessProbeReportHash(value: Omit<HarnessProbeReport, "report_sha256">): string {
	return canonicalHash(value);
}

export function harnessEquivalenceReportHash(value: Omit<HarnessEquivalenceReport, "report_sha256">): string {
	return canonicalHash(value);
}

export function verifyOfficialHarnessSourceLock(value: unknown): OfficialHarnessSourceLock {
	if (!sourceLockValidator.Check(value)) {
		throw new Error("Official harness source lock does not satisfy the v1 contract");
	}
	const { lock_sha256: actualHash, ...unsignedLock } = value;
	if (officialHarnessSourceLockHash(unsignedLock) !== actualHash) {
		throw new Error("Official harness source lock SHA-256 does not match canonical content");
	}
	if (!arraysMatchExactly(value.test_command, AXIOS_SMOKE_TEST_COMMAND)) {
		throw new Error("Official harness source lock does not bind the frozen Axios command");
	}
	const paths = value.files.map((file) => file.path);
	if (!isSortedUnique(paths)) {
		throw new Error("Official harness source files must be sorted and unique");
	}
	const requiredPaths = [
		"swebench/harness/constants/javascript.py",
		"swebench/harness/grading.py",
		"swebench/harness/log_parsers/__init__.py",
		"swebench/harness/log_parsers/javascript.py",
		"swebench/harness/run_evaluation.py",
		"swebench/harness/test_spec/javascript.py",
	];
	if (!arraysMatchExactly(paths, requiredPaths)) {
		throw new Error("Official harness source lock does not bind the complete Axios grading path");
	}
	if (
		value.source_aggregate_sha256 !== "b8c8574e17fd0c11159c7fa3a63e17a247ca5b2f73fa0a9899ca542cfcb093e6" ||
		value.pyproject_sha256 !== "d22ab0d742c5bf1f09df4d1ad317d21fb81145be1fba449233ac3e8d71eb3339"
	) {
		throw new Error(
			"Official harness source lock does not bind the frozen full package source and dependency declaration",
		);
	}
	return value;
}

export function verifyHarnessProbeReport(value: unknown): HarnessProbeReport {
	if (!probeReportValidator.Check(value)) {
		throw new Error("Harness probe report does not satisfy the v1 contract");
	}
	const { report_sha256: actualHash, ...unsignedReport } = value;
	if (harnessProbeReportHash(unsignedReport) !== actualHash) {
		throw new Error("Harness probe report SHA-256 does not match canonical content");
	}
	if (value.harness_mode === "pristine" && (value.adapter_sha256 !== null || value.official_report_sha256 === null)) {
		throw new Error("Pristine harness evidence must bind an official report and no adapter");
	}
	if (
		value.harness_mode === "adapted" &&
		(value.adapter_sha256 !== AXIOS_HARNESS_ADAPTER_SHA256 || value.official_report_sha256 !== null)
	) {
		throw new Error("Adapted harness evidence must bind only the frozen adapter");
	}
	for (const values of [
		value.collected_tests,
		value.skipped_tests,
		value.fail_to_pass.success,
		value.fail_to_pass.failure,
		value.pass_to_pass.success,
		value.pass_to_pass.failure,
	]) {
		if (!isSortedUnique(values)) throw new Error("Harness probe test sets must be sorted and unique");
	}
	const statusNames = value.test_status_map.map((entry) => entry.name);
	if (!isSortedUnique(statusNames) || !arraysMatchExactly(statusNames, value.collected_tests)) {
		throw new Error("Harness probe status map must be sorted, unique, and match the collected test set");
	}
	if (value.skipped_tests.some((name) => !value.collected_tests.includes(name))) {
		throw new Error("Harness probe skipped tests must be a subset of collected tests");
	}
	if (value.test_collected !== value.collected_tests.length > 0) {
		throw new Error("Harness probe test_collected does not match collected_tests");
	}
	if (value.test_executed !== (value.exit_code !== null || value.timed_out)) {
		throw new Error("Harness probe execution evidence is internally inconsistent");
	}
	if ((value.test_log_sha256 === null) === value.test_executed) {
		throw new Error("Harness probe test log binding does not match execution status");
	}
	if (
		value.probe_kind === "base" &&
		(value.candidate_patch_sha256 !== null || value.candidate_patch_apply_status !== "not_applicable")
	) {
		throw new Error("Base probe must not contain or apply a candidate patch");
	}
	if (value.probe_kind !== "base" && value.candidate_patch_sha256 === null) {
		throw new Error("Non-base probe must bind a candidate patch SHA-256");
	}
	if (value.resolved !== probeHardGatesPass(value)) {
		throw new Error("Harness probe resolved status does not match its grading and safety evidence");
	}
	return value;
}

function expectedProbeOutcome(report: HarnessProbeReport): boolean {
	switch (report.probe_kind) {
		case "base":
		case "no_op":
			return !report.resolved;
		case "malformed":
			return (
				report.error_class === "patch_apply_error" &&
				report.candidate_patch_apply_status === "error" &&
				!report.test_executed &&
				!report.resolved
			);
		case "gold":
			return report.resolved;
	}
}

function mismatches(pristine: HarnessProbeReport, adapted: HarnessProbeReport): string[] {
	return EQUIVALENCE_FIELDS.filter(
		(field) => stableStringify(pristine[field]) !== stableStringify(adapted[field]),
	).sort();
}

export function createHarnessEquivalenceReport(
	pristineValues: readonly unknown[],
	adaptedValues: readonly unknown[],
): HarnessEquivalenceReport {
	const pristine = new Map(
		pristineValues.map((value) => {
			const report = verifyHarnessProbeReport(value);
			if (report.harness_mode !== "pristine") throw new Error("Expected pristine harness probe evidence");
			return [report.probe_kind, report] as const;
		}),
	);
	const adapted = new Map(
		adaptedValues.map((value) => {
			const report = verifyHarnessProbeReport(value);
			if (report.harness_mode !== "adapted") throw new Error("Expected adapted harness probe evidence");
			return [report.probe_kind, report] as const;
		}),
	);
	if (pristine.size !== PROBE_ORDER.length || adapted.size !== PROBE_ORDER.length) {
		throw new Error("Harness equivalence requires exactly one report for each of the four probes and modes");
	}
	const pristineRuntimeLockSha256 = pristine.get("base")!.pristine_runtime_lock_sha256;
	const probes = PROBE_ORDER.map((probeKind) => {
		const pristineReport = pristine.get(probeKind);
		const adaptedReport = adapted.get(probeKind);
		if (pristineReport === undefined || adaptedReport === undefined) {
			throw new Error(`Harness equivalence is missing ${probeKind} evidence`);
		}
		if (
			pristineReport.official_source_lock_sha256 !== adaptedReport.official_source_lock_sha256 ||
			pristineReport.harness_revision !== adaptedReport.harness_revision ||
			pristineReport.pristine_runtime_lock_sha256 !== pristineRuntimeLockSha256 ||
			adaptedReport.pristine_runtime_lock_sha256 !== pristineRuntimeLockSha256
		) {
			throw new Error(`Harness equivalence ${probeKind} evidence has mismatched runtime or upstream bindings`);
		}
		const mismatchedFields = mismatches(pristineReport, adaptedReport);
		return {
			probe_kind: probeKind,
			pristine_report_sha256: pristineReport.report_sha256,
			adapted_report_sha256: adaptedReport.report_sha256,
			equivalent: mismatchedFields.length === 0,
			expected_outcome: expectedProbeOutcome(pristineReport) && expectedProbeOutcome(adaptedReport),
			mismatched_fields: mismatchedFields,
		};
	});
	const first = pristine.get("base")!;
	const unsignedReport = {
		schema_version: "v1" as const,
		report_type: "harness_equivalence" as const,
		instance_id: first.instance_id,
		base_commit: first.base_commit,
		harness_revision: first.harness_revision,
		official_source_lock_sha256: first.official_source_lock_sha256,
		pristine_runtime_lock_sha256: pristineRuntimeLockSha256,
		adapter_sha256: AXIOS_HARNESS_ADAPTER_SHA256,
		status: probes.every((probe) => probe.equivalent && probe.expected_outcome)
			? ("pass" as const)
			: ("fail" as const),
		probes,
	};
	return verifyHarnessEquivalenceReport({
		...unsignedReport,
		report_sha256: harnessEquivalenceReportHash(unsignedReport),
	});
}

export function verifyHarnessEquivalenceReport(value: unknown): HarnessEquivalenceReport {
	if (!equivalenceReportValidator.Check(value)) {
		throw new Error("Harness equivalence report does not satisfy the v1 contract");
	}
	const { report_sha256: actualHash, ...unsignedReport } = value;
	if (harnessEquivalenceReportHash(unsignedReport) !== actualHash) {
		throw new Error("Harness equivalence report SHA-256 does not match canonical content");
	}
	if (
		!arraysMatchExactly(
			value.probes.map((probe) => probe.probe_kind),
			PROBE_ORDER,
		)
	) {
		throw new Error("Harness equivalence probes must use the frozen four-probe order");
	}
	for (const probe of value.probes) {
		if (!isSortedUnique(probe.mismatched_fields) || probe.equivalent !== (probe.mismatched_fields.length === 0)) {
			throw new Error(`Harness equivalence ${probe.probe_kind} diff evidence is inconsistent`);
		}
	}
	if (value.status !== (value.probes.every((probe) => probe.equivalent && probe.expected_outcome) ? "pass" : "fail")) {
		throw new Error("Harness equivalence status does not match its four probe diffs");
	}
	return value;
}
