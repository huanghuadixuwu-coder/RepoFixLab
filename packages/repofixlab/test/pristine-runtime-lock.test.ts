import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createPristineRuntimeLock,
	type PristineRuntimeLockBuildInput,
	stableStringify,
	verifyPristineRuntimeLock,
} from "../src/contracts/index.ts";

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function buildInput(): PristineRuntimeLockBuildInput {
	const unsignedProvenance = {
		schema_version: "v1" as const,
		artifact_type: "repofixlab_pristine_harness" as const,
		platform: "linux/amd64" as const,
		base_image:
			"python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d" as const,
		source_archive_sha256: "a".repeat(64),
		source_lock_sha256: "f7e8a6e953d3351fd9c4dcea471222a277d55af7b5c25d384bda251b91c51a71" as const,
		source_lock_file_sha256: "8b9ce8b01b58cbcfbef3a88e1b4cb99289553c948ccaa27afa83771ae5bb6741" as const,
		source_aggregate_sha256: "b8c8574e17fd0c11159c7fa3a63e17a247ca5b2f73fa0a9899ca542cfcb093e6" as const,
		upstream_revision: "726c5461e2ef52d83cf1ea2107870a8bb3328d57" as const,
		upstream_tree_sha1: "f178530b37202c549b1b2b3300db2da90da648db" as const,
		dependency_lock_sha256: "b836155987474285284c3b8228e8575dda5d4d3ae12e1bce049fc2894424cba9" as const,
		evaluator_kernel_aggregate_sha256: "b".repeat(64),
		evaluator_kernel_file_count: 13,
		evaluator_kernel_bytes: 80_000,
		dockerfile_sha256: "f0427192cf9bcec5a637684875f835bf5144cd3b3c464aa1e6544d8b28c766d1" as const,
	};
	const { source_lock_file_sha256: _sourceLockFileSha256, ...unsignedBuildProvenance } = unsignedProvenance;
	const provenance = {
		...unsignedProvenance,
		sha256: canonicalHash(unsignedBuildProvenance),
	};
	const imageId = `sha256:${"c".repeat(64)}`;
	return {
		schema_version: "v1",
		lock_type: "pristine_runtime",
		created_at: "2026-07-19T00:00:00.000Z",
		image: {
			id: imageId,
			repo_digest: `repofixlab/pristine-harness@${imageId}`,
			created_at: "2026-07-19T00:00:00.000Z",
			size_bytes: 178_000_000,
			base_image: unsignedProvenance.base_image,
			platform: "linux/amd64",
			configured_user: "65532:65532",
			oracle_runtime_user: "0:0",
			entrypoint: ["python", "-m", "repofixlab_evaluator.pristine_runtime"],
			cmd: ["self-check"],
			labels: {
				"io.repofixlab.harness.mode": "pristine",
				"io.repofixlab.provenance.sha256": provenance.sha256,
				"org.opencontainers.image.revision": unsignedProvenance.upstream_revision,
				"org.opencontainers.image.title": "RepoFixLab pristine SWE-bench harness",
			},
		},
		provenance,
		verification: {
			current_materials_bound: true,
			build_time_self_check_passed: true,
			restricted_runtime_self_check_passed: true,
			run_evaluation_import: "swebench/harness/run_evaluation.py",
			golden_oracle_resolved: true,
			golden_oracle_status_map_sha256: "00f69ade8e7237bb84f0d42c92c48fff1b4a7c4e37f3493804fbb978a0c9fbf0",
			runtime_controls: {
				network: "none",
				read_only_root: true,
				cap_drop: ["ALL"],
				no_new_privileges: true,
				docker_socket: false,
				published_ports: false,
				sensitive_environment: false,
				pids_limit: 128,
				memory_bytes: 1_073_741_824,
				cpus: 1,
				tmpfs: "/tmp:rw,noexec,nosuid,size=16m",
			},
		},
	};
}

describe("Pristine runtime lock", () => {
	it("creates and verifies a strict semantic lock", () => {
		const lock = createPristineRuntimeLock(buildInput());
		expect(lock.lock_id).toBe(`pristine-runtime-v1-${lock.semantic_sha256}`);
		expect(verifyPristineRuntimeLock(lock)).toEqual(lock);
	});

	it("rejects unknown fields and provenance drift", () => {
		const lock = createPristineRuntimeLock(buildInput());
		expect(() => verifyPristineRuntimeLock({ ...lock, unexpected: true })).toThrow(/v1 contract/);
		expect(() =>
			verifyPristineRuntimeLock({
				...lock,
				image: { ...lock.image, size_bytes: lock.image.size_bytes + 1 },
			}),
		).toThrow(/semantic SHA-256/);
	});
});
