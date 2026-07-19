import { describe, expect, it } from "vitest";
import {
	assessBootstrapImageProvenance,
	createBootstrapImageProvenanceLock,
	type UnsignedBootstrapImageProvenanceLock,
	verifyBootstrapImageProvenanceLock,
} from "../src/doctor/index.ts";
import {
	CONTROLLER_IMAGE_ID,
	PYTHON_DIGEST,
	passingImageProvenanceObservation,
	unsignedImageProvenanceLock,
} from "./image-provenance-fixture.ts";

describe("bootstrap image provenance", () => {
	it("binds actual running images, image-bound Compose service config, locked bases, networks, and ports", () => {
		const lock = createBootstrapImageProvenanceLock(unsignedImageProvenanceLock());
		const result = assessBootstrapImageProvenance(lock, passingImageProvenanceObservation());

		expect(result.ok).toBe(true);
		expect(result.lockSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(result.services.controller).toMatchObject({
			passed: true,
			expectedImageId: CONTROLLER_IMAGE_ID,
			actualImageId: CONTROLLER_IMAGE_ID,
			baseRepositoryDigest: PYTHON_DIGEST,
		});
	});

	it("does not bind service config proof to a one-off container identity", () => {
		const lock = createBootstrapImageProvenanceLock(unsignedImageProvenanceLock());
		const actual = passingImageProvenanceObservation();
		const controller = actual.services.controller;
		if (controller === null) throw new Error("fixture controller observation is missing");
		const result = assessBootstrapImageProvenance(lock, {
			services: {
				...actual.services,
				controller: { ...controller, containerId: "9".repeat(64) },
			},
		});

		expect(result.ok).toBe(true);
		expect(result.services.controller).toMatchObject({
			containerId: "9".repeat(64),
			expectedComposeConfigSha256: "8".repeat(64),
			actualComposeConfigSha256: "8".repeat(64),
		});
	});

	it("rejects a modified external lock", () => {
		const lock = createBootstrapImageProvenanceLock(unsignedImageProvenanceLock());
		const tampered = {
			...lock,
			services: {
				...lock.services,
				controller: { ...lock.services.controller, expectedImageId: `sha256:${"0".repeat(64)}` },
			},
		};

		expect(() => verifyBootstrapImageProvenanceLock(tampered)).toThrow("SHA-256 does not match");
	});

	it("rejects runtime-cast protocol drift before hashing an external lock", () => {
		const candidate = {
			...unsignedImageProvenanceLock(),
			schemaVersion: "repofixlab.bootstrap-image-provenance-lock.v2",
		};

		expect(() => createBootstrapImageProvenanceLock(candidate as UnsignedBootstrapImageProvenanceLock)).toThrow(
			"metadata is invalid",
		);
	});

	it("fails when runtime evidence diverges from the external lock", () => {
		const lock = createBootstrapImageProvenanceLock(unsignedImageProvenanceLock());
		const actual = passingImageProvenanceObservation();
		const controller = actual.services.controller;
		if (controller === null) throw new Error("fixture controller observation is missing");
		const result = assessBootstrapImageProvenance(lock, {
			services: {
				...actual.services,
				controller: {
					...controller,
					imageId: `sha256:${"0".repeat(64)}`,
					composeConfigSha256: "0".repeat(64),
					publishedPorts: ["0.0.0.0:8000->8000/tcp"],
					imageRootfsLayers: [`sha256:${"f".repeat(64)}`],
				},
			},
		});

		expect(result.ok).toBe(false);
		expect(result.services.controller.errors).toEqual([
			"running image ID does not match the external lock",
			"running image-bound Compose service config hash does not match the external lock",
			"running image rootfs does not extend the inspected locked base image",
			"running service publishes ports",
		]);
	});

	it("fails on an extra runtime network even if the image-bound Compose service config label is unchanged", () => {
		const lock = createBootstrapImageProvenanceLock(unsignedImageProvenanceLock());
		const actual = passingImageProvenanceObservation();
		const orchestrator = actual.services.orchestrator;
		if (orchestrator === null) throw new Error("fixture orchestrator observation is missing");
		const result = assessBootstrapImageProvenance(lock, {
			services: {
				...actual.services,
				orchestrator: {
					...orchestrator,
					networks: [
						...orchestrator.networks,
						{
							networkId: "1".repeat(64),
							composeProject: null,
							composeNetwork: null,
							internal: false,
						},
					],
				},
			},
		});

		expect(result.ok).toBe(false);
		expect(result.services.orchestrator.errors).toContain(
			"running service network attachments do not match the external lock",
		);
	});
});
