import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	AXIOS_SMOKE_BASE_COMMIT,
	AXIOS_SMOKE_INSTANCE_ID,
	createTaskEnvironmentCandidate,
	createTaskRoleFactoryProbeRequest,
	TASK_ROLE_FACTORY_PROBE_PROFILE,
	type TaskEnvironmentCandidate,
	type TaskEnvironmentCandidateBuildInput,
	TaskEnvironmentCandidateBuildInputSchema,
	TaskEnvironmentCandidateSchema,
	type TaskRoleFactoryProbeReport,
	TaskRoleFactoryProbeReportSchema,
	type TaskRoleFactoryProbeRequest,
	TaskRoleFactoryProbeRequestSchema,
	taskEnvironmentCandidateHash,
	taskEnvironmentFilesystemProfileHash,
	taskEnvironmentResourceProfileHash,
	taskEnvironmentSecurityProfileHash,
	taskRoleFactoryProbeEvidenceHash,
	taskRoleFactoryProbeReportHash,
	verifyTaskEnvironmentCandidate,
	verifyTaskEnvironmentCandidateAgainstBuildInput,
	verifyTaskRoleFactoryProbeReport,
	verifyTaskRoleFactoryProbeRequest,
} from "../src/contracts/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const WORKER_IMAGE_ID = `sha256:${HASH_A}`;
const EVALUATOR_IMAGE_ID = `sha256:${HASH_B}`;
const TIMESTAMP = "2026-07-18T12:00:00.000Z";

type WorkerEvidence = TaskRoleFactoryProbeReport["roles"]["worker"];
type EvaluatorEvidence = TaskRoleFactoryProbeReport["roles"]["evaluator"];
type RoleEvidence = WorkerEvidence | EvaluatorEvidence;
type CommonEvidence = Omit<WorkerEvidence, "role" | "evidence_sha256">;
type ControllerExecution = TaskRoleFactoryProbeReport["controller_execution"];

function controllerExecution(): ControllerExecution {
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
			{
				type: "tmpfs",
				source: null,
				destination: "/tmp",
				read_write: true,
			},
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

function candidateBuildInput(): TaskEnvironmentCandidateBuildInput {
	return {
		instance_id: AXIOS_SMOKE_INSTANCE_ID,
		base_commit: AXIOS_SMOKE_BASE_COMMIT,
		dataset_lock: { lock_id: "dataset-lock-v1", lock_sha256: HASH_A },
		official_image_source_lock: {
			lock_id: "official-images-v1",
			lock_sha256: HASH_B,
		},
		roles: {
			worker: {
				image: {
					local_image_id: WORKER_IMAGE_ID,
					provenance_sha256: HASH_C,
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
					local_image_id: EVALUATOR_IMAGE_ID,
					provenance_sha256: HASH_D,
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
		probe_sha256: HASH_A,
		sanitizer_sha256: HASH_B,
		adapter_sha256: HASH_C,
		created_at: TIMESTAMP,
	};
}

function unsignedCandidate(): Omit<TaskEnvironmentCandidate, "candidate_sha256"> {
	const { candidate_sha256: _candidateHash, ...candidate } = signedCandidate();
	return candidate;
}

function signedCandidate(): TaskEnvironmentCandidate {
	return createTaskEnvironmentCandidate(candidateBuildInput());
}

function resignCandidate(candidate: TaskEnvironmentCandidate): TaskEnvironmentCandidate {
	const { candidate_sha256: _candidateHash, ...unsigned } = candidate;
	return {
		...unsigned,
		candidate_sha256: taskEnvironmentCandidateHash(unsigned),
	};
}

function signedRequest(candidate: TaskEnvironmentCandidate): TaskRoleFactoryProbeRequest {
	return createTaskRoleFactoryProbeRequest(candidate, "smoke:axios-5892:01");
}

function commonPassingEvidence(
	candidate: TaskEnvironmentCandidate,
	role: "worker" | "evaluator",
	containerId: string,
	volumeName: string,
): CommonEvidence {
	const roleCandidate = candidate.roles[role];
	const mount = roleCandidate.filesystem_profile.writable_mounts[0];
	if (mount === undefined) throw new Error("fixture requires one writable mount");
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
			nonce_sha256: HASH_D,
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

function signedWorkerEvidence(candidate: TaskEnvironmentCandidate): WorkerEvidence {
	const unsigned = {
		role: "worker",
		...commonPassingEvidence(candidate, "worker", "1".repeat(64), "repofix-worker-operation-01"),
	} as const satisfies Omit<WorkerEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function signedEvaluatorEvidence(candidate: TaskEnvironmentCandidate): EvaluatorEvidence {
	const unsigned = {
		role: "evaluator",
		...commonPassingEvidence(candidate, "evaluator", "2".repeat(64), "repofix-evaluator-operation-01"),
	} as const satisfies Omit<EvaluatorEvidence, "evidence_sha256">;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	};
}

function resignEvidence<T extends RoleEvidence>(evidence: T): T {
	const { evidence_sha256: _oldHash, ...unsigned } = evidence;
	return {
		...unsigned,
		evidence_sha256: taskRoleFactoryProbeEvidenceHash(unsigned),
	} as T;
}

function signedReport(
	candidate: TaskEnvironmentCandidate,
	request: TaskRoleFactoryProbeRequest,
	roles = {
		worker: signedWorkerEvidence(candidate),
		evaluator: signedEvaluatorEvidence(candidate),
	},
	status: "pass" | "fail" = "pass",
): TaskRoleFactoryProbeReport {
	const report: Omit<TaskRoleFactoryProbeReport, "report_sha256"> = {
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
		started_at: TIMESTAMP,
		finished_at: TIMESTAMP,
		execution_order: ["worker", "evaluator"],
		roles,
		errors: [],
	};
	return { ...report, report_sha256: taskRoleFactoryProbeReportHash(report) };
}

function resignReport(report: TaskRoleFactoryProbeReport): TaskRoleFactoryProbeReport {
	const { report_sha256: _oldHash, ...unsigned } = report;
	return {
		...unsigned,
		report_sha256: taskRoleFactoryProbeReportHash(unsigned),
	};
}

describe("task role factory probe v1 contracts", () => {
	it("accepts canonical candidate, request, and passing report evidence", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const report = signedReport(candidate, request);

		expect(Compile(TaskEnvironmentCandidateSchema).Check(candidate)).toBe(true);
		expect(Compile(TaskRoleFactoryProbeRequestSchema).Check(request)).toBe(true);
		expect(Compile(TaskRoleFactoryProbeReportSchema).Check(report)).toBe(true);
		expect(verifyTaskEnvironmentCandidate(candidate)).toBe(candidate);
		expect(verifyTaskRoleFactoryProbeRequest(request)).toBe(request);
		expect(verifyTaskRoleFactoryProbeReport(report, candidate, request)).toBe(report);
	});

	it("builds a deterministic M0 Axios candidate without accepting derived fields", () => {
		const input = candidateBuildInput();
		const first = createTaskEnvironmentCandidate(input);
		const second = createTaskEnvironmentCandidate(input);
		const withDerivedField = { ...input, candidate_sha256: HASH_A };

		expect(Compile(TaskEnvironmentCandidateBuildInputSchema).Check(input)).toBe(true);
		expect(Compile(TaskEnvironmentCandidateBuildInputSchema).Check(withDerivedField)).toBe(false);
		expect(() => createTaskEnvironmentCandidate(withDerivedField)).toThrow("strict v1 contract");
		expect(first).toEqual(second);
		expect(first.candidate_id).toMatch(/^task-environment-candidate-v1-axios-5892-[a-f0-9]{64}$/);
		expect(first.instance_id).toBe(AXIOS_SMOKE_INSTANCE_ID);
		expect(first.base_commit).toBe(AXIOS_SMOKE_BASE_COMMIT);
		expect(first.roles.worker.image.platform).toBe("linux/amd64");
		expect(first.roles.evaluator.image.platform).toBe("linux/amd64");
	});

	it("binds a non-Axios candidate identity and every derived profile to its own frozen task", () => {
		const candidate = createTaskEnvironmentCandidate({
			...candidateBuildInput(),
			instance_id: "immutable-js__immutable-js-2005",
			base_commit: "1234567890abcdef1234567890abcdef12345678",
		});

		expect(candidate.instance_id).toBe("immutable-js__immutable-js-2005");
		expect(candidate.base_commit).toBe("1234567890abcdef1234567890abcdef12345678");
		expect(candidate.candidate_id).toMatch(/^task-environment-candidate-v1-immutable-js-2005-[a-f0-9]{64}$/);
		expect(candidate.roles.worker.security_profile.profile_id).toMatch(
			/^task-environment-profile-v1-immutable-js-2005-worker-security-[a-f0-9]{64}$/,
		);
		expect(candidate.roles.evaluator.filesystem_profile.profile_id).toMatch(
			/^task-environment-profile-v1-immutable-js-2005-evaluator-filesystem-[a-f0-9]{64}$/,
		);
		expect(verifyTaskEnvironmentCandidate(candidate)).toBe(candidate);
	});

	it("builds a canonical probe request from a verified candidate and operation ID", () => {
		const candidate = signedCandidate();
		const request = createTaskRoleFactoryProbeRequest(candidate, "factory-probe:axios-5892:01");

		expect(request).toMatchObject({
			schema_version: "v1",
			request_type: "task_role_factory_probe",
			operation_id: "factory-probe:axios-5892:01",
			candidate_id: candidate.candidate_id,
			candidate_sha256: candidate.candidate_sha256,
			probe_profile: TASK_ROLE_FACTORY_PROBE_PROFILE,
		});
		expect(verifyTaskRoleFactoryProbeRequest(request)).toBe(request);
		expect(() => createTaskRoleFactoryProbeRequest(candidate, "invalid operation/id")).toThrow("v1 contract");
	});

	it("derives profile hashes from canonical profile content", () => {
		const candidate = signedCandidate();
		for (const role of [candidate.roles.worker, candidate.roles.evaluator]) {
			const { profile_sha256: securityHash, ...security } = role.security_profile;
			const { profile_sha256: resourceHash, ...resource } = role.resource_profile;
			const { profile_sha256: filesystemHash, ...filesystem } = role.filesystem_profile;
			expect(securityHash).toBe(taskEnvironmentSecurityProfileHash(security));
			expect(resourceHash).toBe(taskEnvironmentResourceProfileHash(resource));
			expect(filesystemHash).toBe(taskEnvironmentFilesystemProfileHash(filesystem));
		}
	});

	it("keeps the environment ID independent of creation time but sensitive to locked inputs", () => {
		const input = candidateBuildInput();
		const first = createTaskEnvironmentCandidate(input);
		const recreated = createTaskEnvironmentCandidate({
			...input,
			created_at: "2026-07-19T12:00:00.000Z",
		});
		const rebound = createTaskEnvironmentCandidate({
			...input,
			dataset_lock: { ...input.dataset_lock, lock_sha256: HASH_D },
		});

		expect(recreated.candidate_id).toBe(first.candidate_id);
		expect(recreated.candidate_sha256).not.toBe(first.candidate_sha256);
		expect(rebound.candidate_id).not.toBe(first.candidate_id);
	});

	it("rejects a re-signed candidate whose environment ID was not derived from its bindings", () => {
		const candidate = signedCandidate();
		const tampered = resignCandidate({
			...candidate,
			dataset_lock: { ...candidate.dataset_lock, lock_sha256: HASH_D },
		});

		expect(() => verifyTaskEnvironmentCandidate(tampered)).toThrow("candidate ID");
	});

	it("rejects a nested profile hash tamper even when the whole candidate is re-signed", () => {
		const candidate = signedCandidate();
		const tampered = resignCandidate({
			...candidate,
			roles: {
				...candidate.roles,
				worker: {
					...candidate.roles.worker,
					resource_profile: {
						...candidate.roles.worker.resource_profile,
						profile_sha256: HASH_D,
					},
				},
			},
		});

		expect(() => verifyTaskEnvironmentCandidate(tampered)).toThrow("resource profile SHA-256");
	});

	it("rejects shared filesystem profiles and non-canonical mount order", () => {
		const candidate = signedCandidate();
		const shared = resignCandidate({
			...candidate,
			roles: {
				...candidate.roles,
				evaluator: {
					...candidate.roles.evaluator,
					filesystem_profile: candidate.roles.worker.filesystem_profile,
				},
			},
		});
		expect(() => verifyTaskEnvironmentCandidate(shared)).toThrow("independently locked");

		const input = candidateBuildInput();
		const ordered = createTaskEnvironmentCandidate({
			...input,
			roles: {
				...input.roles,
				worker: {
					...input.roles.worker,
					filesystem_profile: {
						writable_mounts: [
							{
								type: "volume",
								destination: "/workspace/tmp",
								read_write: true,
							},
							{ type: "volume", destination: "/workspace", read_write: true },
						],
					},
				},
			},
		});
		expect(ordered.roles.worker.filesystem_profile.writable_mounts.map((mount) => mount.destination)).toEqual([
			"/workspace",
			"/workspace/tmp",
		]);
		const reversed = resignCandidate({
			...ordered,
			roles: {
				...ordered.roles,
				worker: {
					...ordered.roles.worker,
					filesystem_profile: {
						...ordered.roles.worker.filesystem_profile,
						writable_mounts: [...ordered.roles.worker.filesystem_profile.writable_mounts].reverse(),
					},
				},
			},
		});
		expect(() => verifyTaskEnvironmentCandidate(reversed)).toThrow("canonical order");
	});

	it("rejects duplicate mounts and non-distinct M0 artifact or lock bindings", () => {
		const input = candidateBuildInput();
		const duplicateMount = {
			...input,
			roles: {
				...input.roles,
				worker: {
					...input.roles.worker,
					filesystem_profile: {
						writable_mounts: [
							{
								type: "volume" as const,
								destination: "/workspace",
								read_write: true as const,
							},
							{
								type: "tmpfs" as const,
								destination: "/workspace",
								read_write: true as const,
							},
						],
					},
				},
			},
		};
		expect(() => createTaskEnvironmentCandidate(duplicateMount)).toThrow("duplicate writable destinations");
		expect(() =>
			createTaskEnvironmentCandidate({
				...input,
				official_image_source_lock: {
					...input.official_image_source_lock,
					lock_sha256: HASH_A,
				},
			}),
		).toThrow("lock references must be distinct");
		expect(() =>
			createTaskEnvironmentCandidate({
				...input,
				adapter_sha256: input.probe_sha256,
			}),
		).toThrow("must have distinct SHA-256 bindings");
	});

	it("binds role image ordering and component hashes to the strict build input", () => {
		const input = candidateBuildInput();
		const candidate = createTaskEnvironmentCandidate(input);
		const swappedInput: TaskEnvironmentCandidateBuildInput = {
			...input,
			roles: {
				worker: { ...input.roles.worker, image: input.roles.evaluator.image },
				evaluator: {
					...input.roles.evaluator,
					image: input.roles.worker.image,
				},
			},
		};
		const swapped = createTaskEnvironmentCandidate(swappedInput);
		const rebound = createTaskEnvironmentCandidate({
			...input,
			dataset_lock: { ...input.dataset_lock, lock_sha256: HASH_D },
		});

		expect(verifyTaskEnvironmentCandidateAgainstBuildInput(candidate, input)).toBe(candidate);
		expect(() => verifyTaskEnvironmentCandidateAgainstBuildInput(swapped, input)).toThrow("build input bindings");
		expect(() => verifyTaskEnvironmentCandidateAgainstBuildInput(rebound, input)).toThrow("build input bindings");
		expect(() =>
			verifyTaskEnvironmentCandidateAgainstBuildInput(candidate, {
				...input,
				sanitizer_sha256: HASH_D,
			}),
		).toThrow("build input bindings");
	});

	it("rejects caller-supplied image platforms in the strict build input", () => {
		const input = candidateBuildInput();
		const invalid = {
			...input,
			roles: {
				...input.roles,
				worker: {
					...input.roles.worker,
					image: { ...input.roles.worker.image, platform: "linux/arm64" },
				},
			},
		};
		expect(Compile(TaskEnvironmentCandidateBuildInputSchema).Check(invalid)).toBe(false);
		expect(() => createTaskEnvironmentCandidate(invalid)).toThrow("strict v1 contract");
	});

	it("enforces the fixed candidate capability drop array in TypeBox", () => {
		const candidate = signedCandidate();
		const invalid = {
			...candidate,
			roles: {
				...candidate.roles,
				worker: {
					...candidate.roles.worker,
					security_profile: {
						...candidate.roles.worker.security_profile,
						cap_drop: [],
					},
				},
			},
		};

		expect(Compile(TaskEnvironmentCandidateSchema).Check(candidate)).toBe(true);
		expect(Compile(TaskEnvironmentCandidateSchema).Check(invalid)).toBe(false);
	});

	it("rejects candidate content modified after canonical signing", () => {
		const candidate = signedCandidate();
		expect(() =>
			verifyTaskEnvironmentCandidate({
				...candidate,
				adapter_sha256: HASH_D,
			}),
		).toThrow("candidate SHA-256");
	});

	it("rejects unsafe candidate semantics before any factory request", () => {
		const unsigned = unsignedCandidate();
		const unsafe = {
			...unsigned,
			roles: {
				...unsigned.roles,
				worker: {
					...unsigned.roles.worker,
					resource_profile: {
						...unsigned.roles.worker.resource_profile,
						memory_swap_bytes: unsigned.roles.worker.resource_profile.memory_bytes * 2,
					},
				},
			},
		};
		const candidate = {
			...unsafe,
			candidate_sha256: taskEnvironmentCandidateHash(unsafe),
		};
		expect(() => verifyTaskEnvironmentCandidate(candidate)).toThrow("memory swap");
	});

	it.each(["image", "command", "mount", "network", "user", "capability", "docker"])(
		"forbids caller-supplied %s controls in requests",
		(field) => {
			const request = signedRequest(signedCandidate());
			expect(
				Compile(TaskRoleFactoryProbeRequestSchema).Check({
					...request,
					[field]: "forbidden",
				}),
			).toBe(false);
		},
	);

	it("rejects request hash or fixed profile drift", () => {
		const request = signedRequest(signedCandidate());
		expect(() =>
			verifyTaskRoleFactoryProbeRequest({
				...request,
				candidate_id: "different",
			}),
		).toThrow("request SHA-256");
		expect(
			Compile(TaskRoleFactoryProbeRequestSchema).Check({
				...request,
				probe_profile: "arbitrary-profile",
			}),
		).toBe(false);
	});

	it("rejects report bindings even when the report is re-signed", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const report = resignReport({
			...signedReport(candidate, request),
			operation_id: "different-operation",
		});

		expect(() => verifyTaskRoleFactoryProbeReport(report, candidate, request)).toThrow("bindings");
	});

	it("rejects re-signed Controller execution identity or safety drift", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const mutations: Array<(execution: ControllerExecution) => ControllerExecution> = [
			(execution) => ({
				...execution,
				container_hostname: "f".repeat(12),
			}),
			(execution) => ({
				...execution,
				published_ports: ["0.0.0.0:8000->8000/tcp"],
			}),
			(execution) => ({
				...execution,
				networks: [{ ...execution.networks[0]!, internal: false }],
			}),
			(execution) => ({
				...execution,
				mounts: execution.mounts.map((mount) =>
					mount.type === "volume" ? { ...mount, source: "repofixlab_controller-work" } : mount,
				),
			}),
			(execution) => ({
				...execution,
				mounts: execution.mounts.map((mount) =>
					mount.type === "bind" ? { ...mount, source: "/run/docker.sock" } : mount,
				),
			}),
			(execution) => ({
				...execution,
				mounts: execution.mounts.map((mount) =>
					mount.type === "bind" ? { ...mount, destination: "/run/docker.sock" } : mount,
				),
			}),
			(execution) => ({
				...execution,
				mounts: execution.mounts.map((mount) => (mount.type === "bind" ? { ...mount, read_write: false } : mount)),
			}),
		];
		for (const mutate of mutations) {
			const report = resignReport({
				...signedReport(candidate, request),
				controller_execution: mutate(controllerExecution()),
			});
			expect(Compile(TaskRoleFactoryProbeReportSchema).Check(report)).toBe(true);
			expect(() => verifyTaskRoleFactoryProbeReport(report, candidate, request)).toThrow("Controller execution");
		}
	});

	it("accepts the exact Docker Desktop socket proxy source", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const execution = controllerExecution();
		const report = resignReport({
			...signedReport(candidate, request),
			controller_execution: {
				...execution,
				mounts: execution.mounts.map((mount) =>
					mount.type === "bind" ? { ...mount, source: "/run/host-services/docker.proxy.sock" } : mount,
				),
			},
		});

		expect(verifyTaskRoleFactoryProbeReport(report, candidate, request)).toBe(report);
	});

	it("rejects a reversed execution order after schema validation and re-signing", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const report = resignReport({
			...signedReport(candidate, request),
			execution_order: ["evaluator", "worker"],
		});

		expect(Compile(TaskRoleFactoryProbeReportSchema).Check(report)).toBe(true);
		expect(() => verifyTaskRoleFactoryProbeReport(report, candidate, request)).toThrow("execution order");
	});

	it("rejects a passing role when runtime inspect drifts", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const worker = signedWorkerEvidence(candidate);
		if (worker.inspect === null) throw new Error("fixture requires inspect evidence");
		const invalidWorker = resignEvidence({
			...worker,
			inspect: { ...worker.inspect, network_mode: "bridge" },
		});
		const report = signedReport(candidate, request, {
			worker: invalidWorker,
			evaluator: signedEvaluatorEvidence(candidate),
		});

		expect(() => verifyTaskRoleFactoryProbeReport(report, candidate, request)).toThrow(
			"worker status does not match",
		);
	});

	it("rejects a passing report with incomplete active probe or cleanup evidence", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const evaluator = signedEvaluatorEvidence(candidate);
		if (evaluator.active_probe === null) throw new Error("fixture requires active probe evidence");
		const invalidEvaluator = resignEvidence({
			...evaluator,
			active_probe: {
				...evaluator.active_probe,
				writable_path_roundtrip: false,
			},
			cleanup: {
				...evaluator.cleanup,
				residual_volume_names: ["repofix-residual"],
			},
		});
		const report = signedReport(candidate, request, {
			worker: signedWorkerEvidence(candidate),
			evaluator: invalidEvaluator,
		});

		expect(() => verifyTaskRoleFactoryProbeReport(report, candidate, request)).toThrow(
			"evaluator status does not match",
		);
	});

	it("accepts a fully hashed, semantically consistent failure report", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const worker = signedWorkerEvidence(candidate);
		if (worker.inspect === null) throw new Error("fixture requires inspect evidence");
		const failedWorker = resignEvidence({
			...worker,
			status: "fail",
			failure_phase: "runtime_inspect",
			inspect: { ...worker.inspect, privileged: true },
			errors: ["Worker unexpectedly ran privileged"],
		});
		const report = signedReport(
			candidate,
			request,
			{ worker: failedWorker, evaluator: signedEvaluatorEvidence(candidate) },
			"fail",
		);

		expect(verifyTaskRoleFactoryProbeReport(report, candidate, request)).toBe(report);
	});

	it("rejects role evidence modified without recomputing its nested hash", () => {
		const candidate = signedCandidate();
		const request = signedRequest(candidate);
		const report = signedReport(candidate, request);
		const tampered = resignReport({
			...report,
			roles: {
				...report.roles,
				worker: { ...report.roles.worker, actual_image_id: EVALUATOR_IMAGE_ID },
			},
		});

		expect(() => verifyTaskRoleFactoryProbeReport(tampered, candidate, request)).toThrow("role evidence SHA-256");
	});
});
