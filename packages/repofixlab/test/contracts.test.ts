import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	type BootstrapDoctorReport,
	BootstrapDoctorReportSchema,
	type ControllerBootstrapHealth,
	ControllerBootstrapHealthSchema,
	type DatasetLock,
	DatasetLockSchema,
	type OfficialImageSourceLock,
	OfficialImageSourceLockSchema,
	type PublicTaskManifest,
	PublicTaskManifestSchema,
	type TaskEnvironmentLock,
	TaskEnvironmentLockSchema,
} from "../src/contracts/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const IMAGE_ID = `sha256:${HASH_A}`;
const IMAGE_DIGEST = `registry.example/repofix/axios@sha256:${HASH_B}`;
const TIMESTAMP = "2026-07-18T12:00:00.000Z";

const RESOURCE_PROFILE = {
	cpu_count: 2,
	memory_bytes: 4_294_967_296,
	pids_limit: 512,
	network_mode: "none",
	read_only_root_filesystem: true,
} as const;

const datasetLock = {
	schema_version: "v1",
	lock_type: "dataset",
	lock_id: "dataset-lock-v1",
	dataset: {
		name: "SWE-bench/SWE-bench_Multilingual",
		revision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
	},
	generation_id: "dataset-v1-01",
	volumes: {
		public: "repofix-dataset-public-v1-01",
		control: "repofix-dataset-control-v1-01",
		private: "repofix-dataset-private-v1-01",
	},
	record_count: 43,
	files: [{ scope: "public", path: "tasks/axios__axios-5892.json", bytes: 1024, sha256: HASH_A }],
	aggregate_sha256: HASH_B,
	ready: { sha256: HASH_A, written_at: TIMESTAMP },
	seal: { sha256: HASH_B, written_at: TIMESTAMP },
	created_by_image_id: IMAGE_ID,
	created_at: TIMESTAMP,
} satisfies DatasetLock;

const officialImageSourceLock = {
	schema_version: "v1",
	lock_type: "official_image_source",
	lock_id: "official-images-v1",
	dataset_revision: "2b7aced941b4873e9cad3e76abbae93f481d1beb",
	harness_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57",
	images: [
		{
			image_key: "axios__axios-5892",
			requested_reference: "swebench/sweb.eval.x86_64.axios_1776_axios-5892:latest",
			repository_digest: IMAGE_DIGEST,
			local_image_id: IMAGE_ID,
			platform: "linux/amd64",
			registry_response_sha256: HASH_A,
			resolved_at: TIMESTAMP,
		},
	],
	seal_sha256: HASH_B,
	created_at: TIMESTAMP,
} satisfies OfficialImageSourceLock;

const lockedSourceImage = {
	repository_digest: IMAGE_DIGEST,
	local_image_id: IMAGE_ID,
	platform: "linux/amd64",
} as const;

const lockedDerivedImage = {
	local_image_id: IMAGE_ID,
	platform: "linux/amd64",
	provenance_sha256: HASH_A,
} as const;

const taskEnvironmentLock = {
	schema_version: "v1",
	lock_type: "task_environment",
	lock_id: "task-environment-axios-5892",
	instance_id: "axios__axios-5892",
	candidate_id: "task-environment-candidate-axios-5892",
	candidate_sha256: HASH_A,
	dataset_lock_id: datasetLock.lock_id,
	official_image_source_lock_id: officialImageSourceLock.lock_id,
	source_image: lockedSourceImage,
	worker_image: lockedDerivedImage,
	evaluator_image: lockedDerivedImage,
	resource_profile: RESOURCE_PROFILE,
	filesystem_profile_sha256: HASH_A,
	sanitizer_sha256: HASH_B,
	adapter_sha256: HASH_A,
	verification: {
		factory_probe_passed: true,
		factory_probe_report_sha256: HASH_A,
		equivalence_passed: true,
		security_profile_passed: true,
		evidence_sha256: HASH_B,
		completed_at: TIMESTAMP,
	},
	seal_sha256: HASH_B,
	created_at: TIMESTAMP,
} satisfies TaskEnvironmentLock;

const publicTaskManifest = {
	schema_version: "v1",
	manifest_id: "manifest-axios-5892",
	dataset_lock_id: datasetLock.lock_id,
	task_environment_lock_id: taskEnvironmentLock.lock_id,
	task: {
		instance_id: "axios__axios-5892",
		repo: "axios/axios",
		problem_statement: "Axios must preserve the expected request behavior.",
		base_commit: "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b",
		language: "TypeScript",
	},
	worker_image_id: IMAGE_ID,
	resource_profile: RESOURCE_PROFILE,
	split: "dev",
	manifest_sha256: HASH_A,
	created_at: TIMESTAMP,
} satisfies PublicTaskManifest;

const bootstrapDoctorReport = {
	schema_version: "v1",
	report_type: "bootstrap_doctor",
	report_id: "doctor-bootstrap-01",
	status: "fail",
	started_at: TIMESTAMP,
	finished_at: TIMESTAMP,
	checks: {
		docker_daemon: { state: "unverified", message: "Docker Engine is not running." },
		host_artifacts_storage: {
			state: "pass",
			path: "/artifacts",
			minimum_available_bytes: 120_000_000_000,
			available_bytes: 215_581_257_728,
			message: "Host artifacts storage meets the minimum.",
		},
		docker_managed_storage: {
			state: "unverified",
			path: "/probe",
			minimum_available_bytes: 120_000_000_000,
			probe_image_digest: IMAGE_DIGEST,
			message: "Docker managed storage was not measured.",
		},
		compute: {
			state: "unverified",
			minimum_cpu_count: 8,
			minimum_memory_bytes: 17_179_869_184,
			message: "Docker compute capacity was not measured.",
		},
		control_network: { state: "unverified", actual: null, message: "Control network was not probed." },
		docker_socket_ownership: {
			state: "unverified",
			required_roles: ["controller", "orchestrator"],
			deferred_roles: {
				dataset_preparer: "dataset_prepare",
				worker: "smoke_formal",
				evaluator: "smoke_formal",
			},
			actual: {
				controller: null,
				orchestrator: null,
				dataset_preparer: null,
				worker: null,
				evaluator: null,
			},
			message: "Socket ownership was not probed.",
		},
		base_images: {
			state: "fail",
			lock_sha256: null,
			evidence_sha256: null,
			services: {
				controller: {
					state: "fail",
					expected_image_id: null,
					actual_image_id: null,
					expected_compose_config_sha256: null,
					actual_compose_config_sha256: null,
					base_repository_digest: null,
					base_image_id: null,
					errors: ["External image provenance lock is missing."],
				},
				orchestrator: {
					state: "fail",
					expected_image_id: null,
					actual_image_id: null,
					expected_compose_config_sha256: null,
					actual_compose_config_sha256: null,
					base_repository_digest: null,
					base_image_id: null,
					errors: ["External image provenance lock is missing."],
				},
			},
			message: "Bootstrap image provenance was not verified.",
		},
		controller_integrity: {
			state: "fail",
			errors: ["Controller evidence unavailable."],
			message: "Controller collection failed.",
		},
	},
	warnings: ["C drive free space is below the warning threshold."],
	report_sha256: HASH_A,
} satisfies BootstrapDoctorReport;

const controllerBootstrapHealth = {
	schema_version: "v1",
	response_type: "controller_bootstrap_health",
	daemon_reachable: true,
	server_version: "29.3.1",
	os_type: "linux",
	architecture: "x86_64",
	cpu_count: 12,
	memory_bytes: "16616996864",
	docker_root_dir: "/var/lib/docker",
	docker_volume_available_bytes: "949433208832",
	docker_volume_id: "repofixlab-bootstrap-doctor-volume-0123456789ab",
	probe_image_digest: "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
	control_network_internal: true,
	image_provenance: {
		services: {
			controller: {
				container_id: "c".repeat(64),
				image_id: IMAGE_ID,
				platform: "linux/amd64",
				compose_project: "repofixlab",
				compose_service: "controller",
				compose_config_sha256: HASH_A,
				published_ports: [],
				networks: [
					{
						network_id: "d".repeat(64),
						compose_project: "repofixlab",
						compose_network: "repofix-control",
						internal: true,
					},
				],
				image_rootfs_layers: [IMAGE_ID],
				base_image: {
					image_id: IMAGE_ID,
					platform: "linux/amd64",
					repository_digests: [IMAGE_DIGEST],
					rootfs_layers: [IMAGE_ID],
				},
			},
			orchestrator: null,
		},
	},
	socket_topology: {
		controller: "read-write",
		orchestrator: "none",
		dataset_preparer: null,
		worker: null,
		evaluator: null,
	},
	errors: [],
} satisfies ControllerBootstrapHealth;

describe("RepoFixLab v1 contracts", () => {
	it("accepts representative sealed contracts", () => {
		expect(Compile(DatasetLockSchema).Check(datasetLock)).toBe(true);
		expect(Compile(OfficialImageSourceLockSchema).Check(officialImageSourceLock)).toBe(true);
		expect(Compile(TaskEnvironmentLockSchema).Check(taskEnvironmentLock)).toBe(true);
		expect(Compile(PublicTaskManifestSchema).Check(publicTaskManifest)).toBe(true);
		expect(Compile(BootstrapDoctorReportSchema).Check(bootstrapDoctorReport)).toBe(true);
		expect(Compile(ControllerBootstrapHealthSchema).Check(controllerBootstrapHealth)).toBe(true);
	});

	it("rejects traversal paths in dataset locks", () => {
		const invalid = {
			...datasetLock,
			files: [{ ...datasetLock.files[0], path: "../private/tasks.json" }],
		};
		expect(Compile(DatasetLockSchema).Check(invalid)).toBe(false);
	});

	it("rejects floating image references where a repository digest is required", () => {
		const invalid = {
			...officialImageSourceLock,
			images: [{ ...officialImageSourceLock.images[0], repository_digest: "repofix/axios:latest" }],
		};
		expect(Compile(OfficialImageSourceLockSchema).Check(invalid)).toBe(false);
	});

	it("rejects sampling metadata in the public task manifest", () => {
		const invalid = {
			...publicTaskManifest,
			task: { ...publicTaskManifest.task, gold_changed_lines: 12 },
		};
		expect(Compile(PublicTaskManifestSchema).Check(invalid)).toBe(false);
	});

	it("rejects network-enabled worker resource profiles", () => {
		const invalid = {
			...taskEnvironmentLock,
			resource_profile: { ...taskEnvironmentLock.resource_profile, network_mode: "bridge" },
		};
		expect(Compile(TaskEnvironmentLockSchema).Check(invalid)).toBe(false);
	});

	it("rejects the retired preflight self-attestation on final environment locks", () => {
		const { verification: _verification, ...withoutVerification } = taskEnvironmentLock;
		const invalid = {
			...withoutVerification,
			preflight: {
				passed: true,
				equivalence_passed: true,
				security_profile_passed: true,
				evidence_sha256: HASH_A,
				completed_at: TIMESTAMP,
			},
		};
		expect(Compile(TaskEnvironmentLockSchema).Check(invalid)).toBe(false);
	});

	it("rejects the retired self-attested base image boolean", () => {
		expect(
			Compile(ControllerBootstrapHealthSchema).Check({
				...controllerBootstrapHealth,
				base_images_pinned: true,
			}),
		).toBe(false);
	});
});
