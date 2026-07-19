import { describe, expect, it } from "vitest";
import {
	AXIOS_HARNESS_ADAPTER_SHA256,
	createTaskEnvironmentCandidate,
	createTaskEnvironmentLock,
	createTaskRoleFactoryProbeRequest,
	type DatasetLock,
	datasetLockAggregateHash,
	datasetLockReadyMarkerHash,
	datasetLockSealMarkerHash,
	type HarnessEquivalenceReport,
	harnessEquivalenceReportHash,
	type OfficialImageSourceLock,
	officialImageSourceLockSemanticSha256,
	stableStringify,
	type TaskEnvironmentCandidate,
	type TaskEnvironmentCandidateBuildInput,
	type TaskEnvironmentEvidenceInput,
	type TaskEnvironmentLock,
	type TaskRoleFactoryProbeReport,
	type TaskRoleFactoryProbeRequest,
	taskEnvironmentEvidenceFileHash,
	taskEnvironmentFilesystemProfileAggregateHash,
	taskEnvironmentLockFileHash,
	taskEnvironmentLockId,
	taskEnvironmentLockSealHash,
	taskEnvironmentVerificationEvidence,
	taskRoleFactoryProbeEvidenceHash,
	taskRoleFactoryProbeReportHash,
	verifyDatasetLockForTaskEnvironment,
	verifyTaskEnvironmentLock,
} from "../src/contracts/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const TIMESTAMP = "2026-07-19T00:00:00.000Z";
const LATER_TIMESTAMP = "2026-07-19T00:00:01.000Z";

type WorkerEvidence = TaskRoleFactoryProbeReport["roles"]["worker"];
type EvaluatorEvidence = TaskRoleFactoryProbeReport["roles"]["evaluator"];
type CommonEvidence = Omit<WorkerEvidence, "role" | "evidence_sha256">;

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

function datasetLock(): DatasetLock {
	const files: DatasetLock["files"] = [
		{
			scope: "control",
			path: "source-audit.json",
			bytes: 100,
			sha256: HASH_A,
		},
		{
			scope: "private",
			path: "tasks/axios__axios-5892.json",
			bytes: 200,
			sha256: HASH_B,
		},
		{
			scope: "public",
			path: "tasks/axios__axios-5892.json",
			bytes: 300,
			sha256: HASH_C,
		},
	];
	const aggregateSha256 = datasetLockAggregateHash(files);
	const draft: DatasetLock = {
		schema_version: "v1",
		lock_type: "dataset",
		lock_id: `dataset-v1-m0-axios-${aggregateSha256.slice(0, 16)}`,
		dataset: {
			name: "SWE-bench/SWE-bench_Multilingual",
			revision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
		},
		generation_id: "m0-axios",
		volumes: {
			public: "dataset-public-m0-axios",
			control: "dataset-control-m0-axios",
			private: "dataset-private-m0-axios",
		},
		record_count: 43,
		files,
		aggregate_sha256: aggregateSha256,
		ready: { sha256: "0".repeat(64), written_at: TIMESTAMP },
		seal: { sha256: "0".repeat(64), written_at: TIMESTAMP },
		created_by_image_id: `sha256:${HASH_D}`,
		created_at: TIMESTAMP,
	};
	const readySha256 = datasetLockReadyMarkerHash(draft);
	const withReady = {
		...draft,
		ready: { ...draft.ready, sha256: readySha256 },
	};
	return {
		...withReady,
		seal: {
			...withReady.seal,
			sha256: datasetLockSealMarkerHash(withReady),
		},
	};
}

function retimestampDatasetLock(lock: DatasetLock, timestamp: string): DatasetLock {
	const draft: DatasetLock = {
		...lock,
		ready: { sha256: "0".repeat(64), written_at: timestamp },
		seal: { sha256: "0".repeat(64), written_at: timestamp },
		created_at: timestamp,
	};
	const withReady = {
		...draft,
		ready: { ...draft.ready, sha256: datasetLockReadyMarkerHash(draft) },
	};
	return {
		...withReady,
		seal: {
			...withReady.seal,
			sha256: datasetLockSealMarkerHash(withReady),
		},
	};
}

function officialImageSourceLock(): OfficialImageSourceLock {
	const draft: OfficialImageSourceLock = {
		schema_version: "v1",
		lock_type: "official_image_source",
		lock_id: "pending",
		dataset_revision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
		harness_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57",
		images: [
			{
				image_key: "axios__axios-5892",
				requested_reference: "swebench/sweb.eval.x86_64.axios_1776_axios-5892:latest",
				repository_digest: `swebench/axios@sha256:${HASH_C}`,
				local_image_id: `sha256:${HASH_C}`,
				platform: "linux/amd64",
				registry_response_sha256: HASH_D,
				resolved_at: TIMESTAMP,
			},
		],
		seal_sha256: "0".repeat(64),
		created_at: TIMESTAMP,
	};
	const sealSha256 = officialImageSourceLockSemanticSha256(draft);
	return {
		...draft,
		lock_id: `official-images-v1-axios-5892-${sealSha256.slice(0, 16)}`,
		seal_sha256: sealSha256,
	};
}

function candidateBuildInput(
	dataset: DatasetLock,
	datasetJson: string,
	official: OfficialImageSourceLock,
	officialJson: string,
	evaluatorResource: Partial<TaskEnvironmentCandidateBuildInput["roles"]["evaluator"]["resource_profile"]> = {},
): TaskEnvironmentCandidateBuildInput {
	const resource = {
		nano_cpus: 4_000_000_000,
		memory_bytes: 8_589_934_592,
		memory_swap_bytes: 8_589_934_592,
		pids_limit: 512,
		timeout_seconds: 1_800,
	};
	return {
		dataset_lock: {
			lock_id: dataset.lock_id,
			lock_sha256: taskEnvironmentEvidenceFileHash(datasetJson),
		},
		official_image_source_lock: {
			lock_id: official.lock_id,
			lock_sha256: taskEnvironmentEvidenceFileHash(officialJson),
		},
		roles: {
			worker: {
				image: {
					local_image_id: `sha256:${HASH_A}`,
					provenance_sha256: HASH_C,
				},
				runtime_user: { uid: 65_532, gid: 65_532 },
				resource_profile: resource,
				filesystem_profile: {
					writable_mounts: [
						{
							type: "volume",
							destination: "/workspace",
							read_write: true,
						},
					],
				},
			},
			evaluator: {
				image: {
					local_image_id: `sha256:${HASH_B}`,
					provenance_sha256: HASH_D,
				},
				runtime_user: { uid: 0, gid: 0 },
				resource_profile: { ...resource, ...evaluatorResource },
				filesystem_profile: {
					writable_mounts: [
						{
							type: "tmpfs",
							destination: "/evaluation",
							read_write: true,
						},
					],
				},
			},
		},
		probe_sha256: "1".repeat(64),
		sanitizer_sha256: "2".repeat(64),
		adapter_sha256: AXIOS_HARNESS_ADAPTER_SHA256,
		created_at: TIMESTAMP,
	};
}

function commonPassingEvidence(
	candidate: TaskEnvironmentCandidate,
	role: "worker" | "evaluator",
	containerId: string,
	volumeName: string,
): CommonEvidence {
	const roleCandidate = candidate.roles[role];
	const mount = roleCandidate.filesystem_profile.writable_mounts[0];
	if (mount === undefined) {
		throw new Error("Fixture requires one writable mount");
	}
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
			cap_add: [],
			security_opt: ["no-new-privileges:true"],
			privileged: false,
			device_count: 0,
			nano_cpus: roleCandidate.resource_profile.nano_cpus,
			memory_bytes: roleCandidate.resource_profile.memory_bytes,
			memory_swap_bytes: roleCandidate.resource_profile.memory_swap_bytes,
			pids_limit: roleCandidate.resource_profile.pids_limit,
			tty: false,
			stdin_open: false,
			auto_remove: false,
			published_ports: [],
			mounts: [
				{
					type: mount.type,
					source: mount.type === "volume" ? volumeName : null,
					destination: mount.destination,
					read_write: true,
				},
			],
			docker_socket_paths_present: [],
			sensitive_environment_names_present: [],
		},
		active_probe: {
			status: "pass",
			probe_sha256: candidate.probe_sha256,
			nonce_sha256: HASH_E,
			exit_code: 0,
			timed_out: false,
			duration_ms: 250,
			stdout_sha256: HASH_A,
			stderr_sha256: HASH_B,
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
			created_volume_names: mount.type === "volume" ? [volumeName] : [],
			removed_volume_names: mount.type === "volume" ? [volumeName] : [],
			residual_container_ids: [],
			residual_volume_names: [],
			errors: [],
		},
		errors: [],
	};
}

function workerEvidence(candidate: TaskEnvironmentCandidate): WorkerEvidence {
	const unsigned = {
		role: "worker",
		...commonPassingEvidence(candidate, "worker", "3".repeat(64), "repofix-worker-environment-lock"),
	} as const satisfies Omit<WorkerEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function evaluatorEvidence(candidate: TaskEnvironmentCandidate): EvaluatorEvidence {
	const unsigned = {
		role: "evaluator",
		...commonPassingEvidence(candidate, "evaluator", "4".repeat(64), "repofix-evaluator-environment-lock"),
	} as const satisfies Omit<EvaluatorEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function factoryReport(
	candidate: TaskEnvironmentCandidate,
	request: TaskRoleFactoryProbeRequest,
): TaskRoleFactoryProbeReport {
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
		status: "pass",
		started_at: TIMESTAMP,
		finished_at: TIMESTAMP,
		execution_order: ["worker", "evaluator"],
		roles: {
			worker: workerEvidence(candidate),
			evaluator: evaluatorEvidence(candidate),
		},
		errors: [],
	};
	return {
		...unsigned,
		report_sha256: taskRoleFactoryProbeReportHash(unsigned),
	};
}

function equivalenceReport(): HarnessEquivalenceReport {
	const unsigned: Omit<HarnessEquivalenceReport, "report_sha256"> = {
		schema_version: "v1",
		report_type: "harness_equivalence",
		instance_id: "axios__axios-5892",
		base_commit: "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b",
		harness_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57",
		official_source_lock_sha256: HASH_C,
		pristine_runtime_lock_sha256: HASH_D,
		adapter_sha256: AXIOS_HARNESS_ADAPTER_SHA256,
		status: "pass",
		probes: (["base", "no_op", "malformed", "gold"] as const).map((probeKind, index) => ({
			probe_kind: probeKind,
			pristine_report_sha256: String(index + 1).repeat(64),
			adapted_report_sha256: String(index + 5).repeat(64),
			equivalent: true,
			expected_outcome: true,
			mismatched_fields: [],
		})),
	};
	return {
		...unsigned,
		report_sha256: harnessEquivalenceReportHash(unsigned),
	};
}

function evidence(
	evaluatorResource: Partial<TaskEnvironmentCandidateBuildInput["roles"]["evaluator"]["resource_profile"]> = {},
): TaskEnvironmentEvidenceInput {
	const dataset = datasetLock();
	const official = officialImageSourceLock();
	const datasetJson = stableStringify(dataset);
	const officialJson = stableStringify(official);
	const candidate = createTaskEnvironmentCandidate(
		candidateBuildInput(dataset, datasetJson, official, officialJson, evaluatorResource),
	);
	const request = createTaskRoleFactoryProbeRequest(candidate, "factory-probe:axios-5892:environment-lock");
	return {
		dataset_lock_json: datasetJson,
		official_image_source_lock_json: officialJson,
		candidate,
		factory_probe_request: request,
		factory_probe_report: factoryReport(candidate, request),
		harness_equivalence_report: equivalenceReport(),
	};
}

function resealReport(report: TaskRoleFactoryProbeReport): TaskRoleFactoryProbeReport {
	const { report_sha256: _reportSha256, ...unsigned } = report;
	return {
		...unsigned,
		report_sha256: taskRoleFactoryProbeReportHash(unsigned),
	};
}

function failedFactoryReport(report: TaskRoleFactoryProbeReport): TaskRoleFactoryProbeReport {
	const worker = report.roles.worker;
	if (worker.inspect === null) {
		throw new Error("Fixture requires worker inspect evidence");
	}
	const { evidence_sha256: _evidenceSha256, ...unsignedOriginal } = worker;
	const unsignedWorker = {
		...unsignedOriginal,
		status: "fail",
		failure_phase: "runtime_inspect",
		inspect: { ...worker.inspect, privileged: true },
		errors: ["worker:runtime_inspect:privileged"],
	} as const satisfies Omit<WorkerEvidence, "evidence_sha256">;
	const failedWorker: WorkerEvidence = {
		...unsignedWorker,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsignedWorker),
	};
	return resealReport({
		...report,
		status: "fail",
		roles: { ...report.roles, worker: failedWorker },
	});
}

function failedEquivalenceReport(report: HarnessEquivalenceReport): HarnessEquivalenceReport {
	const { report_sha256: _reportSha256, ...unsignedOriginal } = report;
	const probes = report.probes.map((probe, index) => (index === 0 ? { ...probe, expected_outcome: false } : probe));
	const unsigned: Omit<HarnessEquivalenceReport, "report_sha256"> = {
		...unsignedOriginal,
		status: "fail",
		probes,
	};
	return {
		...unsigned,
		report_sha256: harnessEquivalenceReportHash(unsigned),
	};
}

function resealLock(lock: TaskEnvironmentLock): TaskEnvironmentLock {
	const sealSha256 = taskEnvironmentLockSealHash(lock);
	return {
		...lock,
		lock_id: taskEnvironmentLockId(sealSha256),
		seal_sha256: sealSha256,
	};
}

const MATERIAL_BINDING_DRIFTS: readonly {
	readonly name: string;
	readonly mutate: (lock: TaskEnvironmentLock) => TaskEnvironmentLock;
}[] = [
	{
		name: "source image ID",
		mutate: (lock) => ({
			...lock,
			source_image: {
				...lock.source_image,
				local_image_id: `sha256:${HASH_E}`,
			},
		}),
	},
	{
		name: "worker image ID",
		mutate: (lock) => ({
			...lock,
			worker_image: {
				...lock.worker_image,
				local_image_id: `sha256:${HASH_E}`,
			},
		}),
	},
	{
		name: "worker provenance",
		mutate: (lock) => ({
			...lock,
			worker_image: { ...lock.worker_image, provenance_sha256: HASH_E },
		}),
	},
	{
		name: "evaluator provenance",
		mutate: (lock) => ({
			...lock,
			evaluator_image: {
				...lock.evaluator_image,
				provenance_sha256: HASH_E,
			},
		}),
	},
	{
		name: "dataset lock ID",
		mutate: (lock) => ({ ...lock, dataset_lock_id: "dataset-v1-drift" }),
	},
	{
		name: "official image lock ID",
		mutate: (lock) => ({
			...lock,
			official_image_source_lock_id: "official-images-v1-drift",
		}),
	},
	{
		name: "candidate ID",
		mutate: (lock) => ({ ...lock, candidate_id: "candidate-drift" }),
	},
	{
		name: "candidate hash",
		mutate: (lock) => ({ ...lock, candidate_sha256: HASH_E }),
	},
	{
		name: "sanitizer hash",
		mutate: (lock) => ({ ...lock, sanitizer_sha256: HASH_E }),
	},
	{
		name: "adapter hash",
		mutate: (lock) => ({ ...lock, adapter_sha256: HASH_E }),
	},
	{
		name: "factory report hash",
		mutate: (lock) => ({
			...lock,
			verification: {
				...lock.verification,
				factory_probe_report_sha256: HASH_E,
			},
		}),
	},
	{
		name: "verification evidence hash",
		mutate: (lock) => ({
			...lock,
			verification: {
				...lock.verification,
				evidence_sha256: HASH_E,
			},
		}),
	},
];

describe("TaskEnvironmentLock strict builder and verifier", () => {
	it("builds and verifies a lock from all passing raw evidence", () => {
		const rawEvidence = evidence();
		const candidate = rawEvidence.candidate as TaskEnvironmentCandidate;
		const dataset = JSON.parse(rawEvidence.dataset_lock_json) as DatasetLock;
		const official = JSON.parse(rawEvidence.official_image_source_lock_json) as OfficialImageSourceLock;
		const lock = createTaskEnvironmentLock({
			...rawEvidence,
			created_at: TIMESTAMP,
		});

		expect(verifyTaskEnvironmentLock(lock, rawEvidence)).toBe(lock);
		expect(lock.resource_profile).toEqual({
			cpu_count: 4,
			memory_bytes: 8_589_934_592,
			pids_limit: 512,
			network_mode: "none",
			read_only_root_filesystem: true,
		});
		expect(lock.filesystem_profile_sha256).toBe(taskEnvironmentFilesystemProfileAggregateHash(candidate));
		expect(lock.filesystem_profile_sha256).not.toBe(candidate.roles.worker.filesystem_profile.profile_sha256);
		expect(lock.filesystem_profile_sha256).not.toBe(candidate.roles.evaluator.filesystem_profile.profile_sha256);
		expect(lock.seal_sha256).toBe(taskEnvironmentLockSealHash(lock));
		expect(lock.lock_id).toBe(`task-environment-v1-axios-5892-${lock.seal_sha256.slice(0, 16)}`);
		const verificationEvidence = taskEnvironmentVerificationEvidence(rawEvidence);
		expect(candidate.dataset_lock.lock_sha256).toBe(taskEnvironmentEvidenceFileHash(rawEvidence.dataset_lock_json));
		expect(candidate.official_image_source_lock.lock_sha256).toBe(
			taskEnvironmentEvidenceFileHash(rawEvidence.official_image_source_lock_json),
		);
		expect(verificationEvidence).toMatchObject({
			dataset_lock_file_sha256: candidate.dataset_lock.lock_sha256,
			dataset_lock_seal_sha256: dataset.seal.sha256,
			official_image_source_lock_file_sha256: candidate.official_image_source_lock.lock_sha256,
			official_image_source_lock_seal_sha256: official.seal_sha256,
		});
	});

	it("keeps environment identity stable across timestamps while changing the full file hash", () => {
		const rawEvidence = evidence();
		const first = createTaskEnvironmentLock({
			...rawEvidence,
			created_at: TIMESTAMP,
		});
		const second = createTaskEnvironmentLock({
			...rawEvidence,
			created_at: LATER_TIMESTAMP,
		});

		expect(second.lock_id).toBe(first.lock_id);
		expect(second.seal_sha256).toBe(first.seal_sha256);
		expect(taskEnvironmentLockFileHash(second)).not.toBe(taskEnvironmentLockFileHash(first));
		expect(verifyTaskEnvironmentLock(second, rawEvidence)).toBe(second);
	});

	it("rejects semantically identical source-lock JSON when exact file whitespace drifts", () => {
		const rawEvidence = evidence();
		const compactDatasetJson = JSON.stringify(JSON.parse(rawEvidence.dataset_lock_json));
		const compactOfficialJson = JSON.stringify(JSON.parse(rawEvidence.official_image_source_lock_json));
		expect(compactDatasetJson).not.toBe(rawEvidence.dataset_lock_json);
		expect(compactOfficialJson).not.toBe(rawEvidence.official_image_source_lock_json);
		expect(taskEnvironmentEvidenceFileHash(compactDatasetJson)).not.toBe(
			taskEnvironmentEvidenceFileHash(rawEvidence.dataset_lock_json),
		);
		expect(taskEnvironmentEvidenceFileHash(compactOfficialJson)).not.toBe(
			taskEnvironmentEvidenceFileHash(rawEvidence.official_image_source_lock_json),
		);
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				dataset_lock_json: compactDatasetJson,
				created_at: TIMESTAMP,
			}),
		).toThrow("candidate lock bindings");
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				official_image_source_lock_json: compactOfficialJson,
				created_at: TIMESTAMP,
			}),
		).toThrow("candidate lock bindings");
	});

	it.each([
		{ nano_cpus: 3_000_000_000 },
		{
			memory_bytes: 4_294_967_296,
			memory_swap_bytes: 4_294_967_296,
		},
		{ pids_limit: 256 },
	])("rejects a single resource profile when role resources differ: %j", (evaluatorResource) => {
		const rawEvidence = evidence(evaluatorResource);
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				created_at: TIMESTAMP,
			}),
		).toThrow("identical CPU, memory, and pids");
	});

	it("rejects non-passing factory and equivalence evidence", () => {
		const rawEvidence = evidence();
		const failedFactory = failedFactoryReport(rawEvidence.factory_probe_report as TaskRoleFactoryProbeReport);
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				factory_probe_report: failedFactory,
				created_at: TIMESTAMP,
			}),
		).toThrow("passing factory probe");

		const failedEquivalence = failedEquivalenceReport(
			rawEvidence.harness_equivalence_report as HarnessEquivalenceReport,
		);
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				harness_equivalence_report: failedEquivalence,
				created_at: TIMESTAMP,
			}),
		).toThrow("passing harness equivalence");
	});

	it("rejects dataset aggregate, ID, order, and candidate seal drift", () => {
		const rawEvidence = evidence();
		const dataset = JSON.parse(rawEvidence.dataset_lock_json) as DatasetLock;
		expect(() =>
			verifyDatasetLockForTaskEnvironment({
				...dataset,
				aggregate_sha256: HASH_A,
			}),
		).toThrow("aggregate SHA-256");
		expect(() =>
			verifyDatasetLockForTaskEnvironment({
				...dataset,
				lock_id: "dataset-v1-wrong",
			}),
		).toThrow("lock ID");
		expect(() =>
			verifyDatasetLockForTaskEnvironment({
				...dataset,
				files: [...dataset.files].reverse(),
			}),
		).toThrow("canonical order");
		expect(() =>
			verifyDatasetLockForTaskEnvironment({
				...dataset,
				ready: { ...dataset.ready, sha256: HASH_D },
			}),
		).toThrow("READY marker SHA-256");
		expect(() =>
			verifyDatasetLockForTaskEnvironment({
				...dataset,
				seal: { ...dataset.seal, sha256: HASH_D },
			}),
		).toThrow("SEAL marker SHA-256");
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				dataset_lock_json: stableStringify(retimestampDatasetLock(dataset, LATER_TIMESTAMP)),
				created_at: TIMESTAMP,
			}),
		).toThrow("candidate lock bindings");
	});

	it("rejects request, image, provenance, instance, and adapter binding drift", () => {
		const rawEvidence = evidence();
		const candidate = rawEvidence.candidate as TaskEnvironmentCandidate;
		const differentRequest = createTaskRoleFactoryProbeRequest(candidate, "factory-probe:axios-5892:different");
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				factory_probe_request: differentRequest,
				created_at: TIMESTAMP,
			}),
		).toThrow("bindings");

		const report = rawEvidence.factory_probe_report as TaskRoleFactoryProbeReport;
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				factory_probe_report: resealReport({
					...report,
					instance_id: "axios__axios-5892",
					roles: {
						...report.roles,
						worker: {
							...report.roles.worker,
							actual_provenance_sha256: HASH_E,
						},
					},
				}),
				created_at: TIMESTAMP,
			}),
		).toThrow("role evidence SHA-256");

		const equivalence = rawEvidence.harness_equivalence_report as HarnessEquivalenceReport;
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				harness_equivalence_report: {
					...equivalence,
					adapter_sha256: HASH_A,
				},
				created_at: TIMESTAMP,
			}),
		).toThrow("v1 contract");
	});

	it.each(MATERIAL_BINDING_DRIFTS)("rejects $name drift even after a caller recomputes the seal", ({ mutate }) => {
		const rawEvidence = evidence();
		const lock = createTaskEnvironmentLock({
			...rawEvidence,
			created_at: TIMESTAMP,
		});
		const tampered = resealLock(mutate(lock));

		expect(() => verifyTaskEnvironmentLock(tampered, rawEvidence)).toThrow("canonical evidence bindings");
	});

	it("rejects filesystem aggregate drift even after a caller recomputes the seal", () => {
		const rawEvidence = evidence();
		const lock = createTaskEnvironmentLock({
			...rawEvidence,
			created_at: TIMESTAMP,
		});
		const tamperedDraft: TaskEnvironmentLock = {
			...lock,
			filesystem_profile_sha256: HASH_A,
		};
		const tampered = resealLock(tamperedDraft);

		expect(() => verifyTaskEnvironmentLock(tampered, rawEvidence)).toThrow("canonical evidence bindings");
	});

	it("rejects invalid timestamps and incomplete raw evidence", () => {
		const rawEvidence = evidence();
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				created_at: "not-a-timestamp",
			}),
		).toThrow("valid timestamp");
		expect(() =>
			createTaskEnvironmentLock({
				...rawEvidence,
				factory_probe_report: undefined,
				created_at: TIMESTAMP,
			}),
		).toThrow("v1 contract");
	});
});
