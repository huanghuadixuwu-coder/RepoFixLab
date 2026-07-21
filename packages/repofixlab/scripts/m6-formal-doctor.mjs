import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { verifyM6TaskEnvironmentLock } from "../dist/contracts/m6-task-environment-lock.js";
import { stableStringify } from "../dist/contracts/schema-generator.js";
import { taskEnvironmentLockFileHash } from "../dist/contracts/task-environment-lock.js";
import { verifyM6EvaluationCohorts } from "../dist/m6/cohorts.js";

const TASK_COUNT = 26;
const DATASET_LOCK_PATH = "dataset-prepare/20260718T135934707Z-243342d1916a/dataset-lock.json";
const IMAGE_LOCK_PATH = "m3-eligible-image-resolution/20260720T193900Z-26-task-v1/official-image-source-lock.json";
const CANDIDATE_ROOT = "m6-candidate-catalog/20260720T001518846Z-26-task-v1";
const FACTORY_ROOT = "m6-factory-probes/20260720T002522203Z-26-task-v1";
const PREFLIGHT_REQUEST_PATH = "m6-environment-images/20260719T234730636Z-26-task-v1/preflight-request.json";
const PREFLIGHT_RECORD_PATH = "m6-environment-preflight/20260720T000238Z-26-task-v1/controller-record.json";
const LOCK_ROOT = "m6-task-environment-locks/20260720T005226581Z-26-task-v1";

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

function isSha256(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function relativeArtifactPath(root, path) {
	const value = relative(root, path);
	if (value === "" || value.startsWith(`..${sep}`) || value === "..") {
		throw new Error("Formal Doctor artifact path escaped the configured root");
	}
	return value.replaceAll("\\", "/");
}

async function readArtifact(root, path) {
	if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\")) {
		throw new Error("Formal Doctor artifact path is malformed");
	}
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, path);
	if (relative(resolvedRoot, resolvedPath).startsWith("..")) {
		throw new Error("Formal Doctor artifact path escapes the configured root");
	}
	return { content: await readFile(resolvedPath, "utf8"), path: resolvedPath };
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

function parseArguments(args) {
	if (args.length !== 6 || args[0] !== "--runtime-preflight" || args[2] !== "--security-gate" || args[4] !== "--cohorts") {
		throw new Error("Usage: m6-formal-doctor.mjs --runtime-preflight <path> --security-gate <path> --cohorts <path>");
	}
	return { runtimePreflightPath: args[1], securityGatePath: args[3], cohortsPath: args[5] };
}

function canonicalEntries(entries, label) {
	if (!Array.isArray(entries) || entries.length !== TASK_COUNT) {
		throw new Error(`${label} must contain exactly 26 entries`);
	}
	const instanceIds = entries.map((entry) => (isRecord(entry) ? entry.instance_id : undefined));
	if (
		instanceIds.some((instanceId) => typeof instanceId !== "string") ||
		new Set(instanceIds).size !== TASK_COUNT ||
		JSON.stringify(instanceIds) !== JSON.stringify([...instanceIds].sort())
	) {
		throw new Error(`${label} instance IDs are not unique canonical order`);
	}
	return entries;
}

const { runtimePreflightPath, securityGatePath, cohortsPath } = parseArguments(process.argv.slice(2));
const artifactsRoot = resolve(process.env.REPOFIX_ARTIFACTS_PATH ?? "/artifacts");
const paths = {
	dataset: DATASET_LOCK_PATH,
	image: IMAGE_LOCK_PATH,
	candidateCatalog: `${CANDIDATE_ROOT}/candidate-catalog.json`,
	factoryCatalog: `${FACTORY_ROOT}/factory-probe-catalog.json`,
	preflightRequest: PREFLIGHT_REQUEST_PATH,
	preflightRecord: PREFLIGHT_RECORD_PATH,
	lockCatalog: `${LOCK_ROOT}/environment-lock-catalog.json`,
};
const loaded = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readArtifact(artifactsRoot, path)])));
const candidateCatalog = parseJson(loaded.candidateCatalog.content, "M6 candidate catalog");
const factoryCatalog = parseJson(loaded.factoryCatalog.content, "M6 factory catalog");
const lockCatalog = parseJson(loaded.lockCatalog.content, "M6 task environment lock catalog");
if (
	!isRecord(candidateCatalog) ||
	candidateCatalog.schema_version !== "v1" ||
	candidateCatalog.artifact_type !== "m6_task_environment_candidate_catalog" ||
	!isRecord(factoryCatalog) ||
	factoryCatalog.schema_version !== "v1" ||
	factoryCatalog.artifact_type !== "m6_task_role_factory_probe_catalog" ||
	!isRecord(lockCatalog) ||
	lockCatalog.schema_version !== "v1" ||
	lockCatalog.artifact_type !== "m6_task_environment_lock_catalog" ||
	lockCatalog.task_count !== TASK_COUNT ||
	lockCatalog.dataset_lock_file_sha256 !== sha256(loaded.dataset.content) ||
	lockCatalog.official_image_source_lock_file_sha256 !== sha256(loaded.image.content) ||
	lockCatalog.candidate_catalog_file_sha256 !== sha256(loaded.candidateCatalog.content) ||
	lockCatalog.factory_catalog_file_sha256 !== sha256(loaded.factoryCatalog.content) ||
	lockCatalog.m3_preflight_request_file_sha256 !== sha256(loaded.preflightRequest.content) ||
	lockCatalog.m3_preflight_record_file_sha256 !== sha256(loaded.preflightRecord.content)
) {
	throw new Error("M6 formal Doctor top-level lock bindings drifted");
}
const candidates = canonicalEntries(candidateCatalog.candidates, "M6 candidate catalog");
const factoryReports = canonicalEntries(factoryCatalog.factory_reports, "M6 factory catalog");
const lockReferences = canonicalEntries(lockCatalog.locks, "M6 task environment lock catalog");
if (factoryCatalog.candidate_catalog_file_sha256 !== sha256(loaded.candidateCatalog.content) || factoryCatalog.candidate_count !== TASK_COUNT) {
	throw new Error("M6 formal Doctor factory catalog binding drifted");
}
const candidateByInstance = new Map(candidates.map((candidate) => [candidate.instance_id, candidate]));
const factoryByInstance = new Map(factoryReports.map((report) => [report.instance_id, report]));
const verifiedLocks = [];
for (const reference of lockReferences) {
	if (!isRecord(reference) || typeof reference.instance_id !== "string" || typeof reference.lock_path !== "string") {
		throw new Error("M6 formal Doctor lock reference is malformed");
	}
	const candidate = candidateByInstance.get(reference.instance_id);
	const factory = factoryByInstance.get(reference.instance_id);
	if (!isRecord(candidate) || !isRecord(factory) || candidate.candidate_id !== factory.candidate_id || candidate.candidate_sha256 !== factory.candidate_sha256) {
		throw new Error("M6 formal Doctor candidate/factory binding drifted");
	}
	const [candidateRaw, factoryRaw, lockRaw] = await Promise.all([
		readArtifact(artifactsRoot, `${CANDIDATE_ROOT}/${candidate.candidate_path}`),
		readArtifact(artifactsRoot, `${FACTORY_ROOT}/${factory.report_path}`),
		readArtifact(artifactsRoot, `${LOCK_ROOT}/${reference.lock_path}`),
	]);
	if (sha256(candidateRaw.content) !== candidate.candidate_file_sha256 || sha256(factoryRaw.content) !== factory.report_file_sha256) {
		throw new Error(`M6 formal Doctor raw candidate/factory evidence drifted: ${reference.instance_id}`);
	}
	const lockValue = parseJson(lockRaw.content, "M6 task environment lock");
	if (!isRecord(lockValue) || typeof lockValue.created_at !== "string") {
		throw new Error(`M6 formal Doctor task lock is malformed: ${reference.instance_id}`);
	}
	const lock = verifyM6TaskEnvironmentLock(lockValue, {
		created_at: lockValue.created_at,
		dataset_lock_json: loaded.dataset.content,
		official_image_source_lock_json: loaded.image.content,
		candidate_json: candidateRaw.content,
		factory_probe_report_json: factoryRaw.content,
		m3_preflight_request_json: loaded.preflightRequest.content,
		m3_preflight_record_json: loaded.preflightRecord.content,
	});
	if (
		lock.instance_id !== reference.instance_id ||
		lock.lock_id !== reference.lock_id ||
		lock.seal_sha256 !== reference.seal_sha256 ||
		taskEnvironmentLockFileHash(lock) !== reference.file_sha256
	) {
		throw new Error(`M6 formal Doctor task lock catalog binding drifted: ${reference.instance_id}`);
	}
	verifiedLocks.push(lock);
}
const cohortsRaw = await readArtifact(artifactsRoot, cohortsPath);
const cohorts = verifyM6EvaluationCohorts(parseJson(cohortsRaw.content, "M6 cohorts"));
const lockedInstances = new Set(verifiedLocks.map((lock) => lock.instance_id));
if (
	cohorts.main_test_instance_ids.some((instanceId) => !lockedInstances.has(instanceId)) ||
	cohorts.ablation_instance_ids.some((instanceId) => !lockedInstances.has(instanceId)) ||
	cohorts.stability_instance_ids.some((instanceId) => !lockedInstances.has(instanceId))
) {
	throw new Error("M6 formal Doctor cohorts are not contained in the locked population");
}
const runtimeRaw = await readArtifact(artifactsRoot, runtimePreflightPath);
const runtimeCatalog = parseJson(runtimeRaw.content, "M6 runtime preflight catalog");
if (!isRecord(runtimeCatalog) || runtimeCatalog.artifact_type !== "m6_runtime_preflight_catalog" || runtimeCatalog.task_count !== TASK_COUNT || runtimeCatalog.candidate_catalog_file_sha256 !== sha256(loaded.candidateCatalog.content)) {
	throw new Error("M6 formal Doctor runtime preflight catalog binding drifted");
}
const runtimeEntries = canonicalEntries(runtimeCatalog.runtime_preflights, "M6 runtime preflight catalog");
const lockByInstance = new Map(verifiedLocks.map((lock) => [lock.instance_id, lock]));
for (const runtimeEntry of runtimeEntries) {
	const candidate = candidateByInstance.get(runtimeEntry.instance_id);
	const lock = lockByInstance.get(runtimeEntry.instance_id);
	const response = isRecord(runtimeEntry) && isRecord(runtimeEntry.response) ? runtimeEntry.response : undefined;
	const manifest = isRecord(response) && isRecord(response.manifest) ? response.manifest : undefined;
	if (
		!isRecord(candidate) ||
		!lock ||
		!isRecord(response) ||
		!isRecord(manifest) ||
		response.status !== "ready" ||
		manifest.instance_id !== lock.instance_id ||
		manifest.candidate_id !== candidate.candidate_id ||
		manifest.candidate_sha256 !== candidate.candidate_sha256 ||
		manifest.task_environment_lock_sha256 !== lock.seal_sha256 ||
		!isSha256(manifest.policy_sha256)
	) {
		throw new Error(`M6 formal Doctor runtime preflight failed its sealed binding: ${runtimeEntry.instance_id}`);
	}
}
const securityRaw = await readArtifact(artifactsRoot, securityGatePath);
const security = parseJson(securityRaw.content, "M6 security gate");
if (
	!isRecord(security) ||
	security.report_type !== "m6_security_gate" ||
	security.status !== "pass" ||
	!isRecord(security.candidate_catalog) ||
	!isRecord(security.factory_catalog) ||
	security.candidate_catalog.file_sha256 !== sha256(loaded.candidateCatalog.content) ||
	security.factory_catalog.file_sha256 !== sha256(loaded.factoryCatalog.content) ||
	security.candidate_catalog.candidate_count !== TASK_COUNT ||
	security.factory_catalog.factory_report_count !== TASK_COUNT ||
	!isRecord(security.checks) ||
	Object.values(security.checks).some((value) => value !== true)
) {
	throw new Error("M6 formal Doctor security gate is incomplete or failed");
}
const createdAt = new Date().toISOString();
const report = {
	schema_version: "v1",
	report_type: "m6_formal_doctor",
	status: "pass",
	generated_at: createdAt,
	scope: "Pre-provider M6 admission gate. It verifies sealed environment, 26 locked runtime preflights, cohort coverage, and security evidence; GLM smoke/calibration and ExperimentLock remain separate paid gates.",
	checks: {
		m6_task_environment_locks: "pass",
		m6_runtime_preflight: "pass",
		m6_security_gate: "pass",
		m6_cohort_coverage: "pass",
	},
	inputs: {
		m6_lock_catalog_sha256: sha256(loaded.lockCatalog.content),
		runtime_preflight_catalog_sha256: sha256(runtimeRaw.content),
		security_gate_sha256: sha256(securityRaw.content),
		cohorts_sha256: sha256(cohortsRaw.content),
	},
	task_count: TASK_COUNT,
	cohort_sha256: cohorts.cohort_sha256,
};
const outputRoot = join(artifactsRoot, "m6-formal-doctor", `${createdAt.replaceAll(/[-:.]/g, "").replace("Z", "Z")}-26-task-v1`);
const outputPath = join(outputRoot, "formal-doctor-report.json");
await writeNew(outputPath, stableStringify(report));
process.stdout.write(`${relativeArtifactPath(artifactsRoot, outputPath)}\n`);
