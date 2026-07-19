import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createTaskEnvironmentLockFromRawEvidence,
	type TaskEnvironmentLockEvidenceManifest,
	type TaskEnvironmentLockRawEvidence,
	taskEnvironmentLockEvidenceManifestPaths,
	verifyDistinctTaskEnvironmentLockEvidencePaths,
	verifyTaskEnvironmentLockEvidenceManifest,
} from "../src/cli/task-environment-lock.ts";
import {
	AXIOS_HARNESS_ADAPTER_SHA256,
	createHarnessEquivalenceReport,
	createPristineRuntimeLock,
	type HarnessProbeReport,
	harnessProbeReportHash,
	stableStringify,
	taskEnvironmentEvidenceFileHash,
	verifyOfficialHarnessSourceLock,
} from "../src/contracts/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const TIMESTAMP = "2026-07-19T00:00:00.000Z";

function manifest(): TaskEnvironmentLockEvidenceManifest {
	return {
		schema_version: "v1",
		manifest_type: "task_environment_lock_create",
		dataset_lock: "dataset/dataset-lock.json",
		official_image_source_lock: "images/official-image-source-lock.json",
		official_harness_source_lock: "harness/official-source-lock.json",
		candidate: "candidates/axios-5892.json",
		factory_probe_report: "factory/axios-5892.json",
		harness_equivalence_report: "harness/equivalence.json",
		pristine_runtime_lock: "harness/pristine-runtime-lock.json",
		harness_probe_reports: {
			pristine: {
				base: "harness/pristine/base.json",
				no_op: "harness/pristine/no-op.json",
				malformed: "harness/pristine/malformed.json",
				gold: "harness/pristine/gold.json",
			},
			adapted: {
				base: "harness/adapted/base.json",
				no_op: "harness/adapted/no-op.json",
				malformed: "harness/adapted/malformed.json",
				gold: "harness/adapted/gold.json",
			},
		},
	};
}

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function sourceLockJson(): string {
	return readFileSync(
		fileURLToPath(new URL("../configs/harness/official-swebench-v4.1.0.json", import.meta.url)),
		"utf8",
	);
}

function pristineRuntimeLockJson(): string {
	const unsignedProvenance = {
		schema_version: "v1" as const,
		artifact_type: "repofixlab_pristine_harness" as const,
		platform: "linux/amd64" as const,
		base_image:
			"python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d" as const,
		source_archive_sha256: HASH_A,
		source_lock_sha256: "f7e8a6e953d3351fd9c4dcea471222a277d55af7b5c25d384bda251b91c51a71" as const,
		source_lock_file_sha256: "8b9ce8b01b58cbcfbef3a88e1b4cb99289553c948ccaa27afa83771ae5bb6741" as const,
		source_aggregate_sha256: "b8c8574e17fd0c11159c7fa3a63e17a247ca5b2f73fa0a9899ca542cfcb093e6" as const,
		upstream_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57" as const,
		upstream_tree_sha1: "f178530b37202c549b1b2b3300db2da90da648db" as const,
		dependency_lock_sha256: "b836155987474285284c3b8228e8575dda5d4d3ae12e1bce049fc2894424cba9" as const,
		evaluator_kernel_aggregate_sha256: HASH_B,
		evaluator_kernel_file_count: 13,
		evaluator_kernel_bytes: 80_000,
		dockerfile_sha256: "f0427192cf9bcec5a637684875f835bf5144cd3b3c464aa1e6544d8b28c766d1" as const,
	};
	const { source_lock_file_sha256: _sourceLockFileSha256, ...unsignedBuildProvenance } = unsignedProvenance;
	const provenance = {
		...unsignedProvenance,
		sha256: canonicalHash(unsignedBuildProvenance),
	};
	const imageId = `sha256:${HASH_C}`;
	return stableStringify(
		createPristineRuntimeLock({
			schema_version: "v1",
			lock_type: "pristine_runtime",
			created_at: TIMESTAMP,
			image: {
				id: imageId,
				repo_digest: `repofixlab/pristine-harness@${imageId}`,
				created_at: TIMESTAMP,
				size_bytes: 178_000_000,
				base_image: unsignedProvenance.base_image,
				platform: "linux/amd64",
				configured_user: "65532:65532",
				oracle_runtime_user: "0:0",
				entrypoint: ["python", "-m", "repofixlab_evaluator.pristine_runtime"],
				cmd: ["self-check"],
				labels: {
					"io.repofixlab.harness.mode": "pristine",
					"io.repofixlab.provenance.sha256": provenance.sha256,
					"org.opencontainers.image.revision": unsignedProvenance.upstream_revision,
					"org.opencontainers.image.title": "RepoFixLab pristine SWE-bench harness",
				},
			},
			provenance,
			verification: {
				current_materials_bound: true,
				build_time_self_check_passed: true,
				restricted_runtime_self_check_passed: true,
				run_evaluation_import: "swebench/harness/run_evaluation.py",
				golden_oracle_resolved: true,
				golden_oracle_status_map_sha256: "00f69ade8e7237bb84f0d42c92c48fff1b4a7c4e37f3493804fbb978a0c9fbf0",
				runtime_controls: {
					network: "none",
					read_only_root: true,
					cap_drop: ["ALL"],
					no_new_privileges: true,
					docker_socket: false,
					published_ports: false,
					sensitive_environment: false,
					pids_limit: 128,
					memory_bytes: 1_073_741_824,
					cpus: 1,
					tmpfs: "/tmp:rw,noexec,nosuid,size=16m",
				},
			},
		}),
	);
}

function probeReport(
	mode: "adapted" | "pristine",
	probeKind: HarnessProbeReport["probe_kind"],
	pristineRuntimeLockFileSha256: string,
	officialSourceLockSha256: string,
): HarnessProbeReport {
	const malformed = probeKind === "malformed";
	const gold = probeKind === "gold";
	const base = probeKind === "base";
	const statusMap = malformed
		? []
		: [
				{
					name: "fixes compression",
					status: gold ? ("passed" as const) : ("failed" as const),
				},
				{ name: "preserves redirects", status: "passed" as const },
			];
	const unsigned: Omit<HarnessProbeReport, "report_sha256"> = {
		schema_version: "v1",
		report_type: "harness_probe",
		harness_mode: mode,
		probe_kind: probeKind,
		instance_id: "axios__axios-5892",
		base_commit: "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b",
		harness_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57",
		official_source_lock_sha256: officialSourceLockSha256,
		pristine_runtime_lock_sha256: pristineRuntimeLockFileSha256,
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
		fail_to_pass: {
			success: gold ? ["fixes compression"] : [],
			failure: gold ? [] : ["fixes compression"],
		},
		pass_to_pass: {
			success: malformed ? [] : ["preserves redirects"],
			failure: [],
		},
		resolved: gold,
		exit_code: malformed ? null : gold ? 0 : 1,
		timed_out: false,
		duration_ms: malformed ? 0 : mode === "adapted" ? 20 : 21,
		test_log_sha256: malformed ? null : mode === "adapted" ? HASH_D : HASH_E,
		official_report_sha256: mode === "pristine" ? HASH_D : null,
		error_class: malformed ? "patch_apply_error" : null,
	};
	return {
		...unsigned,
		report_sha256: harnessProbeReportHash(unsigned),
	};
}

function rawEvidence(
	officialHarnessSourceLockJson = sourceLockJson(),
	pristineRuntimeJson = pristineRuntimeLockJson(),
): TaskEnvironmentLockRawEvidence {
	const sourceLock = verifyOfficialHarnessSourceLock(JSON.parse(officialHarnessSourceLockJson));
	const runtimeSha256 = taskEnvironmentEvidenceFileHash(pristineRuntimeJson);
	const probeJson = {
		pristine: {
			base: stableStringify(probeReport("pristine", "base", runtimeSha256, sourceLock.lock_sha256)),
			no_op: stableStringify(probeReport("pristine", "no_op", runtimeSha256, sourceLock.lock_sha256)),
			malformed: stableStringify(probeReport("pristine", "malformed", runtimeSha256, sourceLock.lock_sha256)),
			gold: stableStringify(probeReport("pristine", "gold", runtimeSha256, sourceLock.lock_sha256)),
		},
		adapted: {
			base: stableStringify(probeReport("adapted", "base", runtimeSha256, sourceLock.lock_sha256)),
			no_op: stableStringify(probeReport("adapted", "no_op", runtimeSha256, sourceLock.lock_sha256)),
			malformed: stableStringify(probeReport("adapted", "malformed", runtimeSha256, sourceLock.lock_sha256)),
			gold: stableStringify(probeReport("adapted", "gold", runtimeSha256, sourceLock.lock_sha256)),
		},
	};
	const parseProbes = (mode: "pristine" | "adapted"): HarnessProbeReport[] =>
		(["base", "no_op", "malformed", "gold"] as const).map(
			(kind) => JSON.parse(probeJson[mode][kind]) as HarnessProbeReport,
		);
	return {
		dataset_lock_json: "{}",
		official_image_source_lock_json: "{}",
		official_harness_source_lock_json: officialHarnessSourceLockJson,
		candidate_json: "{}",
		factory_probe_report_json: "{}",
		harness_equivalence_report_json: stableStringify(
			createHarnessEquivalenceReport(parseProbes("pristine"), parseProbes("adapted")),
		),
		pristine_runtime_lock_json: pristineRuntimeJson,
		harness_probe_report_json: probeJson,
	};
}

describe("environment-lock-create evidence boundary", () => {
	it("accepts only the complete strict manifest", () => {
		const value = manifest();
		expect(verifyTaskEnvironmentLockEvidenceManifest(value)).toEqual(value);
		expect(() => verifyTaskEnvironmentLockEvidenceManifest({ ...value, unknown: true })).toThrow(
			"fields must be exactly",
		);
		const { candidate: _candidate, ...missingCandidate } = value;
		expect(() => verifyTaskEnvironmentLockEvidenceManifest(missingCandidate)).toThrow("fields must be exactly");
		expect(() => verifyTaskEnvironmentLockEvidenceManifest({ ...value, candidate: " " })).toThrow("non-empty path");
	});

	it("requires exactly 15 distinct resolved evidence paths", () => {
		const paths = taskEnvironmentLockEvidenceManifestPaths(manifest());
		expect(paths).toHaveLength(15);
		expect(() => verifyDistinctTaskEnvironmentLockEvidencePaths(paths)).not.toThrow();
		expect(() => verifyDistinctTaskEnvironmentLockEvidencePaths(paths.slice(1))).toThrow("15 distinct");
		expect(() => verifyDistinctTaskEnvironmentLockEvidencePaths([...paths.slice(0, -1), paths[0]!])).toThrow(
			"15 distinct",
		);
	});

	it("rejects exact official source file drift before semantic evidence", () => {
		const evidence = rawEvidence();
		expect(() =>
			createTaskEnvironmentLockFromRawEvidence(
				{
					...evidence,
					official_harness_source_lock_json: `\n${evidence.official_harness_source_lock_json}`,
				},
				TIMESTAMP,
			),
		).toThrow("exact official harness source lock file");
	});

	it("rejects official source semantic seal drift", () => {
		const source = JSON.parse(sourceLockJson()) as Record<string, unknown>;
		const evidence = rawEvidence();
		expect(() =>
			createTaskEnvironmentLockFromRawEvidence(
				{
					...evidence,
					official_harness_source_lock_json: stableStringify({
						...source,
						lock_sha256: HASH_A,
					}),
				},
				TIMESTAMP,
			),
		).toThrow("SHA-256 does not match canonical content");
	});

	it("rejects exact pristine runtime file drift", () => {
		const evidence = rawEvidence();
		expect(() =>
			createTaskEnvironmentLockFromRawEvidence(
				{
					...evidence,
					pristine_runtime_lock_json: `\n${evidence.pristine_runtime_lock_json}`,
				},
				TIMESTAMP,
			),
		).toThrow("exact pristine runtime lock file");
	});

	it("rejects a harness report placed in the wrong mode/probe slot", () => {
		const evidence = rawEvidence();
		const pristine = evidence.harness_probe_report_json.pristine;
		expect(() =>
			createTaskEnvironmentLockFromRawEvidence(
				{
					...evidence,
					harness_probe_report_json: {
						...evidence.harness_probe_report_json,
						pristine: {
							...pristine,
							base: pristine.no_op,
							no_op: pristine.base,
						},
					},
				},
				TIMESTAMP,
			),
		).toThrow("wrong manifest slot");
	});
});
