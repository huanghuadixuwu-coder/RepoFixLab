import {
	assessBootstrapImageProvenance,
	type BootstrapImageProvenanceLock,
	type BootstrapImageProvenanceObservation,
	type BootstrapServiceImageLock,
	verifyBootstrapImageProvenanceLock,
} from "./image-provenance.ts";

export const ARTIFACTS_PATH = "/artifacts";
export const MIN_AVAILABLE_BYTES = 120_000_000_000n;
export const MIN_DOCKER_CPUS = 8;
export const MIN_DOCKER_MEMORY_BYTES = 16n * 1024n * 1024n * 1024n;

export type BootstrapDoctorStatus = "pass" | "fail";
export type SocketAccess = "read-write" | "read-only" | "none";

export interface StatFsReading {
	readonly availableBlocks: bigint | number | string | null | undefined;
	readonly blockSize: bigint | number | string | null | undefined;
}

export interface SocketTopologyHealth {
	readonly controller?: SocketAccess | null;
	readonly datasetPreparer?: SocketAccess | null;
	readonly evaluator?: SocketAccess | null;
	readonly orchestrator?: SocketAccess | null;
	readonly worker?: SocketAccess | null;
}

export interface CollectedControllerBootstrapHealth {
	readonly architecture?: string | null;
	readonly controlNetworkInternal?: boolean | null;
	readonly cpuCount?: number | null;
	readonly daemonReachable?: boolean | null;
	readonly dockerVolumeAvailableBytes?: bigint | number | string | null;
	readonly dockerVolumeId?: string | null;
	readonly dockerRootDir?: string | null;
	readonly errors?: readonly string[];
	readonly evidenceSha256?: string | null;
	readonly memoryBytes?: bigint | number | string | null;
	readonly imageProvenance?: BootstrapImageProvenanceObservation | null;
	readonly osType?: string | null;
	readonly probeImageDigest?: string | null;
	readonly serverVersion?: string | null;
	readonly socketTopology?: SocketTopologyHealth | null;
}

export interface BootstrapDoctorDependencies {
	readonly now?: () => Date;
	readonly readArtifactsStatFs: (path: string) => Promise<StatFsReading>;
	readonly readControllerHealth: () => Promise<CollectedControllerBootstrapHealth>;
	readonly readImageProvenanceLock?: () => Promise<BootstrapImageProvenanceLock | null>;
}

export interface BootstrapDoctorImageProvenanceServiceEvidence {
	readonly actualComposeConfigSha256: string | null;
	readonly actualImageId: string | null;
	readonly baseImageId: string | null;
	readonly baseRepositoryDigest: string | null;
	readonly errors: readonly string[];
	readonly expectedComposeConfigSha256: string | null;
	readonly expectedImageId: string | null;
	readonly passed: boolean;
}

export interface BootstrapDoctorImageProvenanceEvidence {
	readonly evidenceSha256: string | null;
	readonly lockSha256: string | null;
	readonly services: Readonly<Record<"controller" | "orchestrator", BootstrapDoctorImageProvenanceServiceEvidence>>;
}

export interface BootstrapDoctorCheck {
	readonly actual:
		| BootstrapDoctorImageProvenanceEvidence
		| boolean
		| number
		| string
		| null
		| Record<string, string | null>;
	readonly expected: string;
	readonly id:
		| "artifacts_available_bytes"
		| "base_images"
		| "control_network"
		| "controller_integrity"
		| "controller_daemon"
		| "docker_architecture"
		| "docker_available_bytes"
		| "docker_cpu"
		| "docker_memory_bytes"
		| "docker_os"
		| "socket_topology";
	readonly message: string;
	readonly status: BootstrapDoctorStatus;
}

export interface BootstrapDoctorAssessment {
	readonly checks: readonly BootstrapDoctorCheck[];
	readonly evidence: {
		readonly artifacts: {
			readonly availableBytes: string | null;
			readonly error: string | null;
			readonly path: typeof ARTIFACTS_PATH;
		};
		readonly controller: {
			readonly errors: readonly string[];
			readonly dockerRootDir: string | null;
			readonly dockerVolumeId: string | null;
			readonly error: string | null;
			readonly responseSha256: string | null;
			readonly probeImageDigest: string | null;
			readonly serverVersion: string | null;
		};
	};
	readonly generatedAt: string;
	readonly ok: boolean;
	readonly profile: "bootstrap";
	readonly schemaVersion: "repofixlab.bootstrap-doctor.v1";
	readonly status: BootstrapDoctorStatus;
	readonly summary: {
		readonly failed: number;
		readonly passed: number;
		readonly total: number;
	};
}

interface CollectedArtifactsEvidence {
	readonly availableBytes: bigint | null;
	readonly error: string | null;
}

interface CollectedControllerEvidence {
	readonly error: string | null;
	readonly health: CollectedControllerBootstrapHealth | null;
}

interface CollectedImageProvenanceLock {
	readonly error: string | null;
	readonly lock: BootstrapImageProvenanceLock | null;
}

function parseNonNegativeInteger(value: bigint | number | string | null | undefined): bigint | null {
	if (typeof value === "bigint") {
		return value >= 0n ? value : null;
	}
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
	}
	if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
		return BigInt(value);
	}
	return null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
}

async function collectArtifactsEvidence(
	readArtifactsStatFs: BootstrapDoctorDependencies["readArtifactsStatFs"],
): Promise<CollectedArtifactsEvidence> {
	try {
		const reading = await readArtifactsStatFs(ARTIFACTS_PATH);
		const availableBlocks = parseNonNegativeInteger(reading.availableBlocks);
		const blockSize = parseNonNegativeInteger(reading.blockSize);
		if (availableBlocks === null || blockSize === null || blockSize === 0n) {
			return { availableBytes: null, error: "Invalid statfs reading" };
		}
		return { availableBytes: availableBlocks * blockSize, error: null };
	} catch (error) {
		return { availableBytes: null, error: errorMessage(error) };
	}
}

async function collectControllerEvidence(
	readControllerHealth: BootstrapDoctorDependencies["readControllerHealth"],
): Promise<CollectedControllerEvidence> {
	try {
		return { error: null, health: await readControllerHealth() };
	} catch (error) {
		return { error: errorMessage(error), health: null };
	}
}

async function collectImageProvenanceLock(
	reader: BootstrapDoctorDependencies["readImageProvenanceLock"],
): Promise<CollectedImageProvenanceLock> {
	if (reader === undefined) {
		return { error: "Bootstrap image provenance lock reader is not configured", lock: null };
	}
	try {
		const lock = await reader();
		return lock === null
			? { error: "Bootstrap image provenance lock is missing", lock: null }
			: { error: null, lock };
	} catch (error) {
		return { error: errorMessage(error), lock: null };
	}
}

function missingImageProvenanceService(
	error: string,
	locked: BootstrapServiceImageLock | null,
): BootstrapDoctorImageProvenanceServiceEvidence {
	return {
		passed: false,
		errors: [error],
		expectedImageId: locked?.expectedImageId ?? null,
		actualImageId: null,
		expectedComposeConfigSha256: locked?.composeConfigSha256 ?? null,
		actualComposeConfigSha256: null,
		baseRepositoryDigest: locked?.baseRepositoryDigest ?? null,
		baseImageId: null,
	};
}

function assessImageProvenance(
	collectedLock: CollectedImageProvenanceLock,
	observation: BootstrapImageProvenanceObservation | null | undefined,
): BootstrapDoctorImageProvenanceEvidence {
	const lock = collectedLock.lock;
	if (lock === null) {
		const error = collectedLock.error ?? "Bootstrap image provenance lock is unavailable";
		return {
			lockSha256: null,
			evidenceSha256: null,
			services: {
				controller: missingImageProvenanceService(error, null),
				orchestrator: missingImageProvenanceService(error, null),
			},
		};
	}
	try {
		verifyBootstrapImageProvenanceLock(lock);
	} catch (error) {
		const message = errorMessage(error);
		return {
			lockSha256: null,
			evidenceSha256: null,
			services: {
				controller: missingImageProvenanceService(message, null),
				orchestrator: missingImageProvenanceService(message, null),
			},
		};
	}
	if (observation === undefined || observation === null) {
		const error = "Controller image provenance observation is missing";
		return {
			lockSha256: lock.lockSha256,
			evidenceSha256: null,
			services: {
				controller: missingImageProvenanceService(error, lock.services.controller),
				orchestrator: missingImageProvenanceService(error, lock.services.orchestrator),
			},
		};
	}
	try {
		const assessment = assessBootstrapImageProvenance(lock, observation);
		return {
			lockSha256: assessment.lockSha256,
			evidenceSha256: assessment.evidenceSha256,
			services: assessment.services,
		};
	} catch (error) {
		const message = errorMessage(error);
		return {
			lockSha256: null,
			evidenceSha256: null,
			services: {
				controller: missingImageProvenanceService(message, null),
				orchestrator: missingImageProvenanceService(message, null),
			},
		};
	}
}

function createCheck(
	id: BootstrapDoctorCheck["id"],
	passed: boolean,
	expected: string,
	actual: BootstrapDoctorCheck["actual"],
	message: string,
): BootstrapDoctorCheck {
	return { id, status: passed ? "pass" : "fail", expected, actual, message };
}

function normalizeArchitecture(value: string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "x86_64") {
		return "amd64";
	}
	return normalized || null;
}

function socketTopologyActual(topology: SocketTopologyHealth | null | undefined): Record<string, string | null> {
	return {
		controller: topology?.controller ?? null,
		datasetPreparer: topology?.datasetPreparer ?? null,
		evaluator: topology?.evaluator ?? null,
		orchestrator: topology?.orchestrator ?? null,
		worker: topology?.worker ?? null,
	};
}

function socketTopologyIsValid(topology: SocketTopologyHealth | null | undefined): boolean {
	return (
		topology?.controller === "read-write" &&
		topology.orchestrator === "none" &&
		topology.datasetPreparer === null &&
		topology.worker === null &&
		topology.evaluator === null
	);
}

export async function runBootstrapDoctor(
	dependencies: BootstrapDoctorDependencies,
): Promise<BootstrapDoctorAssessment> {
	const [artifacts, controller, imageProvenanceLock] = await Promise.all([
		collectArtifactsEvidence(dependencies.readArtifactsStatFs),
		collectControllerEvidence(dependencies.readControllerHealth),
		collectImageProvenanceLock(dependencies.readImageProvenanceLock),
	]);
	const health = controller.health;
	const imageProvenance = assessImageProvenance(imageProvenanceLock, health?.imageProvenance);
	const architecture = normalizeArchitecture(health?.architecture);
	const memoryBytes = parseNonNegativeInteger(health?.memoryBytes);
	const dockerVolumeAvailableBytes = parseNonNegativeInteger(health?.dockerVolumeAvailableBytes);
	const cpuCount = health?.cpuCount;
	const checks: BootstrapDoctorCheck[] = [
		createCheck(
			"controller_daemon",
			health?.daemonReachable === true,
			"Controller confirms Docker daemon is reachable",
			health?.daemonReachable ?? null,
			"Docker daemon reachability must be explicitly true.",
		),
		createCheck(
			"docker_os",
			health?.osType?.trim().toLowerCase() === "linux",
			"linux",
			health?.osType ?? null,
			"Docker server must use Linux containers.",
		),
		createCheck(
			"docker_architecture",
			architecture === "amd64",
			"amd64",
			architecture,
			"Docker server architecture must be amd64.",
		),
		createCheck(
			"docker_cpu",
			typeof cpuCount === "number" && Number.isInteger(cpuCount) && cpuCount >= MIN_DOCKER_CPUS,
			`>= ${MIN_DOCKER_CPUS}`,
			typeof cpuCount === "number" && Number.isFinite(cpuCount) ? cpuCount : null,
			"Docker-visible CPU count must meet the bootstrap minimum.",
		),
		createCheck(
			"docker_memory_bytes",
			memoryBytes !== null && memoryBytes >= MIN_DOCKER_MEMORY_BYTES,
			`>= ${MIN_DOCKER_MEMORY_BYTES.toString()}`,
			memoryBytes?.toString() ?? null,
			"Docker-visible memory must meet the 16 GiB bootstrap minimum.",
		),
		createCheck(
			"artifacts_available_bytes",
			artifacts.availableBytes !== null && artifacts.availableBytes >= MIN_AVAILABLE_BYTES,
			`>= ${MIN_AVAILABLE_BYTES.toString()}`,
			artifacts.availableBytes?.toString() ?? null,
			"The /artifacts bind mount must meet the host-space minimum.",
		),
		createCheck(
			"docker_available_bytes",
			dockerVolumeAvailableBytes !== null && dockerVolumeAvailableBytes >= MIN_AVAILABLE_BYTES,
			`>= ${MIN_AVAILABLE_BYTES.toString()}`,
			dockerVolumeAvailableBytes?.toString() ?? null,
			"A Docker managed volume must meet the internal-space minimum.",
		),
		createCheck(
			"socket_topology",
			socketTopologyIsValid(health?.socketTopology),
			"Bootstrap requires Controller=read-write and Orchestrator=none; later-lifecycle roles must be deferred",
			socketTopologyActual(health?.socketTopology),
			"Bootstrap verifies current control-plane roles; Dataset Preparer, Worker, and Evaluator must be absent and deferred to their lifecycle gates.",
		),
		createCheck(
			"control_network",
			health?.controlNetworkInternal === true,
			"Controller is attached only to an internal control network",
			health?.controlNetworkInternal ?? null,
			"The Controller control network must be explicitly internal.",
		),
		createCheck(
			"base_images",
			imageProvenance.services.controller.passed && imageProvenance.services.orchestrator.passed,
			"Running Controller and Orchestrator images match the external provenance lock",
			imageProvenance,
			"Bootstrap images, image-bound Compose service config, fixed bases, and runtime topology must match the external lock.",
		),
		createCheck(
			"controller_integrity",
			controller.error === null && health !== null && (health.errors?.length ?? 0) === 0,
			"Controller collection completes without errors",
			health?.errors?.length ?? null,
			"Any Controller collection or cleanup error is a hard bootstrap failure.",
		),
	];
	const passed = checks.filter((check) => check.status === "pass").length;
	const failed = checks.length - passed;

	return {
		schemaVersion: "repofixlab.bootstrap-doctor.v1",
		profile: "bootstrap",
		generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
		status: failed === 0 ? "pass" : "fail",
		ok: failed === 0,
		summary: { total: checks.length, passed, failed },
		checks,
		evidence: {
			artifacts: {
				path: ARTIFACTS_PATH,
				availableBytes: artifacts.availableBytes?.toString() ?? null,
				error: artifacts.error,
			},
			controller: {
				errors: health?.errors ?? [],
				dockerRootDir: health?.dockerRootDir ?? null,
				dockerVolumeId: health?.dockerVolumeId ?? null,
				probeImageDigest: health?.probeImageDigest ?? null,
				serverVersion: health?.serverVersion ?? null,
				error: controller.error,
				responseSha256: health?.evidenceSha256 ?? null,
			},
		},
	};
}
