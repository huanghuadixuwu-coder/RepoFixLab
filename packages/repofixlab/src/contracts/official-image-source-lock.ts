import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "./schema-generator.ts";
import { AXIOS_SMOKE_INSTANCE_ID, type OfficialImageSourceLock, OfficialImageSourceLockSchema } from "./v1.ts";

export interface ExpectedOfficialImageSourceLockFacts {
	readonly datasetRevision: string;
	readonly harnessRevision: string;
	readonly imageKey: typeof AXIOS_SMOKE_INSTANCE_ID;
	readonly requestedReference: string;
	readonly repositoryDigest: string;
	readonly localImageId: string;
	readonly platform: "linux/amd64";
	readonly registryResponseSha256: string;
}

export interface OfficialImageSourceLockSemanticSubset {
	readonly dataset_revision: string;
	readonly harness_revision: string;
	readonly images: readonly [
		{
			readonly image_key: string;
			readonly local_image_id: string;
			readonly platform: "linux/amd64";
			readonly registry_response_sha256: string;
			readonly repository_digest: string;
			readonly requested_reference: string;
		},
	];
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

export function officialImageSourceLockSemanticSubset(
	lock: OfficialImageSourceLock,
): OfficialImageSourceLockSemanticSubset {
	const image = lock.images[0];
	if (lock.images.length !== 1 || image === undefined) {
		throw new Error("Official image source lock must contain exactly one Axios image");
	}
	return {
		dataset_revision: lock.dataset_revision,
		harness_revision: lock.harness_revision,
		images: [
			{
				image_key: image.image_key,
				local_image_id: image.local_image_id,
				platform: image.platform,
				registry_response_sha256: image.registry_response_sha256,
				repository_digest: image.repository_digest,
				requested_reference: image.requested_reference,
			},
		],
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

export function verifyOfficialImageSourceLock(
	value: unknown,
	expected: ExpectedOfficialImageSourceLockFacts,
): OfficialImageSourceLock {
	if (!lockValidator.Check(value)) {
		throw new Error("Official image source lock does not satisfy the strict v1 schema");
	}
	const image = value.images[0];
	if (value.images.length !== 1 || image === undefined || image.image_key !== AXIOS_SMOKE_INSTANCE_ID) {
		throw new Error("Official image source lock must contain exactly one Axios image");
	}
	if (!isTimestamp(value.created_at) || !isTimestamp(image.resolved_at) || value.created_at !== image.resolved_at) {
		throw new Error("Official image source lock created_at must equal its valid image resolved_at timestamp");
	}
	if (
		value.dataset_revision !== expected.datasetRevision ||
		value.harness_revision !== expected.harnessRevision ||
		image.image_key !== expected.imageKey ||
		image.requested_reference !== expected.requestedReference ||
		image.repository_digest !== expected.repositoryDigest ||
		image.local_image_id !== expected.localImageId ||
		image.platform !== expected.platform ||
		image.registry_response_sha256 !== expected.registryResponseSha256
	) {
		throw new Error("Official image source lock does not match the expected frozen facts");
	}
	const semanticHash = officialImageSourceLockSemanticSha256(value);
	if (value.seal_sha256 !== semanticHash) {
		throw new Error("Official image source lock seal does not match its stable semantic subset");
	}
	if (value.lock_id !== `official-images-v1-axios-5892-${semanticHash.slice(0, 16)}`) {
		throw new Error("Official image source lock ID does not match its semantic seal prefix");
	}
	return value;
}
