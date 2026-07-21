import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { RepoFixConfigId } from "../agent/repofix-config.ts";
import type { M3SplitManifest } from "../m3/split.ts";

export const M6_CALIBRATION_PROTOCOL_REVISION = "repofixlab-protocol-1.5-deepseek-v4-flash" as const;
export const M6_CALIBRATION_RUN_COUNT = 6;
export const M6_CALIBRATION_PER_RUN_CAP_TOKENS = 3_500_000;
export const M6_CALIBRATION_PROJECT_CAP_TOKENS = 22_000_000;
export const M6_PROVIDER_SMOKE_CAP_TOKENS = 10_000;

const CALIBRATION_CONFIG_IDS = ["pi-general", "repofix-full"] as const satisfies readonly RepoFixConfigId[];
export const M6_CALIBRATION_INSTANCE_IDS = [
	"axios__axios-5892",
	"mrdoob__three.js-26589",
	"preactjs__preact-4182",
] as const;

export interface M6CalibrationRun {
	readonly run_id: string;
	readonly instance_id: (typeof M6_CALIBRATION_INSTANCE_IDS)[number];
	readonly config_id: (typeof CALIBRATION_CONFIG_IDS)[number];
	readonly replicate: 1;
}

/**
 * v3 preserves the v2 cohort but binds it to DeepSeek V4 Flash. Existing GLM
 * calibration artifacts stay immutable historical evidence and are not compared.
 */
export interface M6DevCalibrationBatch {
	readonly schema_version: "v2";
	readonly manifest_type: "m6_dev_calibration_batch";
	readonly protocol_revision: typeof M6_CALIBRATION_PROTOCOL_REVISION;
	readonly m3_assignment_sha256: string;
	readonly selected_dev_instance_ids: readonly (typeof M6_CALIBRATION_INSTANCE_IDS)[number][];
	readonly config_ids: readonly (typeof CALIBRATION_CONFIG_IDS)[number][];
	readonly replicates_per_configuration: 1;
	readonly logical_runs: readonly M6CalibrationRun[];
	readonly calibration_batch_sha256: string;
}

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function equalsStringArray(value: unknown, expected: readonly string[]): boolean {
	return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function createRunId(instanceId: M6CalibrationRun["instance_id"], configId: M6CalibrationRun["config_id"]): string {
	return `m6-calibration-${canonicalHash({
		protocol_revision: M6_CALIBRATION_PROTOCOL_REVISION,
		instance_id: instanceId,
		config_id: configId,
		replicate: 1,
	}).slice(0, 32)}`;
}

function semanticSubset(value: M6DevCalibrationBatch): Omit<M6DevCalibrationBatch, "calibration_batch_sha256"> {
	const { calibration_batch_sha256: _calibrationBatchSha256, ...semantic } = value;
	return semantic;
}

function isCalibrationInstanceId(value: unknown): value is M6CalibrationRun["instance_id"] {
	return typeof value === "string" && (M6_CALIBRATION_INSTANCE_IDS as readonly string[]).includes(value);
}

function isConfigurationId(value: unknown): value is M6CalibrationRun["config_id"] {
	return typeof value === "string" && (CALIBRATION_CONFIG_IDS as readonly string[]).includes(value);
}

export function createM6DevCalibrationBatch(split: M3SplitManifest): M6DevCalibrationBatch {
	const dev = new Set(split.assignments.filter((assignment) => assignment.split === "dev").map((assignment) => assignment.instance_id));
	if (!M6_CALIBRATION_INSTANCE_IDS.every((instanceId) => dev.has(instanceId))) {
		throw new Error("M6 v2 calibration tasks must all belong to the frozen Dev split");
	}
	const logicalRuns = M6_CALIBRATION_INSTANCE_IDS.flatMap((instanceId) =>
		CALIBRATION_CONFIG_IDS.map((configId) => ({
			run_id: createRunId(instanceId, configId),
			instance_id: instanceId,
			config_id: configId,
			replicate: 1 as const,
		})),
	).sort((left, right) => left.run_id.localeCompare(right.run_id));
	const draft: Omit<M6DevCalibrationBatch, "calibration_batch_sha256"> = {
		schema_version: "v2",
		manifest_type: "m6_dev_calibration_batch",
		protocol_revision: M6_CALIBRATION_PROTOCOL_REVISION,
		m3_assignment_sha256: split.assignment_sha256,
		selected_dev_instance_ids: [...M6_CALIBRATION_INSTANCE_IDS],
		config_ids: [...CALIBRATION_CONFIG_IDS],
		replicates_per_configuration: 1,
		logical_runs: logicalRuns,
	};
	return verifyM6DevCalibrationBatch({ ...draft, calibration_batch_sha256: canonicalHash(draft) });
}

export function verifyM6DevCalibrationBatch(value: unknown): M6DevCalibrationBatch {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("M6 Dev calibration batch must be an object");
	}
	const batch = value as Record<string, unknown>;
	const expectedFields = [
		"calibration_batch_sha256",
		"config_ids",
		"logical_runs",
		"m3_assignment_sha256",
		"manifest_type",
		"protocol_revision",
		"replicates_per_configuration",
		"schema_version",
		"selected_dev_instance_ids",
	];
	if (JSON.stringify(Object.keys(batch).sort()) !== JSON.stringify(expectedFields)) {
		throw new Error("M6 Dev calibration batch fields must match the v2 contract");
	}
	if (
		batch.schema_version !== "v2" ||
		batch.manifest_type !== "m6_dev_calibration_batch" ||
		batch.protocol_revision !== M6_CALIBRATION_PROTOCOL_REVISION ||
		!isSha256(batch.m3_assignment_sha256) ||
		!isSha256(batch.calibration_batch_sha256) ||
		!equalsStringArray(batch.selected_dev_instance_ids, M6_CALIBRATION_INSTANCE_IDS) ||
		!equalsStringArray(batch.config_ids, CALIBRATION_CONFIG_IDS) ||
		batch.replicates_per_configuration !== 1 ||
		!Array.isArray(batch.logical_runs) ||
		batch.logical_runs.length !== M6_CALIBRATION_RUN_COUNT
	) {
		throw new Error("M6 Dev calibration batch is malformed");
	}
	const typed = batch as unknown as M6DevCalibrationBatch;
	if (
		new Set(typed.logical_runs.map((run) => run.run_id)).size !== M6_CALIBRATION_RUN_COUNT ||
		typed.logical_runs.some(
			(run, index) =>
				typeof run !== "object" ||
				run === null ||
				!isCalibrationInstanceId(run.instance_id) ||
				!isConfigurationId(run.config_id) ||
				run.replicate !== 1 ||
				run.run_id !== createRunId(run.instance_id, run.config_id) ||
				(index > 0 && typed.logical_runs[index - 1]!.run_id >= run.run_id),
		) ||
		canonicalHash(semanticSubset(typed)) !== typed.calibration_batch_sha256
	) {
		throw new Error("M6 Dev calibration batch binding is invalid");
	}
	for (const instanceId of M6_CALIBRATION_INSTANCE_IDS) {
		for (const configId of CALIBRATION_CONFIG_IDS) {
			if (typed.logical_runs.filter((run) => run.instance_id === instanceId && run.config_id === configId).length !== 1) {
				throw new Error("M6 Dev calibration batch must contain exactly one run per task and configuration");
			}
		}
	}
	return typed;
}
