import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/schema-generator.ts";

export const M3_CANDIDATE_TASK_COUNT = 43;
export const M3_ELIGIBLE_TASK_COUNT = 26;
export const M3_SPLIT_SEED = "repofixlab-m3-repo-stratified-v1";
export const M3_SPLIT_TARGETS = {
	dev: 5,
	validation: 4,
	test: 17,
} as const;
export const M3_PREFLIGHT_ACCEPTANCE_CRITERION =
	"both pristine and adapted official-image modes execute; official grading reports base unresolved and gold resolved" as const;

export type M3SplitName = keyof typeof M3_SPLIT_TARGETS;

export interface M3SamplingMetadata {
	readonly schema_version: "v1";
	readonly record_type: "sampling_metadata";
	readonly dataset_revision: string;
	readonly instance_id: string;
	readonly repo: string;
	readonly issue_bytes: number;
	readonly gold_changed_lines: number;
	readonly parser_version: "unified-diff-v1";
}

export interface M3EligibilityManifest {
	readonly schema_version: "v1";
	readonly manifest_type: "m3_official_preflight_eligibility";
	readonly candidate_dataset_lock_id: string;
	readonly candidate_dataset_lock_seal_sha256: string;
	readonly candidate_sampling_metadata_sha256: string;
	readonly official_image_source_lock_id: string;
	readonly official_image_source_lock_seal_sha256: string;
	readonly preflight_summary_file_sha256: string;
	readonly preflight_record_sha256: string;
	readonly acceptance_criterion: typeof M3_PREFLIGHT_ACCEPTANCE_CRITERION;
	readonly candidate_task_count: typeof M3_CANDIDATE_TASK_COUNT;
	readonly eligible_task_count: typeof M3_ELIGIBLE_TASK_COUNT;
	readonly eligible_instance_ids: readonly string[];
	readonly eligibility_sha256: string;
}

export interface M3EligibilityManifestInput {
	readonly candidateDatasetLockId: string;
	readonly candidateDatasetLockSealSha256: string;
	readonly candidateSamplingMetadataSha256: string;
	readonly officialImageSourceLockId: string;
	readonly officialImageSourceLockSealSha256: string;
	readonly preflightSummaryFileSha256: string;
	readonly preflightRecordSha256: string;
	readonly eligibleInstanceIds: readonly string[];
}

export interface M3SplitAssignment {
	readonly instance_id: string;
	readonly split: M3SplitName;
}

export interface M3SplitManifest {
	readonly schema_version: "v1";
	readonly manifest_type: "m3_repo_stratified_split";
	readonly dataset_lock_id: string;
	readonly dataset_lock_seal_sha256: string;
	readonly eligibility_manifest_sha256: string;
	readonly sampling_metadata_sha256: string;
	readonly split_seed: typeof M3_SPLIT_SEED;
	readonly target_counts: typeof M3_SPLIT_TARGETS;
	readonly assignments: readonly M3SplitAssignment[];
	readonly assignment_sha256: string;
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

function isCanonicalTaskIdList(value: unknown, expectedCount: number): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length === expectedCount &&
		value.every((instanceId, index) => {
			const previous = value[index - 1];
			return (
				typeof instanceId === "string" &&
				/^[a-z0-9][a-z0-9_.-]{0,199}__[a-z0-9][a-z0-9_.-]{0,199}$/.test(instanceId) &&
				(previous === undefined || previous < instanceId)
			);
		})
	);
}

function assertRecord(value: unknown): asserts value is M3SamplingMetadata {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Sampling metadata record must be an object");
	}
	const record = value as Record<string, unknown>;
	const expected = [
		"dataset_revision",
		"gold_changed_lines",
		"instance_id",
		"issue_bytes",
		"parser_version",
		"record_type",
		"repo",
		"schema_version",
	];
	if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected)) {
		throw new Error("Sampling metadata fields must match the sealed v1 contract");
	}
	if (
		record.schema_version !== "v1" ||
		record.record_type !== "sampling_metadata" ||
		record.parser_version !== "unified-diff-v1" ||
		typeof record.dataset_revision !== "string" ||
		!record.dataset_revision ||
		typeof record.instance_id !== "string" ||
		!record.instance_id ||
		typeof record.repo !== "string" ||
		!record.repo ||
		!Number.isSafeInteger(record.issue_bytes) ||
		(record.issue_bytes as number) < 0 ||
		!Number.isSafeInteger(record.gold_changed_lines) ||
		(record.gold_changed_lines as number) < 0
	) {
		throw new Error("Sampling metadata record is malformed");
	}
}

export function parseM3SamplingMetadataJsonl(content: string, expectedDatasetRevision: string): M3SamplingMetadata[] {
	if (typeof content !== "string" || !content.endsWith("\n")) {
		throw new Error("Sampling metadata must be newline-terminated JSONL");
	}
	const lines = content.slice(0, -1).split("\n");
	if (lines.length === 0 || lines.some((line) => line.length === 0)) {
		throw new Error("Sampling metadata must contain non-empty JSONL records");
	}
	const records = lines.map((line, index) => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`Sampling metadata record ${index + 1} is not valid JSON`);
		}
		assertRecord(value);
		if (value.dataset_revision !== expectedDatasetRevision) {
			throw new Error("Sampling metadata dataset revision does not match DatasetLock");
		}
		return value;
	});
	const instanceIds = new Set(records.map((record) => record.instance_id));
	if (instanceIds.size !== records.length) {
		throw new Error("Sampling metadata contains duplicate instance IDs");
	}
	return records;
}

function eligibilitySemanticSubset(
	manifest: M3EligibilityManifest,
): Omit<M3EligibilityManifest, "eligibility_sha256"> {
	const { eligibility_sha256: _eligibilitySha256, ...semantic } = manifest;
	return semantic;
}

export function verifyM3EligibilityManifest(value: unknown): M3EligibilityManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("M3 eligibility manifest must be an object");
	}
	const manifest = value as Record<string, unknown>;
	const expectedFields = [
		"acceptance_criterion",
		"candidate_dataset_lock_id",
		"candidate_dataset_lock_seal_sha256",
		"candidate_sampling_metadata_sha256",
		"candidate_task_count",
		"eligibility_sha256",
		"eligible_instance_ids",
		"eligible_task_count",
		"manifest_type",
		"official_image_source_lock_id",
		"official_image_source_lock_seal_sha256",
		"preflight_record_sha256",
		"preflight_summary_file_sha256",
		"schema_version",
	];
	if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedFields)) {
		throw new Error("M3 eligibility manifest fields must match the v1 contract");
	}
	if (
		manifest.schema_version !== "v1" ||
		manifest.manifest_type !== "m3_official_preflight_eligibility" ||
		typeof manifest.candidate_dataset_lock_id !== "string" ||
		!manifest.candidate_dataset_lock_id ||
		!isSha256(manifest.candidate_dataset_lock_seal_sha256) ||
		!isSha256(manifest.candidate_sampling_metadata_sha256) ||
		typeof manifest.official_image_source_lock_id !== "string" ||
		!manifest.official_image_source_lock_id ||
		!isSha256(manifest.official_image_source_lock_seal_sha256) ||
		!isSha256(manifest.preflight_summary_file_sha256) ||
		!isSha256(manifest.preflight_record_sha256) ||
		manifest.acceptance_criterion !== M3_PREFLIGHT_ACCEPTANCE_CRITERION ||
		manifest.candidate_task_count !== M3_CANDIDATE_TASK_COUNT ||
		manifest.eligible_task_count !== M3_ELIGIBLE_TASK_COUNT ||
		!isCanonicalTaskIdList(manifest.eligible_instance_ids, M3_ELIGIBLE_TASK_COUNT) ||
		!isSha256(manifest.eligibility_sha256)
	) {
		throw new Error("M3 eligibility manifest is malformed");
	}
	const typed = manifest as unknown as M3EligibilityManifest;
	if (canonicalHash(eligibilitySemanticSubset(typed)) !== typed.eligibility_sha256) {
		throw new Error("M3 eligibility manifest SHA-256 does not match its canonical content");
	}
	return typed;
}

export function createM3EligibilityManifest(input: M3EligibilityManifestInput): M3EligibilityManifest {
	const eligibleInstanceIds = [...input.eligibleInstanceIds];
	if (!isCanonicalTaskIdList(eligibleInstanceIds, M3_ELIGIBLE_TASK_COUNT)) {
		throw new Error("M3 eligibility instance IDs must be canonical, unique, and complete");
	}
	const draft: Omit<M3EligibilityManifest, "eligibility_sha256"> = {
		schema_version: "v1",
		manifest_type: "m3_official_preflight_eligibility",
		candidate_dataset_lock_id: input.candidateDatasetLockId,
		candidate_dataset_lock_seal_sha256: input.candidateDatasetLockSealSha256,
		candidate_sampling_metadata_sha256: input.candidateSamplingMetadataSha256,
		official_image_source_lock_id: input.officialImageSourceLockId,
		official_image_source_lock_seal_sha256: input.officialImageSourceLockSealSha256,
		preflight_summary_file_sha256: input.preflightSummaryFileSha256,
		preflight_record_sha256: input.preflightRecordSha256,
		acceptance_criterion: M3_PREFLIGHT_ACCEPTANCE_CRITERION,
		candidate_task_count: M3_CANDIDATE_TASK_COUNT,
		eligible_task_count: M3_ELIGIBLE_TASK_COUNT,
		eligible_instance_ids: eligibleInstanceIds,
	};
	return verifyM3EligibilityManifest({ ...draft, eligibility_sha256: canonicalHash(draft) });
}

function allocationForTarget(groups: ReadonlyMap<string, readonly M3SamplingMetadata[]>, target: number): Map<string, number> {
	const total = [...groups.values()].reduce((sum, records) => sum + records.length, 0);
	if (!Number.isSafeInteger(target) || target < 0 || target > total) {
		throw new Error("Split target is outside the available task population");
	}
	const allocations: RepositoryAllocation[] = [...groups.entries()].map(([repo, records]) => {
		const scaled = records.length * target;
		return {
			repo,
			total: records.length,
			count: Math.floor(scaled / total),
			remainder: scaled % total,
		};
	});
	let remaining = target - allocations.reduce((sum, allocation) => sum + allocation.count, 0);
	for (const allocation of [...allocations].sort((left, right) => {
		if (left.remainder !== right.remainder) return right.remainder - left.remainder;
		return left.repo < right.repo ? -1 : left.repo > right.repo ? 1 : 0;
	})) {
		if (remaining === 0) break;
		if (allocation.count >= allocation.total) continue;
		allocation.count += 1;
		remaining -= 1;
	}
	if (remaining !== 0) throw new Error("Unable to allocate a repository-stratified split");
	return new Map(allocations.map((allocation) => [allocation.repo, allocation.count]));
}

function score(record: M3SamplingMetadata): string {
	return canonicalHash({
		seed: M3_SPLIT_SEED,
		repo: record.repo,
		instance_id: record.instance_id,
		issue_bytes: record.issue_bytes,
		gold_changed_lines: record.gold_changed_lines,
		parser_version: record.parser_version,
	});
}

function assignmentHash(assignments: readonly M3SplitAssignment[]): string {
	return canonicalHash(assignments);
}

function assertAssignment(value: unknown): asserts value is M3SplitAssignment {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("M3 split assignment must be an object");
	}
	const assignment = value as Record<string, unknown>;
	if (
		JSON.stringify(Object.keys(assignment).sort()) !== JSON.stringify(["instance_id", "split"]) ||
		typeof assignment.instance_id !== "string" ||
		!assignment.instance_id ||
		(assignment.split !== "dev" && assignment.split !== "validation" && assignment.split !== "test")
	) {
		throw new Error("M3 split assignment is malformed");
	}
}

export function verifyM3RepoStratifiedSplit(
	value: unknown,
	eligibilityValue?: unknown,
): M3SplitManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("M3 split manifest must be an object");
	}
	const manifest = value as Record<string, unknown>;
	const expectedFields = [
		"assignment_sha256",
		"assignments",
		"dataset_lock_id",
		"dataset_lock_seal_sha256",
		"eligibility_manifest_sha256",
		"manifest_type",
		"sampling_metadata_sha256",
		"schema_version",
		"split_seed",
		"target_counts",
	];
	if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedFields)) {
		throw new Error("M3 split manifest fields must match the v1 contract");
	}
	if (
		manifest.schema_version !== "v1" ||
		manifest.manifest_type !== "m3_repo_stratified_split" ||
		manifest.split_seed !== M3_SPLIT_SEED ||
		typeof manifest.dataset_lock_id !== "string" ||
		!manifest.dataset_lock_id ||
		!isSha256(manifest.dataset_lock_seal_sha256) ||
		!isSha256(manifest.eligibility_manifest_sha256) ||
		!isSha256(manifest.sampling_metadata_sha256) ||
		!isSha256(manifest.assignment_sha256) ||
		stableStringify(manifest.target_counts) !== stableStringify(M3_SPLIT_TARGETS) ||
		!Array.isArray(manifest.assignments)
	) {
		throw new Error("M3 split manifest is malformed");
	}
	for (const assignment of manifest.assignments) assertAssignment(assignment);
	const assignments = manifest.assignments as M3SplitAssignment[];
	if (
		assignments.length !== M3_ELIGIBLE_TASK_COUNT ||
		new Set(assignments.map((assignment) => assignment.instance_id)).size !== assignments.length ||
		assignments.some((assignment, index) => {
			const previous = assignments[index - 1];
			return previous !== undefined && previous.instance_id >= assignment.instance_id;
		}) ||
		assignmentHash(assignments) !== manifest.assignment_sha256
	) {
		throw new Error("M3 split assignments are not a canonical frozen 26-task set");
	}
	const observed = assignments.reduce<Record<M3SplitName, number>>(
		(counts, assignment) => ({ ...counts, [assignment.split]: counts[assignment.split] + 1 }),
		{ dev: 0, validation: 0, test: 0 },
	);
	if (stableStringify(observed) !== stableStringify(M3_SPLIT_TARGETS)) {
		throw new Error("M3 split assignments do not satisfy 5/4/17 targets");
	}
	const typed = manifest as unknown as M3SplitManifest;
	if (eligibilityValue !== undefined) {
		const eligibility = verifyM3EligibilityManifest(eligibilityValue);
		if (
			typed.eligibility_manifest_sha256 !== eligibility.eligibility_sha256 ||
			JSON.stringify(assignments.map((assignment) => assignment.instance_id)) !==
				JSON.stringify(eligibility.eligible_instance_ids)
		) {
			throw new Error("M3 split assignments do not match the sealed eligibility manifest");
		}
	}
	return typed;
}

/**
 * Uses the entire sealed control-plane sampling source but selects only the
 * M3 preflight-eligible task IDs. The returned manifest is safe to publish:
 * it contains task IDs and split labels, not control-plane sampling values.
 */
export function createM3RepoStratifiedSplit(
	records: readonly M3SamplingMetadata[],
	input: {
		readonly datasetLockId: string;
		readonly datasetLockSealSha256: string;
		readonly samplingMetadataContent: string;
		readonly eligibilityManifest: unknown;
	},
): M3SplitManifest {
	const eligibility = verifyM3EligibilityManifest(input.eligibilityManifest);
	if (records.length !== eligibility.candidate_task_count) {
		throw new Error(`M3 requires exactly ${eligibility.candidate_task_count} sealed candidate sampling records`);
	}
	if (!isSha256(input.datasetLockSealSha256)) {
		throw new Error("DatasetLock seal SHA-256 is malformed");
	}
	if (!input.datasetLockId) throw new Error("DatasetLock ID is required");
	if (input.datasetLockId !== eligibility.candidate_dataset_lock_id) {
		throw new Error("DatasetLock ID does not match the sealed eligibility manifest");
	}
	if (input.datasetLockSealSha256 !== eligibility.candidate_dataset_lock_seal_sha256) {
		throw new Error("DatasetLock seal SHA-256 does not match the sealed eligibility manifest");
	}
	const samplingMetadataSha256 = createHash("sha256").update(input.samplingMetadataContent, "utf8").digest("hex");
	if (samplingMetadataSha256 !== eligibility.candidate_sampling_metadata_sha256) {
		throw new Error("Sampling metadata SHA-256 does not match the sealed eligibility manifest");
	}
	const recordsById = new Map(records.map((record) => [record.instance_id, record]));
	const eligibleRecords = eligibility.eligible_instance_ids.map((instanceId) => recordsById.get(instanceId));
	if (eligibleRecords.some((record) => record === undefined)) {
		throw new Error("Sealed eligibility manifest references a task absent from sampling metadata");
	}

	const groups = new Map<string, M3SamplingMetadata[]>();
	for (const record of eligibleRecords as M3SamplingMetadata[]) {
		const group = groups.get(record.repo);
		if (group === undefined) groups.set(record.repo, [record]);
		else group.push(record);
	}
	const devCounts = allocationForTarget(groups, M3_SPLIT_TARGETS.dev);
	const remainingGroups = new Map(
		[...groups.entries()].map(([repo, group]) => [repo, group.slice(devCounts.get(repo) ?? 0)]),
	);
	const validationCounts = allocationForTarget(remainingGroups, M3_SPLIT_TARGETS.validation);

	const assignments: M3SplitAssignment[] = [];
	for (const [repo, group] of [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
		const ranked = [...group].sort((left, right) => {
			const leftScore = score(left);
			const rightScore = score(right);
			return leftScore < rightScore ? -1 : leftScore > rightScore ? 1 : left.instance_id.localeCompare(right.instance_id);
		});
		const devCount = devCounts.get(repo) ?? 0;
		const validationCount = validationCounts.get(repo) ?? 0;
		for (const [index, record] of ranked.entries()) {
			assignments.push({
				instance_id: record.instance_id,
				split: index < devCount ? "dev" : index < devCount + validationCount ? "validation" : "test",
			});
		}
	}
	assignments.sort((left, right) => left.instance_id.localeCompare(right.instance_id));
	const observed = assignments.reduce<Record<M3SplitName, number>>(
		(counts, assignment) => ({ ...counts, [assignment.split]: counts[assignment.split] + 1 }),
		{ dev: 0, validation: 0, test: 0 },
	);
	if (stableStringify(observed) !== stableStringify(M3_SPLIT_TARGETS)) {
		throw new Error("Repository-stratified allocation does not satisfy M3 split targets");
	}
	return {
		schema_version: "v1",
		manifest_type: "m3_repo_stratified_split",
		dataset_lock_id: input.datasetLockId,
		dataset_lock_seal_sha256: input.datasetLockSealSha256,
		eligibility_manifest_sha256: eligibility.eligibility_sha256,
		sampling_metadata_sha256: samplingMetadataSha256,
		split_seed: M3_SPLIT_SEED,
		target_counts: M3_SPLIT_TARGETS,
		assignments,
		assignment_sha256: assignmentHash(assignments),
	};
}
