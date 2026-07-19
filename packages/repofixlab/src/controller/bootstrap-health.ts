import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "../contracts/schema-generator.ts";
import { type ControllerBootstrapHealth, ControllerBootstrapHealthSchema } from "../contracts/v1.ts";
import type { CollectedControllerBootstrapHealth } from "../doctor/bootstrap-doctor.ts";
import type { BootstrapServiceImageObservation } from "../doctor/image-provenance.ts";

const controllerBootstrapHealthValidator = Compile(ControllerBootstrapHealthSchema);

function toServiceImageObservation(
	value: ControllerBootstrapHealth["image_provenance"]["services"]["controller"],
): BootstrapServiceImageObservation | null {
	if (value === null) return null;
	return {
		containerId: value.container_id,
		imageId: value.image_id,
		platform: value.platform,
		composeProject: value.compose_project,
		composeService: value.compose_service,
		composeConfigSha256: value.compose_config_sha256,
		publishedPorts: value.published_ports,
		networks: value.networks.map((network) => ({
			networkId: network.network_id,
			composeProject: network.compose_project,
			composeNetwork: network.compose_network,
			internal: network.internal,
		})),
		imageRootfsLayers: value.image_rootfs_layers,
		baseImage: {
			imageId: value.base_image.image_id,
			platform: value.base_image.platform,
			repositoryDigests: value.base_image.repository_digests,
			rootfsLayers: value.base_image.rootfs_layers,
		},
	};
}

export function parseControllerBootstrapHealth(value: unknown): ControllerBootstrapHealth {
	if (!controllerBootstrapHealthValidator.Check(value)) {
		throw new Error("Controller returned an invalid v1 bootstrap health response");
	}
	return value;
}

export function toCollectedControllerBootstrapHealth(
	response: ControllerBootstrapHealth,
): CollectedControllerBootstrapHealth {
	return {
		daemonReachable: response.daemon_reachable,
		serverVersion: response.server_version,
		osType: response.os_type,
		architecture: response.architecture,
		cpuCount: response.cpu_count,
		memoryBytes: response.memory_bytes,
		dockerRootDir: response.docker_root_dir,
		dockerVolumeAvailableBytes: response.docker_volume_available_bytes,
		dockerVolumeId: response.docker_volume_id,
		probeImageDigest: response.probe_image_digest,
		controlNetworkInternal: response.control_network_internal,
		imageProvenance: {
			services: {
				controller: toServiceImageObservation(response.image_provenance.services.controller),
				orchestrator: toServiceImageObservation(response.image_provenance.services.orchestrator),
			},
		},
		socketTopology: {
			controller: response.socket_topology.controller,
			orchestrator: response.socket_topology.orchestrator,
			datasetPreparer: response.socket_topology.dataset_preparer,
			worker: response.socket_topology.worker,
			evaluator: response.socket_topology.evaluator,
		},
		errors: response.errors,
		evidenceSha256: createHash("sha256").update(stableStringify(response)).digest("hex"),
	};
}

export async function readControllerBootstrapHealth(
	controllerUrl: string,
): Promise<CollectedControllerBootstrapHealth> {
	const endpoint = new URL("/v1/doctor/bootstrap", controllerUrl);
	const response = await fetch(endpoint, {
		headers: { accept: "application/json" },
		method: "POST",
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(`Controller bootstrap health returned HTTP ${response.status}`);
	}
	const body: unknown = await response.json();
	return toCollectedControllerBootstrapHealth(parseControllerBootstrapHealth(body));
}
