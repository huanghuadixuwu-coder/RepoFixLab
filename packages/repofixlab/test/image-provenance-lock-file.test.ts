import { describe, expect, it } from "vitest";
import type { UnsignedBootstrapImageProvenanceLock } from "../src/doctor/image-provenance.ts";
import {
	createBootstrapImageProvenanceLockFile,
	parseBootstrapImageProvenanceLockFile,
	parseUnsignedBootstrapImageProvenanceLock,
} from "../src/doctor/image-provenance-lock-file.ts";

const IMAGE_ID = `sha256:${"1".repeat(64)}`;
const BASE_ID = `sha256:${"2".repeat(64)}`;
const BASE_DIGEST = `python@sha256:${"3".repeat(64)}`;

function candidate(): UnsignedBootstrapImageProvenanceLock {
	const service = {
		baseRepositoryDigest: BASE_DIGEST,
		buildInputsSha256: "4".repeat(64),
		composeConfigSha256: "5".repeat(64),
		dockerfileSha256: "6".repeat(64),
		expectedBaseImageId: BASE_ID,
		expectedImageId: IMAGE_ID,
		expectedNetworks: [{ internal: true, logicalName: "repofix-control" }],
		platform: "linux/amd64" as const,
	};
	return {
		composeProject: "repofixlab",
		createdAt: "2026-07-18T00:00:00.000Z",
		lockId: "bootstrap-images-20260718",
		lockType: "bootstrap_image_provenance",
		schemaVersion: "repofixlab.bootstrap-image-provenance-lock.v1",
		services: { controller: service, orchestrator: service },
	};
}

describe("bootstrap image provenance lock file", () => {
	it("strictly parses and hashes a host-generated candidate", () => {
		const output = createBootstrapImageProvenanceLockFile(JSON.stringify(candidate()));
		expect(parseBootstrapImageProvenanceLockFile(output)).toMatchObject({
			composeProject: "repofixlab",
			lockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("rejects a lock whose content changed after publication", () => {
		const output = createBootstrapImageProvenanceLockFile(JSON.stringify(candidate()));
		const lock: unknown = JSON.parse(output);
		if (typeof lock !== "object" || lock === null || !("composeProject" in lock)) {
			throw new Error("Test lock shape is invalid");
		}
		lock.composeProject = "different-project";
		expect(() => parseBootstrapImageProvenanceLockFile(JSON.stringify(lock))).toThrow("SHA-256 does not match");
	});

	it("rejects unknown top-level fields instead of silently hashing them", () => {
		const value = { ...candidate(), trusted: true };
		expect(() => parseUnsignedBootstrapImageProvenanceLock(JSON.stringify(value))).toThrow("fields must be exactly");
	});

	it("rejects unknown nested fields", () => {
		const value = candidate();
		const altered = {
			...value,
			services: {
				...value.services,
				controller: { ...value.services.controller, imageTag: "latest" },
			},
		};
		expect(() => parseUnsignedBootstrapImageProvenanceLock(JSON.stringify(altered))).toThrow(
			"services.controller fields must be exactly",
		);
	});

	it("rejects invalid literal values through domain validation", () => {
		const value = { ...candidate(), lockType: "self_attested" };
		expect(() => createBootstrapImageProvenanceLockFile(JSON.stringify(value))).toThrow("metadata is invalid");
	});
});
