import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/schema-generator.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_DIGEST_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

export type BootstrapService = "controller" | "orchestrator";

export interface BootstrapServiceImageLock {
	readonly baseRepositoryDigest: string;
	readonly buildInputsSha256: string;
	readonly composeConfigSha256: string;
	readonly dockerfileSha256: string;
	readonly expectedBaseImageId: string;
	readonly expectedImageId: string;
	readonly expectedNetworks: readonly BootstrapServiceNetworkLock[];
	readonly platform: "linux/amd64";
}

export interface BootstrapServiceNetworkLock {
	readonly internal: boolean;
	readonly logicalName: string;
}

export interface UnsignedBootstrapImageProvenanceLock {
	readonly composeProject: string;
	readonly createdAt: string;
	readonly lockId: string;
	readonly lockType: "bootstrap_image_provenance";
	readonly schemaVersion: "repofixlab.bootstrap-image-provenance-lock.v1";
	readonly services: Readonly<Record<BootstrapService, BootstrapServiceImageLock>>;
}

export interface BootstrapImageProvenanceLock extends UnsignedBootstrapImageProvenanceLock {
	readonly lockSha256: string;
}

export interface BootstrapNetworkObservation {
	readonly composeNetwork: string | null;
	readonly composeProject: string | null;
	readonly internal: boolean;
	readonly networkId: string;
}

export interface BootstrapBaseImageObservation {
	readonly imageId: string;
	readonly platform: string;
	readonly repositoryDigests: readonly string[];
	readonly rootfsLayers: readonly string[];
}

export interface BootstrapServiceImageObservation {
	readonly baseImage: BootstrapBaseImageObservation;
	readonly composeConfigSha256: string | null;
	readonly composeProject: string | null;
	readonly composeService: string | null;
	readonly containerId: string;
	readonly imageId: string;
	readonly imageRootfsLayers: readonly string[];
	readonly networks: readonly BootstrapNetworkObservation[];
	readonly platform: string;
	readonly publishedPorts: readonly string[];
}

export interface BootstrapImageProvenanceObservation {
	readonly services: Readonly<Record<BootstrapService, BootstrapServiceImageObservation | null>>;
}

export interface BootstrapServiceImageProvenanceResult {
	readonly actualComposeConfigSha256: string | null;
	readonly actualImageId: string | null;
	readonly baseImageId: string | null;
	readonly baseRepositoryDigest: string;
	readonly containerId: string | null;
	readonly errors: readonly string[];
	readonly expectedComposeConfigSha256: string;
	readonly expectedImageId: string;
	readonly networks: readonly BootstrapNetworkObservation[];
	readonly passed: boolean;
}

export interface BootstrapImageProvenanceAssessment {
	readonly evidenceSha256: string;
	readonly lockSha256: string;
	readonly ok: boolean;
	readonly services: Readonly<Record<BootstrapService, BootstrapServiceImageProvenanceResult>>;
}

function hash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function validateLockService(service: BootstrapService, value: BootstrapServiceImageLock): void {
	if (typeof value !== "object" || value === null) {
		throw new Error(`${service} image lock is missing`);
	}
	if (!REPOSITORY_DIGEST_PATTERN.test(value.baseRepositoryDigest)) {
		throw new Error(`${service} base image is not a repository digest`);
	}
	if (!SHA256_PATTERN.test(value.buildInputsSha256)) {
		throw new Error(`${service} build-input SHA-256 is invalid`);
	}
	if (!SHA256_PATTERN.test(value.composeConfigSha256)) {
		throw new Error(`${service} Compose service config SHA-256 is invalid`);
	}
	if (!SHA256_PATTERN.test(value.dockerfileSha256)) {
		throw new Error(`${service} Dockerfile SHA-256 is invalid`);
	}
	if (!IMAGE_ID_PATTERN.test(value.expectedImageId)) {
		throw new Error(`${service} expected image ID is invalid`);
	}
	if (!IMAGE_ID_PATTERN.test(value.expectedBaseImageId)) {
		throw new Error(`${service} expected base image ID is invalid`);
	}
	if (value.platform !== "linux/amd64") {
		throw new Error(`${service} platform must be linux/amd64`);
	}
	if (!Array.isArray(value.expectedNetworks)) {
		throw new Error(`${service} expected Compose networks are invalid`);
	}
	if (value.expectedNetworks.length === 0) {
		throw new Error(`${service} must lock at least one Compose network`);
	}
	if (
		value.expectedNetworks.some(
			(network) =>
				typeof network !== "object" ||
				network === null ||
				typeof network.internal !== "boolean" ||
				typeof network.logicalName !== "string",
		)
	) {
		throw new Error(`${service} expected Compose networks are invalid`);
	}
	const logicalNames = value.expectedNetworks.map(({ logicalName }) => logicalName);
	if (
		logicalNames.some((logicalName) => logicalName.length === 0) ||
		new Set(logicalNames).size !== logicalNames.length
	) {
		throw new Error(`${service} expected Compose networks must have unique non-empty logical names`);
	}
}

export function createBootstrapImageProvenanceLock(
	value: UnsignedBootstrapImageProvenanceLock,
): BootstrapImageProvenanceLock {
	if (
		value.schemaVersion !== "repofixlab.bootstrap-image-provenance-lock.v1" ||
		value.lockType !== "bootstrap_image_provenance" ||
		typeof value.services !== "object" ||
		value.services === null ||
		typeof value.composeProject !== "string" ||
		value.composeProject.length === 0 ||
		typeof value.lockId !== "string" ||
		value.lockId.length === 0 ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt))
	) {
		throw new Error("Bootstrap image provenance lock metadata is invalid");
	}
	validateLockService("controller", value.services.controller);
	validateLockService("orchestrator", value.services.orchestrator);
	return { ...value, lockSha256: hash(value) };
}

export function verifyBootstrapImageProvenanceLock(value: BootstrapImageProvenanceLock): BootstrapImageProvenanceLock {
	const unsigned: UnsignedBootstrapImageProvenanceLock = {
		schemaVersion: value.schemaVersion,
		lockType: value.lockType,
		lockId: value.lockId,
		composeProject: value.composeProject,
		createdAt: value.createdAt,
		services: value.services,
	};
	const recreated = createBootstrapImageProvenanceLock(unsigned);
	if (!SHA256_PATTERN.test(value.lockSha256) || recreated.lockSha256 !== value.lockSha256) {
		throw new Error("Bootstrap image provenance lock SHA-256 does not match its content");
	}
	return value;
}

function assessService(
	service: BootstrapService,
	project: string,
	locked: BootstrapServiceImageLock,
	observed: BootstrapServiceImageObservation | null,
): BootstrapServiceImageProvenanceResult {
	if (observed === null) {
		return {
			passed: false,
			errors: ["runtime image provenance observation is missing"],
			containerId: null,
			expectedImageId: locked.expectedImageId,
			actualImageId: null,
			expectedComposeConfigSha256: locked.composeConfigSha256,
			actualComposeConfigSha256: null,
			baseRepositoryDigest: locked.baseRepositoryDigest,
			baseImageId: null,
			networks: [],
		};
	}
	const errors: string[] = [];
	if (!IMAGE_ID_PATTERN.test(observed.imageId) || observed.imageId !== locked.expectedImageId) {
		errors.push("running image ID does not match the external lock");
	}
	if (observed.composeProject !== project || observed.composeService !== service) {
		errors.push("running container Compose project/service labels do not match the external lock");
	}
	if (observed.composeConfigSha256 !== locked.composeConfigSha256) {
		errors.push("running image-bound Compose service config hash does not match the external lock");
	}
	if (observed.platform !== locked.platform || observed.baseImage.platform !== locked.platform) {
		errors.push("running or base image platform does not match the external lock");
	}
	if (!observed.baseImage.repositoryDigests.includes(locked.baseRepositoryDigest)) {
		errors.push("inspected base image does not advertise the locked repository digest");
	}
	if (observed.baseImage.imageId !== locked.expectedBaseImageId) {
		errors.push("inspected base image ID does not match the external lock");
	}
	if (
		observed.baseImage.rootfsLayers.length === 0 ||
		observed.imageRootfsLayers.length < observed.baseImage.rootfsLayers.length ||
		!observed.baseImage.rootfsLayers.every((layer, index) => observed.imageRootfsLayers[index] === layer)
	) {
		errors.push("running image rootfs does not extend the inspected locked base image");
	}
	if (observed.publishedPorts.length !== 0) {
		errors.push("running service publishes ports");
	}
	const expectedNetworks = locked.expectedNetworks
		.map(({ internal, logicalName }) => `${logicalName}:${internal ? "internal" : "external"}`)
		.sort();
	const actualNetworks = observed.networks
		.map((network) => `${network.composeNetwork ?? "<unlabeled>"}:${network.internal ? "internal" : "external"}`)
		.sort();
	if (
		observed.networks.some((network) => network.composeProject !== project) ||
		stableStringify(actualNetworks) !== stableStringify(expectedNetworks)
	) {
		errors.push("running service network attachments do not match the external lock");
	}

	return {
		passed: errors.length === 0,
		errors,
		containerId: observed.containerId,
		expectedImageId: locked.expectedImageId,
		actualImageId: observed.imageId,
		expectedComposeConfigSha256: locked.composeConfigSha256,
		actualComposeConfigSha256: observed.composeConfigSha256,
		baseRepositoryDigest: locked.baseRepositoryDigest,
		baseImageId: observed.baseImage.imageId,
		networks: observed.networks,
	};
}

export function assessBootstrapImageProvenance(
	lock: BootstrapImageProvenanceLock,
	observation: BootstrapImageProvenanceObservation,
): BootstrapImageProvenanceAssessment {
	verifyBootstrapImageProvenanceLock(lock);
	const services = {
		controller: assessService(
			"controller",
			lock.composeProject,
			lock.services.controller,
			observation.services.controller,
		),
		orchestrator: assessService(
			"orchestrator",
			lock.composeProject,
			lock.services.orchestrator,
			observation.services.orchestrator,
		),
	};
	return {
		ok: services.controller.passed && services.orchestrator.passed,
		lockSha256: lock.lockSha256,
		evidenceSha256: hash({ lock, observation }),
		services,
	};
}
