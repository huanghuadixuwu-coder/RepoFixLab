import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "../contracts/schema-generator.ts";
import { type BootstrapDoctorReport, BootstrapDoctorReportSchema } from "../contracts/v1.ts";
import {
	ARTIFACTS_PATH,
	type BootstrapDoctorAssessment,
	type BootstrapDoctorCheck,
	type BootstrapDoctorImageProvenanceEvidence,
	type BootstrapDoctorImageProvenanceServiceEvidence,
	MIN_AVAILABLE_BYTES,
	MIN_DOCKER_CPUS,
	MIN_DOCKER_MEMORY_BYTES,
} from "./bootstrap-doctor.ts";

const bootstrapDoctorReportValidator = Compile(BootstrapDoctorReportSchema);

function reportHash(value: Omit<BootstrapDoctorReport, "report_sha256">): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function checkById(assessment: BootstrapDoctorAssessment, id: BootstrapDoctorCheck["id"]): BootstrapDoctorCheck {
	const check = assessment.checks.find((candidate) => candidate.id === id);
	if (check === undefined) throw new Error(`Bootstrap assessment is missing check ${id}`);
	return check;
}

function combinedState(checks: readonly BootstrapDoctorCheck[]): "pass" | "fail" {
	return checks.every((check) => check.status === "pass") ? "pass" : "fail";
}

function combinedMessage(checks: readonly BootstrapDoctorCheck[]): string {
	const failed = checks.filter((check) => check.status === "fail").map((check) => check.id);
	return failed.length === 0 ? "All required facts were explicitly verified." : `Failed checks: ${failed.join(", ")}.`;
}

function optionalString(value: BootstrapDoctorCheck["actual"]): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalSafeInteger(value: BootstrapDoctorCheck["actual"]): number | undefined {
	if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function optionalBoolean(value: BootstrapDoctorCheck["actual"]): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function evidenceHash(value: string | null): { readonly evidence_sha256: string } | Record<string, never> {
	return value === null ? {} : { evidence_sha256: value };
}

function normalizeSocketTopology(value: BootstrapDoctorCheck["actual"]): {
	controller: "read-write" | "read-only" | "none" | null;
	orchestrator: "read-write" | "read-only" | "none" | null;
	dataset_preparer: "read-write" | "read-only" | "none" | null;
	worker: "read-write" | "read-only" | "none" | null;
	evaluator: "read-write" | "read-only" | "none" | null;
} {
	const actual: Record<string, unknown> =
		typeof value === "object" && value !== null ? (value as unknown as Record<string, unknown>) : {};
	const access = (key: string): "read-write" | "read-only" | "none" | null => {
		const candidate = actual[key];
		return candidate === "read-write" || candidate === "read-only" || candidate === "none" ? candidate : null;
	};
	return {
		controller: access("controller"),
		orchestrator: access("orchestrator"),
		dataset_preparer: access("datasetPreparer"),
		worker: access("worker"),
		evaluator: access("evaluator"),
	};
}

function imageProvenanceActual(value: BootstrapDoctorCheck["actual"]): BootstrapDoctorImageProvenanceEvidence {
	if (typeof value !== "object" || value === null || !("lockSha256" in value) || !("services" in value)) {
		throw new Error("Bootstrap assessment image provenance evidence is missing");
	}
	return value as BootstrapDoctorImageProvenanceEvidence;
}

function imageProvenanceService(service: BootstrapDoctorImageProvenanceServiceEvidence): {
	state: "pass" | "fail";
	expected_image_id: string | null;
	actual_image_id: string | null;
	expected_compose_config_sha256: string | null;
	actual_compose_config_sha256: string | null;
	base_repository_digest: string | null;
	base_image_id: string | null;
	errors: string[];
} {
	return {
		state: service.passed ? "pass" : "fail",
		expected_image_id: service.expectedImageId,
		actual_image_id: service.actualImageId,
		expected_compose_config_sha256: service.expectedComposeConfigSha256,
		actual_compose_config_sha256: service.actualComposeConfigSha256,
		base_repository_digest: service.baseRepositoryDigest,
		base_image_id: service.baseImageId,
		errors: [...service.errors],
	};
}

export function verifyBootstrapDoctorReport(value: unknown): BootstrapDoctorReport {
	if (!bootstrapDoctorReportValidator.Check(value)) {
		throw new Error("Bootstrap doctor report does not satisfy the v1 contract");
	}
	const { report_sha256: actualHash, ...unsignedReport } = value;
	if (reportHash(unsignedReport) !== actualHash) {
		throw new Error("Bootstrap doctor report SHA-256 does not match its content");
	}
	const requiredRoles = value.checks.docker_socket_ownership.required_roles;
	if (requiredRoles.length !== 2 || requiredRoles[0] !== "controller" || requiredRoles[1] !== "orchestrator") {
		throw new Error("Bootstrap doctor required roles must be exactly [controller, orchestrator]");
	}
	const expectedStatus = Object.values(value.checks).every((check) => check.state === "pass") ? "pass" : "fail";
	if (value.status !== expectedStatus) {
		throw new Error("Bootstrap doctor report status does not match its hard-gate checks");
	}
	const provenance = value.checks.base_images;
	const provenancePassed =
		provenance.lock_sha256 !== null &&
		provenance.evidence_sha256 !== null &&
		Object.values(provenance.services).every(
			(service) =>
				service.state === "pass" &&
				service.errors.length === 0 &&
				service.expected_image_id !== null &&
				service.actual_image_id !== null &&
				service.expected_compose_config_sha256 !== null &&
				service.actual_compose_config_sha256 !== null &&
				service.base_repository_digest !== null &&
				service.base_image_id !== null,
		);
	if (provenance.state !== (provenancePassed ? "pass" : "fail")) {
		throw new Error("Bootstrap doctor image provenance state does not match its structured evidence");
	}
	const socketOwnership = value.checks.docker_socket_ownership;
	const socketPassed =
		socketOwnership.actual.controller === "read-write" &&
		socketOwnership.actual.orchestrator === "none" &&
		socketOwnership.actual.dataset_preparer === null &&
		socketOwnership.actual.worker === null &&
		socketOwnership.actual.evaluator === null;
	if (socketOwnership.state !== (socketPassed ? "pass" : "fail")) {
		throw new Error("Bootstrap doctor socket ownership state does not match its lifecycle-scoped evidence");
	}
	const startedAt = Date.parse(value.started_at);
	const finishedAt = Date.parse(value.finished_at);
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt > finishedAt) {
		throw new Error("Bootstrap doctor report timestamps are invalid or out of order");
	}
	return value;
}

export function createBootstrapDoctorReport(
	assessment: BootstrapDoctorAssessment,
	startedAt: string,
	reportId: string,
): BootstrapDoctorReport {
	const daemon = checkById(assessment, "controller_daemon");
	const operatingSystem = checkById(assessment, "docker_os");
	const architecture = checkById(assessment, "docker_architecture");
	const hostStorage = checkById(assessment, "artifacts_available_bytes");
	const dockerStorage = checkById(assessment, "docker_available_bytes");
	const cpu = checkById(assessment, "docker_cpu");
	const memory = checkById(assessment, "docker_memory_bytes");
	const controlNetwork = checkById(assessment, "control_network");
	const socketTopology = checkById(assessment, "socket_topology");
	const baseImages = checkById(assessment, "base_images");
	const imageProvenance = imageProvenanceActual(baseImages.actual);
	const controllerIntegrity = checkById(assessment, "controller_integrity");
	const daemonChecks = [daemon, operatingSystem, architecture];
	const computeChecks = [cpu, memory];
	const controllerErrors = [
		...(assessment.evidence.controller.error === null ? [] : [assessment.evidence.controller.error]),
		...assessment.evidence.controller.errors,
	];
	const controllerEvidence = evidenceHash(assessment.evidence.controller.responseSha256);
	const warnings = [
		...(assessment.evidence.artifacts.error === null
			? []
			: [`artifacts statfs: ${assessment.evidence.artifacts.error}`]),
		...(assessment.evidence.controller.error === null
			? []
			: [`Controller health: ${assessment.evidence.controller.error}`]),
		...assessment.evidence.controller.errors,
	];
	const unsignedReport = {
		schema_version: "v1",
		report_type: "bootstrap_doctor",
		report_id: reportId,
		status: assessment.status,
		started_at: startedAt,
		finished_at: assessment.generatedAt,
		checks: {
			docker_daemon: {
				state: combinedState(daemonChecks),
				...controllerEvidence,
				...(assessment.evidence.controller.serverVersion === null
					? {}
					: { server_version: assessment.evidence.controller.serverVersion }),
				...(optionalString(operatingSystem.actual) === undefined
					? {}
					: { operating_system: optionalString(operatingSystem.actual) }),
				...(optionalString(architecture.actual) === undefined
					? {}
					: { architecture: optionalString(architecture.actual) }),
				message: combinedMessage(daemonChecks),
			},
			host_artifacts_storage: {
				state: hostStorage.status,
				path: ARTIFACTS_PATH,
				minimum_available_bytes: Number(MIN_AVAILABLE_BYTES),
				...(optionalSafeInteger(hostStorage.actual) === undefined
					? {}
					: { available_bytes: optionalSafeInteger(hostStorage.actual) }),
				message: hostStorage.message,
			},
			docker_managed_storage: {
				state: dockerStorage.status,
				...controllerEvidence,
				path: "/probe",
				minimum_available_bytes: Number(MIN_AVAILABLE_BYTES),
				...(optionalSafeInteger(dockerStorage.actual) === undefined
					? {}
					: { available_bytes: optionalSafeInteger(dockerStorage.actual) }),
				...(assessment.evidence.controller.dockerVolumeId === null
					? {}
					: { volume_id: assessment.evidence.controller.dockerVolumeId }),
				...(assessment.evidence.controller.probeImageDigest === null
					? {}
					: { probe_image_digest: assessment.evidence.controller.probeImageDigest }),
				message: dockerStorage.message,
			},
			compute: {
				state: combinedState(computeChecks),
				...controllerEvidence,
				minimum_cpu_count: MIN_DOCKER_CPUS,
				minimum_memory_bytes: Number(MIN_DOCKER_MEMORY_BYTES),
				...(optionalSafeInteger(cpu.actual) === undefined ? {} : { cpu_count: optionalSafeInteger(cpu.actual) }),
				...(optionalSafeInteger(memory.actual) === undefined
					? {}
					: { memory_bytes: optionalSafeInteger(memory.actual) }),
				message: combinedMessage(computeChecks),
			},
			control_network: {
				state: controlNetwork.status,
				...controllerEvidence,
				actual: optionalBoolean(controlNetwork.actual),
				message: controlNetwork.message,
			},
			docker_socket_ownership: {
				state: socketTopology.status,
				...controllerEvidence,
				required_roles: ["controller", "orchestrator"],
				deferred_roles: {
					dataset_preparer: "dataset_prepare",
					worker: "smoke_formal",
					evaluator: "smoke_formal",
				},
				actual: normalizeSocketTopology(socketTopology.actual),
				message: socketTopology.message,
			},
			base_images: {
				state: baseImages.status,
				lock_sha256: imageProvenance.lockSha256,
				evidence_sha256: imageProvenance.evidenceSha256,
				services: {
					controller: imageProvenanceService(imageProvenance.services.controller),
					orchestrator: imageProvenanceService(imageProvenance.services.orchestrator),
				},
				message: baseImages.message,
			},
			controller_integrity: {
				state: controllerIntegrity.status,
				...controllerEvidence,
				errors: controllerErrors,
				message: controllerIntegrity.message,
			},
		},
		warnings,
	} as const satisfies Omit<BootstrapDoctorReport, "report_sha256">;
	const reportSha256 = reportHash(unsignedReport);
	const report = { ...unsignedReport, report_sha256: reportSha256 };
	return verifyBootstrapDoctorReport(report);
}
