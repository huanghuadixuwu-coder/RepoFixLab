import { stableStringify } from "../contracts/schema-generator.ts";
import type { SmokeDoctorEvidenceInput } from "../doctor/smoke-doctor.ts";
import type { TaskEnvironmentLockRawEvidence } from "./task-environment-lock.ts";

export interface SmokeDoctorEvidenceManifest {
	readonly schema_version: "v1";
	readonly manifest_type: "smoke_doctor";
	readonly bootstrap_doctor_report: string;
	readonly bootstrap_provenance_lock: string;
	readonly task_environment_lock: string;
	readonly environment_lock_evidence_manifest: string;
}

const MANIFEST_KEYS = [
	"schema_version",
	"manifest_type",
	"bootstrap_doctor_report",
	"bootstrap_provenance_lock",
	"task_environment_lock",
	"environment_lock_evidence_manifest",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function verifySmokeDoctorEvidenceManifest(value: unknown): SmokeDoctorEvidenceManifest {
	if (!isRecord(value)) {
		throw new Error("Smoke Doctor evidence manifest must be an object");
	}
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...MANIFEST_KEYS].sort();
	if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
		throw new Error(`Smoke Doctor evidence manifest fields must be exactly ${expectedKeys.join(", ")}`);
	}
	if (value.schema_version !== "v1" || value.manifest_type !== "smoke_doctor") {
		throw new Error("Smoke Doctor evidence manifest metadata is invalid");
	}
	return {
		schema_version: "v1",
		manifest_type: "smoke_doctor",
		bootstrap_doctor_report: evidencePath(value.bootstrap_doctor_report, "bootstrap_doctor_report"),
		bootstrap_provenance_lock: evidencePath(value.bootstrap_provenance_lock, "bootstrap_provenance_lock"),
		task_environment_lock: evidencePath(value.task_environment_lock, "task_environment_lock"),
		environment_lock_evidence_manifest: evidencePath(
			value.environment_lock_evidence_manifest,
			"environment_lock_evidence_manifest",
		),
	};
}

export function smokeDoctorEvidenceManifestPaths(manifest: SmokeDoctorEvidenceManifest): readonly string[] {
	return [
		manifest.bootstrap_doctor_report,
		manifest.bootstrap_provenance_lock,
		manifest.task_environment_lock,
		manifest.environment_lock_evidence_manifest,
	];
}

export function verifyDistinctSmokeDoctorEvidencePaths(paths: readonly string[]): void {
	if (paths.length !== 20 || new Set(paths).size !== paths.length) {
		throw new Error("Smoke Doctor requires 20 distinct resolved manifest and evidence files");
	}
}

export function smokeDoctorEvidenceInput(
	bootstrapDoctorReportJson: string,
	bootstrapProvenanceLockJson: string,
	taskEnvironmentLockJson: string,
	evidence: TaskEnvironmentLockRawEvidence,
): SmokeDoctorEvidenceInput {
	return {
		bootstrap_doctor_report_json: bootstrapDoctorReportJson,
		bootstrap_provenance_lock_json: bootstrapProvenanceLockJson,
		dataset_lock_json: evidence.dataset_lock_json,
		official_image_source_lock_json: evidence.official_image_source_lock_json,
		task_environment_lock_json: taskEnvironmentLockJson,
		candidate: parseJson(evidence.candidate_json, "Task environment candidate"),
		factory_probe_report: parseJson(evidence.factory_probe_report_json, "Factory probe report"),
		pristine_runtime_lock_json: evidence.pristine_runtime_lock_json,
		official_harness_source_lock_json: evidence.official_harness_source_lock_json,
		harness_equivalence_report: parseJson(evidence.harness_equivalence_report_json, "Harness equivalence report"),
		harness_probe_reports: [
			parseJson(evidence.harness_probe_report_json.pristine.base, "pristine.base harness probe"),
			parseJson(evidence.harness_probe_report_json.pristine.no_op, "pristine.no_op harness probe"),
			parseJson(evidence.harness_probe_report_json.pristine.malformed, "pristine.malformed harness probe"),
			parseJson(evidence.harness_probe_report_json.pristine.gold, "pristine.gold harness probe"),
			parseJson(evidence.harness_probe_report_json.adapted.base, "adapted.base harness probe"),
			parseJson(evidence.harness_probe_report_json.adapted.no_op, "adapted.no_op harness probe"),
			parseJson(evidence.harness_probe_report_json.adapted.malformed, "adapted.malformed harness probe"),
			parseJson(evidence.harness_probe_report_json.adapted.gold, "adapted.gold harness probe"),
		],
	};
}
