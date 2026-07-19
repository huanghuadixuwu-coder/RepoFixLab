import {
	type BootstrapImageProvenanceLock,
	type BootstrapImageProvenanceObservation,
	createBootstrapImageProvenanceLock,
	type UnsignedBootstrapImageProvenanceLock,
} from "../src/doctor/index.ts";

export const CONTROLLER_IMAGE_ID = `sha256:${"1".repeat(64)}`;
export const ORCHESTRATOR_IMAGE_ID = `sha256:${"2".repeat(64)}`;
export const CONTROLLER_BASE_ID = `sha256:${"3".repeat(64)}`;
export const ORCHESTRATOR_BASE_ID = `sha256:${"4".repeat(64)}`;
export const PYTHON_DIGEST = `python@sha256:${"5".repeat(64)}`;
export const NODE_DIGEST = `mirror.gcr.io/library/node@sha256:${"6".repeat(64)}`;

export function unsignedImageProvenanceLock(): UnsignedBootstrapImageProvenanceLock {
	return {
		schemaVersion: "repofixlab.bootstrap-image-provenance-lock.v1",
		lockType: "bootstrap_image_provenance",
		lockId: "bootstrap-images-20260718",
		composeProject: "repofixlab",
		createdAt: "2026-07-18T00:00:00.000Z",
		services: {
			controller: {
				baseRepositoryDigest: PYTHON_DIGEST,
				buildInputsSha256: "7".repeat(64),
				composeConfigSha256: "8".repeat(64),
				dockerfileSha256: "9".repeat(64),
				expectedBaseImageId: CONTROLLER_BASE_ID,
				expectedImageId: CONTROLLER_IMAGE_ID,
				expectedNetworks: [{ logicalName: "repofix-control", internal: true }],
				platform: "linux/amd64",
			},
			orchestrator: {
				baseRepositoryDigest: NODE_DIGEST,
				buildInputsSha256: "a".repeat(64),
				composeConfigSha256: "b".repeat(64),
				dockerfileSha256: "c".repeat(64),
				expectedBaseImageId: ORCHESTRATOR_BASE_ID,
				expectedImageId: ORCHESTRATOR_IMAGE_ID,
				expectedNetworks: [
					{ logicalName: "provider-egress", internal: false },
					{ logicalName: "repofix-control", internal: true },
				],
				platform: "linux/amd64",
			},
		},
	};
}

export function passingImageProvenanceLock(): BootstrapImageProvenanceLock {
	return createBootstrapImageProvenanceLock(unsignedImageProvenanceLock());
}

export function passingImageProvenanceObservation(): BootstrapImageProvenanceObservation {
	return {
		services: {
			controller: {
				containerId: "d".repeat(64),
				imageId: CONTROLLER_IMAGE_ID,
				platform: "linux/amd64",
				composeProject: "repofixlab",
				composeService: "controller",
				composeConfigSha256: "8".repeat(64),
				publishedPorts: [],
				networks: [
					{
						networkId: "e".repeat(64),
						composeProject: "repofixlab",
						composeNetwork: "repofix-control",
						internal: true,
					},
				],
				baseImage: {
					imageId: CONTROLLER_BASE_ID,
					platform: "linux/amd64",
					repositoryDigests: [PYTHON_DIGEST],
					rootfsLayers: [`sha256:${"a".repeat(64)}`],
				},
				imageRootfsLayers: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
			},
			orchestrator: {
				containerId: "f".repeat(64),
				imageId: ORCHESTRATOR_IMAGE_ID,
				platform: "linux/amd64",
				composeProject: "repofixlab",
				composeService: "orchestrator",
				composeConfigSha256: "b".repeat(64),
				publishedPorts: [],
				networks: [
					{
						networkId: "0".repeat(64),
						composeProject: "repofixlab",
						composeNetwork: "provider-egress",
						internal: false,
					},
					{
						networkId: "e".repeat(64),
						composeProject: "repofixlab",
						composeNetwork: "repofix-control",
						internal: true,
					},
				],
				baseImage: {
					imageId: ORCHESTRATOR_BASE_ID,
					platform: "linux/amd64",
					repositoryDigests: [NODE_DIGEST],
					rootfsLayers: [`sha256:${"c".repeat(64)}`],
				},
				imageRootfsLayers: [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`],
			},
		},
	};
}
