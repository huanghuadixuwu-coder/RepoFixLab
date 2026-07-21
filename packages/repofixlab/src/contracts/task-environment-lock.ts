import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { verifyHarnessEquivalenceReport } from "./harness-equivalence.ts";
import { verifyOfficialImageSourceLock } from "./official-image-source-lock.ts";
import { stableStringify } from "./schema-generator.ts";
import {
	verifyTaskEnvironmentCandidate,
	verifyTaskRoleFactoryProbeReport,
	verifyTaskRoleFactoryProbeRequest,
} from "./task-role-factory-probe.ts";
import {
	DATASET_PREPARER_SELF_CHECK_CONSTANTS,
	type DatasetLock,
	DatasetLockSchema,
	type HarnessEquivalenceReport,
	type OfficialImageSourceLock,
	OfficialImageSourceLockSchema,
	SWE_BENCH_HARNESS_REVISION,
	type TaskEnvironmentCandidate,
	type TaskEnvironmentLock,
	TaskEnvironmentLockSchema,
	type TaskRoleFactoryProbeReport,
	type TaskRoleFactoryProbeRequest,
} from "./v1.ts";

export interface TaskEnvironmentEvidenceInput {
	readonly dataset_lock_json: string;
	readonly official_image_source_lock_json: string;
	readonly candidate: unknown;
	readonly factory_probe_request: unknown;
	readonly factory_probe_report: unknown;
	readonly harness_equivalence_report: unknown;
}

export interface TaskEnvironmentLockBuildInput extends TaskEnvironmentEvidenceInput {
	readonly created_at: string;
}

interface VerifiedTaskEnvironmentEvidence {
	readonly datasetLock: DatasetLock;
	readonly datasetLockFileSha256: string;
	readonly officialImageSourceLock: OfficialImageSourceLock;
	readonly officialImageSourceLockFileSha256: string;
	readonly candidate: TaskEnvironmentCandidate;
	readonly factoryProbeRequest: TaskRoleFactoryProbeRequest;
	readonly factoryProbeReport: TaskRoleFactoryProbeReport;
	readonly harnessEquivalenceReport: HarnessEquivalenceReport;
}

export interface TaskEnvironmentVerificationEvidence {
	readonly schema_version: "v1";
	readonly evidence_type: "task_environment_verification";
	readonly dataset_lock_id: string;
	readonly dataset_lock_file_sha256: string;
	readonly dataset_lock_seal_sha256: string;
	readonly official_image_source_lock_id: string;
	readonly official_image_source_lock_file_sha256: string;
	readonly official_image_source_lock_seal_sha256: string;
	readonly candidate_id: string;
	readonly candidate_sha256: string;
	readonly factory_probe_request_sha256: string;
	readonly factory_probe_report_sha256: string;
	readonly harness_equivalence_report_sha256: string;
}

export interface TaskEnvironmentFilesystemProfileAggregate {
	readonly schema_version: "v1";
	readonly aggregate_type: "task_environment_filesystem_profiles";
	readonly worker: TaskEnvironmentCandidate["roles"]["worker"]["filesystem_profile"];
	readonly evaluator: TaskEnvironmentCandidate["roles"]["evaluator"]["filesystem_profile"];
}

type TaskEnvironmentLockSemanticSubset = Omit<
	TaskEnvironmentLock,
	"lock_id" | "seal_sha256" | "created_at" | "verification"
> & {
	readonly verification: Omit<TaskEnvironmentLock["verification"], "completed_at">;
};

const datasetLockValidator = Compile(DatasetLockSchema);
const officialImageSourceLockValidator = Compile(OfficialImageSourceLockSchema);
const taskEnvironmentLockValidator = Compile(TaskEnvironmentLockSchema);

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

/** Hash the exact UTF-8 file text without whitespace or newline normalization. */
export function taskEnvironmentEvidenceFileHash(content: string): string {
	if (typeof content !== "string") {
		throw new Error("Task environment evidence file content must be text");
	}
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function parseEvidenceJson(content: string, label: string): unknown {
	if (typeof content !== "string") {
		throw new Error(`${label} evidence must be supplied as raw JSON text`);
	}
	try {
		return JSON.parse(content);
	} catch {
		throw new Error(`${label} evidence is not valid JSON text`);
	}
}

function isTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareDatasetFiles(left: DatasetLock["files"][number], right: DatasetLock["files"][number]): number {
	const scopeOrder = compareText(left.scope, right.scope);
	return scopeOrder === 0 ? compareText(left.path, right.path) : scopeOrder;
}

export function datasetLockAggregateHash(files: DatasetLock["files"]): string {
	return canonicalHash(files);
}

export function datasetLockReadyMarkerHash(value: DatasetLock): string {
	return canonicalHash({
		schema_version: "v1",
		marker_type: "dataset_generation",
		state: "ready",
		dataset: value.dataset,
		generation_id: value.generation_id,
		record_count: value.record_count,
		aggregate_sha256: value.aggregate_sha256,
		source_sha256: DATASET_PREPARER_SELF_CHECK_CONSTANTS.sourceSha256,
		written_at: value.ready.written_at,
	});
}

export function datasetLockSealMarkerHash(value: DatasetLock): string {
	return canonicalHash({
		schema_version: "v1",
		marker_type: "dataset_generation",
		state: "sealed",
		dataset: value.dataset,
		generation_id: value.generation_id,
		record_count: value.record_count,
		aggregate_sha256: value.aggregate_sha256,
		ready_sha256: datasetLockReadyMarkerHash(value),
		written_at: value.seal.written_at,
	});
}

export function verifyDatasetLockForTaskEnvironment(value: unknown): DatasetLock {
	if (!datasetLockValidator.Check(value)) {
		throw new Error("Dataset lock does not satisfy the strict v1 schema");
	}
	if (
		value.dataset.name !== DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetName ||
		value.dataset.revision !== DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision ||
		value.record_count !== DATASET_PREPARER_SELF_CHECK_CONSTANTS.expectedRecordCount
	) {
		throw new Error("Dataset lock does not bind the frozen dataset protocol");
	}
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.generation_id)) {
		throw new Error("Dataset lock generation ID is invalid");
	}
	const expectedVolumes = {
		public: `dataset-public-${value.generation_id}`,
		control: `dataset-control-${value.generation_id}`,
		private: `dataset-private-${value.generation_id}`,
	};
	if (stableStringify(value.volumes) !== stableStringify(expectedVolumes)) {
		throw new Error("Dataset lock volumes do not bind its generation ID");
	}
	const seenFiles = new Set<string>();
	for (const [index, file] of value.files.entries()) {
		const key = `${file.scope}\0${file.path}`;
		if (seenFiles.has(key)) {
			throw new Error("Dataset lock contains duplicate file descriptors");
		}
		seenFiles.add(key);
		const previous = value.files[index - 1];
		if (previous !== undefined && compareDatasetFiles(previous, file) >= 0) {
			throw new Error("Dataset lock file descriptors are not in canonical order");
		}
	}
	if (value.aggregate_sha256 !== datasetLockAggregateHash(value.files)) {
		throw new Error("Dataset lock aggregate SHA-256 does not match its file descriptors");
	}
	const expectedLockId = `dataset-v1-${value.generation_id}-${value.aggregate_sha256.slice(0, 16)}`;
	if (value.lock_id !== expectedLockId) {
		throw new Error("Dataset lock ID does not match its generation and aggregate");
	}
	if (
		!isTimestamp(value.created_at) ||
		!isTimestamp(value.ready.written_at) ||
		!isTimestamp(value.seal.written_at) ||
		value.ready.written_at !== value.created_at ||
		value.seal.written_at !== value.created_at
	) {
		throw new Error("Dataset lock timestamps are invalid or inconsistent");
	}
	if (value.ready.sha256 !== datasetLockReadyMarkerHash(value)) {
		throw new Error("Dataset lock READY marker SHA-256 does not match its canonical content");
	}
	if (value.seal.sha256 !== datasetLockSealMarkerHash(value)) {
		throw new Error("Dataset lock SEAL marker SHA-256 does not match its canonical content");
	}
	return value;
}

function verifyOfficialImageSourceLockForEnvironment(value: unknown, instanceId: string): OfficialImageSourceLock {
	if (!officialImageSourceLockValidator.Check(value)) {
		throw new Error("Official image source lock does not satisfy the strict v1 schema");
	}
	const image = value.images.find((candidate) => candidate.image_key === instanceId);
	if (image === undefined) {
		throw new Error("Official image source lock is missing the candidate task image");
	}
	return verifyOfficialImageSourceLock(value, {
		datasetRevision: value.dataset_revision,
		harnessRevision: value.harness_revision,
		images: value.images.map((candidate) => ({
			imageKey: candidate.image_key,
			requestedReference: candidate.requested_reference,
			repositoryDigest: candidate.repository_digest,
			localImageId: candidate.local_image_id,
			platform: candidate.platform,
			registryResponseSha256: candidate.registry_response_sha256,
		})),
	});
}

function verifyEvidence(input: TaskEnvironmentEvidenceInput): VerifiedTaskEnvironmentEvidence {
	const datasetLockFileSha256 = taskEnvironmentEvidenceFileHash(input.dataset_lock_json);
	const datasetLock = verifyDatasetLockForTaskEnvironment(parseEvidenceJson(input.dataset_lock_json, "Dataset lock"));
	const candidate = verifyTaskEnvironmentCandidate(input.candidate);
	const officialImageSourceLockFileSha256 = taskEnvironmentEvidenceFileHash(input.official_image_source_lock_json);
	const officialImageSourceLock = verifyOfficialImageSourceLockForEnvironment(
		parseEvidenceJson(input.official_image_source_lock_json, "Official image source lock"),
		candidate.instance_id,
	);
	const factoryProbeRequest = verifyTaskRoleFactoryProbeRequest(input.factory_probe_request);
	const factoryProbeReport = verifyTaskRoleFactoryProbeReport(
		input.factory_probe_report,
		candidate,
		factoryProbeRequest,
	);
	const harnessEquivalenceReport = verifyHarnessEquivalenceReport(input.harness_equivalence_report);

	if (factoryProbeReport.status !== "pass") {
		throw new Error("Task environment lock requires a passing factory probe");
	}
	if (harnessEquivalenceReport.status !== "pass") {
		throw new Error("Task environment lock requires passing harness equivalence");
	}
	const officialImage = officialImageSourceLock.images.find((image) => image.image_key === candidate.instance_id);
	if (officialImage === undefined) {
		throw new Error("Official image source lock is missing the candidate task image");
	}
	if (
		datasetLock.dataset.revision !== officialImageSourceLock.dataset_revision ||
		officialImageSourceLock.harness_revision !== SWE_BENCH_HARNESS_REVISION ||
		officialImageSourceLock.harness_revision !== harnessEquivalenceReport.harness_revision
	) {
		throw new Error("Task environment upstream revisions do not match");
	}
	if (
		candidate.dataset_lock.lock_id !== datasetLock.lock_id ||
		candidate.dataset_lock.lock_sha256 !== datasetLockFileSha256 ||
		candidate.official_image_source_lock.lock_id !== officialImageSourceLock.lock_id ||
		candidate.official_image_source_lock.lock_sha256 !== officialImageSourceLockFileSha256
	) {
		throw new Error("Task environment candidate lock bindings do not match");
	}
	if (
		candidate.instance_id !== officialImage.image_key ||
		candidate.instance_id !== harnessEquivalenceReport.instance_id ||
		candidate.base_commit !== harnessEquivalenceReport.base_commit ||
		candidate.adapter_sha256 !== harnessEquivalenceReport.adapter_sha256
	) {
		throw new Error("Task environment instance or adapter bindings do not match");
	}
	const workerResource = candidate.roles.worker.resource_profile;
	const evaluatorResource = candidate.roles.evaluator.resource_profile;
	if (
		workerResource.nano_cpus !== evaluatorResource.nano_cpus ||
		workerResource.memory_bytes !== evaluatorResource.memory_bytes ||
		workerResource.pids_limit !== evaluatorResource.pids_limit
	) {
		throw new Error("Task environment roles must share identical CPU, memory, and pids limits");
	}
	return {
		datasetLock,
		datasetLockFileSha256,
		officialImageSourceLock,
		officialImageSourceLockFileSha256,
		candidate,
		factoryProbeRequest,
		factoryProbeReport,
		harnessEquivalenceReport,
	};
}

export function taskEnvironmentFilesystemProfileAggregate(
	candidateValue: unknown,
): TaskEnvironmentFilesystemProfileAggregate {
	const candidate = verifyTaskEnvironmentCandidate(candidateValue);
	return {
		schema_version: "v1",
		aggregate_type: "task_environment_filesystem_profiles",
		worker: candidate.roles.worker.filesystem_profile,
		evaluator: candidate.roles.evaluator.filesystem_profile,
	};
}

/**
 * Hash both complete, role-labelled filesystem profiles as one canonical object.
 * The environment lock never selects either role's profile hash as a proxy.
 */
export function taskEnvironmentFilesystemProfileAggregateHash(candidateValue: unknown): string {
	return canonicalHash(taskEnvironmentFilesystemProfileAggregate(candidateValue));
}

function verificationEvidenceFromVerified(
	evidence: VerifiedTaskEnvironmentEvidence,
): TaskEnvironmentVerificationEvidence {
	return {
		schema_version: "v1",
		evidence_type: "task_environment_verification",
		dataset_lock_id: evidence.datasetLock.lock_id,
		dataset_lock_file_sha256: evidence.datasetLockFileSha256,
		dataset_lock_seal_sha256: evidence.datasetLock.seal.sha256,
		official_image_source_lock_id: evidence.officialImageSourceLock.lock_id,
		official_image_source_lock_file_sha256: evidence.officialImageSourceLockFileSha256,
		official_image_source_lock_seal_sha256: evidence.officialImageSourceLock.seal_sha256,
		candidate_id: evidence.candidate.candidate_id,
		candidate_sha256: evidence.candidate.candidate_sha256,
		factory_probe_request_sha256: evidence.factoryProbeRequest.request_sha256,
		factory_probe_report_sha256: evidence.factoryProbeReport.report_sha256,
		harness_equivalence_report_sha256: evidence.harnessEquivalenceReport.report_sha256,
	};
}

export function taskEnvironmentVerificationEvidence(
	input: TaskEnvironmentEvidenceInput,
): TaskEnvironmentVerificationEvidence {
	return verificationEvidenceFromVerified(verifyEvidence(input));
}

export function taskEnvironmentVerificationEvidenceHash(input: TaskEnvironmentEvidenceInput): string {
	return canonicalHash(taskEnvironmentVerificationEvidence(input));
}

function lockSemanticSubset(value: TaskEnvironmentLock): TaskEnvironmentLockSemanticSubset {
	const { lock_id: _lockId, seal_sha256: _sealSha256, created_at: _createdAt, verification, ...lock } = value;
	const { completed_at: _completedAt, ...stableVerification } = verification;
	return { ...lock, verification: stableVerification };
}

/**
 * Seal the stable environment semantics. Publication timestamps, the derived
 * lock ID, and the seal field itself are excluded; all evidence bindings remain.
 */
export function taskEnvironmentLockSealHash(value: TaskEnvironmentLock): string {
	return canonicalHash(lockSemanticSubset(value));
}

export function taskEnvironmentLockInstancePrefix(instanceId: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(instanceId)) {
		throw new Error("Task environment lock instance ID is invalid");
	}
	const separator = instanceId.indexOf("__");
	if (separator < 1 || separator === instanceId.length - 2) {
		throw new Error("Task environment lock instance ID is not repository-qualified");
	}
	const repository = instanceId.slice(0, separator);
	const task = instanceId.slice(separator + 2);
	return task.startsWith(`${repository}-`) ? task : `${repository}-${task}`;
}

export function taskEnvironmentLockId(instanceId: string, sealSha256: string): string {
	if (!/^[a-f0-9]{64}$/.test(sealSha256)) throw new Error("Task environment lock seal is invalid");
	return `task-environment-v1-${taskEnvironmentLockInstancePrefix(instanceId)}-${sealSha256.slice(0, 16)}`;
}

/** Hash the complete serialized contract, including publication timestamps. */
export function taskEnvironmentLockFileHash(value: TaskEnvironmentLock): string {
	return canonicalHash(value);
}

function buildLock(evidence: VerifiedTaskEnvironmentEvidence, createdAt: string): TaskEnvironmentLock {
	if (!isTimestamp(createdAt)) {
		throw new Error("Task environment lock created_at must be a valid timestamp");
	}
	const candidate = evidence.candidate;
	const officialImage = evidence.officialImageSourceLock.images.find((image) => image.image_key === candidate.instance_id);
	if (officialImage === undefined) {
		throw new Error("Official image source lock is missing the candidate task image");
	}
	const evidenceHash = canonicalHash(verificationEvidenceFromVerified(evidence));
	const draft: TaskEnvironmentLock = {
		schema_version: "v1",
		lock_type: "task_environment",
		lock_id: "pending",
		instance_id: candidate.instance_id,
		candidate_id: candidate.candidate_id,
		candidate_sha256: candidate.candidate_sha256,
		dataset_lock_id: evidence.datasetLock.lock_id,
		official_image_source_lock_id: evidence.officialImageSourceLock.lock_id,
		source_image: {
			repository_digest: officialImage.repository_digest,
			local_image_id: officialImage.local_image_id,
			platform: officialImage.platform,
		},
		worker_image: { ...candidate.roles.worker.image },
		evaluator_image: { ...candidate.roles.evaluator.image },
		resource_profile: {
			cpu_count: candidate.roles.worker.resource_profile.nano_cpus / 1_000_000_000,
			memory_bytes: candidate.roles.worker.resource_profile.memory_bytes,
			pids_limit: candidate.roles.worker.resource_profile.pids_limit,
			network_mode: candidate.roles.worker.security_profile.network_mode,
			read_only_root_filesystem: candidate.roles.worker.security_profile.read_only_root_filesystem,
		},
		filesystem_profile_sha256: taskEnvironmentFilesystemProfileAggregateHash(candidate),
		sanitizer_sha256: candidate.sanitizer_sha256,
		adapter_sha256: candidate.adapter_sha256,
		verification: {
			factory_probe_passed: true,
			factory_probe_report_sha256: evidence.factoryProbeReport.report_sha256,
			equivalence_passed: true,
			security_profile_passed: true,
			evidence_sha256: evidenceHash,
			completed_at: createdAt,
		},
		seal_sha256: "0".repeat(64),
		created_at: createdAt,
	};
	const sealSha256 = taskEnvironmentLockSealHash(draft);
	return {
		...draft,
		lock_id: taskEnvironmentLockId(candidate.instance_id, sealSha256),
		seal_sha256: sealSha256,
	};
}

export function createTaskEnvironmentLock(input: TaskEnvironmentLockBuildInput): TaskEnvironmentLock {
	const lock = buildLock(verifyEvidence(input), input.created_at);
	if (!taskEnvironmentLockValidator.Check(lock)) {
		throw new Error("Constructed task environment lock violates the v1 schema");
	}
	return lock;
}

export function verifyTaskEnvironmentLock(value: unknown, input: TaskEnvironmentEvidenceInput): TaskEnvironmentLock {
	if (!taskEnvironmentLockValidator.Check(value)) {
		throw new Error("Task environment lock does not satisfy the strict v1 schema");
	}
	if (
		!isTimestamp(value.created_at) ||
		!isTimestamp(value.verification.completed_at) ||
		value.created_at !== value.verification.completed_at
	) {
		throw new Error("Task environment lock timestamps are invalid or inconsistent");
	}
	const expected = buildLock(verifyEvidence(input), value.created_at);
	if (stableStringify(value) !== stableStringify(expected)) {
		throw new Error("Task environment lock does not match its canonical evidence bindings");
	}
	return value;
}
