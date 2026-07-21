import { describe, expect, it } from "vitest";
import type { M3SplitManifest } from "../src/m3/split.ts";
import { createM6DevCalibrationBatch, verifyM6DevCalibrationBatch } from "../src/m6/calibration-cohort.ts";

const split: M3SplitManifest = {
	schema_version: "v1",
	manifest_type: "m3_repo_stratified_split",
	dataset_lock_id: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
	dataset_lock_seal_sha256: "a".repeat(64),
	eligibility_manifest_sha256: "b".repeat(64),
	sampling_metadata_sha256: "c".repeat(64),
	split_seed: "repofixlab-m3-repo-stratified-v1",
	target_counts: { dev: 5, validation: 4, test: 17 },
	assignments: [
		{ instance_id: "axios__axios-5892", split: "dev" },
		{ instance_id: "mrdoob__three.js-26589", split: "dev" },
		{ instance_id: "preactjs__preact-2927", split: "dev" },
		{ instance_id: "preactjs__preact-3562", split: "dev" },
		{ instance_id: "preactjs__preact-4182", split: "dev" },
		...Array.from({ length: 4 }, (_, index) => ({ instance_id: `validation__repo-${index}`, split: "validation" as const })),
		...Array.from({ length: 17 }, (_, index) => ({ instance_id: `test__repo-${index}`, split: "test" as const })),
	].sort((left, right) => left.instance_id.localeCompare(right.instance_id)),
	assignment_sha256: "d".repeat(64),
};

describe("M6 v2 Dev calibration cohort", () => {
	it("freezes the three selected Dev tasks into six one-shot balanced runs", () => {
		const batch = createM6DevCalibrationBatch(split);
		expect(batch.schema_version).toBe("v2");
		expect(batch.selected_dev_instance_ids).toEqual(["axios__axios-5892", "mrdoob__three.js-26589", "preactjs__preact-4182"]);
		expect(batch.logical_runs).toHaveLength(6);
		expect(batch.logical_runs.filter((run) => run.config_id === "pi-general")).toHaveLength(3);
		expect(batch.logical_runs.filter((run) => run.config_id === "repofix-full")).toHaveLength(3);
		expect(batch.logical_runs.every((run) => run.replicate === 1)).toBe(true);
		expect(verifyM6DevCalibrationBatch(batch)).toEqual(batch);
	});

	it("rejects a batch whose selected calibration task or budget-neutral multiplicity drifts", () => {
		const batch = createM6DevCalibrationBatch(split);
		expect(() => verifyM6DevCalibrationBatch({ ...batch, selected_dev_instance_ids: ["axios__axios-5892", "mrdoob__three.js-26589", "preactjs__preact-3562"] })).toThrow(/malformed/);
		expect(() => verifyM6DevCalibrationBatch({ ...batch, logical_runs: batch.logical_runs.slice(1) })).toThrow(/malformed/);
	});
});
