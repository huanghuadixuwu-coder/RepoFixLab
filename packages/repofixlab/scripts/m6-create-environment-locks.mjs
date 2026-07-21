import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	createM6TaskEnvironmentLock,
	verifyM6TaskEnvironmentLock,
} from "../dist/contracts/m6-task-environment-lock.js";
import { stableStringify } from "../dist/contracts/schema-generator.js";
import { taskEnvironmentLockFileHash } from "../dist/contracts/task-environment-lock.js";

const TASK_COUNT = 26;
const DATASET_LOCK_PATH = "dataset-prepare/20260718T135934707Z-243342d1916a/dataset-lock.json";
const IMAGE_LOCK_PATH = "m3-eligible-image-resolution/20260720T193900Z-26-task-v1/official-image-source-lock.json";
const CANDIDATE_ROOT = "m6-candidate-catalog/20260720T001518846Z-26-task-v1";
const FACTORY_ROOT = "m6-factory-probes/20260720T002522203Z-26-task-v1";
const PREFLIGHT_REQUEST_PATH = "m6-environment-images/20260719T234730636Z-26-task-v1/preflight-request.json";
const PREFLIGHT_RECORD_PATH = "m6-environment-preflight/20260720T000238Z-26-task-v1/controller-record.json";

function sha256(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function parseJson(content, label) {
	try {
		return JSON.parse(content);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskPrefix(instanceId) {
	if (typeof instanceId !== "string") throw new Error("M6 catalog instance ID is malformed");
	const separator = instanceId.indexOf("__");
	if (separator < 1 || separator === instanceId.length - 2) {
		throw new Error("M6 catalog instance ID is not repository-qualified");
	}
	const repository = instanceId.slice(0, separator);
	const task = instanceId.slice(separator + 2);
	return task.startsWith(`${repository}-`) ? task : `${repository}-${task}`;
}

function compareCatalogEntries(left, right) {
	return left.instance_id.localeCompare(right.instance_id);
}

async function readText(root, relativePath) {
	return readFile(join(root, relativePath), "utf8");
}

async function writeNew(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

function validateCandidateCatalog(value, rawContent) {
	if (
		!isRecord(value) ||
		value.schema_version !== "v1" ||
		value.artifact_type !== "m6_task_environment_candidate_catalog" ||
		!Array.isArray(value.candidates) ||
		value.candidates.length !== TASK_COUNT
	) {
		throw new Error("M6 candidate catalog does not contain the frozen 26-task population");
	}
	const candidates = value.candidates.map((candidate) => {
		if (
			!isRecord(candidate) ||
			typeof candidate.instance_id !== "string" ||
			typeof candidate.candidate_id !== "string" ||
			!/^task-environment-candidate-v1-/.test(candidate.candidate_id) ||
			typeof candidate.candidate_sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(candidate.candidate_sha256) ||
			typeof candidate.candidate_path !== "string" ||
			!candidate.candidate_path.startsWith("candidates/m6-") ||
			typeof candidate.candidate_file_sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(candidate.candidate_file_sha256)
		) {
			throw new Error("M6 candidate catalog entry is malformed");
		}
		return candidate;
	});
	const sorted = candidates.slice().sort(compareCatalogEntries);
	if (
		sorted.some((candidate, index) => candidate !== candidates[index]) ||
		new Set(candidates.map((candidate) => candidate.instance_id)).size !== TASK_COUNT ||
		new Set(candidates.map((candidate) => candidate.candidate_id)).size !== TASK_COUNT
	) {
		throw new Error("M6 candidate catalog is not unique and canonical-order sorted");
	}
	return { candidates, fileSha256: sha256(rawContent) };
}

function validateFactoryCatalog(value, rawContent, candidateCatalogFileSha256) {
	if (
		!isRecord(value) ||
		value.schema_version !== "v1" ||
		value.artifact_type !== "m6_task_role_factory_probe_catalog" ||
		value.candidate_catalog_file_sha256 !== candidateCatalogFileSha256 ||
		value.candidate_count !== TASK_COUNT ||
		!Array.isArray(value.factory_reports) ||
		value.factory_reports.length !== TASK_COUNT
	) {
		throw new Error("M6 factory catalog does not bind the frozen candidate catalog");
	}
	const reports = value.factory_reports.map((report) => {
		if (
			!isRecord(report) ||
			typeof report.instance_id !== "string" ||
			typeof report.candidate_id !== "string" ||
			typeof report.candidate_sha256 !== "string" ||
			typeof report.operation_id !== "string" ||
			typeof report.report_path !== "string" ||
			!report.report_path.startsWith("reports/") ||
			typeof report.report_file_sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(report.report_file_sha256) ||
			typeof report.report_sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(report.report_sha256)
		) {
			throw new Error("M6 factory catalog entry is malformed");
		}
		return report;
	});
	const sorted = reports.slice().sort(compareCatalogEntries);
	if (
		sorted.some((report, index) => report !== reports[index]) ||
		new Set(reports.map((report) => report.instance_id)).size !== TASK_COUNT
	) {
		throw new Error("M6 factory catalog is not unique and canonical-order sorted");
	}
	return { reports, fileSha256: sha256(rawContent) };
}

const artifactsRoot = resolve(process.env.REPOFIX_ARTIFACTS_PATH ?? "/artifacts");
const [
	datasetLockJson,
	officialImageSourceLockJson,
	preflightRequestJson,
	preflightRecordJson,
	candidateCatalogJson,
	factoryCatalogJson,
] = await Promise.all([
	readText(artifactsRoot, DATASET_LOCK_PATH),
	readText(artifactsRoot, IMAGE_LOCK_PATH),
	readText(artifactsRoot, PREFLIGHT_REQUEST_PATH),
	readText(artifactsRoot, PREFLIGHT_RECORD_PATH),
	readText(artifactsRoot, `${CANDIDATE_ROOT}/candidate-catalog.json`),
	readText(artifactsRoot, `${FACTORY_ROOT}/factory-probe-catalog.json`),
]);

const candidateCatalog = validateCandidateCatalog(parseJson(candidateCatalogJson, "M6 candidate catalog"), candidateCatalogJson);
const factoryCatalog = validateFactoryCatalog(
	parseJson(factoryCatalogJson, "M6 factory catalog"),
	factoryCatalogJson,
	candidateCatalog.fileSha256,
);
const factoryByInstanceId = new Map(factoryCatalog.reports.map((report) => [report.instance_id, report]));
const createdAt = new Date().toISOString();
const outputRoot = join(artifactsRoot, "m6-task-environment-locks", `${createdAt.replaceAll(/[-:.]/g, "").replace("Z", "Z")}-26-task-v1`);
const lockReferences = [];

for (const catalogEntry of candidateCatalog.candidates) {
	const factoryEntry = factoryByInstanceId.get(catalogEntry.instance_id);
	if (
		factoryEntry === undefined ||
		factoryEntry.candidate_id !== catalogEntry.candidate_id ||
		factoryEntry.candidate_sha256 !== catalogEntry.candidate_sha256
	) {
		throw new Error(`M6 factory catalog is missing the exact candidate binding: ${catalogEntry.instance_id}`);
	}
	const [candidateJson, factoryProbeReportJson] = await Promise.all([
		readText(artifactsRoot, `${CANDIDATE_ROOT}/${catalogEntry.candidate_path}`),
		readText(artifactsRoot, `${FACTORY_ROOT}/${factoryEntry.report_path}`),
	]);
	if (
		sha256(candidateJson) !== catalogEntry.candidate_file_sha256 ||
		sha256(factoryProbeReportJson) !== factoryEntry.report_file_sha256
	) {
		throw new Error(`M6 catalog file hash drifted: ${catalogEntry.instance_id}`);
	}
	const candidate = parseJson(candidateJson, "M6 candidate");
	const factoryReport = parseJson(factoryProbeReportJson, "M6 factory report");
	if (
		!isRecord(candidate) ||
		!isRecord(factoryReport) ||
		candidate.instance_id !== catalogEntry.instance_id ||
		candidate.candidate_id !== catalogEntry.candidate_id ||
		candidate.candidate_sha256 !== catalogEntry.candidate_sha256 ||
		factoryReport.candidate_id !== catalogEntry.candidate_id ||
		factoryReport.candidate_sha256 !== catalogEntry.candidate_sha256 ||
		factoryReport.report_sha256 !== factoryEntry.report_sha256
	) {
		throw new Error(`M6 candidate or factory report semantic binding drifted: ${catalogEntry.instance_id}`);
	}
	const input = {
		created_at: createdAt,
		dataset_lock_json: datasetLockJson,
		official_image_source_lock_json: officialImageSourceLockJson,
		candidate_json: candidateJson,
		factory_probe_report_json: factoryProbeReportJson,
		m3_preflight_request_json: preflightRequestJson,
		m3_preflight_record_json: preflightRecordJson,
	};
	const lock = createM6TaskEnvironmentLock(input);
	verifyM6TaskEnvironmentLock(lock, input);
	const prefix = taskPrefix(catalogEntry.instance_id);
	const lockPath = `locks/${prefix}/task-environment-lock.json`;
	const lockJson = stableStringify(lock);
	await writeNew(join(outputRoot, lockPath), lockJson);
	lockReferences.push({
		instance_id: lock.instance_id,
		lock_id: lock.lock_id,
		seal_sha256: lock.seal_sha256,
		file_sha256: taskEnvironmentLockFileHash(lock),
		worker_image_id: lock.worker_image.local_image_id,
		evaluator_image_id: lock.evaluator_image.local_image_id,
		lock_path: lockPath,
	});
}

const catalog = {
	schema_version: "v1",
	artifact_type: "m6_task_environment_lock_catalog",
	created_at: createdAt,
	task_count: TASK_COUNT,
	dataset_lock_file_sha256: sha256(datasetLockJson),
	official_image_source_lock_file_sha256: sha256(officialImageSourceLockJson),
	m3_preflight_request_file_sha256: sha256(preflightRequestJson),
	m3_preflight_record_file_sha256: sha256(preflightRecordJson),
	candidate_catalog_file_sha256: candidateCatalog.fileSha256,
	factory_catalog_file_sha256: factoryCatalog.fileSha256,
	locks: lockReferences,
};
await writeNew(join(outputRoot, "environment-lock-catalog.json"), stableStringify(catalog));
process.stdout.write(`${join(outputRoot, "environment-lock-catalog.json")}\n`);
