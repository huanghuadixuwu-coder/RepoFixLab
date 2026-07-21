import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExperimentPlan } from "../src/contracts/experiment-plan.ts";
import {
	createM3EligibilityManifest,
	createM3RepoStratifiedSplit,
	parseM3SamplingMetadataJsonl,
} from "../src/m3/split.ts";
import { createM6EvaluationCohorts } from "../src/m6/cohorts.ts";
import {
	createM6ExperimentLock,
	verifyM6ExperimentLock,
	type M6TaskEnvironmentLockReference,
} from "../src/m6/experiment-lock.ts";

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

function buildCohorts() {
	const content = [
		...Array.from({ length: 4 }, (_, index) => record("axios/axios", index)),
		...Array.from({ length: 2 }, (_, index) => record("immutable-js/immutable-js", index)),
		...Array.from({ length: 3 }, (_, index) => record("mrdoob/three.js", index)),
		...Array.from({ length: 17 }, (_, index) => record("preactjs/preact", index)),
		...Array.from({ length: 17 }, (_, index) => record("vuejs/core", index)),
	].join("\n") + "\n";
	const records = parseM3SamplingMetadataJsonl(content, REVISION);
	const allInstanceIds = [
		...Array.from({ length: 4 }, (_, index) => recordId("axios/axios", index)),
		...Array.from({ length: 2 }, (_, index) => recordId("immutable-js/immutable-js", index)),
		...Array.from({ length: 3 }, (_, index) => recordId("mrdoob/three.js", index)),
		...Array.from({ length: 17 }, (_, index) => recordId("preactjs/preact", index)),
	];
	const samplingMetadataSha256 = createHash("sha256").update(content, "utf8").digest("hex");
	const eligibility = createM3EligibilityManifest({
		candidateDatasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
		candidateDatasetLockSealSha256: "a".repeat(64),
		candidateSamplingMetadataSha256: samplingMetadataSha256,
		officialImageSourceLockId: "official-images-v1-set-43-0123456789abcdef",
		officialImageSourceLockSealSha256: "b".repeat(64),
		preflightSummaryFileSha256: "c".repeat(64),
		preflightRecordSha256: "d".repeat(64),
		eligibleInstanceIds: allInstanceIds,
	});
	const split = createM3RepoStratifiedSplit(records, {
		datasetLockId: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
		datasetLockSealSha256: "a".repeat(64),
		samplingMetadataContent: content,
		eligibilityManifest: eligibility,
	});
	return { cohorts: createM6EvaluationCohorts(split, records), allInstanceIds };
}

function plan(instanceIds: readonly string[]): ExperimentPlan {
	return {
		schema_version: "v1",
		plan_type: "experiment_capacity",
		experiment_id: "repofixlab-v1",
		task_selection: { status: "frozen", declared_task_count: 26, instance_ids: [...instanceIds].sort() },
		matrix: [
			{ group_id: "main", task_count: 17, config_ids: ["pi-general", "repofix-full"], replicates: 1 },
			{ group_id: "ablation-no-localize", task_count: 8, config_ids: ["repofix-no-localize"], replicates: 1 },
			{
				group_id: "ablation-no-verify-feedback",
				task_count: 8,
				config_ids: ["repofix-no-verify-feedback"],
				replicates: 1,
			},
			{ group_id: "stability-additional", task_count: 6, config_ids: ["pi-general", "repofix-full"], replicates: 2 },
		],
		budget: { per_run_accounted_admission_cap_tokens: 200_000, total_accounted_admission_cap_tokens: 14_800_000 },
		runtime_status: "lifecycle_unavailable",
	};
}

function imageId(index: number, suffix: string): string {
	return `sha256:${createHash("sha256").update(`${index}:${suffix}`, "utf8").digest("hex")}`;
}

function lockReferences(instanceIds: readonly string[]): readonly M6TaskEnvironmentLockReference[] {
	return [...instanceIds].sort().map((instanceId, index) => ({
		instance_id: instanceId,
		lock_id: `task-environment-v1-${index}-${"a".repeat(16)}`,
		seal_sha256: createHash("sha256").update(`seal:${instanceId}`, "utf8").digest("hex"),
		file_sha256: createHash("sha256").update(`file:${instanceId}`, "utf8").digest("hex"),
		worker_image_id: imageId(index, "worker"),
		evaluator_image_id: imageId(index, "evaluator"),
	}));
}

describe("M6 experiment lock", () => {
	it("expands the registered 74-run matrix while allowing preregistered cross-group task reuse", () => {
		const { cohorts, allInstanceIds } = buildCohorts();
		const lock = createM6ExperimentLock({
			plan: plan(allInstanceIds),
			cohorts,
			code_revision_sha256: "e".repeat(64),
			dataset_lock: {
				lock_id: "dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6",
				seal_sha256: "a".repeat(64),
			},
			official_image_source_lock: {
				lock_id: "official-images-v1-set-43-0123456789abcdef",
				seal_sha256: "b".repeat(64),
			},
			task_environment_locks: lockReferences(allInstanceIds),
			model: {
				provider: "zhipu-standard",
				model_id: "glm-4.5-air",
				model_spec_sha256: "c".repeat(64),
				pricing_spec_sha256: "d".repeat(64),
				temperature: 0.2,
				max_output_tokens: 16_384,
				max_model_turns: 64,
				max_tool_calls: 100,
				max_wall_time_ms: 1_800_000,
				provider_retry_policy: "orchestrator_only",
				overflow_auto_recovery: false,
			},
			token_admission_estimator: {
				version: "glm-calibration-v1",
				multiplier: 1.1,
				framing_margin_tokens: 128,
				maximum_request_actual_tokens: 147_456,
				calibration_evidence_sha256: "f".repeat(64),
			},
		});

		expect(lock.logical_runs).toHaveLength(74);
		expect(lock.logical_runs.filter((run) => run.group_id === "main")).toHaveLength(34);
		expect(lock.logical_runs.filter((run) => run.group_id === "ablation-no-localize")).toHaveLength(8);
		expect(lock.logical_runs.filter((run) => run.group_id === "ablation-no-verify-feedback")).toHaveLength(8);
		expect(lock.logical_runs.filter((run) => run.group_id === "stability-additional")).toHaveLength(24);
		expect(new Set(lock.logical_runs.map((run) => run.run_id)).size).toBe(74);
		expect(verifyM6ExperimentLock(lock)).toEqual(lock);
		expect(() => verifyM6ExperimentLock({ ...lock, experiment_lock_sha256: "0".repeat(64) })).toThrow("SHA-256");
	});
});
