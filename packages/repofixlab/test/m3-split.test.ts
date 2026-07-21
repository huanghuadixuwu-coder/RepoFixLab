import { createHash as createHashImpl } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createM3EligibilityManifest,
	createM3RepoStratifiedSplit,
	M3_ELIGIBLE_TASK_COUNT,
	M3_SPLIT_TARGETS,
	parseM3SamplingMetadataJsonl,
	verifyM3EligibilityManifest,
	verifyM3RepoStratifiedSplit,
} from "../src/m3/split.ts";

const REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb";

function record(repo: string, index: number): string {
	return JSON.stringify({
		schema_version: "v1",
		record_type: "sampling_metadata",
		dataset_revision: REVISION,
		instance_id: `${repo.replaceAll("/", "__")}-${String(index).padStart(2, "0")}`,
		repo,
		issue_bytes: 1_000 + index,
		gold_changed_lines: index % 7,
		parser_version: "unified-diff-v1",
	});
}

function metadata(): string {
	return [
		...Array.from({ length: 6 }, (_, index) => record("axios/axios", index)),
		...Array.from({ length: 5 }, (_, index) => record("babel/babel", index)),
		...Array.from({ length: 5 }, (_, index) => record("facebook/docusaurus", index)),
		...Array.from({ length: 2 }, (_, index) => record("immutable-js/immutable-js", index)),
		...Array.from({ length: 3 }, (_, index) => record("mrdoob/three.js", index)),
		...Array.from({ length: 17 }, (_, index) => record("preactjs/preact", index)),
		...Array.from({ length: 5 }, (_, index) => record("vuejs/core", index)),
	].join("\n") + "\n";
}

function eligibility(candidateSamplingMetadataSha256 = "b".repeat(64)) {
	return createM3EligibilityManifest({
		candidateDatasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
		candidateDatasetLockSealSha256: "a".repeat(64),
		candidateSamplingMetadataSha256,
		officialImageSourceLockId: "official-images-v1-set-43-0123456789abcdef",
		officialImageSourceLockSealSha256: "c".repeat(64),
		preflightSummaryFileSha256: "d".repeat(64),
		preflightRecordSha256: "e".repeat(64),
		eligibleInstanceIds: [
			...Array.from({ length: 4 }, (_, index) => recordId("axios/axios", index)),
			...Array.from({ length: 2 }, (_, index) => recordId("immutable-js/immutable-js", index)),
			...Array.from({ length: 3 }, (_, index) => recordId("mrdoob/three.js", index)),
			...Array.from({ length: 17 }, (_, index) => recordId("preactjs/preact", index)),
		],
	});
}

function recordId(repo: string, index: number): string {
	return `${repo.replaceAll("/", "__")}-${String(index).padStart(2, "0")}`;
}

describe("M3 repository-stratified split", () => {
	it("freezes a deterministic 5/4/17 split from the 26-task eligible subset without exposing control metadata", () => {
		const content = metadata();
		const records = parseM3SamplingMetadataJsonl(content, REVISION);
		const eligible = eligibility(createHash(content));
		const manifest = createM3RepoStratifiedSplit(records, {
			datasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
			datasetLockSealSha256: "a".repeat(64),
			samplingMetadataContent: content,
			eligibilityManifest: eligible,
		});

		expect(manifest.target_counts).toEqual(M3_SPLIT_TARGETS);
		expect(manifest.assignments).toHaveLength(M3_ELIGIBLE_TASK_COUNT);
		expect(manifest.assignments.filter((assignment) => assignment.split === "dev")).toHaveLength(5);
		expect(manifest.assignments.filter((assignment) => assignment.split === "validation")).toHaveLength(4);
		expect(manifest.assignments.filter((assignment) => assignment.split === "test")).toHaveLength(17);
		expect(JSON.stringify(manifest)).not.toContain("gold_changed_lines");
		expect(JSON.stringify(manifest)).not.toContain("issue_bytes");
		expect(
			createM3RepoStratifiedSplit(records, {
				datasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
				datasetLockSealSha256: "a".repeat(64),
				samplingMetadataContent: content,
				eligibilityManifest: eligible,
			}),
		).toEqual(manifest);
		const sealedEligibility = verifyM3EligibilityManifest(eligible);
		expect(verifyM3RepoStratifiedSplit(manifest, sealedEligibility)).toEqual(manifest);
	});

	it("rejects duplicate IDs and a dataset revision mismatch", () => {
		const content = `${record("axios/axios", 0)}\n${record("axios/axios", 0)}\n`;
		expect(() => parseM3SamplingMetadataJsonl(content, REVISION)).toThrow("duplicate instance IDs");
		expect(() => parseM3SamplingMetadataJsonl(`${record("axios/axios", 0)}\n`, "f".repeat(40))).toThrow(
			"dataset revision",
		);
	});

	it("rejects metadata leakage and tampered assignments", () => {
		const content = metadata();
		const eligible = eligibility(createHash(content));
		const manifest = createM3RepoStratifiedSplit(parseM3SamplingMetadataJsonl(content, REVISION), {
			datasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
			datasetLockSealSha256: "a".repeat(64),
			samplingMetadataContent: content,
			eligibilityManifest: eligible,
		});
		expect(() => verifyM3RepoStratifiedSplit({ ...manifest, issue_bytes: 1 })).toThrow("fields");
		expect(() => verifyM3RepoStratifiedSplit({ ...manifest, assignment_sha256: "b".repeat(64) })).toThrow(
			"canonical frozen",
		);
		expect(() => verifyM3RepoStratifiedSplit(manifest, { ...eligible, eligibility_sha256: "f".repeat(64) })).toThrow(
			"eligibility manifest SHA-256",
		);
	});
});

function createHash(content: string): string {
	return createHashImpl("sha256").update(content, "utf8").digest("hex");
}
