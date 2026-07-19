import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/contracts/schema-generator.ts";
import { type BootstrapDoctorReport, BootstrapDoctorReportSchema } from "../src/contracts/v1.ts";
import {
	createBootstrapDoctorReport,
	MIN_AVAILABLE_BYTES,
	MIN_DOCKER_MEMORY_BYTES,
	runBootstrapDoctor,
	verifyBootstrapDoctorReport,
} from "../src/doctor/index.ts";
import {
	CONTROLLER_IMAGE_ID,
	passingImageProvenanceLock,
	passingImageProvenanceObservation,
} from "./image-provenance-fixture.ts";

function resignReport(report: Omit<BootstrapDoctorReport, "report_sha256">): BootstrapDoctorReport {
	const reportSha256 = createHash("sha256").update(stableStringify(report)).digest("hex");
	return { ...report, report_sha256: reportSha256 };
}

describe("createBootstrapDoctorReport", () => {
	it("maps the fail-closed assessment into the public v1 contract", async () => {
		const assessment = await runBootstrapDoctor({
			now: () => new Date("2026-07-18T00:00:01.000Z"),
			readArtifactsStatFs: async () => ({ availableBlocks: MIN_AVAILABLE_BYTES, blockSize: 1n }),
			readControllerHealth: async () => ({
				daemonReachable: true,
				serverVersion: "29.3.1",
				osType: "linux",
				architecture: "amd64",
				cpuCount: 12,
				memoryBytes: MIN_DOCKER_MEMORY_BYTES - 1n,
				dockerRootDir: "/var/lib/docker",
				dockerVolumeAvailableBytes: MIN_AVAILABLE_BYTES,
				dockerVolumeId: "repofixlab-bootstrap-doctor-volume-0123456789ab",
				probeImageDigest: "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
				controlNetworkInternal: true,
				imageProvenance: passingImageProvenanceObservation(),
				socketTopology: {
					controller: "read-write",
					orchestrator: "none",
					datasetPreparer: null,
					worker: null,
					evaluator: null,
				},
				errors: [],
			}),
			readImageProvenanceLock: async () => passingImageProvenanceLock(),
		});

		const first = createBootstrapDoctorReport(assessment, "2026-07-18T00:00:00.000Z", "bootstrap-20260718-000001");
		const second = createBootstrapDoctorReport(assessment, "2026-07-18T00:00:00.000Z", "bootstrap-20260718-000001");

		expect(Compile(BootstrapDoctorReportSchema).Check(first)).toBe(true);
		expect(first.status).toBe("fail");
		expect(first.checks.compute).toMatchObject({
			state: "fail",
			memory_bytes: Number(MIN_DOCKER_MEMORY_BYTES - 1n),
		});
		expect(first.checks.base_images).toMatchObject({
			state: "pass",
			lock_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			services: {
				controller: {
					state: "pass",
					expected_image_id: CONTROLLER_IMAGE_ID,
					actual_image_id: CONTROLLER_IMAGE_ID,
					errors: [],
				},
			},
		});
		expect(first.checks.docker_socket_ownership).toMatchObject({
			state: "pass",
			required_roles: ["controller", "orchestrator"],
			deferred_roles: {
				dataset_preparer: "dataset_prepare",
				worker: "smoke_formal",
				evaluator: "smoke_formal",
			},
			actual: {
				controller: "read-write",
				orchestrator: "none",
				dataset_preparer: null,
				worker: null,
				evaluator: null,
			},
		});
		expect(first.report_sha256).toBe(second.report_sha256);
		expect(() => verifyBootstrapDoctorReport({ ...first, warnings: ["tampered"] })).toThrow("SHA-256 does not match");
	});

	it("rejects reversed required roles after schema validation and re-signing", async () => {
		const assessment = await runBootstrapDoctor({
			now: () => new Date("2026-07-18T00:00:01.000Z"),
			readArtifactsStatFs: async () => ({ availableBlocks: MIN_AVAILABLE_BYTES, blockSize: 1n }),
			readControllerHealth: async () => ({
				daemonReachable: true,
				serverVersion: "29.3.1",
				osType: "linux",
				architecture: "amd64",
				cpuCount: 12,
				memoryBytes: MIN_DOCKER_MEMORY_BYTES,
				dockerRootDir: "/var/lib/docker",
				dockerVolumeAvailableBytes: MIN_AVAILABLE_BYTES,
				dockerVolumeId: "repofixlab-bootstrap-doctor-volume-0123456789ab",
				probeImageDigest: "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
				controlNetworkInternal: true,
				imageProvenance: passingImageProvenanceObservation(),
				socketTopology: {
					controller: "read-write",
					orchestrator: "none",
					datasetPreparer: null,
					worker: null,
					evaluator: null,
				},
				errors: [],
			}),
			readImageProvenanceLock: async () => passingImageProvenanceLock(),
		});
		const original = createBootstrapDoctorReport(assessment, "2026-07-18T00:00:00.000Z", "bootstrap-20260718-000001");
		const { report_sha256: _reportSha256, ...unsigned } = original;
		const reversed = resignReport({
			...unsigned,
			checks: {
				...unsigned.checks,
				docker_socket_ownership: {
					...unsigned.checks.docker_socket_ownership,
					required_roles: ["orchestrator", "controller"],
				},
			},
		});

		expect(Compile(BootstrapDoctorReportSchema).Check(reversed)).toBe(true);
		expect(() => verifyBootstrapDoctorReport(reversed)).toThrow("required roles");
	});
});
