import { describe, expect, it } from "vitest";
import {
	parseControllerBootstrapHealth,
	toCollectedControllerBootstrapHealth,
} from "../src/controller/bootstrap-health.ts";

const DIGEST = `alpine@sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const BASE_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const BASE_DIGEST = `python@sha256:${"d".repeat(64)}`;

function serviceObservation(service: "controller" | "orchestrator"): Record<string, unknown> {
	return {
		container_id: "e".repeat(64),
		image_id: IMAGE_ID,
		platform: "linux/amd64",
		compose_project: "repofixlab",
		compose_service: service,
		compose_config_sha256: "f".repeat(64),
		published_ports: [],
		networks: [
			{
				network_id: "1".repeat(64),
				compose_project: "repofixlab",
				compose_network: "repofix-control",
				internal: true,
			},
		],
		image_rootfs_layers: [`sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`],
		base_image: {
			image_id: BASE_IMAGE_ID,
			platform: "linux/amd64",
			repository_digests: [BASE_DIGEST],
			rootfs_layers: [`sha256:${"2".repeat(64)}`],
		},
	};
}

function healthResponse(): Record<string, unknown> {
	return {
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
		probe_image_digest: DIGEST,
		control_network_internal: true,
		image_provenance: {
			services: {
				controller: serviceObservation("controller"),
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
	};
}

describe("Controller bootstrap health boundary", () => {
	it("validates the strict wire contract and maps snake_case", () => {
		const response = parseControllerBootstrapHealth(healthResponse());
		const collected = toCollectedControllerBootstrapHealth(response);

		expect(collected).toMatchObject({
			daemonReachable: true,
			memoryBytes: "16616996864",
			imageProvenance: {
				services: {
					controller: {
						imageId: IMAGE_ID,
						baseImage: { imageId: BASE_IMAGE_ID, repositoryDigests: [BASE_DIGEST] },
					},
					orchestrator: null,
				},
			},
			socketTopology: { datasetPreparer: null },
		});
		expect(collected.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects unknown fields instead of silently accepting protocol drift", () => {
		expect(() => parseControllerBootstrapHealth({ ...healthResponse(), debug: true })).toThrow(
			"invalid v1 bootstrap health response",
		);
	});

	it("requires the image provenance observation envelope", () => {
		const { image_provenance: _imageProvenance, ...withoutProvenance } = healthResponse();
		expect(() => parseControllerBootstrapHealth(withoutProvenance)).toThrow("invalid v1 bootstrap health response");
	});

	it("rejects unknown nested provenance fields", () => {
		const response = healthResponse();
		const provenance = response.image_provenance as {
			services: { controller: Record<string, unknown> };
		};
		provenance.services.controller.debug = true;
		expect(() => parseControllerBootstrapHealth(response)).toThrow("invalid v1 bootstrap health response");
	});
});
