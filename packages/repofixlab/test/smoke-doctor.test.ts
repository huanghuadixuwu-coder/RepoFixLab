import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AXIOS_HARNESS_ADAPTER_SHA256,
	controllerExecutionMountsMatchExactAllowlist,
	createHarnessEquivalenceReport,
	createPristineRuntimeLock,
	type HarnessProbeReport,
	harnessProbeReportHash,
	type PristineRuntimeLockBuildInput,
	stableStringify,
	type TaskRoleFactoryProbeReport,
	taskEnvironmentEvidenceFileHash,
} from "../src/contracts/index.ts";
import {
	factoryProbeExecutionOrderIsExact,
	runSmokeDoctor,
	smokeDoctorReportHash,
	verifySmokeDoctorReport,
} from "../src/doctor/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const OFFICIAL_HARNESS_SOURCE_LOCK_PATH = fileURLToPath(
	new URL("../configs/harness/official-swebench-v4.1.0.json", import.meta.url),
);
const OFFICIAL_HARNESS_SOURCE_LOCK_JSON = readFileSync(OFFICIAL_HARNESS_SOURCE_LOCK_PATH, "utf8");
const OFFICIAL_HARNESS_SOURCE_LOCK_FILE_SHA256 = taskEnvironmentEvidenceFileHash(OFFICIAL_HARNESS_SOURCE_LOCK_JSON);
const OFFICIAL_HARNESS_SOURCE_LOCK_SEMANTIC_SHA256 = "f7e8a6e953d3351fd9c4dcea471222a277d55af7b5c25d384bda251b91c51a71";

function controllerExecution(socketSource: string): TaskRoleFactoryProbeReport["controller_execution"] {
	return {
		container_hostname: "e".repeat(12),
		container_id: "e".repeat(64),
		image_id: `sha256:${"7".repeat(64)}`,
		compose_project: "repofixlab",
		compose_service: "controller",
		compose_config_sha256: "4".repeat(64),
		read_only_root_filesystem: true,
		cap_drop: ["ALL"],
		security_opt: ["no-new-privileges:true"],
		published_ports: [],
		networks: [
			{
				network_id: "5".repeat(64),
				compose_project: "repofixlab",
				compose_network: "repofix-control",
				internal: true,
			},
		],
		mounts: [
			{
				type: "bind",
				source: socketSource,
				destination: "/var/run/docker.sock",
				read_write: true,
			},
			{ type: "tmpfs", source: null, destination: "/tmp", read_write: true },
			{
				type: "volume",
				source: "repofixlab_controller-work-v2",
				destination: "/var/lib/repofix/controller",
				read_write: true,
			},
			{
				type: "volume",
				source: "repofixlab_controller-candidates-v1",
				destination: "/etc/repofixlab/candidates",
				read_write: false,
			},
		],
	};
}

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function pristineRuntimeBuildInput(): PristineRuntimeLockBuildInput {
	const unsignedProvenance = {
		schema_version: "v1" as const,
		artifact_type: "repofixlab_pristine_harness" as const,
		platform: "linux/amd64" as const,
		base_image:
			"python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d" as const,
		source_archive_sha256: HASH_A,
		source_lock_sha256: "f7e8a6e953d3351fd9c4dcea471222a277d55af7b5c25d384bda251b91c51a71" as const,
		source_lock_file_sha256:
			OFFICIAL_HARNESS_SOURCE_LOCK_FILE_SHA256 as "8b9ce8b01b58cbcfbef3a88e1b4cb99289553c948ccaa27afa83771ae5bb6741",
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
	const imageId = `sha256:${HASH_C}` as const;
	return {
		schema_version: "v1",
		lock_type: "pristine_runtime",
		created_at: "2026-07-19T00:00:00.000Z",
		image: {
			id: imageId,
			repo_digest: `repofixlab/pristine-harness@${imageId}`,
			created_at: "2026-07-19T00:00:00.000Z",
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
	};
}

function unsignedProbe(
	mode: "adapted" | "pristine",
	probeKind: HarnessProbeReport["probe_kind"],
	runtimeLockFileSha256: string,
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
		official_source_lock_sha256: OFFICIAL_HARNESS_SOURCE_LOCK_SEMANTIC_SHA256,
		pristine_runtime_lock_sha256: runtimeLockFileSha256,
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

function probe(
	mode: "adapted" | "pristine",
	probeKind: HarnessProbeReport["probe_kind"],
	runtimeLockFileSha256: string,
): HarnessProbeReport {
	const unsigned = unsignedProbe(mode, probeKind, runtimeLockFileSha256);
	return { ...unsigned, report_sha256: harnessProbeReportHash(unsigned) };
}

function evidence() {
	const pristineRuntimeLockJson = `${JSON.stringify(createPristineRuntimeLock(pristineRuntimeBuildInput()))}\n`;
	const runtimeLockFileSha256 = taskEnvironmentEvidenceFileHash(pristineRuntimeLockJson);
	const pristine = (["base", "no_op", "malformed", "gold"] as const).map((kind) =>
		probe("pristine", kind, runtimeLockFileSha256),
	);
	const adapted = (["base", "no_op", "malformed", "gold"] as const).map((kind) =>
		probe("adapted", kind, runtimeLockFileSha256),
	);
	return {
		bootstrap_doctor_report_json: "{}",
		bootstrap_provenance_lock_json: "{}",
		dataset_lock_json: "{}",
		official_image_source_lock_json: "{}",
		task_environment_lock_json: "{}",
		candidate: {},
		factory_probe_report: {},
		pristine_runtime_lock_json: pristineRuntimeLockJson,
		official_harness_source_lock_json: OFFICIAL_HARNESS_SOURCE_LOCK_JSON,
		harness_equivalence_report: createHarnessEquivalenceReport(pristine, adapted),
		harness_probe_reports: [...pristine, ...adapted],
	};
}

const METADATA = {
	reportId: "smoke-doctor-20260719-000001",
	startedAt: "2026-07-19T00:00:00.000Z",
	finishedAt: "2026-07-19T00:00:01.000Z",
} as const;

describe("Smoke Doctor evidence contract", () => {
	it("requires the exact two-step Factory execution order", () => {
		expect(factoryProbeExecutionOrderIsExact(["worker", "evaluator"])).toBe(true);
		expect(factoryProbeExecutionOrderIsExact(["evaluator", "worker"])).toBe(false);
		expect(factoryProbeExecutionOrderIsExact(["worker"])).toBe(false);
		expect(factoryProbeExecutionOrderIsExact(["worker", "evaluator", "worker"])).toBe(false);
	});

	it("uses the shared exact Controller mount predicate for native and Docker Desktop socket evidence", () => {
		const native = controllerExecution("/var/run/docker.sock");
		const desktop = controllerExecution("/run/host-services/docker.proxy.sock");
		expect(controllerExecutionMountsMatchExactAllowlist(native)).toBe(true);
		expect(controllerExecutionMountsMatchExactAllowlist(desktop)).toBe(true);
		expect(desktop.mounts[0]?.source).toBe("/run/host-services/docker.proxy.sock");

		for (const invalid of [
			controllerExecution("/run/docker.sock"),
			{
				...native,
				mounts: native.mounts.map((mount) =>
					mount.type === "bind" ? { ...mount, destination: "/run/docker.sock" } : mount,
				),
			},
			{
				...native,
				mounts: native.mounts.map((mount) => (mount.type === "bind" ? { ...mount, read_write: false } : mount)),
			},
			{ ...native, mounts: [native.mounts[0]!, native.mounts[0]!, native.mounts[2]!, native.mounts[3]!] },
		]) {
			expect(controllerExecutionMountsMatchExactAllowlist(invalid)).toBe(false);
		}
	});

	it("accepts the exact runtime/source-bound four-by-two harness matrix while other missing gates fail closed", () => {
		const report = runSmokeDoctor(evidence(), METADATA);

		expect(report.status).toBe("fail");
		expect(report.checks.pristine_runtime_lock.state).toBe("pass");
		expect(report.checks.harness_probe_matrix.state).toBe("pass");
		expect(report.checks.harness_equivalence.state).toBe("pass");
		expect(report.checks.factory_controller_identity).toMatchObject({
			state: "fail",
			errors: [],
		});
		expect(verifySmokeDoctorReport(report)).toEqual(report);
	});

	it("rejects duplicate scenarios even when eight signed reports are supplied", () => {
		const input = evidence();
		const reports = [...input.harness_probe_reports];
		reports[1] = reports[0]!;
		const report = runSmokeDoctor({ ...input, harness_probe_reports: reports }, METADATA);

		expect(report.checks.harness_probe_matrix.state).toBe("fail");
		expect(report.checks.harness_probe_matrix.errors.join("\n")).toContain("Duplicate harness probe scenario");
	});

	it("rejects whitespace-only runtime lock file drift because probes bind the exact file bytes", () => {
		const input = evidence();
		const report = runSmokeDoctor(
			{ ...input, pristine_runtime_lock_json: ` ${input.pristine_runtime_lock_json}` },
			METADATA,
		);

		expect(report.checks.pristine_runtime_lock.state).toBe("pass");
		expect(report.checks.harness_probe_matrix.state).toBe("fail");
		expect(report.checks.harness_equivalence.state).toBe("fail");
	});

	it("rejects missing official harness raw evidence", () => {
		const input = evidence();
		const report = runSmokeDoctor({ ...input, official_harness_source_lock_json: "{}" }, METADATA);
		expect(report.checks.pristine_runtime_lock.state).toBe("fail");
		expect(report.checks.harness_probe_matrix.state).toBe("fail");
	});

	it("rejects caller-authored status and content tampering", () => {
		const report = runSmokeDoctor(evidence(), METADATA);
		const { report_sha256: _reportSha256, ...unsigned } = report;
		const forgedUnsigned = { ...unsigned, status: "pass" as const };
		const forged = {
			...forgedUnsigned,
			report_sha256: smokeDoctorReportHash(forgedUnsigned),
		};
		expect(() => verifySmokeDoctorReport(forged)).toThrow(/status is not derived/);
		expect(() => verifySmokeDoctorReport({ ...report, report_id: "tampered" })).toThrow(/report SHA-256/);
	});
});
