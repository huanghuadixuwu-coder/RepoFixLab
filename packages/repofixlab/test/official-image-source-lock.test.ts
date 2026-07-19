import { describe, expect, it } from "vitest";
import {
	type ExpectedOfficialImageSourceLockFacts,
	officialImageSourceLockFileSha256,
	officialImageSourceLockSemanticSha256,
	officialImageSourceLockSemanticSubset,
	verifyOfficialImageSourceLock,
} from "../src/contracts/official-image-source-lock.ts";
import { stableStringify } from "../src/contracts/schema-generator.ts";
import type { OfficialImageSourceLock } from "../src/contracts/v1.ts";

const TIMESTAMP = "2026-07-18T12:00:00.000Z";
const DATASET_REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb";
const HARNESS_REVISION = "726c5461e2ef52d83cf1ea2107870a8bb3328d57";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const REGISTRY_RESPONSE_SHA256 = "b".repeat(64);
const REPOSITORY_DIGEST = `swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:${"c".repeat(64)}`;
const REQUESTED_REFERENCE = "swebench/sweb.eval.x86_64.axios_1776_axios-5892:latest";
const GOLDEN_SEMANTIC_SHA256 = "0ee78c1e1d7f205c88329bc1d28c03d3a8f07bf4e4ec4fe100ad2fa3a718ef6e";

const expected: ExpectedOfficialImageSourceLockFacts = {
	datasetRevision: DATASET_REVISION,
	harnessRevision: HARNESS_REVISION,
	imageKey: "axios__axios-5892",
	requestedReference: REQUESTED_REFERENCE,
	repositoryDigest: REPOSITORY_DIGEST,
	localImageId: IMAGE_ID,
	platform: "linux/amd64",
	registryResponseSha256: REGISTRY_RESPONSE_SHA256,
};

function officialLock(timestamp = TIMESTAMP): OfficialImageSourceLock {
	const draft: OfficialImageSourceLock = {
		schema_version: "v1",
		lock_type: "official_image_source",
		lock_id: "pending",
		dataset_revision: DATASET_REVISION,
		harness_revision: HARNESS_REVISION,
		images: [
			{
				image_key: "axios__axios-5892",
				requested_reference: REQUESTED_REFERENCE,
				repository_digest: REPOSITORY_DIGEST,
				local_image_id: IMAGE_ID,
				platform: "linux/amd64",
				registry_response_sha256: REGISTRY_RESPONSE_SHA256,
				resolved_at: timestamp,
			},
		],
		seal_sha256: "0".repeat(64),
		created_at: timestamp,
	};
	return reseal(draft);
}

function reseal(lock: OfficialImageSourceLock): OfficialImageSourceLock {
	const seal = officialImageSourceLockSemanticSha256(lock);
	return {
		...lock,
		lock_id: `official-images-v1-axios-5892-${seal.slice(0, 16)}`,
		seal_sha256: seal,
	};
}

describe("OfficialImageSourceLock semantic verifier", () => {
	it("matches the PowerShell semantic subset and golden SHA-256", () => {
		const lock = officialLock();

		expect(officialImageSourceLockSemanticSubset(lock)).toEqual({
			dataset_revision: DATASET_REVISION,
			harness_revision: HARNESS_REVISION,
			images: [
				{
					image_key: "axios__axios-5892",
					local_image_id: IMAGE_ID,
					platform: "linux/amd64",
					registry_response_sha256: REGISTRY_RESPONSE_SHA256,
					repository_digest: REPOSITORY_DIGEST,
					requested_reference: REQUESTED_REFERENCE,
				},
			],
			lock_type: "official_image_source",
			schema_version: "v1",
		});
		expect(lock.seal_sha256).toBe(GOLDEN_SEMANTIC_SHA256);
		expect(verifyOfficialImageSourceLock(lock, expected)).toBe(lock);
	});

	it("keeps the semantic seal stable across timestamps while file hashes remain byte-specific", () => {
		const first = officialLock("2026-07-18T12:00:00.000Z");
		const second = officialLock("2026-07-19T12:00:00.000Z");

		expect(second.seal_sha256).toBe(first.seal_sha256);
		expect(second.lock_id).toBe(first.lock_id);
		expect(officialImageSourceLockFileSha256(stableStringify(second))).not.toBe(
			officialImageSourceLockFileSha256(stableStringify(first)),
		);
		expect(verifyOfficialImageSourceLock(second, expected)).toBe(second);
	});

	it("rejects seal, ID, content, and extra-property tampering", () => {
		const lock = officialLock();
		const semanticTamper = reseal({
			...lock,
			images: [{ ...lock.images[0]!, registry_response_sha256: "d".repeat(64) }],
		});
		expect(() => verifyOfficialImageSourceLock({ ...lock, seal_sha256: "f".repeat(64) }, expected)).toThrow("seal");
		expect(() =>
			verifyOfficialImageSourceLock({ ...lock, lock_id: "official-images-v1-axios-5892-deadbeef" }, expected),
		).toThrow("ID");
		expect(() => verifyOfficialImageSourceLock({ ...lock, unexpected: true }, expected)).toThrow("strict v1 schema");
		expect(() =>
			verifyOfficialImageSourceLock({ ...lock, images: [...lock.images, lock.images[0]!] }, expected),
		).toThrow("exactly one Axios image");
		expect(() => verifyOfficialImageSourceLock(semanticTamper, expected)).toThrow("expected frozen facts");
	});

	it("rejects timestamp mismatch or invalid timestamps", () => {
		const lock = officialLock();
		expect(() =>
			verifyOfficialImageSourceLock({ ...lock, created_at: "2026-07-18T12:00:01.000Z" }, expected),
		).toThrow("created_at");
		expect(() =>
			verifyOfficialImageSourceLock(
				{
					...lock,
					created_at: "2026-99-99T12:00:00Z",
					images: [{ ...lock.images[0]!, resolved_at: "2026-99-99T12:00:00Z" }],
				},
				expected,
			),
		).toThrow("valid image resolved_at");
	});

	it("rejects drift from caller-supplied frozen facts", () => {
		const lock = officialLock();
		expect(() =>
			verifyOfficialImageSourceLock(lock, {
				...expected,
				harnessRevision: "0".repeat(40),
			}),
		).toThrow("expected frozen facts");
	});
});
