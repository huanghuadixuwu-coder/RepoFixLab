import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "./schema-generator.ts";
import { type PristineRuntimeLock, PristineRuntimeLockSchema } from "./v1.ts";

export type PristineRuntimeLockBuildInput = Omit<PristineRuntimeLock, "lock_id" | "semantic_sha256">;

type PristineRuntimeLockSemanticContent = Omit<PristineRuntimeLock, "lock_id" | "created_at" | "semantic_sha256">;

const validator = Compile(PristineRuntimeLockSchema);

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

export function pristineRuntimeLockSemanticSha256(value: PristineRuntimeLockSemanticContent): string {
	return canonicalHash(value);
}

export function createPristineRuntimeLock(input: PristineRuntimeLockBuildInput): PristineRuntimeLock {
	const { created_at: _createdAt, ...semanticContent } = input;
	const semanticSha256 = pristineRuntimeLockSemanticSha256(semanticContent);
	return verifyPristineRuntimeLock({
		...input,
		lock_id: `pristine-runtime-v1-${semanticSha256}`,
		semantic_sha256: semanticSha256,
	});
}

export function verifyPristineRuntimeLock(value: unknown): PristineRuntimeLock {
	if (!validator.Check(value)) {
		throw new Error("Pristine runtime lock does not satisfy the v1 contract");
	}
	const { lock_id: lockId, created_at: _createdAt, semantic_sha256: actualSemanticSha256, ...semanticContent } = value;
	const expectedSemanticSha256 = pristineRuntimeLockSemanticSha256(semanticContent);
	if (actualSemanticSha256 !== expectedSemanticSha256) {
		throw new Error("Pristine runtime lock semantic SHA-256 does not match canonical content");
	}
	if (lockId !== `pristine-runtime-v1-${expectedSemanticSha256}`) {
		throw new Error("Pristine runtime lock ID does not match canonical content");
	}
	if (!value.image.repo_digest.endsWith(`@${value.image.id}`)) {
		throw new Error("Pristine runtime lock image ID does not match its repository digest");
	}
	if (
		value.image.entrypoint.join("\u0000") !==
			["python", "-m", "repofixlab_evaluator.pristine_runtime"].join("\u0000") ||
		value.image.cmd.join("\u0000") !== "self-check" ||
		value.verification.runtime_controls.cap_drop.join("\u0000") !== "ALL"
	) {
		throw new Error("Pristine runtime lock executable or capability controls drifted");
	}
	if (
		value.image.labels["io.repofixlab.provenance.sha256"] !== value.provenance.sha256 ||
		value.image.labels["org.opencontainers.image.revision"] !== value.provenance.upstream_revision ||
		value.image.base_image !== value.provenance.base_image ||
		value.image.platform !== value.provenance.platform
	) {
		throw new Error("Pristine runtime lock image and build provenance disagree");
	}
	const {
		sha256: actualProvenanceSha256,
		source_lock_file_sha256: _sourceLockFileSha256,
		...unsignedProvenance
	} = value.provenance;
	const buildProvenance = {
		...unsignedProvenance,
		provenance_sha256: actualProvenanceSha256,
	};
	const { provenance_sha256: _provenanceSha256, ...canonicalBuildProvenance } = buildProvenance;
	if (canonicalHash(canonicalBuildProvenance) !== actualProvenanceSha256) {
		throw new Error("Pristine runtime lock build provenance SHA-256 does not match canonical content");
	}
	for (const timestamp of [value.created_at, value.image.created_at]) {
		if (!timestamp.endsWith("Z") || Number.isNaN(Date.parse(timestamp))) {
			throw new Error("Pristine runtime lock contains an invalid UTC timestamp");
		}
	}
	return value;
}
