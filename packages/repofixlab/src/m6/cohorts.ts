import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { M3SamplingMetadata, M3SplitManifest } from "../m3/split.ts";

export const M6_ABLATION_TASK_COUNT = 8;
export const M6_STABILITY_TASK_COUNT = 6;
export const M6_ABLATION_SELECTION_SEED = "repofixlab-m6-ablation-repository-stratified-v1";
export const M6_STABILITY_SELECTION_SEED = "repofixlab-m6-stability-repository-stratified-v1";
export const M6_COHORT_SELECTION_POLICY =
	"repository-stratified-minimum-representation-then-largest-remainder-v1" as const;

export interface M6EvaluationCohorts {
	readonly schema_version: "v1";
	readonly manifest_type: "m6_evaluation_cohorts";
	readonly m3_assignment_sha256: string;
	readonly sampling_metadata_sha256: string;
	readonly selection_policy: typeof M6_COHORT_SELECTION_POLICY;
	readonly main_test_instance_ids: readonly string[];
	readonly ablation_instance_ids: readonly string[];
	readonly ablation_selection_seed: typeof M6_ABLATION_SELECTION_SEED;
	readonly stability_instance_ids: readonly string[];
	readonly stability_selection_seed: typeof M6_STABILITY_SELECTION_SEED;
	readonly cohort_sha256: string;
}

interface RepositoryAllocation {
	readonly repo: string;
	readonly total: number;
	count: number;
	readonly remainder: number;
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

function isCanonicalInstanceIds(value: unknown, expectedCount: number): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length === expectedCount &&
		value.every((instanceId, index) => {
			const previous = value[index - 1];
			return (
				typeof instanceId === "string" &&
				/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(instanceId) &&
				(previous === undefined || previous < instanceId)
			);
		})
	);
}

function semanticSubset(value: M6EvaluationCohorts): Omit<M6EvaluationCohorts, "cohort_sha256"> {
	const { cohort_sha256: _cohortSha256, ...semantic } = value;
	return semantic;
}

function score(seed: string, record: M3SamplingMetadata): string {
	// The deterministic selection deliberately excludes issue size and gold-patch
	// metadata, so task membership is not selected from hidden task difficulty.
	return canonicalHash({ seed, repo: record.repo, instance_id: record.instance_id });
}

function allocationForTarget(groups: ReadonlyMap<string, readonly M3SamplingMetadata[]>, target: number): Map<string, number> {
	const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
	const total = orderedGroups.reduce((sum, [, records]) => sum + records.length, 0);
	if (!Number.isSafeInteger(target) || target < 1 || target > total) {
		throw new Error("M6 cohort target is outside the frozen Test population");
	}
	if (target < orderedGroups.length) {
		throw new Error("M6 cohort target cannot represent every Test repository");
	}
	const remainingTarget = target - orderedGroups.length;
	const remainingPopulation = total - orderedGroups.length;
	const allocations: RepositoryAllocation[] = orderedGroups.map(([repo, records]) => {
		const residual = records.length - 1;
		const scaled = residual * remainingTarget;
		return {
			repo,
			total: records.length,
			count: 1 + Math.floor(scaled / remainingPopulation),
			remainder: scaled % remainingPopulation,
		};
	});
	let unallocated = target - allocations.reduce((sum, allocation) => sum + allocation.count, 0);
	for (const allocation of [...allocations].sort((left, right) => {
		if (left.remainder !== right.remainder) return right.remainder - left.remainder;
		return left.repo.localeCompare(right.repo);
	})) {
		if (unallocated === 0) break;
		if (allocation.count >= allocation.total) continue;
		allocation.count += 1;
		unallocated -= 1;
	}
	if (unallocated !== 0) throw new Error("M6 cohort allocation cannot satisfy repository quotas");
	return new Map(allocations.map((allocation) => [allocation.repo, allocation.count]));
}

function selectRepositoryStratified(
	records: readonly M3SamplingMetadata[],
	target: number,
	seed: string,
): readonly string[] {
	const groups = new Map<string, M3SamplingMetadata[]>();
	for (const record of records) {
		const group = groups.get(record.repo);
		if (group === undefined) groups.set(record.repo, [record]);
		else group.push(record);
	}
	const allocation = allocationForTarget(groups, target);
	const selected: string[] = [];
	for (const [repo, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const count = allocation.get(repo);
		if (count === undefined) throw new Error("M6 cohort allocation is missing a Test repository");
		selected.push(
			...group
				.slice()
				.sort((left, right) => {
					const comparison = score(seed, left).localeCompare(score(seed, right));
					return comparison !== 0 ? comparison : left.instance_id.localeCompare(right.instance_id);
				})
				.slice(0, count)
				.map((record) => record.instance_id),
		);
	}
	return selected.sort();
}

function assertM3TestPopulation(
	split: M3SplitManifest,
	metadata: readonly M3SamplingMetadata[],
): readonly M3SamplingMetadata[] {
	const testInstanceIds = split.assignments.filter((assignment) => assignment.split === "test").map((assignment) => assignment.instance_id);
	if (!isCanonicalInstanceIds(testInstanceIds, 17)) throw new Error("M3 Test assignments are not a canonical 17-task set");
	const byInstanceId = new Map(metadata.map((record) => [record.instance_id, record]));
	if (byInstanceId.size !== metadata.length) throw new Error("M6 sampling metadata contains duplicate instance IDs");
	const testRecords = testInstanceIds.map((instanceId) => byInstanceId.get(instanceId));
	if (testRecords.some((record) => record === undefined)) throw new Error("M6 sampling metadata is missing a frozen Test task");
	return testRecords as M3SamplingMetadata[];
}

export function createM6EvaluationCohorts(
	split: M3SplitManifest,
	metadata: readonly M3SamplingMetadata[],
): M6EvaluationCohorts {
	const testRecords = assertM3TestPopulation(split, metadata);
	const mainTestInstanceIds = testRecords.map((record) => record.instance_id).sort();
	const draft: Omit<M6EvaluationCohorts, "cohort_sha256"> = {
		schema_version: "v1",
		manifest_type: "m6_evaluation_cohorts",
		m3_assignment_sha256: split.assignment_sha256,
		sampling_metadata_sha256: split.sampling_metadata_sha256,
		selection_policy: M6_COHORT_SELECTION_POLICY,
		main_test_instance_ids: mainTestInstanceIds,
		ablation_instance_ids: selectRepositoryStratified(testRecords, M6_ABLATION_TASK_COUNT, M6_ABLATION_SELECTION_SEED),
		ablation_selection_seed: M6_ABLATION_SELECTION_SEED,
		stability_instance_ids: selectRepositoryStratified(testRecords, M6_STABILITY_TASK_COUNT, M6_STABILITY_SELECTION_SEED),
		stability_selection_seed: M6_STABILITY_SELECTION_SEED,
	};
	return verifyM6EvaluationCohorts({ ...draft, cohort_sha256: canonicalHash(draft) });
}

export function verifyM6EvaluationCohorts(value: unknown): M6EvaluationCohorts {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("M6 evaluation cohort manifest must be an object");
	}
	const manifest = value as Record<string, unknown>;
	const expectedFields = [
		"ablation_instance_ids",
		"ablation_selection_seed",
		"cohort_sha256",
		"m3_assignment_sha256",
		"main_test_instance_ids",
		"manifest_type",
		"sampling_metadata_sha256",
		"schema_version",
		"selection_policy",
		"stability_instance_ids",
		"stability_selection_seed",
	];
	if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedFields)) {
		throw new Error("M6 evaluation cohort manifest fields must match the v1 contract");
	}
	if (
		manifest.schema_version !== "v1" ||
		manifest.manifest_type !== "m6_evaluation_cohorts" ||
		manifest.selection_policy !== M6_COHORT_SELECTION_POLICY ||
		manifest.ablation_selection_seed !== M6_ABLATION_SELECTION_SEED ||
		manifest.stability_selection_seed !== M6_STABILITY_SELECTION_SEED ||
		!isSha256(manifest.m3_assignment_sha256) ||
		!isSha256(manifest.sampling_metadata_sha256) ||
		!isSha256(manifest.cohort_sha256) ||
		!isCanonicalInstanceIds(manifest.main_test_instance_ids, 17) ||
		!isCanonicalInstanceIds(manifest.ablation_instance_ids, M6_ABLATION_TASK_COUNT) ||
		!isCanonicalInstanceIds(manifest.stability_instance_ids, M6_STABILITY_TASK_COUNT)
	) {
		throw new Error("M6 evaluation cohort manifest is malformed");
	}
	const typed = manifest as unknown as M6EvaluationCohorts;
	const main = new Set(typed.main_test_instance_ids);
	if (
		typed.ablation_instance_ids.some((instanceId) => !main.has(instanceId)) ||
		typed.stability_instance_ids.some((instanceId) => !main.has(instanceId)) ||
		canonicalHash(semanticSubset(typed)) !== typed.cohort_sha256
	) {
		throw new Error("M6 evaluation cohort manifest is not a sealed subset of the frozen Test split");
	}
	return typed;
}
