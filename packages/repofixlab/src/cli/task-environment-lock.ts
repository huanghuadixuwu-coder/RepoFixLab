import {
	createHarnessEquivalenceReport,
	verifyHarnessEquivalenceReport,
	verifyHarnessProbeReport,
	verifyOfficialHarnessSourceLock,
} from "../contracts/harness-equivalence.ts";
import { verifyPristineRuntimeLock } from "../contracts/pristine-runtime-lock.ts";
import { stableStringify } from "../contracts/schema-generator.ts";
import { createTaskEnvironmentLock, taskEnvironmentEvidenceFileHash } from "../contracts/task-environment-lock.ts";
import {
	createTaskRoleFactoryProbeRequest,
	verifyTaskEnvironmentCandidate,
	verifyTaskRoleFactoryProbeReport,
} from "../contracts/task-role-factory-probe.ts";
import type { HarnessProbeReport, TaskEnvironmentLock } from "../contracts/v1.ts";

const PROBE_KINDS = ["base", "no_op", "malformed", "gold"] as const;
const HARNESS_MODES = ["pristine", "adapted"] as const;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

type HarnessMode = (typeof HARNESS_MODES)[number];
type ProbeKind = (typeof PROBE_KINDS)[number];

export interface TaskEnvironmentLockEvidenceManifest {
	readonly schema_version: "v1";
	readonly manifest_type: "task_environment_lock_create";
	readonly dataset_lock: string;
	readonly official_image_source_lock: string;
	readonly official_harness_source_lock: string;
	readonly candidate: string;
	readonly factory_probe_report: string;
	readonly harness_equivalence_report: string;
	readonly pristine_runtime_lock: string;
	readonly harness_probe_reports: Readonly<Record<HarnessMode, Readonly<Record<ProbeKind, string>>>>;
}

export interface TaskEnvironmentLockRawEvidence {
	readonly dataset_lock_json: string;
	readonly official_image_source_lock_json: string;
	readonly official_harness_source_lock_json: string;
	readonly candidate_json: string;
	readonly factory_probe_report_json: string;
	readonly harness_equivalence_report_json: string;
	readonly pristine_runtime_lock_json: string;
	readonly harness_probe_report_json: Readonly<Record<HarnessMode, Readonly<Record<ProbeKind, string>>>>;
}

export interface TaskEnvironmentLockEvidenceLoader {
	readonly artifactsRoot: string;
	readonly resolveInputPath: (artifactsRoot: string, requestedPath: string) => Promise<string>;
	readonly readInputFile: (path: string) => Promise<string>;
}

export interface LoadedTaskEnvironmentLockRawEvidence {
	readonly evidence: TaskEnvironmentLockRawEvidence;
	readonly resolvedPaths: readonly string[];
}

const MANIFEST_KEYS = [
	"schema_version",
	"manifest_type",
	"dataset_lock",
	"official_image_source_lock",
	"official_harness_source_lock",
	"candidate",
	"factory_probe_report",
	"harness_equivalence_report",
	"pristine_runtime_lock",
	"harness_probe_reports",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (stableStringify(actual) !== stableStringify(sortedExpected)) {
		throw new Error(`${label} fields must be exactly ${sortedExpected.join(", ")}`);
	}
}

function evidencePath(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty path without NUL bytes`);
	}
	return value;
}

function parseJson(content: string, label: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		throw new Error(`${label} is not valid JSON text`);
	}
}

function probePathMatrix(value: unknown): TaskEnvironmentLockEvidenceManifest["harness_probe_reports"] {
	if (!isRecord(value)) {
		throw new Error("harness_probe_reports must be an object");
	}
	assertExactKeys(value, HARNESS_MODES, "harness_probe_reports");
	const result = {} as Record<HarnessMode, Record<ProbeKind, string>>;
	for (const mode of HARNESS_MODES) {
		const modeValue = value[mode];
		if (!isRecord(modeValue)) {
			throw new Error(`harness_probe_reports.${mode} must be an object`);
		}
		assertExactKeys(modeValue, PROBE_KINDS, `harness_probe_reports.${mode}`);
		result[mode] = {
			base: evidencePath(modeValue.base, `harness_probe_reports.${mode}.base`),
			no_op: evidencePath(modeValue.no_op, `harness_probe_reports.${mode}.no_op`),
			malformed: evidencePath(modeValue.malformed, `harness_probe_reports.${mode}.malformed`),
			gold: evidencePath(modeValue.gold, `harness_probe_reports.${mode}.gold`),
		};
	}
	return result;
}

export function verifyTaskEnvironmentLockEvidenceManifest(value: unknown): TaskEnvironmentLockEvidenceManifest {
	if (!isRecord(value)) {
		throw new Error("Task environment lock evidence manifest must be an object");
	}
	assertExactKeys(value, MANIFEST_KEYS, "Task environment lock evidence manifest");
	if (value.schema_version !== "v1" || value.manifest_type !== "task_environment_lock_create") {
		throw new Error("Task environment lock evidence manifest metadata is invalid");
	}
	return {
		schema_version: "v1",
		manifest_type: "task_environment_lock_create",
		dataset_lock: evidencePath(value.dataset_lock, "dataset_lock"),
		official_image_source_lock: evidencePath(value.official_image_source_lock, "official_image_source_lock"),
		official_harness_source_lock: evidencePath(value.official_harness_source_lock, "official_harness_source_lock"),
		candidate: evidencePath(value.candidate, "candidate"),
		factory_probe_report: evidencePath(value.factory_probe_report, "factory_probe_report"),
		harness_equivalence_report: evidencePath(value.harness_equivalence_report, "harness_equivalence_report"),
		pristine_runtime_lock: evidencePath(value.pristine_runtime_lock, "pristine_runtime_lock"),
		harness_probe_reports: probePathMatrix(value.harness_probe_reports),
	};
}

export function taskEnvironmentLockEvidenceManifestPaths(
	manifest: TaskEnvironmentLockEvidenceManifest,
): readonly string[] {
	return [
		manifest.dataset_lock,
		manifest.official_image_source_lock,
		manifest.official_harness_source_lock,
		manifest.candidate,
		manifest.factory_probe_report,
		manifest.harness_equivalence_report,
		manifest.pristine_runtime_lock,
		...HARNESS_MODES.flatMap((mode) => PROBE_KINDS.map((kind) => manifest.harness_probe_reports[mode][kind])),
	];
}

export function verifyDistinctTaskEnvironmentLockEvidencePaths(paths: readonly string[]): void {
	if (paths.length !== 15 || new Set(paths).size !== paths.length) {
		throw new Error("Task environment lock requires 15 distinct resolved evidence files");
	}
}

export async function loadTaskEnvironmentLockRawEvidence(
	manifest: TaskEnvironmentLockEvidenceManifest,
	loader: TaskEnvironmentLockEvidenceLoader,
): Promise<LoadedTaskEnvironmentLockRawEvidence> {
	const requestedPaths = taskEnvironmentLockEvidenceManifestPaths(manifest);
	const resolvedPaths = await Promise.all(
		requestedPaths.map((path) => loader.resolveInputPath(loader.artifactsRoot, path)),
	);
	verifyDistinctTaskEnvironmentLockEvidencePaths(resolvedPaths);
	const contents = await Promise.all(resolvedPaths.map((path) => loader.readInputFile(path)));
	const contentByRequestedPath = new Map(requestedPaths.map((path, index) => [path, contents[index]!] as const));
	const contentFor = (path: string): string => {
		const content = contentByRequestedPath.get(path);
		if (content === undefined) {
			throw new Error(`Task environment evidence was not loaded: ${path}`);
		}
		return content;
	};
	return {
		resolvedPaths,
		evidence: {
			dataset_lock_json: contentFor(manifest.dataset_lock),
			official_image_source_lock_json: contentFor(manifest.official_image_source_lock),
			official_harness_source_lock_json: contentFor(manifest.official_harness_source_lock),
			candidate_json: contentFor(manifest.candidate),
			factory_probe_report_json: contentFor(manifest.factory_probe_report),
			harness_equivalence_report_json: contentFor(manifest.harness_equivalence_report),
			pristine_runtime_lock_json: contentFor(manifest.pristine_runtime_lock),
			harness_probe_report_json: {
				pristine: {
					base: contentFor(manifest.harness_probe_reports.pristine.base),
					no_op: contentFor(manifest.harness_probe_reports.pristine.no_op),
					malformed: contentFor(manifest.harness_probe_reports.pristine.malformed),
					gold: contentFor(manifest.harness_probe_reports.pristine.gold),
				},
				adapted: {
					base: contentFor(manifest.harness_probe_reports.adapted.base),
					no_op: contentFor(manifest.harness_probe_reports.adapted.no_op),
					malformed: contentFor(manifest.harness_probe_reports.adapted.malformed),
					gold: contentFor(manifest.harness_probe_reports.adapted.gold),
				},
			},
		},
	};
}

function operationIdFromFactoryReport(value: unknown): string {
	if (!isRecord(value) || typeof value.operation_id !== "string" || !OPERATION_ID_PATTERN.test(value.operation_id)) {
		throw new Error("Factory probe report does not contain a valid operation ID");
	}
	return value.operation_id;
}

function exactFileSha256(content: string): string {
	return taskEnvironmentEvidenceFileHash(content);
}

function verifyProbeMatrix(
	evidence: TaskEnvironmentLockRawEvidence,
	runtimeLockFileSha256: string,
	officialHarnessSourceLockSha256: string,
): Readonly<Record<HarnessMode, readonly HarnessProbeReport[]>> {
	const result = {} as Record<HarnessMode, HarnessProbeReport[]>;
	for (const mode of HARNESS_MODES) {
		const reports: HarnessProbeReport[] = [];
		for (const kind of PROBE_KINDS) {
			const report = verifyHarnessProbeReport(
				parseJson(evidence.harness_probe_report_json[mode][kind], `${mode}.${kind} harness probe report`),
			);
			if (report.harness_mode !== mode || report.probe_kind !== kind) {
				throw new Error(`${mode}.${kind} harness probe report is in the wrong manifest slot`);
			}
			if (report.pristine_runtime_lock_sha256 !== runtimeLockFileSha256) {
				throw new Error(`${mode}.${kind} harness probe does not bind the exact pristine runtime lock file`);
			}
			if (report.official_source_lock_sha256 !== officialHarnessSourceLockSha256) {
				throw new Error(`${mode}.${kind} harness probe does not bind the official harness semantic lock`);
			}
			reports.push(report);
		}
		result[mode] = reports;
	}
	return result;
}

export function createTaskEnvironmentLockFromRawEvidence(
	evidence: TaskEnvironmentLockRawEvidence,
	createdAt: string,
): TaskEnvironmentLock {
	const officialHarnessSourceLock = verifyOfficialHarnessSourceLock(
		parseJson(evidence.official_harness_source_lock_json, "Official harness source lock"),
	);
	const officialHarnessSourceLockFileSha256 = exactFileSha256(evidence.official_harness_source_lock_json);
	const pristineRuntimeLock = verifyPristineRuntimeLock(
		parseJson(evidence.pristine_runtime_lock_json, "Pristine runtime lock"),
	);
	const pristineRuntimeLockFileSha256 = exactFileSha256(evidence.pristine_runtime_lock_json);
	if (pristineRuntimeLock.provenance.source_lock_file_sha256 !== officialHarnessSourceLockFileSha256) {
		throw new Error("Pristine runtime lock does not bind the exact official harness source lock file");
	}
	if (pristineRuntimeLock.provenance.source_lock_sha256 !== officialHarnessSourceLock.lock_sha256) {
		throw new Error("Pristine runtime lock does not bind the official harness semantic lock");
	}

	const probes = verifyProbeMatrix(evidence, pristineRuntimeLockFileSha256, officialHarnessSourceLock.lock_sha256);
	const suppliedEquivalence = verifyHarnessEquivalenceReport(
		parseJson(evidence.harness_equivalence_report_json, "Harness equivalence report"),
	);
	if (suppliedEquivalence.pristine_runtime_lock_sha256 !== pristineRuntimeLockFileSha256) {
		throw new Error("Harness equivalence does not bind the exact pristine runtime lock file");
	}
	if (suppliedEquivalence.official_source_lock_sha256 !== officialHarnessSourceLock.lock_sha256) {
		throw new Error("Harness equivalence does not bind the official harness semantic lock");
	}
	const recomputedEquivalence = createHarnessEquivalenceReport(probes.pristine, probes.adapted);
	if (stableStringify(recomputedEquivalence) !== stableStringify(suppliedEquivalence)) {
		throw new Error("Supplied harness equivalence does not match the eight probe reports");
	}

	const candidateValue = parseJson(evidence.candidate_json, "Task environment candidate");
	const candidate = verifyTaskEnvironmentCandidate(candidateValue);
	const factoryReportValue = parseJson(evidence.factory_probe_report_json, "Factory probe report");
	const factoryRequest = createTaskRoleFactoryProbeRequest(
		candidate,
		operationIdFromFactoryReport(factoryReportValue),
	);
	verifyTaskRoleFactoryProbeReport(factoryReportValue, candidate, factoryRequest);

	return createTaskEnvironmentLock({
		created_at: createdAt,
		dataset_lock_json: evidence.dataset_lock_json,
		official_image_source_lock_json: evidence.official_image_source_lock_json,
		candidate: candidateValue,
		factory_probe_request: factoryRequest,
		factory_probe_report: factoryReportValue,
		harness_equivalence_report: suppliedEquivalence,
	});
}
