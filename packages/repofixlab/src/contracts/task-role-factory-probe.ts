import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "./schema-generator.ts";
import {
	TASK_ROLE_FACTORY_PROBE_PROFILE,
	type TaskEnvironmentCandidate,
	type TaskEnvironmentCandidateBuildInput,
	TaskEnvironmentCandidateBuildInputSchema,
	TaskEnvironmentCandidateSchema,
	type TaskRoleFactoryProbeReport,
	TaskRoleFactoryProbeReportSchema,
	type TaskRoleFactoryProbeRequest,
	TaskRoleFactoryProbeRequestSchema,
} from "./v1.ts";

type CandidateRole = TaskEnvironmentCandidate["roles"]["worker"] | TaskEnvironmentCandidate["roles"]["evaluator"];
type CandidateRoleName = CandidateRole["role"];
type CandidateProfileKind = "security" | "resource" | "filesystem";
type CandidateSecurityProfile = CandidateRole["security_profile"];
type CandidateResourceProfile = CandidateRole["resource_profile"];
type CandidateFilesystemProfile = CandidateRole["filesystem_profile"];
type CandidateSecurityProfileBody = Omit<CandidateSecurityProfile, "profile_id" | "profile_sha256">;
type CandidateResourceProfileBody = Omit<CandidateResourceProfile, "profile_id" | "profile_sha256">;
type CandidateFilesystemProfileBody = Omit<CandidateFilesystemProfile, "profile_id" | "profile_sha256">;
type CandidateIdentityMaterial = Omit<TaskEnvironmentCandidate, "candidate_id" | "candidate_sha256" | "created_at">;
type FactoryRoleEvidence =
	| TaskRoleFactoryProbeReport["roles"]["worker"]
	| TaskRoleFactoryProbeReport["roles"]["evaluator"];
type ControllerExecution = TaskRoleFactoryProbeReport["controller_execution"];

export const CONTROLLER_DOCKER_SOCKET_SOURCES = [
	"/var/run/docker.sock",
	"/run/host-services/docker.proxy.sock",
] as const;

const candidateValidator = Compile(TaskEnvironmentCandidateSchema);
const candidateBuildInputValidator = Compile(TaskEnvironmentCandidateBuildInputSchema);
const requestValidator = Compile(TaskRoleFactoryProbeRequestSchema);
const reportValidator = Compile(TaskRoleFactoryProbeReportSchema);

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function arraysMatchExactly(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareWritableMounts(
	left: CandidateFilesystemProfileBody["writable_mounts"][number],
	right: CandidateFilesystemProfileBody["writable_mounts"][number],
): number {
	const destinationOrder = compareText(left.destination, right.destination);
	return destinationOrder === 0 ? compareText(left.type, right.type) : destinationOrder;
}

function canonicalWritableMounts(
	mounts: CandidateFilesystemProfileBody["writable_mounts"],
): CandidateFilesystemProfileBody["writable_mounts"] {
	return mounts
		.map((mount) => ({
			type: mount.type,
			destination: mount.destination,
			read_write: mount.read_write,
		}))
		.sort(compareWritableMounts);
}

function environmentInstancePrefix(instanceId: string): string {
	const separator = instanceId.indexOf("__");
	if (separator < 1 || separator === instanceId.length - 2) {
		throw new Error("Task environment candidate instance ID is not repository-qualified");
	}
	const repository = instanceId.slice(0, separator);
	const task = instanceId.slice(separator + 2);
	return task.startsWith(`${repository}-`) ? task : `${repository}-${task}`;
}

function profileId(instanceId: string, role: CandidateRoleName, kind: CandidateProfileKind, body: unknown): string {
	return `task-environment-profile-v1-${environmentInstancePrefix(instanceId)}-${role}-${kind}-${canonicalHash(body)}`;
}

function securityProfileBody(): CandidateSecurityProfileBody {
	return {
		network_mode: "none",
		read_only_root_filesystem: true,
		cap_drop: ["ALL"],
		cap_add: [],
		no_new_privileges: true,
		privileged: false,
		devices: [],
		host_bind_mounts_allowed: false,
		docker_socket_allowed: false,
		published_ports_allowed: false,
		sensitive_environment_allowed: false,
		tty: false,
		stdin_open: false,
		auto_remove: false,
	};
}

function buildSecurityProfile(instanceId: string, role: CandidateRoleName): CandidateSecurityProfile {
	const body = securityProfileBody();
	const unsigned = { profile_id: profileId(instanceId, role, "security", body), ...body };
	return {
		...unsigned,
		profile_sha256: taskEnvironmentSecurityProfileHash(unsigned),
	};
}

function buildResourceProfile(
	instanceId: string,
	role: CandidateRoleName,
	body: CandidateResourceProfileBody,
): CandidateResourceProfile {
	const unsigned = { profile_id: profileId(instanceId, role, "resource", body), ...body };
	return {
		...unsigned,
		profile_sha256: taskEnvironmentResourceProfileHash(unsigned),
	};
}

function buildFilesystemProfile(
	instanceId: string,
	role: CandidateRoleName,
	body: CandidateFilesystemProfileBody,
): CandidateFilesystemProfile {
	const canonicalBody = {
		writable_mounts: canonicalWritableMounts(body.writable_mounts),
	};
	const unsigned = {
		profile_id: profileId(instanceId, role, "filesystem", canonicalBody),
		...canonicalBody,
	};
	return {
		...unsigned,
		profile_sha256: taskEnvironmentFilesystemProfileHash(unsigned),
	};
}

function assertDistinctExternalBindings(
	value: Pick<
		TaskEnvironmentCandidate,
		"dataset_lock" | "official_image_source_lock" | "roles" | "probe_sha256" | "sanitizer_sha256" | "adapter_sha256"
	>,
): void {
	if (
		value.dataset_lock.lock_id === value.official_image_source_lock.lock_id ||
		value.dataset_lock.lock_sha256 === value.official_image_source_lock.lock_sha256
	) {
		throw new Error("Dataset and official image source lock references must be distinct");
	}
	if (
		value.roles.worker.image.local_image_id === value.roles.evaluator.image.local_image_id ||
		value.roles.worker.image.provenance_sha256 === value.roles.evaluator.image.provenance_sha256
	) {
		throw new Error("Worker and Evaluator images must be independently locked");
	}
	if (new Set([value.probe_sha256, value.sanitizer_sha256, value.adapter_sha256]).size !== 3) {
		throw new Error("Probe, sanitizer, and adapter artifacts must have distinct SHA-256 bindings");
	}
}

function verifyRoleProfiles(instanceId: string, roleName: CandidateRoleName, role: CandidateRole): void {
	const { profile_sha256: securityHash, ...unsignedSecurity } = role.security_profile;
	const { profile_id: securityId, ...securityBody } = unsignedSecurity;
	if (securityId !== profileId(instanceId, roleName, "security", securityBody)) {
		throw new Error(`${roleName} security profile ID does not match its canonical content`);
	}
	if (securityHash !== taskEnvironmentSecurityProfileHash(unsignedSecurity)) {
		throw new Error(`${roleName} security profile SHA-256 does not match its canonical content`);
	}

	const { profile_sha256: resourceHash, ...unsignedResource } = role.resource_profile;
	const { profile_id: resourceId, ...resourceBody } = unsignedResource;
	if (resourceId !== profileId(instanceId, roleName, "resource", resourceBody)) {
		throw new Error(`${roleName} resource profile ID does not match its canonical content`);
	}
	if (resourceHash !== taskEnvironmentResourceProfileHash(unsignedResource)) {
		throw new Error(`${roleName} resource profile SHA-256 does not match its canonical content`);
	}

	const { profile_sha256: filesystemHash, ...unsignedFilesystem } = role.filesystem_profile;
	const { profile_id: filesystemId, ...filesystemBody } = unsignedFilesystem;
	if (filesystemId !== profileId(instanceId, roleName, "filesystem", filesystemBody)) {
		throw new Error(`${roleName} filesystem profile ID does not match its canonical content`);
	}
	if (filesystemHash !== taskEnvironmentFilesystemProfileHash(unsignedFilesystem)) {
		throw new Error(`${roleName} filesystem profile SHA-256 does not match its canonical content`);
	}
}

function mountSignatures(mounts: readonly { type: string; destination: string; read_write: boolean }[]): string[] {
	return mounts.map((mount) => `${mount.type}\0${mount.destination}\0${String(mount.read_write)}`).sort();
}

function roleEvidenceHashIsValid(evidence: FactoryRoleEvidence): boolean {
	const { evidence_sha256: actualHash, ...unsignedEvidence } = evidence;
	return taskRoleFactoryProbeEvidenceHash(unsignedEvidence) === actualHash;
}

export function controllerExecutionMountsMatchExactAllowlist(execution: ControllerExecution): boolean {
	const actualMounts = new Set(
		execution.mounts.map((mount) => JSON.stringify([mount.type, mount.source, mount.destination, mount.read_write])),
	);
	return (
		execution.mounts.length === 4 &&
		actualMounts.size === 4 &&
		CONTROLLER_DOCKER_SOCKET_SOURCES.some((socketSource) => {
			const expectedMounts = new Set([
				JSON.stringify(["bind", socketSource, "/var/run/docker.sock", true]),
				JSON.stringify([
					"volume",
					`${execution.compose_project}_controller-work-v2`,
					"/var/lib/repofix/controller",
					true,
				]),
				JSON.stringify([
					"volume",
					`${execution.compose_project}_controller-candidates-v1`,
					"/etc/repofixlab/candidates",
					false,
				]),
				JSON.stringify(["tmpfs", null, "/tmp", true]),
			]);
			return [...actualMounts].every((mount) => expectedMounts.has(mount));
		})
	);
}

function controllerExecutionHardGatesPass(execution: ControllerExecution): boolean {
	const network = execution.networks[0];
	return (
		execution.container_id.startsWith(execution.container_hostname) &&
		execution.compose_service === "controller" &&
		execution.read_only_root_filesystem &&
		arraysMatchExactly(execution.cap_drop, ["ALL"]) &&
		arraysMatchExactly(execution.security_opt, ["no-new-privileges:true"]) &&
		execution.published_ports.length === 0 &&
		execution.networks.length === 1 &&
		network !== undefined &&
		network.compose_project === execution.compose_project &&
		network.compose_network === "repofix-control" &&
		network.internal &&
		controllerExecutionMountsMatchExactAllowlist(execution)
	);
}

function candidateRoleForEvidence(candidate: TaskEnvironmentCandidate, evidence: FactoryRoleEvidence): CandidateRole {
	return evidence.role === "worker" ? candidate.roles.worker : candidate.roles.evaluator;
}

function roleHardGatesPass(candidate: TaskEnvironmentCandidate, evidence: FactoryRoleEvidence): boolean {
	const role = candidateRoleForEvidence(candidate, evidence);
	if (
		evidence.expected_image_id !== role.image.local_image_id ||
		evidence.expected_platform !== role.image.platform ||
		evidence.expected_provenance_sha256 !== role.image.provenance_sha256
	) {
		throw new Error(`${evidence.role} expected image evidence does not match the candidate`);
	}

	const inspect = evidence.inspect;
	const activeProbe = evidence.active_probe;
	const cleanup = evidence.cleanup;
	const volumeMountSources =
		inspect?.mounts
			.filter((mount) => mount.type === "volume")
			.map((mount) => mount.source)
			.filter((source): source is string => source !== null) ?? [];
	const mountSourcesPass =
		inspect?.mounts.every((mount) =>
			mount.type === "volume" ? mount.source !== null : mount.type === "tmpfs" && mount.source === null,
		) === true && arraysEqual(volumeMountSources, cleanup.created_volume_names);
	const inspectPasses =
		evidence.container_id !== null &&
		evidence.actual_image_id === role.image.local_image_id &&
		evidence.actual_platform === role.image.platform &&
		evidence.actual_provenance_sha256 === role.image.provenance_sha256 &&
		inspect !== null &&
		inspect.configured_user === `${role.runtime_user.uid}:${role.runtime_user.gid}` &&
		inspect.uid === role.runtime_user.uid &&
		inspect.gid === role.runtime_user.gid &&
		inspect.network_mode === role.security_profile.network_mode &&
		inspect.read_only_root_filesystem === role.security_profile.read_only_root_filesystem &&
		arraysEqual(inspect.cap_drop, role.security_profile.cap_drop) &&
		arraysEqual(inspect.cap_add, role.security_profile.cap_add) &&
		arraysEqual(inspect.security_opt, ["no-new-privileges:true"]) &&
		inspect.privileged === role.security_profile.privileged &&
		inspect.device_count === 0 &&
		inspect.nano_cpus === role.resource_profile.nano_cpus &&
		inspect.memory_bytes === role.resource_profile.memory_bytes &&
		inspect.memory_swap_bytes === role.resource_profile.memory_swap_bytes &&
		inspect.pids_limit === role.resource_profile.pids_limit &&
		inspect.tty === role.security_profile.tty &&
		inspect.stdin_open === role.security_profile.stdin_open &&
		inspect.auto_remove === role.security_profile.auto_remove &&
		inspect.published_ports.length === 0 &&
		inspect.mounts.every((mount) => mount.type !== "bind") &&
		JSON.stringify(mountSignatures(inspect.mounts)) ===
			JSON.stringify(mountSignatures(role.filesystem_profile.writable_mounts)) &&
		mountSourcesPass &&
		inspect.docker_socket_paths_present.length === 0 &&
		inspect.sensitive_environment_names_present.length === 0;

	const activeProbePasses =
		activeProbe !== null &&
		activeProbe.status === "pass" &&
		activeProbe.probe_sha256 === candidate.probe_sha256 &&
		activeProbe.exit_code === 0 &&
		activeProbe.timed_out === false &&
		activeProbe.duration_ms <= role.resource_profile.timeout_seconds * 1_000 &&
		activeProbe.stdout_sha256 !== null &&
		activeProbe.stderr_sha256 !== null &&
		activeProbe.observed_uid === role.runtime_user.uid &&
		activeProbe.observed_gid === role.runtime_user.gid &&
		activeProbe.observed_base_commit === candidate.base_commit &&
		activeProbe.writable_path_roundtrip &&
		activeProbe.docker_socket_paths_present.length === 0 &&
		activeProbe.sensitive_environment_names_present.length === 0 &&
		activeProbe.errors.length === 0;

	const cleanupPasses =
		cleanup.container_removal_attempted &&
		cleanup.container_removed &&
		arraysEqual(cleanup.created_volume_names, cleanup.removed_volume_names) &&
		cleanup.residual_container_ids.length === 0 &&
		cleanup.residual_volume_names.length === 0 &&
		cleanup.errors.length === 0;

	return inspectPasses && activeProbePasses && cleanupPasses && evidence.errors.length === 0;
}

export function taskEnvironmentCandidateHash(value: Omit<TaskEnvironmentCandidate, "candidate_sha256">): string {
	return canonicalHash(value);
}

export function taskEnvironmentSecurityProfileHash(value: Omit<CandidateSecurityProfile, "profile_sha256">): string {
	return canonicalHash(value);
}

export function taskEnvironmentResourceProfileHash(value: Omit<CandidateResourceProfile, "profile_sha256">): string {
	return canonicalHash(value);
}

export function taskEnvironmentFilesystemProfileHash(
	value: Omit<CandidateFilesystemProfile, "profile_sha256">,
): string {
	return canonicalHash(value);
}

export function taskEnvironmentCandidateId(value: CandidateIdentityMaterial): string {
	return `task-environment-candidate-v1-${environmentInstancePrefix(value.instance_id)}-${canonicalHash(value)}`;
}

export function createTaskEnvironmentCandidate(input: unknown): TaskEnvironmentCandidate {
	if (!candidateBuildInputValidator.Check(input)) {
		throw new Error("Task environment candidate build input does not satisfy the strict v1 contract");
	}
	const workerFilesystem = buildFilesystemProfile(input.instance_id, "worker", input.roles.worker.filesystem_profile);
	const evaluatorFilesystem = buildFilesystemProfile(input.instance_id, "evaluator", input.roles.evaluator.filesystem_profile);
	const identity: CandidateIdentityMaterial = {
		schema_version: "v1",
		candidate_type: "task_environment_candidate",
		instance_id: input.instance_id,
		base_commit: input.base_commit,
		dataset_lock: { ...input.dataset_lock },
		official_image_source_lock: { ...input.official_image_source_lock },
		roles: {
			worker: {
				role: "worker",
				image: { ...input.roles.worker.image, platform: "linux/amd64" },
				runtime_user: { ...input.roles.worker.runtime_user },
				security_profile: buildSecurityProfile(input.instance_id, "worker"),
				resource_profile: buildResourceProfile(input.instance_id, "worker", input.roles.worker.resource_profile),
				filesystem_profile: workerFilesystem,
			},
			evaluator: {
				role: "evaluator",
				image: { ...input.roles.evaluator.image, platform: "linux/amd64" },
				runtime_user: { ...input.roles.evaluator.runtime_user },
				security_profile: buildSecurityProfile(input.instance_id, "evaluator"),
				resource_profile: buildResourceProfile(input.instance_id, "evaluator", input.roles.evaluator.resource_profile),
				filesystem_profile: evaluatorFilesystem,
			},
		},
		probe_sha256: input.probe_sha256,
		sanitizer_sha256: input.sanitizer_sha256,
		adapter_sha256: input.adapter_sha256,
	};
	const unsignedCandidate = {
		...identity,
		candidate_id: taskEnvironmentCandidateId(identity),
		created_at: input.created_at,
	};
	return verifyTaskEnvironmentCandidate({
		...unsignedCandidate,
		candidate_sha256: taskEnvironmentCandidateHash(unsignedCandidate),
	});
}

export function verifyTaskEnvironmentCandidateAgainstBuildInput(
	value: unknown,
	input: TaskEnvironmentCandidateBuildInput,
): TaskEnvironmentCandidate {
	const candidate = verifyTaskEnvironmentCandidate(value);
	const expected = createTaskEnvironmentCandidate(input);
	if (stableStringify(candidate) !== stableStringify(expected)) {
		throw new Error("Task environment candidate does not match its strict build input bindings");
	}
	return candidate;
}

export function taskRoleFactoryProbeRequestHash(value: Omit<TaskRoleFactoryProbeRequest, "request_sha256">): string {
	return canonicalHash(value);
}

export function createTaskRoleFactoryProbeRequest(
	candidateValue: unknown,
	operationId: string,
): TaskRoleFactoryProbeRequest {
	const candidate = verifyTaskEnvironmentCandidate(candidateValue);
	const unsignedRequest: Omit<TaskRoleFactoryProbeRequest, "request_sha256"> = {
		schema_version: "v1",
		request_type: "task_role_factory_probe",
		operation_id: operationId,
		candidate_id: candidate.candidate_id,
		candidate_sha256: candidate.candidate_sha256,
		probe_profile: TASK_ROLE_FACTORY_PROBE_PROFILE,
	};
	return verifyTaskRoleFactoryProbeRequest({
		...unsignedRequest,
		request_sha256: taskRoleFactoryProbeRequestHash(unsignedRequest),
	});
}

export function taskRoleFactoryProbeEvidenceHash(value: Omit<FactoryRoleEvidence, "evidence_sha256">): string {
	return canonicalHash(value);
}

export function taskRoleFactoryProbeReportHash(value: Omit<TaskRoleFactoryProbeReport, "report_sha256">): string {
	return canonicalHash(value);
}

export function verifyTaskEnvironmentCandidate(value: unknown): TaskEnvironmentCandidate {
	if (!candidateValidator.Check(value)) {
		throw new Error("Task environment candidate does not satisfy the v1 contract");
	}
	const { candidate_sha256: actualHash, ...unsignedCandidate } = value;
	if (taskEnvironmentCandidateHash(unsignedCandidate) !== actualHash) {
		throw new Error("Task environment candidate SHA-256 does not match its canonical content");
	}
	assertDistinctExternalBindings(value);
	if (
		value.roles.worker.filesystem_profile.profile_id === value.roles.evaluator.filesystem_profile.profile_id ||
		value.roles.worker.filesystem_profile.profile_sha256 === value.roles.evaluator.filesystem_profile.profile_sha256
	) {
		throw new Error("Worker and Evaluator filesystem profiles must be independently locked");
	}
	for (const role of [value.roles.worker, value.roles.evaluator]) {
		if (!arraysMatchExactly(role.security_profile.cap_drop, ["ALL"])) {
			throw new Error(`${role.role} capability drop policy must be exactly [ALL]`);
		}
		if (role.resource_profile.memory_swap_bytes !== role.resource_profile.memory_bytes) {
			throw new Error(`${role.role} memory swap must equal its memory limit`);
		}
		const destinations = role.filesystem_profile.writable_mounts.map((mount) => mount.destination);
		if (new Set(destinations).size !== destinations.length) {
			throw new Error(`${role.role} filesystem profile contains duplicate writable destinations`);
		}
		if (
			role.filesystem_profile.writable_mounts.some((mount, index, mounts) => {
				const previous = mounts[index - 1];
				return previous !== undefined && compareWritableMounts(previous, mount) > 0;
			})
		) {
			throw new Error(`${role.role} filesystem profile mounts are not in canonical order`);
		}
		verifyRoleProfiles(value.instance_id, role.role, role);
	}
	const { candidate_id: actualId, candidate_sha256: _candidateHash, created_at: _createdAt, ...identity } = value;
	if (taskEnvironmentCandidateId(identity) !== actualId) {
		throw new Error("Task environment candidate ID does not match its canonical environment identity");
	}
	return value;
}

export function verifyTaskRoleFactoryProbeRequest(value: unknown): TaskRoleFactoryProbeRequest {
	if (!requestValidator.Check(value)) {
		throw new Error("Task role factory probe request does not satisfy the v1 contract");
	}
	const { request_sha256: actualHash, ...unsignedRequest } = value;
	if (taskRoleFactoryProbeRequestHash(unsignedRequest) !== actualHash) {
		throw new Error("Task role factory probe request SHA-256 does not match its canonical content");
	}
	return value;
}

export function verifyTaskRoleFactoryProbeReport(
	value: unknown,
	candidateValue: unknown,
	requestValue: unknown,
): TaskRoleFactoryProbeReport {
	if (!reportValidator.Check(value)) {
		throw new Error("Task role factory probe report does not satisfy the v1 contract");
	}
	const candidate = verifyTaskEnvironmentCandidate(candidateValue);
	const request = verifyTaskRoleFactoryProbeRequest(requestValue);
	const { report_sha256: actualHash, ...unsignedReport } = value;
	if (taskRoleFactoryProbeReportHash(unsignedReport) !== actualHash) {
		throw new Error("Task role factory probe report SHA-256 does not match its canonical content");
	}
	if (!arraysMatchExactly(value.execution_order, ["worker", "evaluator"])) {
		throw new Error("Task role factory probe execution order must be exactly [worker, evaluator]");
	}
	if (request.candidate_id !== candidate.candidate_id || request.candidate_sha256 !== candidate.candidate_sha256) {
		throw new Error("Task role factory probe request does not bind the supplied candidate");
	}
	if (
		value.operation_id !== request.operation_id ||
		value.request_sha256 !== request.request_sha256 ||
		value.candidate_id !== candidate.candidate_id ||
		value.candidate_sha256 !== candidate.candidate_sha256 ||
		value.probe_profile !== request.probe_profile ||
		value.instance_id !== candidate.instance_id ||
		value.base_commit !== candidate.base_commit
	) {
		throw new Error("Task role factory probe report bindings do not match its request and candidate");
	}
	if (!controllerExecutionHardGatesPass(value.controller_execution)) {
		throw new Error("Task role factory probe Controller execution identity or safety hard gates failed");
	}

	const workerHashValid = roleEvidenceHashIsValid(value.roles.worker);
	const evaluatorHashValid = roleEvidenceHashIsValid(value.roles.evaluator);
	if (!workerHashValid || !evaluatorHashValid) {
		throw new Error("Task role factory probe role evidence SHA-256 does not match canonical content");
	}
	const workerPassed = roleHardGatesPass(candidate, value.roles.worker);
	const evaluatorPassed = roleHardGatesPass(candidate, value.roles.evaluator);
	for (const [evidence, passed] of [
		[value.roles.worker, workerPassed],
		[value.roles.evaluator, evaluatorPassed],
	] as const) {
		if (evidence.status !== (passed ? "pass" : "fail")) {
			throw new Error(`${evidence.role} status does not match its factory hard-gate evidence`);
		}
		if ((evidence.failure_phase === null) !== passed) {
			throw new Error(`${evidence.role} failure phase does not match its factory status`);
		}
	}
	const passed = workerPassed && evaluatorPassed && value.errors.length === 0;
	if (value.status !== (passed ? "pass" : "fail")) {
		throw new Error("Task role factory probe report status does not match its role evidence");
	}
	return value;
}
