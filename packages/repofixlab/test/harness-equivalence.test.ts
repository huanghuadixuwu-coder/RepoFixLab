import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AXIOS_HARNESS_ADAPTER_SHA256,
	createHarnessEquivalenceReport,
	type HarnessProbeReport,
	harnessProbeReportHash,
	verifyHarnessProbeReport,
	verifyOfficialHarnessSourceLock,
} from "../src/contracts/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

function unsignedProbe(
	mode: "adapted" | "pristine",
	probeKind: HarnessProbeReport["probe_kind"],
): Omit<HarnessProbeReport, "report_sha256"> {
	const malformed = probeKind === "malformed";
	const gold = probeKind === "gold";
	const base = probeKind === "base";
	const statusMap = malformed
		? []
		: [
				{ name: "fixes compression", status: gold ? ("passed" as const) : ("failed" as const) },
				{ name: "preserves redirects", status: "passed" as const },
			];
	return {
		schema_version: "v1",
		report_type: "harness_probe",
		harness_mode: mode,
		probe_kind: probeKind,
		instance_id: "axios__axios-5892",
		base_commit: "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b",
		harness_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57",
		official_source_lock_sha256: HASH_A,
		pristine_runtime_lock_sha256: HASH_F,
		adapter_sha256: mode === "adapted" ? AXIOS_HARNESS_ADAPTER_SHA256 : null,
		candidate_patch_sha256: base ? null : HASH_C,
		test_patch_sha256: HASH_B,
		candidate_patch_apply_status: base ? "not_applicable" : malformed ? "error" : "applied",
		test_patch_apply_status: malformed ? "not_run" : "applied",
		test_executed: !malformed,
		test_collected: !malformed,
		test_status_map: statusMap,
		collected_tests: statusMap.map((entry) => entry.name),
		skipped_tests: [],
		fail_to_pass: { success: gold ? ["fixes compression"] : [], failure: gold ? [] : ["fixes compression"] },
		pass_to_pass: { success: malformed ? [] : ["preserves redirects"], failure: [] },
		resolved: gold,
		exit_code: malformed ? null : gold ? 0 : 1,
		timed_out: false,
		duration_ms: malformed ? 0 : mode === "adapted" ? 20 : 21,
		test_log_sha256: malformed ? null : mode === "adapted" ? HASH_D : HASH_E,
		official_report_sha256: mode === "pristine" ? HASH_D : null,
		error_class: malformed ? "patch_apply_error" : null,
	};
}

function probe(mode: "adapted" | "pristine", probeKind: HarnessProbeReport["probe_kind"]): HarnessProbeReport {
	const unsigned = unsignedProbe(mode, probeKind);
	return { ...unsigned, report_sha256: harnessProbeReportHash(unsigned) };
}

function four(mode: "adapted" | "pristine"): HarnessProbeReport[] {
	return (["base", "no_op", "malformed", "gold"] as const).map((probeKind) => probe(mode, probeKind));
}

describe("RepoFixLab harness provenance and equivalence contracts", () => {
	it("verifies the committed official v4.1.0 Axios grading source lock", () => {
		const lockPath = fileURLToPath(new URL("../configs/harness/official-swebench-v4.1.0.json", import.meta.url));
		expect(() => verifyOfficialHarnessSourceLock(JSON.parse(readFileSync(lockPath, "utf8")))).not.toThrow();
	});

	it("accepts equivalent results from independent pristine and adapted paths", () => {
		const report = createHarnessEquivalenceReport(four("pristine"), four("adapted"));
		expect(report.status).toBe("pass");
		expect(report.probes.map((entry) => entry.probe_kind)).toEqual(["base", "no_op", "malformed", "gold"]);
		expect(report.probes.every((entry) => entry.equivalent && entry.expected_outcome)).toBe(true);
		expect(report.pristine_runtime_lock_sha256).toBe(HASH_F);
	});

	it("rejects reports that do not bind one exact pristine runtime lock", () => {
		const adapted = four("adapted");
		const noOp = adapted[1]!;
		const { report_sha256: _oldHash, ...unsigned } = noOp;
		const mismatched = { ...unsigned, pristine_runtime_lock_sha256: HASH_E };
		adapted[1] = { ...mismatched, report_sha256: harnessProbeReportHash(mismatched) };
		expect(() => createHarnessEquivalenceReport(four("pristine"), adapted)).toThrow(
			/mismatched runtime or upstream bindings/,
		);
	});

	it("detects parser output drift without comparing log hashes or timing", () => {
		const adapted = four("adapted");
		const gold = adapted[3]!;
		const unsigned = {
			...gold,
			test_status_map: [
				{ name: "fixes compression", status: "failed" as const },
				{ name: "preserves redirects", status: "passed" as const },
			],
			fail_to_pass: { success: [], failure: ["fixes compression"] },
			resolved: false,
		};
		const { report_sha256: _oldHash, ...withoutHash } = unsigned;
		adapted[3] = { ...withoutHash, report_sha256: harnessProbeReportHash(withoutHash) };
		const report = createHarnessEquivalenceReport(four("pristine"), adapted);
		expect(report.status).toBe("fail");
		expect(report.probes[3]?.mismatched_fields).toEqual(["fail_to_pass", "resolved", "test_status_map"]);
	});

	it("rejects a pristine report that self-identifies as adapted evidence", () => {
		const pristine = probe("pristine", "gold");
		const unsigned = {
			...pristine,
			adapter_sha256: AXIOS_HARNESS_ADAPTER_SHA256,
		};
		const { report_sha256: _oldHash, ...withoutHash } = unsigned;
		expect(() =>
			verifyHarnessProbeReport({
				...withoutHash,
				report_sha256: harnessProbeReportHash(withoutHash),
			}),
		).toThrow(/Pristine harness evidence/);
	});

	it("keeps a gold all-skip result valid but blocks the four-probe pass gate", () => {
		const pristine = four("pristine");
		const adapted = four("adapted");
		for (const reports of [pristine, adapted]) {
			const gold = reports[3]!;
			const unsigned = {
				...gold,
				skipped_tests: [...gold.collected_tests],
				fail_to_pass: { success: [], failure: ["fixes compression"] },
				resolved: false,
				error_class: "all_tests_skipped" as const,
			};
			const { report_sha256: _oldHash, ...withoutHash } = unsigned;
			reports[3] = { ...withoutHash, report_sha256: harnessProbeReportHash(withoutHash) };
		}
		const report = createHarnessEquivalenceReport(pristine, adapted);
		expect(report.probes[3]?.equivalent).toBe(true);
		expect(report.probes[3]?.expected_outcome).toBe(false);
		expect(report.status).toBe("fail");
	});
});
