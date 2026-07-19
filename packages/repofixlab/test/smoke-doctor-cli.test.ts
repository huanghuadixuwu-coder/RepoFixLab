import { describe, expect, it } from "vitest";
import {
	smokeDoctorEvidenceManifestPaths,
	verifyDistinctSmokeDoctorEvidencePaths,
	verifySmokeDoctorEvidenceManifest,
} from "../src/cli/smoke-doctor.ts";

function manifest() {
	return {
		schema_version: "v1",
		manifest_type: "smoke_doctor",
		bootstrap_doctor_report: "smoke/bootstrap-doctor.json",
		bootstrap_provenance_lock: "smoke/bootstrap-provenance-lock.json",
		task_environment_lock: "smoke/task-environment-lock.json",
		environment_lock_evidence_manifest: "smoke/environment-evidence-manifest.json",
	} as const;
}

describe("Smoke Doctor CLI evidence manifest", () => {
	it("accepts only the strict four-path manifest", () => {
		const value = manifest();
		expect(verifySmokeDoctorEvidenceManifest(value)).toEqual(value);
		expect(() => verifySmokeDoctorEvidenceManifest({ ...value, trusted: true })).toThrow("fields must be exactly");
		const { task_environment_lock: _taskEnvironmentLock, ...missing } = value;
		expect(() => verifySmokeDoctorEvidenceManifest(missing)).toThrow("fields must be exactly");
		expect(() => verifySmokeDoctorEvidenceManifest({ ...value, bootstrap_doctor_report: " " })).toThrow(
			"non-empty path",
		);
	});

	it("exposes the four referenced paths and requires global uniqueness with nested evidence", () => {
		expect(smokeDoctorEvidenceManifestPaths(manifest())).toEqual([
			"smoke/bootstrap-doctor.json",
			"smoke/bootstrap-provenance-lock.json",
			"smoke/task-environment-lock.json",
			"smoke/environment-evidence-manifest.json",
		]);
		const paths = Array.from({ length: 20 }, (_, index) => `/artifacts/evidence-${index}.json`);
		expect(() => verifyDistinctSmokeDoctorEvidencePaths(paths)).not.toThrow();
		expect(() => verifyDistinctSmokeDoctorEvidencePaths(paths.slice(1))).toThrow("20 distinct");
		expect(() => verifyDistinctSmokeDoctorEvidencePaths([...paths.slice(0, -1), paths[0]!])).toThrow("20 distinct");
	});
});
