import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createM3EligibilityManifest,
	createM3RepoStratifiedSplit,
	parseM3SamplingMetadataJsonl,
} from "../src/m3/split.ts";
import {
	createM6EvaluationCohorts,
	M6_ABLATION_TASK_COUNT,
	M6_STABILITY_TASK_COUNT,
	verifyM6EvaluationCohorts,
} from "../src/m6/cohorts.ts";

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

function recordId(repo: string, index: number): string {
	return `${repo.replaceAll("/", "__")}-${String(index).padStart(2, "0")}`;
}

function metadata(): string {
	return [
		...Array.from({ length: 4 }, (_, index) => record("axios/axios", index)),
		...Array.from({ length: 2 }, (_, index) => record("immutable-js/immutable-js", index)),
		...Array.from({ length: 3 }, (_, index) => record("mrdoob/three.js", index)),
		...Array.from({ length: 17 }, (_, index) => record("preactjs/preact", index)),
		...Array.from({ length: 17 }, (_, index) => record("vuejs/core", index)),
	].join("\n") + "\n";
}

function eligibility(metadataSha256: string) {
	return createM3EligibilityManifest({
		candidateDatasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
		candidateDatasetLockSealSha256: "a".repeat(64),
		candidateSamplingMetadataSha256: metadataSha256,
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

describe("M6 evaluation cohorts", () => {
	it("freezes repository-stratified ablation and stability cohorts inside the sealed Test split", () => {
		const content = metadata();
		const metadataSha256 = createHash("sha256").update(content, "utf8").digest("hex");
		const records = parseM3SamplingMetadataJsonl(content, REVISION);
		const split = createM3RepoStratifiedSplit(records, {
			datasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
			datasetLockSealSha256: "a".repeat(64),
			samplingMetadataContent: content,
			eligibilityManifest: eligibility(metadataSha256),
		});
		const cohorts = createM6EvaluationCohorts(split, records);

		expect(cohorts.main_test_instance_ids).toHaveLength(17);
		expect(cohorts.ablation_instance_ids).toHaveLength(M6_ABLATION_TASK_COUNT);
		expect(cohorts.stability_instance_ids).toHaveLength(M6_STABILITY_TASK_COUNT);
		expect(cohorts.main_test_instance_ids).toEqual([...cohorts.main_test_instance_ids].sort());
		expect(cohorts.ablation_instance_ids.every((instanceId) => cohorts.main_test_instance_ids.includes(instanceId))).toBe(true);
		expect(cohorts.stability_instance_ids.every((instanceId) => cohorts.main_test_instance_ids.includes(instanceId))).toBe(true);
		expect(createM6EvaluationCohorts(split, records)).toEqual(cohorts);
		expect(verifyM6EvaluationCohorts(cohorts)).toEqual(cohorts);
		expect(JSON.stringify(cohorts)).not.toContain("gold_changed_lines");
		expect(JSON.stringify(cohorts)).not.toContain("issue_bytes");
	});

	it("rejects cohort tampering and missing M3 Test metadata", () => {
		const content = metadata();
		const metadataSha256 = createHash("sha256").update(content, "utf8").digest("hex");
		const records = parseM3SamplingMetadataJsonl(content, REVISION);
		const split = createM3RepoStratifiedSplit(records, {
			datasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
			datasetLockSealSha256: "a".repeat(64),
			samplingMetadataContent: content,
			eligibilityManifest: eligibility(metadataSha256),
		});
		const cohorts = createM6EvaluationCohorts(split, records);
		expect(() => verifyM6EvaluationCohorts({ ...cohorts, cohort_sha256: "f".repeat(64) })).toThrow("sealed subset");
		expect(() => createM6EvaluationCohorts(split, records.slice(1))).toThrow("missing a frozen Test task");
	});
});
