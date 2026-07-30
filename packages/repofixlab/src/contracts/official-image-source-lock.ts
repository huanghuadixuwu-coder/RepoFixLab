import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "./schema-generator.ts";
import type { OfficialImageSourceLock } from "./v1.ts";
import { OfficialImageSourceLockSchema } from "./v1.ts";

export interface ExpectedOfficialImageSourceLockImage {
	readonly imageKey: string;
	readonly requestedReference: string;
	readonly repositoryDigest: string;
	readonly localImageId: string;
	readonly platform: "linux/amd64";
	readonly registryResponseSha256: string;
}

export interface ExpectedOfficialImageSourceLockFacts {
	readonly datasetRevision: string;
	readonly harnessRevision: string;
	readonly images: readonly ExpectedOfficialImageSourceLockImage[];
}

export interface OfficialImageSourceLockSemanticSubset {
	readonly dataset_revision: string;
	readonly harness_revision: string;
	readonly images: readonly {
		readonly image_key: string;
		readonly local_image_id: string;
		readonly platform: "linux/amd64";
		readonly registry_response_sha256: string;
		readonly repository_digest: string;
		readonly requested_reference: string;
	}[];
	readonly lock_type: "official_image_source";
	readonly schema_version: "v1";
}

const lockValidator = Compile(OfficialImageSourceLockSchema);

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function compactCanonicalJson(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return `${JSON.stringify(normalized)}\n`;
}

function isTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function imageKeyPrefix(images: readonly { readonly image_key: string }[]): string {
	const first = images[0];
	if (images.length === 1 && first !== undefined) {
		return first.image_key === "axios__axios-5892" ? "axios-5892" : first.image_key.replaceAll("__", "-");
	}
	return `set-${images.length}`;
}

function exactImageFacts(image: OfficialImageSourceLock["images"][number]): ExpectedOfficialImageSourceLockImage {
	return {
		imageKey: image.image_key,
		requestedReference: image.requested_reference,
		repositoryDigest: image.repository_digest,
		localImageId: image.local_image_id,
		platform: image.platform,
		registryResponseSha256: image.registry_response_sha256,
	};
}

function areStrictlySortedImageKeys(keys: readonly string[]): boolean {
	return keys.every((key, index) => {
		const previous = keys[index - 1];
		return previous === undefined || previous < key;
	});
}

export function officialImageSourceLockSemanticSubset(
	lock: OfficialImageSourceLock,
): OfficialImageSourceLockSemanticSubset {
	return {
		dataset_revision: lock.dataset_revision,
		harness_revision: lock.harness_revision,
		images: lock.images.map((image) => ({
			image_key: image.image_key,
			local_image_id: image.local_image_id,
			platform: image.platform,
			registry_response_sha256: image.registry_response_sha256,
			repository_digest: image.repository_digest,
			requested_reference: image.requested_reference,
		})),
		lock_type: lock.lock_type,
		schema_version: lock.schema_version,
	};
}

export function officialImageSourceLockSemanticSha256(lock: OfficialImageSourceLock): string {
	return sha256(compactCanonicalJson(officialImageSourceLockSemanticSubset(lock)));
}

export function officialImageSourceLockFileSha256(content: string): string {
	return sha256(content);
}

export function officialImageSourceLockId(lock: OfficialImageSourceLock): string {
	return `official-images-v1-${imageKeyPrefix(lock.images)}-${officialImageSourceLockSemanticSha256(lock).slice(0, 16)}`;
}

export function verifyOfficialImageSourceLock(
	value: unknown,
	expected: ExpectedOfficialImageSourceLockFacts,
): OfficialImageSourceLock {
	if (!lockValidator.Check(value)) {
		throw new Error("Official image source lock does not satisfy the strict v1 schema");
	}
	if (
		!areStrictlySortedImageKeys(value.images.map((image) => image.image_key)) ||
		!areStrictlySortedImageKeys(expected.images.map((image) => image.imageKey))
	) {
		throw new Error("Official image source lock image keys must be unique and canonical-order sorted");
	}
	if (
		!isTimestamp(value.created_at) ||
		value.images.some((image) => !isTimestamp(image.resolved_at) || value.created_at !== image.resolved_at)
	) {
		throw new Error("Official image source lock created_at must equal every valid image resolved_at timestamp");
	}
	if (
		value.dataset_revision !== expected.datasetRevision ||
		value.harness_revision !== expected.harnessRevision ||
		value.images.length !== expected.images.length ||
		value.images.some((image, index) => {
			const imageExpected = expected.images[index];
			return (
				imageExpected === undefined || stableStringify(exactImageFacts(image)) !== stableStringify(imageExpected)
			);
		})
	) {
		throw new Error("Official image source lock does not match the expected frozen facts");
	}
	const semanticHash = officialImageSourceLockSemanticSha256(value);
	if (value.seal_sha256 !== semanticHash) {
		throw new Error("Official image source lock seal does not match its stable semantic subset");
	}
	if (value.lock_id !== officialImageSourceLockId(value)) {
		throw new Error("Official image source lock ID does not match its semantic seal prefix");
	}
	return value;
}

/** Verify a sealed lock before a caller applies its own dataset/task bindings. */
export function verifyOfficialImageSourceLockSelfContained(value: unknown): OfficialImageSourceLock {
	if (!lockValidator.Check(value)) {
		throw new Error("Official image source lock does not satisfy the strict v1 schema");
	}
	return verifyOfficialImageSourceLock(value, {
		datasetRevision: value.dataset_revision,
		harnessRevision: value.harness_revision,
		images: value.images.map((image) => exactImageFacts(image)),
	});
}
