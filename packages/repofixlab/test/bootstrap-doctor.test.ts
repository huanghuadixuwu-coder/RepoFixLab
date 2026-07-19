import { describe, expect, it } from "vitest";
import {
	ARTIFACTS_PATH,
	type BootstrapDoctorDependencies,
	type CollectedControllerBootstrapHealth,
	MIN_AVAILABLE_BYTES,
	MIN_DOCKER_MEMORY_BYTES,
	runBootstrapDoctor,
	type SocketTopologyHealth,
} from "../src/doctor/index.ts";
import { passingImageProvenanceLock, passingImageProvenanceObservation } from "./image-provenance-fixture.ts";

const FIXED_NOW = new Date("2026-07-18T00:00:00.000Z");

function passingSocketTopology(): SocketTopologyHealth {
	return {
		controller: "read-write",
		orchestrator: "none",
		datasetPreparer: null,
		worker: null,
		evaluator: null,
	};
}

function passingControllerHealth(): CollectedControllerBootstrapHealth {
	return {
		daemonReachable: true,
		osType: "linux",
		architecture: "amd64",
		cpuCount: 8,
		memoryBytes: MIN_DOCKER_MEMORY_BYTES,
		dockerVolumeAvailableBytes: MIN_AVAILABLE_BYTES,
		dockerRootDir: "/var/lib/docker",
		dockerVolumeId: "bootstrap-space-probe",
		probeImageDigest: "example.invalid/probe@sha256:fixed",
		controlNetworkInternal: true,
		imageProvenance: passingImageProvenanceObservation(),
		errors: [],
		socketTopology: passingSocketTopology(),
	};
}

function dependencies(
	controllerHealth: CollectedControllerBootstrapHealth = passingControllerHealth(),
): BootstrapDoctorDependencies {
	return {
		now: () => FIXED_NOW,
		readArtifactsStatFs: async (path) => {
			expect(path).toBe(ARTIFACTS_PATH);
			return { availableBlocks: MIN_AVAILABLE_BYTES, blockSize: 1n };
		},
		readControllerHealth: async () => controllerHealth,
		readImageProvenanceLock: async () => passingImageProvenanceLock(),
	};
}

describe("runBootstrapDoctor", () => {
	it("passes only when every bootstrap fact is explicitly proven", async () => {
		const report = await runBootstrapDoctor(dependencies());

		expect(report).toMatchObject({
			schemaVersion: "repofixlab.bootstrap-doctor.v1",
			profile: "bootstrap",
			generatedAt: FIXED_NOW.toISOString(),
			status: "pass",
			ok: true,
			summary: { total: 11, passed: 11, failed: 0 },
		});
		expect(() => JSON.stringify(report)).not.toThrow();
	});

	it("fails for this machine's observed Docker memory even though it is close to 16 GiB", async () => {
		const report = await runBootstrapDoctor(
			dependencies({ ...passingControllerHealth(), memoryBytes: 16_616_996_864 }),
		);

		expect(report.status).toBe("fail");
		expect(report.checks.find((check) => check.id === "docker_memory_bytes")).toMatchObject({
			status: "fail",
			actual: "16616996864",
			expected: ">= 17179869184",
		});
	});

	it("normalizes Docker x86_64 while retaining strict linux/amd64 semantics", async () => {
		const report = await runBootstrapDoctor(dependencies({ ...passingControllerHealth(), architecture: "x86_64" }));

		expect(report.checks.find((check) => check.id === "docker_architecture")).toMatchObject({
			status: "pass",
			actual: "amd64",
		});
	});

	it("fails closed when Controller health fields are unknown", async () => {
		const report = await runBootstrapDoctor(
			dependencies({
				...passingControllerHealth(),
				cpuCount: null,
			}),
		);

		expect(report.ok).toBe(false);
		expect(report.checks.find((check) => check.id === "docker_cpu")?.status).toBe("fail");
	});

	it.each(["datasetPreparer", "worker", "evaluator"] as const)(
		"fails closed when deferred role %s has stale runtime evidence",
		async (role) => {
			const report = await runBootstrapDoctor(
				dependencies({
					...passingControllerHealth(),
					socketTopology: { ...passingSocketTopology(), [role]: "none" },
				}),
			);

			expect(report.checks.find((check) => check.id === "socket_topology")?.status).toBe("fail");
		},
	);

	it("fails closed when a required bootstrap role is missing", async () => {
		const report = await runBootstrapDoctor(
			dependencies({
				...passingControllerHealth(),
				socketTopology: { ...passingSocketTopology(), orchestrator: null },
			}),
		);

		expect(report.checks.find((check) => check.id === "socket_topology")).toMatchObject({
			status: "fail",
			actual: { controller: "read-write", orchestrator: null },
		});
	});

	it("treats every Controller collection error as a hard failure", async () => {
		const report = await runBootstrapDoctor(
			dependencies({ ...passingControllerHealth(), errors: ["cleanup volume failed"] }),
		);

		expect(report.checks.find((check) => check.id === "controller_integrity")).toMatchObject({
			status: "fail",
			actual: 1,
		});
		expect(report.status).toBe("fail");
	});

	it("fails closed with structured evidence when the external image lock is missing", async () => {
		const report = await runBootstrapDoctor({
			...dependencies(),
			readImageProvenanceLock: async () => null,
		});

		expect(report.checks.find((check) => check.id === "base_images")).toMatchObject({
			status: "fail",
			actual: {
				lockSha256: null,
				evidenceSha256: null,
				services: {
					controller: {
						passed: false,
						expectedImageId: null,
						errors: ["Bootstrap image provenance lock is missing"],
					},
				},
			},
		});
	});

	it("fails closed when a locked service observation is missing", async () => {
		const observation = passingImageProvenanceObservation();
		const report = await runBootstrapDoctor(
			dependencies({
				...passingControllerHealth(),
				imageProvenance: { services: { ...observation.services, orchestrator: null } },
			}),
		);

		expect(report.checks.find((check) => check.id === "base_images")).toMatchObject({
			status: "fail",
			actual: {
				lockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				services: {
					orchestrator: {
						passed: false,
						actualImageId: null,
						errors: ["runtime image provenance observation is missing"],
					},
				},
			},
		});
	});

	it("fails closed when a running image differs from the external lock", async () => {
		const observation = passingImageProvenanceObservation();
		const controller = observation.services.controller;
		if (controller === null) throw new Error("fixture controller observation is missing");
		const report = await runBootstrapDoctor(
			dependencies({
				...passingControllerHealth(),
				imageProvenance: {
					services: {
						...observation.services,
						controller: { ...controller, imageId: `sha256:${"0".repeat(64)}` },
					},
				},
			}),
		);

		expect(report.checks.find((check) => check.id === "base_images")).toMatchObject({
			status: "fail",
			actual: {
				services: {
					controller: {
						passed: false,
						actualImageId: `sha256:${"0".repeat(64)}`,
						errors: ["running image ID does not match the external lock"],
					},
				},
			},
		});
	});

	it("returns a machine-readable failed report when evidence providers reject", async () => {
		const report = await runBootstrapDoctor({
			now: () => FIXED_NOW,
			readArtifactsStatFs: async () => {
				throw new Error("statfs unavailable");
			},
			readControllerHealth: async () => {
				throw new Error("controller unavailable");
			},
		});

		expect(report).toMatchObject({
			status: "fail",
			ok: false,
			evidence: {
				artifacts: { availableBytes: null, error: "Error: statfs unavailable" },
				controller: { error: "Error: controller unavailable" },
			},
		});
		expect(report.summary.failed).toBe(11);
		expect(() => JSON.stringify(report)).not.toThrow();
	});

	it("fails invalid statfs readings instead of treating them as zero-capacity evidence", async () => {
		const baseDependencies = dependencies();
		const report = await runBootstrapDoctor({
			...baseDependencies,
			readArtifactsStatFs: async () => ({ availableBlocks: -1, blockSize: 4096 }),
		});

		expect(report.checks.find((check) => check.id === "artifacts_available_bytes")).toMatchObject({
			status: "fail",
			actual: null,
		});
		expect(report.evidence.artifacts.error).toBe("Invalid statfs reading");
	});
});
