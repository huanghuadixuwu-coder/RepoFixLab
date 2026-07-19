import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	DATASET_PREPARER_SELF_CHECK_CONSTANTS,
	type DatasetPreparerSelfCheckReport,
	DatasetPreparerSelfCheckReportSchema,
	datasetPreparerSelfCheckReportHash,
	verifyDatasetPreparerSelfCheckReport,
} from "../src/contracts/index.ts";

function passingUnsignedReport(): Omit<DatasetPreparerSelfCheckReport, "report_sha256"> {
	return {
		schema_version: "v1",
		report_type: "dataset_preparer_self_check",
		status: "pass",
		image_id: `sha256:${"a".repeat(64)}`,
		dataset: {
			name: DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetName,
			revision: DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision,
			source_sha256: DATASET_PREPARER_SELF_CHECK_CONSTANTS.sourceSha256,
			source_bytes: DATASET_PREPARER_SELF_CHECK_CONSTANTS.sourceBytes,
			expected_source_record_count: DATASET_PREPARER_SELF_CHECK_CONSTANTS.expectedSourceRecordCount,
			expected_record_count: DATASET_PREPARER_SELF_CHECK_CONSTANTS.expectedRecordCount,
			required_instance_id: DATASET_PREPARER_SELF_CHECK_CONSTANTS.requiredInstanceId,
		},
		runtime: {
			python_version: DATASET_PREPARER_SELF_CHECK_CONSTANTS.pythonVersion,
			pyarrow_version: DATASET_PREPARER_SELF_CHECK_CONSTANTS.pyarrowVersion,
			uid: DATASET_PREPARER_SELF_CHECK_CONSTANTS.uid,
			gid: DATASET_PREPARER_SELF_CHECK_CONSTANTS.gid,
		},
		checks: {
			image_id_bound: true,
			runtime_user: true,
			pyarrow_version: true,
			data_directories_exist: { public: true, control: true, private: true },
			docker_socket_absent: true,
			sensitive_environment_absent: true,
		},
		observations: {
			docker_socket_paths_present: [],
			sensitive_environment_names_present: [],
		},
		errors: [],
	};
}

function signedReport(value: Omit<DatasetPreparerSelfCheckReport, "report_sha256">): DatasetPreparerSelfCheckReport {
	return { ...value, report_sha256: datasetPreparerSelfCheckReportHash(value) };
}

describe("Dataset Preparer self-check v1 contract", () => {
	it("accepts and verifies a canonical passing report", () => {
		const report = signedReport(passingUnsignedReport());

		expect(Compile(DatasetPreparerSelfCheckReportSchema).Check(report)).toBe(true);
		expect(verifyDatasetPreparerSelfCheckReport(report)).toBe(report);
	});

	it("rejects unknown fields", () => {
		const report = signedReport(passingUnsignedReport());
		expect(Compile(DatasetPreparerSelfCheckReportSchema).Check({ ...report, trusted: true })).toBe(false);
	});

	it("rejects a report whose canonical content was modified after signing", () => {
		const report = signedReport(passingUnsignedReport());
		expect(() => verifyDatasetPreparerSelfCheckReport({ ...report, errors: ["tampered"] })).toThrow(
			"SHA-256 does not match",
		);
	});

	it("accepts a semantically consistent failed runtime-user report", () => {
		const passing = passingUnsignedReport();
		const failed = signedReport({
			...passing,
			status: "fail",
			runtime: { ...passing.runtime, uid: 0, gid: 0 },
			checks: { ...passing.checks, runtime_user: false },
		});

		expect(verifyDatasetPreparerSelfCheckReport(failed)).toBe(failed);
	});

	it("accepts a semantically consistent failed image-binding report", () => {
		const passing = passingUnsignedReport();
		const failed = signedReport({
			...passing,
			status: "fail",
			image_id: "sha256:not-an-id",
			checks: { ...passing.checks, image_id_bound: false },
			errors: ["REPOFIX_PREPARER_IMAGE_ID must be a lowercase sha256 image ID"],
		});

		expect(verifyDatasetPreparerSelfCheckReport(failed)).toBe(failed);
	});

	it("rejects pass when a sensitive environment variable is present", () => {
		const passing = passingUnsignedReport();
		const invalid = signedReport({
			...passing,
			observations: { ...passing.observations, sensitive_environment_names_present: ["ZHIPU_API_KEY"] },
			checks: { ...passing.checks, sensitive_environment_absent: false },
		});

		expect(() => verifyDatasetPreparerSelfCheckReport(invalid)).toThrow("status does not match");
	});

	it("rejects check booleans that contradict observations", () => {
		const passing = passingUnsignedReport();
		const invalid = signedReport({
			...passing,
			status: "fail",
			observations: { ...passing.observations, docker_socket_paths_present: ["/run/docker.sock"] },
		});

		expect(() => verifyDatasetPreparerSelfCheckReport(invalid)).toThrow(
			"Docker-socket check does not match observed paths",
		);
	});

	it("rejects drift in frozen dataset constants", () => {
		const passing = passingUnsignedReport();
		const invalid = {
			...passing,
			dataset: { ...passing.dataset, expected_record_count: 42 },
			report_sha256: "0".repeat(64),
		};

		expect(Compile(DatasetPreparerSelfCheckReportSchema).Check(invalid)).toBe(false);
	});
});
