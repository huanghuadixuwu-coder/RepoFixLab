import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type CliRuntime,
	FACTORY_PROBE_TIMEOUT_MS,
	type FactoryProbeControllerResponse,
	resolveRunConfigPath,
	runCli,
} from "../src/cli/main.ts";
import {
	createTaskEnvironmentCandidate,
	createTaskRoleFactoryProbeRequest,
	stableStringify,
	type TaskEnvironmentCandidate,
	type TaskRoleFactoryProbeReport,
	taskRoleFactoryProbeEvidenceHash,
	taskRoleFactoryProbeReportHash,
} from "../src/contracts/index.ts";
import { MIN_AVAILABLE_BYTES } from "../src/doctor/index.ts";

const ARTIFACTS_ROOT = fileURLToPath(new URL("fixtures/artifacts", import.meta.url));
const PROBE_DIGEST = `alpine@sha256:${"a".repeat(64)}`;

function candidateBuildInput(): object {
	return {
		dataset_lock: { lock_id: "dataset-lock-v1", lock_sha256: "1".repeat(64) },
		official_image_source_lock: {
			lock_id: "official-images-v1",
			lock_sha256: "2".repeat(64),
		},
		roles: {
			worker: {
				image: {
					local_image_id: `sha256:${"3".repeat(64)}`,
					provenance_sha256: "8".repeat(64),
				},
				runtime_user: { uid: 65_532, gid: 65_532 },
				resource_profile: {
					nano_cpus: 4_000_000_000,
					memory_bytes: 8_589_934_592,
					memory_swap_bytes: 8_589_934_592,
					pids_limit: 512,
					timeout_seconds: 1_800,
				},
				filesystem_profile: {
					writable_mounts: [{ type: "volume", destination: "/workspace", read_write: true }],
				},
			},
			evaluator: {
				image: {
					local_image_id: `sha256:${"4".repeat(64)}`,
					provenance_sha256: "9".repeat(64),
				},
				runtime_user: { uid: 0, gid: 0 },
				resource_profile: {
					nano_cpus: 4_000_000_000,
					memory_bytes: 8_589_934_592,
					memory_swap_bytes: 8_589_934_592,
					pids_limit: 512,
					timeout_seconds: 1_800,
				},
				filesystem_profile: {
					writable_mounts: [{ type: "tmpfs", destination: "/evaluation", read_write: true }],
				},
			},
		},
		probe_sha256: "5".repeat(64),
		sanitizer_sha256: "6".repeat(64),
		adapter_sha256: "7".repeat(64),
		created_at: "2026-07-18T00:00:00.000Z",
	};
}

type WorkerEvidence = TaskRoleFactoryProbeReport["roles"]["worker"];
type EvaluatorEvidence = TaskRoleFactoryProbeReport["roles"]["evaluator"];
type RoleEvidenceBody = Omit<WorkerEvidence, "role" | "evidence_sha256">;

function controllerExecution(): TaskRoleFactoryProbeReport["controller_execution"] {
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
				source: "/var/run/docker.sock",
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

function failedEvidenceBody(candidate: TaskEnvironmentCandidate, role: "worker" | "evaluator"): RoleEvidenceBody {
	const roleCandidate = candidate.roles[role];
	return {
		status: "fail",
		failure_phase: "create",
		container_id: null,
		expected_image_id: roleCandidate.image.local_image_id,
		actual_image_id: null,
		expected_platform: roleCandidate.image.platform,
		actual_platform: null,
		expected_provenance_sha256: roleCandidate.image.provenance_sha256,
		actual_provenance_sha256: null,
		inspect: null,
		active_probe: null,
		cleanup: {
			container_removal_attempted: false,
			container_removed: false,
			created_volume_names: [],
			removed_volume_names: [],
			residual_container_ids: [],
			residual_volume_names: [],
			errors: [],
		},
		errors: [`${role}:create:failed`],
	};
}

function passingEvidenceBody(
	candidate: TaskEnvironmentCandidate,
	role: "worker" | "evaluator",
	containerId: string,
	volumeName: string,
): RoleEvidenceBody {
	const roleCandidate = candidate.roles[role];
	const mount = roleCandidate.filesystem_profile.writable_mounts[0];
	if (mount === undefined) throw new Error("fixture requires a writable mount");
	const volumeNames = mount.type === "volume" ? [volumeName] : [];
	return {
		status: "pass",
		failure_phase: null,
		container_id: containerId,
		expected_image_id: roleCandidate.image.local_image_id,
		actual_image_id: roleCandidate.image.local_image_id,
		expected_platform: roleCandidate.image.platform,
		actual_platform: roleCandidate.image.platform,
		expected_provenance_sha256: roleCandidate.image.provenance_sha256,
		actual_provenance_sha256: roleCandidate.image.provenance_sha256,
		inspect: {
			configured_user: `${roleCandidate.runtime_user.uid}:${roleCandidate.runtime_user.gid}`,
			uid: roleCandidate.runtime_user.uid,
			gid: roleCandidate.runtime_user.gid,
			network_mode: roleCandidate.security_profile.network_mode,
			read_only_root_filesystem: roleCandidate.security_profile.read_only_root_filesystem,
			cap_drop: [...roleCandidate.security_profile.cap_drop],
			cap_add: [...roleCandidate.security_profile.cap_add],
			security_opt: ["no-new-privileges:true"],
			privileged: roleCandidate.security_profile.privileged,
			device_count: 0,
			nano_cpus: roleCandidate.resource_profile.nano_cpus,
			memory_bytes: roleCandidate.resource_profile.memory_bytes,
			memory_swap_bytes: roleCandidate.resource_profile.memory_swap_bytes,
			pids_limit: roleCandidate.resource_profile.pids_limit,
			tty: roleCandidate.security_profile.tty,
			stdin_open: roleCandidate.security_profile.stdin_open,
			auto_remove: roleCandidate.security_profile.auto_remove,
			published_ports: [],
			mounts: [
				{
					type: mount.type,
					source: mount.type === "volume" ? volumeName : null,
					destination: mount.destination,
					read_write: mount.read_write,
				},
			],
			docker_socket_paths_present: [],
			sensitive_environment_names_present: [],
		},
		active_probe: {
			status: "pass",
			probe_sha256: candidate.probe_sha256,
			nonce_sha256: "a".repeat(64),
			exit_code: 0,
			timed_out: false,
			duration_ms: 250,
			stdout_sha256: "b".repeat(64),
			stderr_sha256: "c".repeat(64),
			observed_uid: roleCandidate.runtime_user.uid,
			observed_gid: roleCandidate.runtime_user.gid,
			observed_base_commit: candidate.base_commit,
			writable_path_roundtrip: true,
			docker_socket_paths_present: [],
			sensitive_environment_names_present: [],
			errors: [],
		},
		cleanup: {
			container_removal_attempted: true,
			container_removed: true,
			created_volume_names: volumeNames,
			removed_volume_names: volumeNames,
			residual_container_ids: [],
			residual_volume_names: [],
			errors: [],
		},
		errors: [],
	};
}

function failedWorkerEvidence(candidate: TaskEnvironmentCandidate): WorkerEvidence {
	const unsigned = {
		role: "worker",
		...failedEvidenceBody(candidate, "worker"),
	} as const satisfies Omit<WorkerEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function failedEvaluatorEvidence(candidate: TaskEnvironmentCandidate): EvaluatorEvidence {
	const unsigned = {
		role: "evaluator",
		...failedEvidenceBody(candidate, "evaluator"),
	} as const satisfies Omit<EvaluatorEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function passingWorkerEvidence(candidate: TaskEnvironmentCandidate): WorkerEvidence {
	const unsigned = {
		role: "worker",
		...passingEvidenceBody(candidate, "worker", "1".repeat(64), "repofix-worker-cli-pass"),
	} as const satisfies Omit<WorkerEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function passingEvaluatorEvidence(candidate: TaskEnvironmentCandidate): EvaluatorEvidence {
	const unsigned = {
		role: "evaluator",
		...passingEvidenceBody(candidate, "evaluator", "2".repeat(64), "repofix-evaluator-cli-pass"),
	} as const satisfies Omit<EvaluatorEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function factoryProbeReport(
	candidate: TaskEnvironmentCandidate,
	operationId: string,
	status: "pass" | "fail" = "fail",
): TaskRoleFactoryProbeReport {
	const request = createTaskRoleFactoryProbeRequest(candidate, operationId);
	const unsigned: Omit<TaskRoleFactoryProbeReport, "report_sha256"> = {
		schema_version: "v1",
		report_type: "task_role_factory_probe",
		operation_id: request.operation_id,
		request_sha256: request.request_sha256,
		candidate_id: candidate.candidate_id,
		candidate_sha256: candidate.candidate_sha256,
		probe_profile: request.probe_profile,
		instance_id: candidate.instance_id,
		base_commit: candidate.base_commit,
		controller_execution: controllerExecution(),
		status,
		started_at: "2026-07-18T00:00:00.000Z",
		finished_at: "2026-07-18T00:00:00.000Z",
		execution_order: ["worker", "evaluator"],
		roles: {
			worker: status === "pass" ? passingWorkerEvidence(candidate) : failedWorkerEvidence(candidate),
			evaluator: status === "pass" ? passingEvaluatorEvidence(candidate) : failedEvaluatorEvidence(candidate),
		},
		errors: [],
	};
	return {
		...unsigned,
		report_sha256: taskRoleFactoryProbeReportHash(unsigned),
	};
}

function runtime(overrides: Partial<CliRuntime> = {}): CliRuntime {
	return {
		artifactsRoot: ARTIFACTS_ROOT,
		controllerUrl: "http://controller:8000",
		now: () => new Date("2026-07-18T00:00:00.000Z"),
		randomId: () => "00000000-0000-4000-8000-000000000000",
		readArtifactsStatFs: async () => ({
			availableBlocks: MIN_AVAILABLE_BYTES,
			blockSize: 1n,
		}),
		readControllerHealth: async () => ({
			daemonReachable: true,
			serverVersion: "29.3.1",
			osType: "linux",
			architecture: "amd64",
			cpuCount: 12,
			memoryBytes: "16616996864",
			dockerRootDir: "/var/lib/docker",
			dockerVolumeAvailableBytes: MIN_AVAILABLE_BYTES,
			dockerVolumeId: "repofixlab-bootstrap-doctor-volume-test",
			probeImageDigest: PROBE_DIGEST,
			controlNetworkInternal: true,
			socketTopology: {
				controller: "read-write",
				orchestrator: "none",
				datasetPreparer: null,
				worker: null,
				evaluator: null,
			},
			errors: [],
		}),
		readImageProvenanceLock: async () => null,
		readInputFile: async () => "",
		requestFactoryProbe: async () => {
			throw new Error("must not request factory probe");
		},
		runExperiment: async () => {
			throw new Error("must not execute experiment");
		},
		resolveInputPath: async (artifactsRoot, requestedPath) => resolve(artifactsRoot, requestedPath),
		resolveRunConfigPath: async (artifactsRoot, requestedPath) => resolve(artifactsRoot, requestedPath),
		resolveOutputPath: async (artifactsRoot, requestedPath) => resolve(artifactsRoot, requestedPath),
		stderr: () => {},
		stdout: () => {},
		writeOutput: async () => {},
		...overrides,
	};
}

function environmentEvidenceManifest(datasetLock = "environment/dataset-lock.json"): object {
	return {
		schema_version: "v1",
		manifest_type: "task_environment_lock_create",
		dataset_lock: datasetLock,
		official_image_source_lock: "environment/official-image-source-lock.json",
		official_harness_source_lock: "environment/official-harness-source-lock.json",
		candidate: "environment/candidate.json",
		factory_probe_report: "environment/factory-probe-report.json",
		harness_equivalence_report: "environment/harness-equivalence-report.json",
		pristine_runtime_lock: "environment/pristine-runtime-lock.json",
		harness_probe_reports: {
			pristine: {
				base: "environment/probes/pristine/base.json",
				no_op: "environment/probes/pristine/no-op.json",
				malformed: "environment/probes/pristine/malformed.json",
				gold: "environment/probes/pristine/gold.json",
			},
			adapted: {
				base: "environment/probes/adapted/base.json",
				no_op: "environment/probes/adapted/no-op.json",
				malformed: "environment/probes/adapted/malformed.json",
				gold: "environment/probes/adapted/gold.json",
			},
		},
	};
}

function smokeEvidenceFiles(datasetLock = "environment/dataset-lock.json"): ReadonlyMap<string, string> {
	const smokeManifest = {
		schema_version: "v1",
		manifest_type: "smoke_doctor",
		bootstrap_doctor_report: "smoke/bootstrap.json",
		bootstrap_provenance_lock: "smoke/bootstrap-provenance.json",
		task_environment_lock: "smoke/task-environment-lock.json",
		environment_lock_evidence_manifest: "smoke/environment-evidence-manifest.json",
	};
	const files = new Map<string, string>([
		["smoke/manifest.json", JSON.stringify(smokeManifest)],
		["smoke/bootstrap.json", "{}"],
		["smoke/bootstrap-provenance.json", "{}"],
		["smoke/task-environment-lock.json", "{}"],
		["smoke/environment-evidence-manifest.json", JSON.stringify(environmentEvidenceManifest(datasetLock))],
	]);
	for (const value of Object.values(environmentEvidenceManifest(datasetLock))) {
		if (typeof value === "string") files.set(value, "{}");
	}
	const probePaths = (
		environmentEvidenceManifest(datasetLock) as {
			harness_probe_reports: Record<string, Record<string, string>>;
		}
	).harness_probe_reports;
	for (const mode of Object.values(probePaths)) {
		for (const path of Object.values(mode)) files.set(path, "{}");
	}
	return new Map([...files].map(([path, content]) => [resolve(ARTIFACTS_ROOT, path), content]));
}

const M1_EXPERIMENT_PLAN = `schema_version: v1
plan_type: experiment_capacity
experiment_id: m1-axios
task_selection:
  status: frozen
  declared_task_count: 1
  instance_ids: [axios__axios-5892]
matrix:
  - group_id: m1-smoke
    task_count: 1
    config_ids: [pi-general]
    replicates: 1
budget:
  per_run_accounted_admission_cap_tokens: null
  total_accounted_admission_cap_tokens: null
runtime_status: m1_single_run_available
`;

describe("RepoFixLab CLI", () => {
	it("reads the displayed version from package.json", async () => {
		let stdout = "";
		const exitCode = await runCli(
			["--version"],
			runtime({
				stdout: (text) => {
					stdout += text;
				},
			}),
		);

		expect(exitCode).toBe(0);
		expect(stdout).toBe("0.80.3\n");
	});

	it("resolves packaged and artifact-relative run configs without traversal", async () => {
		const testRoot = fileURLToPath(new URL(".", import.meta.url));
		expect(await resolveRunConfigPath(testRoot, "configs/experiments/m1-axios.yaml")).toMatch(
			/[\\/]configs[\\/]experiments[\\/]m1-axios\.yaml$/,
		);
		expect(await resolveRunConfigPath(testRoot, "contracts.test.ts")).toBe(resolve(testRoot, "contracts.test.ts"));
		await expect(resolveRunConfigPath(testRoot, "configs/experiments/../v1.yaml")).rejects.toThrow(
			/without traversal/,
		);
	});

	it("dry-runs an experiment plan without invoking the lifecycle", async () => {
		let stdout = "";
		const exitCode = await runCli(
			["run", "--config", "configs/experiments/m1-axios.yaml", "--dry-run"],
			runtime({
				readInputFile: async () => M1_EXPERIMENT_PLAN,
				stdout: (text) => {
					stdout += text;
				},
			}),
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			summary_type: "experiment_dry_run",
			experiment_id: "m1-axios",
			logical_run_count: 1,
			total_accounted_admission_cap_tokens: null,
			runtime_status: "m1_single_run_available",
			lifecycle_available: true,
		});
	});

	it("executes a non-dry-run experiment plan through the injected Runner", async () => {
		let stdout = "";
		let executed = false;
		const exitCode = await runCli(
			["run", "--config", "plans/m1.yaml"],
			runtime({
				readInputFile: async () => M1_EXPERIMENT_PLAN,
				runExperiment: async (plan) => {
					executed = true;
					return {
						schema_version: "v1",
						summary_type: "m1_run",
						experiment_id: plan.experiment_id,
						run_id: "run-test",
						attempt_id: "attempt-test",
						terminal_status: "completed",
						termination_reason: "official_unresolved",
						resolved: false,
						run_directory: "C:/artifacts/run-test",
						result_sha256: "a".repeat(64),
					};
				},
				stdout: (text) => {
					stdout += text;
				},
			}),
		);

		expect(exitCode).toBe(0);
		expect(executed).toBe(true);
		expect(JSON.parse(stdout)).toMatchObject({ summary_type: "m1_run", termination_reason: "official_unresolved" });
	});

	it("writes a schema-shaped bootstrap failure and returns exit code 1", async () => {
		let stdout = "";
		let outputPath = "";
		let outputContent = "";
		let outputMode = 0;
		const exitCode = await runCli(
			["doctor", "--profile", "bootstrap", "--output", "doctor/bootstrap.json"],
			runtime({
				stdout: (text) => {
					stdout += text;
				},
				writeOutput: async (path, content, mode) => {
					outputPath = path;
					outputContent = content;
					outputMode = mode;
				},
			}),
		);

		expect(exitCode).toBe(1);
		expect(outputPath).toBe(resolve(ARTIFACTS_ROOT, "doctor/bootstrap.json"));
		expect(outputMode).toBe(0o600);
		expect(outputContent).toBe(stdout);
		expect(stdout).toContain('"status": "fail"');
		expect(stdout).toContain('"memory_bytes": 16616996864');
	});

	it("fails closed for a profile whose lifecycle is not implemented", async () => {
		let stderr = "";
		const exitCode = await runCli(
			["doctor", "--profile", "formal"],
			runtime({
				stderr: (text) => {
					stderr += text;
				},
				readControllerHealth: async () => {
					throw new Error("must not collect bootstrap evidence");
				},
			}),
		);

		expect(exitCode).toBe(3);
		expect(stderr).toContain("not implemented");
	});

	it("publishes a fail-closed Smoke Doctor report from one shared evidence set", async () => {
		const files = smokeEvidenceFiles();
		let outputPath = "";
		let outputContent = "";
		let outputMode = 0;
		const exitCode = await runCli(
			["doctor", "--profile", "smoke", "--input", "smoke/manifest.json", "--output", "smoke/report.json"],
			runtime({
				readInputFile: async (path) => {
					const content = files.get(path);
					if (content === undefined) throw new Error(`missing fixture ${path}`);
					return content;
				},
				writeOutput: async (path, content, mode) => {
					outputPath = path;
					outputContent = content;
					outputMode = mode;
				},
			}),
		);

		expect(exitCode).toBe(1);
		expect(outputPath).toBe(resolve(ARTIFACTS_ROOT, "smoke/report.json"));
		expect(outputMode).toBe(0o600);
		expect(JSON.parse(outputContent)).toMatchObject({
			report_type: "smoke_doctor",
			status: "fail",
		});
	});

	it("does not resolve Smoke Doctor output when nested evidence aliases a top-level file", async () => {
		const files = smokeEvidenceFiles("smoke/bootstrap.json");
		let outputResolved = false;
		await expect(
			runCli(
				["doctor", "--profile", "smoke", "--input", "smoke/manifest.json", "--output", "smoke/report.json"],
				runtime({
					readInputFile: async (path) => {
						const content = files.get(path);
						if (content === undefined) throw new Error(`missing fixture ${path}`);
						return content;
					},
					resolveOutputPath: async (artifactsRoot, requestedPath) => {
						outputResolved = true;
						return resolve(artifactsRoot, requestedPath);
					},
				}),
			),
		).rejects.toThrow("20 distinct");
		expect(outputResolved).toBe(false);
	});

	it("creates an immutable external lock from a strict host candidate", async () => {
		let outputPath = "";
		let outputContent = "";
		let outputMode = 0;
		const service = {
			baseRepositoryDigest: `python@sha256:${"1".repeat(64)}`,
			buildInputsSha256: "2".repeat(64),
			composeConfigSha256: "3".repeat(64),
			dockerfileSha256: "4".repeat(64),
			expectedBaseImageId: `sha256:${"5".repeat(64)}`,
			expectedImageId: `sha256:${"6".repeat(64)}`,
			expectedNetworks: [{ internal: true, logicalName: "repofix-control" }],
			platform: "linux/amd64",
		};
		const exitCode = await runCli(
			[
				"provenance-lock",
				"--input",
				"provenance/run/candidate.json",
				"--output",
				"locks/bootstrap-image-provenance-lock.v1.json",
			],
			runtime({
				readInputFile: async () =>
					JSON.stringify({
						composeProject: "repofixlab",
						createdAt: "2026-07-18T00:00:00.000Z",
						lockId: "bootstrap-images-test",
						lockType: "bootstrap_image_provenance",
						schemaVersion: "repofixlab.bootstrap-image-provenance-lock.v1",
						services: { controller: service, orchestrator: service },
					}),
				writeOutput: async (path, content, mode) => {
					outputPath = path;
					outputContent = content;
					outputMode = mode;
				},
			}),
		);

		expect(exitCode).toBe(0);
		expect(outputPath).toBe(resolve(ARTIFACTS_ROOT, "locks/bootstrap-image-provenance-lock.v1.json"));
		expect(outputMode).toBe(0o600);
		expect(JSON.parse(outputContent).lockSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("creates a canonical task environment candidate through the artifact boundary", async () => {
		let stdout = "";
		let outputPath = "";
		let outputContent = "";
		let outputMode = 0;
		const exitCode = await runCli(
			[
				"candidate-create",
				"--input",
				"candidates/axios-5892.build-input.json",
				"--output",
				"candidates/axios-5892.candidate.json",
			],
			runtime({
				readInputFile: async () => JSON.stringify(candidateBuildInput()),
				stdout: (text) => {
					stdout += text;
				},
				writeOutput: async (path, content, mode) => {
					outputPath = path;
					outputContent = content;
					outputMode = mode;
				},
			}),
		);

		const candidate = JSON.parse(outputContent) as Record<string, unknown>;
		expect(exitCode).toBe(0);
		expect(outputPath).toBe(resolve(ARTIFACTS_ROOT, "candidates/axios-5892.candidate.json"));
		expect(outputMode).toBe(0o644);
		expect(outputContent).toBe(stdout);
		expect(outputContent).toBe(stableStringify(candidate));
		expect(candidate.candidate_id).toMatch(/^task-environment-candidate-v1-axios-5892-[a-f0-9]{64}$/);
		expect(candidate.candidate_sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("does not resolve or create an output for invalid candidate build input", async () => {
		let outputResolved = false;
		let outputWritten = false;
		await expect(
			runCli(
				["candidate-create", "--input", "candidates/invalid.json", "--output", "candidates/invalid.candidate.json"],
				runtime({
					readInputFile: async () =>
						JSON.stringify({
							...candidateBuildInput(),
							candidate_sha256: "f".repeat(64),
						}),
					resolveOutputPath: async (artifactsRoot, requestedPath) => {
						outputResolved = true;
						return resolve(artifactsRoot, requestedPath);
					},
					writeOutput: async () => {
						outputWritten = true;
					},
				}),
			),
		).rejects.toThrow("strict v1 contract");
		expect(outputResolved).toBe(false);
		expect(outputWritten).toBe(false);
	});

	it.each([
		{ status: "fail", idempotentReplay: "false", expectedExitCode: 1 },
		{ status: "fail", idempotentReplay: "true", expectedExitCode: 1 },
		{ status: "pass", idempotentReplay: "false", expectedExitCode: 0 },
		{ status: "pass", idempotentReplay: "true", expectedExitCode: 0 },
	] as const)(
		"publishes a verified $status factory report for replay header $idempotentReplay",
		async ({ status, idempotentReplay, expectedExitCode }) => {
			const candidate = createTaskEnvironmentCandidate(candidateBuildInput());
			const operationId = "factory-probe:axios-5892:cli";
			const report = factoryProbeReport(candidate, operationId, status);
			let requestedControllerUrl = "";
			let requestedBody: object | undefined;
			let requestedTimeout = 0;
			let outputPath = "";
			let outputContent = "";
			let outputMode = 0;
			let stdout = "";
			const exitCode = await runCli(
				[
					"factory-probe",
					"--candidate",
					"candidates/axios-5892.candidate.json",
					"--operation-id",
					operationId,
					"--output",
					"probes/axios-5892.report.json",
				],
				runtime({
					readInputFile: async () => JSON.stringify(candidate),
					requestFactoryProbe: async (controllerUrl, request, timeoutMs) => {
						requestedControllerUrl = controllerUrl;
						requestedBody = request;
						requestedTimeout = timeoutMs;
						return {
							status: 200,
							contentType: "application/json; charset=utf-8",
							idempotentReplay,
							body: JSON.stringify(report),
						};
					},
					stdout: (text) => {
						stdout += text;
					},
					writeOutput: async (path, content, mode) => {
						outputPath = path;
						outputContent = content;
						outputMode = mode;
					},
				}),
			);

			expect(exitCode).toBe(expectedExitCode);
			expect(requestedControllerUrl).toBe("http://controller:8000");
			expect(requestedBody).toEqual({
				operation_id: operationId,
				candidate_id: candidate.candidate_id,
				instance_id: candidate.instance_id,
			});
			expect(Object.keys(requestedBody ?? {})).toEqual(["operation_id", "candidate_id", "instance_id"]);
			expect(requestedTimeout).toBe(FACTORY_PROBE_TIMEOUT_MS);
			expect(outputPath).toBe(resolve(ARTIFACTS_ROOT, "probes/axios-5892.report.json"));
			expect(outputMode).toBe(0o600);
			expect(outputContent).toBe(stableStringify(report));
			expect(stdout).toBe(outputContent);
		},
	);

	it.each([
		{
			name: "non-2xx status",
			response: {
				status: 500,
				contentType: "application/json",
				idempotentReplay: null,
				body: '{"detail":"failed"}',
			} satisfies FactoryProbeControllerResponse,
			error: "HTTP 500",
		},
		{
			name: "missing replay header",
			response: {
				status: 200,
				contentType: "application/json",
				idempotentReplay: null,
				body: "VALID_REPORT",
			} satisfies FactoryProbeControllerResponse,
			error: "idempotent replay header",
		},
		{
			name: "unexpected replay header",
			response: {
				status: 200,
				contentType: "application/json",
				idempotentReplay: "maybe",
				body: "VALID_REPORT",
			} satisfies FactoryProbeControllerResponse,
			error: "idempotent replay header",
		},
		{
			name: "non-JSON content type",
			response: {
				status: 200,
				contentType: "text/plain",
				idempotentReplay: "false",
				body: "VALID_REPORT",
			} satisfies FactoryProbeControllerResponse,
			error: "non-JSON",
		},
		{
			name: "malformed JSON",
			response: {
				status: 200,
				contentType: "application/json",
				idempotentReplay: "false",
				body: "{",
			} satisfies FactoryProbeControllerResponse,
			error: "malformed JSON",
		},
	])("does not publish a factory report for $name", async ({ response, error }) => {
		const candidate = createTaskEnvironmentCandidate(candidateBuildInput());
		const validReport = factoryProbeReport(candidate, "factory-probe:axios-5892:fail-closed");
		let outputResolved = false;
		let outputWritten = false;
		await expect(
			runCli(
				[
					"factory-probe",
					"--candidate",
					"candidates/axios-5892.candidate.json",
					"--operation-id",
					"factory-probe:axios-5892:fail-closed",
					"--output",
					"probes/invalid.report.json",
				],
				runtime({
					readInputFile: async () => JSON.stringify(candidate),
					requestFactoryProbe: async () => ({
						...response,
						body: response.body === "VALID_REPORT" ? JSON.stringify(validReport) : response.body,
					}),
					resolveOutputPath: async (artifactsRoot, requestedPath) => {
						outputResolved = true;
						return resolve(artifactsRoot, requestedPath);
					},
					writeOutput: async () => {
						outputWritten = true;
					},
				}),
			),
		).rejects.toThrow(error);
		expect(outputResolved).toBe(false);
		expect(outputWritten).toBe(false);
	});

	it("does not publish a semantically invalid factory report", async () => {
		const candidate = createTaskEnvironmentCandidate(candidateBuildInput());
		const operationId = "factory-probe:axios-5892:invalid-report";
		const validReport = factoryProbeReport(candidate, operationId);
		let outputResolved = false;
		let outputWritten = false;
		await expect(
			runCli(
				[
					"factory-probe",
					"--candidate",
					"candidates/axios-5892.candidate.json",
					"--operation-id",
					operationId,
					"--output",
					"probes/invalid.report.json",
				],
				runtime({
					readInputFile: async () => JSON.stringify(candidate),
					requestFactoryProbe: async () => ({
						status: 200,
						contentType: "application/json",
						idempotentReplay: "false",
						body: JSON.stringify({ ...validReport, status: "pass" }),
					}),
					resolveOutputPath: async (artifactsRoot, requestedPath) => {
						outputResolved = true;
						return resolve(artifactsRoot, requestedPath);
					},
					writeOutput: async () => {
						outputWritten = true;
					},
				}),
			),
		).rejects.toThrow("report SHA-256");
		expect(outputResolved).toBe(false);
		expect(outputWritten).toBe(false);
	});

	it("does not publish when the controller request times out", async () => {
		const candidate = createTaskEnvironmentCandidate(candidateBuildInput());
		let outputResolved = false;
		let outputWritten = false;
		await expect(
			runCli(
				[
					"factory-probe",
					"--candidate",
					"candidates/axios-5892.candidate.json",
					"--operation-id",
					"factory-probe:axios-5892:timeout",
					"--output",
					"probes/timeout.report.json",
				],
				runtime({
					readInputFile: async () => JSON.stringify(candidate),
					requestFactoryProbe: async () => {
						throw new Error("Controller factory probe request timed out");
					},
					resolveOutputPath: async (artifactsRoot, requestedPath) => {
						outputResolved = true;
						return resolve(artifactsRoot, requestedPath);
					},
					writeOutput: async () => {
						outputWritten = true;
					},
				}),
			),
		).rejects.toThrow("timed out");
		expect(outputResolved).toBe(false);
		expect(outputWritten).toBe(false);
	});

	it("rejects an invalid candidate before contacting the controller or resolving output", async () => {
		const candidate = createTaskEnvironmentCandidate(candidateBuildInput());
		let controllerRequested = false;
		let outputResolved = false;
		await expect(
			runCli(
				[
					"factory-probe",
					"--candidate",
					"candidates/invalid.candidate.json",
					"--operation-id",
					"factory-probe:axios-5892:invalid-candidate",
					"--output",
					"probes/invalid-candidate.report.json",
				],
				runtime({
					readInputFile: async () => JSON.stringify({ ...candidate, candidate_sha256: "f".repeat(64) }),
					requestFactoryProbe: async () => {
						controllerRequested = true;
						throw new Error("must not request controller");
					},
					resolveOutputPath: async (artifactsRoot, requestedPath) => {
						outputResolved = true;
						return resolve(artifactsRoot, requestedPath);
					},
				}),
			),
		).rejects.toThrow("candidate SHA-256");
		expect(controllerRequested).toBe(false);
		expect(outputResolved).toBe(false);
	});
});
