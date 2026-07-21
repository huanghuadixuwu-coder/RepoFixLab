import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { verifyOfficialImageSourceLockSelfContained } from "./official-image-source-lock.ts";
import { stableStringify } from "./schema-generator.ts";
import {
	taskEnvironmentEvidenceFileHash,
	taskEnvironmentFilesystemProfileAggregateHash,
	taskEnvironmentLockId,
	taskEnvironmentLockSealHash,
	verifyDatasetLockForTaskEnvironment,
} from "./task-environment-lock.ts";
import {
	createTaskRoleFactoryProbeRequest,
	verifyTaskEnvironmentCandidate,
	verifyTaskRoleFactoryProbeReport,
} from "./task-role-factory-probe.ts";
import {
	type DatasetLock,
	type OfficialImageSourceLock,
	type TaskEnvironmentCandidate,
	type TaskEnvironmentLock,
	TaskEnvironmentLockSchema,
	type TaskRoleFactoryProbeReport,
} from "./v1.ts";

const M6_ELIGIBLE_TASK_COUNT = 26;

type JsonObject = Record<string, unknown>;

interface M3PreflightTask {
	readonly instance_id: string;
	readonly base_commit: string;
	readonly repo: string;
	readonly private_task_sha256: string;
	readonly source_image_id: string;
	readonly adapted_image_reference: string;
	readonly adapted_image_id: string;
}

interface M3OfficialGrade {
	readonly resolved: boolean;
}

interface M3PreflightProbe {
	readonly harness_mode: "pristine" | "adapted";
	readonly probe_kind: "base" | "gold";
	readonly resolved: boolean;
	readonly official_grading: M3OfficialGrade;
}

interface M3PreflightTaskReport {
	readonly instance_id: string;
	readonly base_commit: string;
	readonly source_image_id: string;
	readonly adapted_image_id: string;
	readonly passed: true;
	readonly probes: readonly M3PreflightProbe[];
}

interface VerifiedM6PreflightEvidence {
	readonly requestSha256: string;
	readonly requestFileSha256: string;
	readonly recordFileSha256: string;
	readonly taskReportSha256: string;
}

interface VerifiedM6TaskEnvironmentEvidence {
	readonly datasetLock: DatasetLock;
	readonly datasetLockFileSha256: string;
	readonly officialImageSourceLock: OfficialImageSourceLock;
	readonly officialImageSourceLockFileSha256: string;
	readonly candidate: TaskEnvironmentCandidate;
	readonly candidateFileSha256: string;
	readonly factoryProbeReport: TaskRoleFactoryProbeReport;
	readonly factoryProbeReportFileSha256: string;
	readonly preflight: VerifiedM6PreflightEvidence;
}

export interface M6TaskEnvironmentLockBuildInput {
	readonly created_at: string;
	readonly dataset_lock_json: string;
	readonly official_image_source_lock_json: string;
	readonly candidate_json: string;
	readonly factory_probe_report_json: string;
	readonly m3_preflight_request_json: string;
	readonly m3_preflight_record_json: string;
}

export interface M6TaskEnvironmentVerificationEvidence {
	readonly schema_version: "v1";
	readonly evidence_type: "m6_task_environment_verification";
	readonly dataset_lock_id: string;
	readonly dataset_lock_file_sha256: string;
	readonly dataset_lock_seal_sha256: string;
	readonly official_image_source_lock_id: string;
	readonly official_image_source_lock_file_sha256: string;
	readonly official_image_source_lock_seal_sha256: string;
	readonly candidate_id: string;
	readonly candidate_sha256: string;
	readonly candidate_file_sha256: string;
	readonly factory_probe_request_sha256: string;
	readonly factory_probe_report_sha256: string;
	readonly factory_probe_report_file_sha256: string;
	readonly m3_preflight_request_sha256: string;
	readonly m3_preflight_request_file_sha256: string;
	readonly m3_preflight_record_file_sha256: string;
	readonly m3_preflight_task_report_sha256: string;
}

type TaskEnvironmentLockSemanticSubset = Omit<
	TaskEnvironmentLock,
	"lock_id" | "seal_sha256" | "created_at" | "verification"
> & {
	readonly verification: Omit<TaskEnvironmentLock["verification"], "completed_at">;
};

const taskEnvironmentLockValidator = Compile(TaskEnvironmentLockSchema);

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isImageId(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isCommit(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parseJson(content: string, label: string): unknown {
	if (typeof content !== "string") throw new Error(`${label} must be supplied as raw JSON text`);
	try {
		return JSON.parse(content);
	} catch {
		throw new Error(`${label} is not valid JSON text`);
	}
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

function taskPrefix(instanceId: string): string {
	const separator = instanceId.indexOf("__");
	if (separator < 1 || separator === instanceId.length - 2) {
		throw new Error("M6 TaskEnvironmentLock instance ID is not repository-qualified");
	}
	const repository = instanceId.slice(0, separator);
	const task = instanceId.slice(separator + 2);
	return task.startsWith(`${repository}-`) ? task : `${repository}-${task}`;
}

function expectedRepository(instanceId: string): string {
	const separator = instanceId.indexOf("__");
	const suffix = instanceId.slice(separator + 2);
	const issueSeparator = suffix.lastIndexOf("-");
	if (separator < 1 || issueSeparator < 1 || issueSeparator === suffix.length - 1) {
		throw new Error("M6 preflight instance ID cannot derive its repository");
	}
	return `${instanceId.slice(0, separator).replaceAll("__", "/")}/${suffix.slice(0, issueSeparator)}`;
}

function privateTaskSha256(datasetLock: DatasetLock, instanceId: string): string {
	const path = `tasks/${instanceId}.json`;
	const files = datasetLock.files.filter((file) => file.scope === "private" && file.path === path);
	if (files.length !== 1 || files[0] === undefined) {
		throw new Error("DatasetLock does not have exactly one private task descriptor for the candidate");
	}
	return files[0].sha256;
}

function officialImageFor(
	officialImageSourceLock: OfficialImageSourceLock,
	instanceId: string,
): OfficialImageSourceLock["images"][number] {
	const image = officialImageSourceLock.images.find((candidate) => candidate.image_key === instanceId);
	if (image === undefined) throw new Error("OfficialImageSourceLock is missing the M6 candidate image");
	return image;
}

function parseM3PreflightTask(value: unknown): M3PreflightTask {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"adapted_image_id",
			"adapted_image_reference",
			"base_commit",
			"instance_id",
			"private_task_sha256",
			"repo",
			"source_image_id",
		]) ||
		typeof value.instance_id !== "string" ||
		!isCommit(value.base_commit) ||
		typeof value.repo !== "string" ||
		value.repo.length === 0 ||
		value.repo.trim() !== value.repo ||
		/\s/.test(value.repo) ||
		!isSha256(value.private_task_sha256) ||
		!isImageId(value.source_image_id) ||
		typeof value.adapted_image_reference !== "string" ||
		!isImageId(value.adapted_image_id)
	) {
		throw new Error("M3 preflight task is malformed");
	}
	return value as unknown as M3PreflightTask;
}

function assertM3PreflightTaskMatchesFrozenInputs(
	task: M3PreflightTask,
	datasetLock: DatasetLock,
	officialImageSourceLock: OfficialImageSourceLock,
): void {
	const image = officialImageFor(officialImageSourceLock, task.instance_id);
	if (
		task.repo !== expectedRepository(task.instance_id) ||
		task.private_task_sha256 !== privateTaskSha256(datasetLock, task.instance_id) ||
		task.source_image_id !== image.local_image_id ||
		task.adapted_image_reference !== `repofixlab-m6-${taskPrefix(task.instance_id)}-evaluator:v1`
	) {
		throw new Error("M3 preflight task does not match the frozen DatasetLock or OfficialImageSourceLock");
	}
}

function requestCanonicalHash(value: JsonObject): string {
	return canonicalHash({
		schema_version: value.schema_version,
		request_type: value.request_type,
		operation_id: value.operation_id,
		dataset_revision: value.dataset_revision,
		private_volume: value.private_volume,
		tasks: value.tasks,
	});
}

function verifyM3PreflightRequest(
	value: unknown,
	datasetLock: DatasetLock,
	officialImageSourceLock: OfficialImageSourceLock,
	candidate: TaskEnvironmentCandidate,
): { readonly request: JsonObject; readonly targetTask: M3PreflightTask; readonly requestSha256: string } {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["dataset_revision", "operation_id", "private_volume", "request_type", "schema_version", "tasks"]) ||
		value.schema_version !== "v1" ||
		value.request_type !== "m3_official_image_preflight" ||
		typeof value.operation_id !== "string" ||
		!/^m6:environment-preflight:[A-Za-z0-9_.:-]{1,128}$/.test(value.operation_id) ||
		value.dataset_revision !== datasetLock.dataset.revision ||
		value.private_volume !== datasetLock.volumes.private ||
		!Array.isArray(value.tasks)
	) {
		throw new Error("M3 preflight request is malformed or does not bind the DatasetLock");
	}
	const tasks = value.tasks.map(parseM3PreflightTask);
	if (!isCanonicalInstanceIds(tasks.map((task) => task.instance_id), M6_ELIGIBLE_TASK_COUNT)) {
		throw new Error("M3 preflight request does not contain the canonical 26-task M6 population");
	}
	for (const task of tasks) assertM3PreflightTaskMatchesFrozenInputs(task, datasetLock, officialImageSourceLock);
	const targetTask = tasks.find((task) => task.instance_id === candidate.instance_id);
	if (
		targetTask === undefined ||
		targetTask.base_commit !== candidate.base_commit ||
		targetTask.adapted_image_id !== candidate.roles.evaluator.image.local_image_id
	) {
		throw new Error("M3 preflight request does not bind the candidate evaluator image and base commit");
	}
	return { request: value, targetTask, requestSha256: requestCanonicalHash(value) };
}

function parseGradeCounts(value: unknown, label: string, requireAllPass: boolean): void {
	if (!isRecord(value) || !hasExactKeys(value, ["failed", "passed", "total"])) {
		throw new Error(`M3 official grade ${label} aggregate is malformed`);
	}
	const { total, passed, failed } = value;
	if (
		!isNonNegativeSafeInteger(total) ||
		!isNonNegativeSafeInteger(passed) ||
		!isNonNegativeSafeInteger(failed) ||
		passed + failed !== total ||
		(requireAllPass && failed !== 0)
	) {
		throw new Error(`M3 official grade ${label} aggregate is malformed`);
	}
}

function parseM3PreflightProbe(
	value: unknown,
	task: M3PreflightTask,
	mode: "pristine" | "adapted",
	probeKind: "base" | "gold",
): M3PreflightProbe {
	const durationMs = isRecord(value) ? value.duration_ms : undefined;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"base_commit",
			"candidate_patch_apply_status",
			"candidate_patch_sha256",
			"duration_ms",
			"exit_code",
			"harness_mode",
			"instance_id",
			"official_grading",
			"probe_kind",
			"record_type",
			"resolved",
			"schema_version",
			"test_executed",
			"test_log_sha256",
			"test_patch_apply_status",
			"test_patch_sha256",
			"timed_out",
		]) ||
		value.schema_version !== "v1" ||
		value.record_type !== "m3_official_image_preflight" ||
		value.harness_mode !== mode ||
		value.probe_kind !== probeKind ||
		value.instance_id !== task.instance_id ||
		value.base_commit !== task.base_commit ||
		value.candidate_patch_apply_status !== (probeKind === "base" ? "not_applicable" : "applied") ||
		(probeKind === "base" ? value.candidate_patch_sha256 !== null : !isSha256(value.candidate_patch_sha256)) ||
		value.test_patch_apply_status !== "applied" ||
		!isSha256(value.test_patch_sha256) ||
		value.test_executed !== true ||
		value.exit_code !== 0 ||
		value.timed_out !== false ||
		!isNonNegativeSafeInteger(durationMs) ||
		!isSha256(value.test_log_sha256) ||
		value.resolved !== (probeKind === "gold") ||
		!isRecord(value.official_grading) ||
		!hasExactKeys(value.official_grading, [
			"fail_to_pass",
			"found",
			"instance_id",
			"pass_to_pass",
			"record_type",
			"resolved",
			"schema_version",
			"status_map_sha256",
			"test_log_sha256",
		]) ||
		value.official_grading.schema_version !== "v1" ||
		value.official_grading.record_type !== "m3_official_log_grade" ||
		value.official_grading.instance_id !== task.instance_id ||
		value.official_grading.test_log_sha256 !== value.test_log_sha256 ||
		value.official_grading.found !== true ||
		value.official_grading.resolved !== value.resolved ||
		!isSha256(value.official_grading.status_map_sha256)
	) {
		throw new Error("M3 preflight probe does not satisfy the official grading contract");
	}
	parseGradeCounts(value.official_grading.fail_to_pass, "FAIL_TO_PASS", probeKind === "gold");
	parseGradeCounts(value.official_grading.pass_to_pass, "PASS_TO_PASS", true);
	if (probeKind === "base") {
		const failToPass = value.official_grading.fail_to_pass as JsonObject;
		if (failToPass.failed === 0) throw new Error("M3 base probe does not demonstrate an unresolved FAIL_TO_PASS test");
	}
	return {
		harness_mode: mode,
		probe_kind: probeKind,
		resolved: probeKind === "gold",
		official_grading: { resolved: probeKind === "gold" },
	};
}

function parseM3PreflightTaskReport(value: unknown, task: M3PreflightTask): M3PreflightTaskReport {
	const rawProbes = isRecord(value) ? value.probes : undefined;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["adapted_image_id", "base_commit", "instance_id", "passed", "probes", "source_image_id"]) ||
		value.instance_id !== task.instance_id ||
		value.base_commit !== task.base_commit ||
		value.source_image_id !== task.source_image_id ||
		value.adapted_image_id !== task.adapted_image_id ||
		value.passed !== true ||
		!Array.isArray(rawProbes) ||
		rawProbes.length !== 4
	) {
		throw new Error("M3 preflight task report does not bind the frozen task images");
	}
	const expected: readonly ["pristine" | "adapted", "base" | "gold"][] = [
		["pristine", "base"],
		["pristine", "gold"],
		["adapted", "base"],
		["adapted", "gold"],
	];
	const probes = expected.map(([mode, probeKind], index) =>
		parseM3PreflightProbe(rawProbes[index], task, mode, probeKind),
	);
	return {
		instance_id: task.instance_id,
		base_commit: task.base_commit,
		source_image_id: task.source_image_id,
		adapted_image_id: task.adapted_image_id,
		passed: true,
		probes,
	};
}

function verifyM3PreflightRecord(
	value: unknown,
	request: JsonObject,
	targetTask: M3PreflightTask,
	requestSha256: string,
): M3PreflightTaskReport {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"completed_task_count",
			"created_at",
			"operation_id",
			"record_type",
			"request_sha256",
			"schema_version",
			"status",
			"task_reports",
			"total_task_count",
			"updated_at",
		]) ||
		value.schema_version !== "v1" ||
		value.record_type !== "m3_official_image_preflight" ||
		value.operation_id !== request.operation_id ||
		value.request_sha256 !== requestSha256 ||
		value.status !== "completed" ||
		value.total_task_count !== M6_ELIGIBLE_TASK_COUNT ||
		value.completed_task_count !== M6_ELIGIBLE_TASK_COUNT ||
		!isTimestamp(value.created_at) ||
		!isTimestamp(value.updated_at) ||
		!Array.isArray(value.task_reports) ||
		value.task_reports.length !== M6_ELIGIBLE_TASK_COUNT
	) {
		throw new Error("M3 preflight record is incomplete or does not bind the immutable request");
	}
	const requestTasks = request.tasks as unknown[];
	let targetReport: M3PreflightTaskReport | undefined;
	for (const [index, rawReport] of value.task_reports.entries()) {
		const requestTask = parseM3PreflightTask(requestTasks[index]);
		const report = parseM3PreflightTaskReport(rawReport, requestTask);
		if (report.instance_id === targetTask.instance_id) targetReport = report;
	}
	if (targetReport === undefined) throw new Error("M3 preflight record is missing the candidate task report");
	return targetReport;
}

function verifyEvidence(input: M6TaskEnvironmentLockBuildInput): VerifiedM6TaskEnvironmentEvidence {
	const datasetLockFileSha256 = taskEnvironmentEvidenceFileHash(input.dataset_lock_json);
	const datasetLock = verifyDatasetLockForTaskEnvironment(parseJson(input.dataset_lock_json, "DatasetLock"));
	const officialImageSourceLockFileSha256 = taskEnvironmentEvidenceFileHash(input.official_image_source_lock_json);
	const officialImageSourceLock = verifyOfficialImageSourceLockSelfContained(
		parseJson(input.official_image_source_lock_json, "OfficialImageSourceLock"),
	);
	const candidateFileSha256 = taskEnvironmentEvidenceFileHash(input.candidate_json);
	const candidate = verifyTaskEnvironmentCandidate(parseJson(input.candidate_json, "TaskEnvironmentCandidate"));
	const factoryProbeReportFileSha256 = taskEnvironmentEvidenceFileHash(input.factory_probe_report_json);
	const factoryProbeReportRaw = parseJson(input.factory_probe_report_json, "TaskRoleFactoryProbeReport");
	if (!isRecord(factoryProbeReportRaw) || typeof factoryProbeReportRaw.operation_id !== "string") {
		throw new Error("TaskRoleFactoryProbeReport is malformed");
	}
	const factoryProbeReport = verifyTaskRoleFactoryProbeReport(
		factoryProbeReportRaw,
		candidate,
		createTaskRoleFactoryProbeRequest(candidate, factoryProbeReportRaw.operation_id),
	);
	if (factoryProbeReport.status !== "pass") throw new Error("M6 TaskEnvironmentLock requires a passing factory probe");
	if (
		candidate.dataset_lock.lock_id !== datasetLock.lock_id ||
		candidate.dataset_lock.lock_sha256 !== datasetLockFileSha256 ||
		candidate.official_image_source_lock.lock_id !== officialImageSourceLock.lock_id ||
		candidate.official_image_source_lock.lock_sha256 !== officialImageSourceLockFileSha256 ||
		datasetLock.dataset.revision !== officialImageSourceLock.dataset_revision
	) {
		throw new Error("M6 candidate lock bindings do not match the sealed upstream artifacts");
	}
	const requestText = input.m3_preflight_request_json;
	const recordText = input.m3_preflight_record_json;
	const request = verifyM3PreflightRequest(
		parseJson(requestText, "M3 preflight request"),
		datasetLock,
		officialImageSourceLock,
		candidate,
	);
	const targetReport = verifyM3PreflightRecord(
		parseJson(recordText, "M3 preflight record"),
		request.request,
		request.targetTask,
		request.requestSha256,
	);
	const workerResource = candidate.roles.worker.resource_profile;
	const evaluatorResource = candidate.roles.evaluator.resource_profile;
	if (
		workerResource.nano_cpus !== evaluatorResource.nano_cpus ||
		workerResource.memory_bytes !== evaluatorResource.memory_bytes ||
		workerResource.pids_limit !== evaluatorResource.pids_limit
	) {
		throw new Error("M6 Worker and Evaluator must share CPU, memory, and pids limits");
	}
	return {
		datasetLock,
		datasetLockFileSha256,
		officialImageSourceLock,
		officialImageSourceLockFileSha256,
		candidate,
		candidateFileSha256,
		factoryProbeReport,
		factoryProbeReportFileSha256,
		preflight: {
			requestSha256: request.requestSha256,
			requestFileSha256: taskEnvironmentEvidenceFileHash(requestText),
			recordFileSha256: taskEnvironmentEvidenceFileHash(recordText),
			taskReportSha256: canonicalHash(targetReport),
		},
	};
}

function verificationEvidenceFromVerified(
	evidence: VerifiedM6TaskEnvironmentEvidence,
): M6TaskEnvironmentVerificationEvidence {
	return {
		schema_version: "v1",
		evidence_type: "m6_task_environment_verification",
		dataset_lock_id: evidence.datasetLock.lock_id,
		dataset_lock_file_sha256: evidence.datasetLockFileSha256,
		dataset_lock_seal_sha256: evidence.datasetLock.seal.sha256,
		official_image_source_lock_id: evidence.officialImageSourceLock.lock_id,
		official_image_source_lock_file_sha256: evidence.officialImageSourceLockFileSha256,
		official_image_source_lock_seal_sha256: evidence.officialImageSourceLock.seal_sha256,
		candidate_id: evidence.candidate.candidate_id,
		candidate_sha256: evidence.candidate.candidate_sha256,
		candidate_file_sha256: evidence.candidateFileSha256,
		factory_probe_request_sha256: evidence.factoryProbeReport.request_sha256,
		factory_probe_report_sha256: evidence.factoryProbeReport.report_sha256,
		factory_probe_report_file_sha256: evidence.factoryProbeReportFileSha256,
		m3_preflight_request_sha256: evidence.preflight.requestSha256,
		m3_preflight_request_file_sha256: evidence.preflight.requestFileSha256,
		m3_preflight_record_file_sha256: evidence.preflight.recordFileSha256,
		m3_preflight_task_report_sha256: evidence.preflight.taskReportSha256,
	};
}

export function m6TaskEnvironmentVerificationEvidence(
	input: M6TaskEnvironmentLockBuildInput,
): M6TaskEnvironmentVerificationEvidence {
	return verificationEvidenceFromVerified(verifyEvidence(input));
}

export function m6TaskEnvironmentVerificationEvidenceHash(input: M6TaskEnvironmentLockBuildInput): string {
	return canonicalHash(m6TaskEnvironmentVerificationEvidence(input));
}

function semanticSubset(value: TaskEnvironmentLock): TaskEnvironmentLockSemanticSubset {
	const { lock_id: _lockId, seal_sha256: _sealSha256, created_at: _createdAt, verification, ...lock } = value;
	const { completed_at: _completedAt, ...stableVerification } = verification;
	return { ...lock, verification: stableVerification };
}

function buildLock(evidence: VerifiedM6TaskEnvironmentEvidence, createdAt: string): TaskEnvironmentLock {
	if (!isTimestamp(createdAt)) throw new Error("M6 TaskEnvironmentLock created_at must be a valid timestamp");
	const candidate = evidence.candidate;
	const officialImage = officialImageFor(evidence.officialImageSourceLock, candidate.instance_id);
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
			evidence_sha256: canonicalHash(verificationEvidenceFromVerified(evidence)),
			completed_at: createdAt,
		},
		seal_sha256: "0".repeat(64),
		created_at: createdAt,
	};
	const sealSha256 = taskEnvironmentLockSealHash(draft);
	if (canonicalHash(semanticSubset(draft)) !== sealSha256) {
		throw new Error("M6 TaskEnvironmentLock seal is not internally canonical");
	}
	return {
		...draft,
		lock_id: taskEnvironmentLockId(candidate.instance_id, sealSha256),
		seal_sha256: sealSha256,
	};
}

export function createM6TaskEnvironmentLock(input: M6TaskEnvironmentLockBuildInput): TaskEnvironmentLock {
	const lock = buildLock(verifyEvidence(input), input.created_at);
	if (!taskEnvironmentLockValidator.Check(lock)) {
		throw new Error("Constructed M6 TaskEnvironmentLock violates the strict v1 schema");
	}
	return lock;
}

export function verifyM6TaskEnvironmentLock(
	value: unknown,
	input: M6TaskEnvironmentLockBuildInput,
): TaskEnvironmentLock {
	if (!taskEnvironmentLockValidator.Check(value)) {
		throw new Error("M6 TaskEnvironmentLock does not satisfy the strict v1 schema");
	}
	if (
		!isTimestamp(value.created_at) ||
		!isTimestamp(value.verification.completed_at) ||
		value.created_at !== value.verification.completed_at
	) {
		throw new Error("M6 TaskEnvironmentLock timestamps are invalid or inconsistent");
	}
	const expected = buildLock(verifyEvidence(input), value.created_at);
	if (stableStringify(value) !== stableStringify(expected)) {
		throw new Error("M6 TaskEnvironmentLock does not match its canonical frozen evidence");
	}
	return value;
}
