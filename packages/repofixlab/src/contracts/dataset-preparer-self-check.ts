import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "./schema-generator.ts";
import {
	DATASET_PREPARER_SELF_CHECK_CONSTANTS,
	type DatasetPreparerSelfCheckReport,
	DatasetPreparerSelfCheckReportSchema,
	IMAGE_ID_PATTERN,
} from "./v1.ts";

const datasetPreparerSelfCheckReportValidator = Compile(DatasetPreparerSelfCheckReportSchema);
const imageIdPattern = new RegExp(IMAGE_ID_PATTERN);

export function datasetPreparerSelfCheckReportHash(
	value: Omit<DatasetPreparerSelfCheckReport, "report_sha256">,
): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	const canonicalJson = `${JSON.stringify(normalized)}\n`;
	return createHash("sha256").update(canonicalJson).digest("hex");
}

export function verifyDatasetPreparerSelfCheckReport(value: unknown): DatasetPreparerSelfCheckReport {
	if (!datasetPreparerSelfCheckReportValidator.Check(value)) {
		throw new Error("Dataset Preparer self-check report does not satisfy the v1 contract");
	}
	const { report_sha256: actualHash, ...unsignedReport } = value;
	if (datasetPreparerSelfCheckReportHash(unsignedReport) !== actualHash) {
		throw new Error("Dataset Preparer self-check report SHA-256 does not match its canonical content");
	}

	const imageIdBound = value.image_id !== null && imageIdPattern.test(value.image_id);
	const runtimeUser =
		value.runtime.uid === DATASET_PREPARER_SELF_CHECK_CONSTANTS.uid &&
		value.runtime.gid === DATASET_PREPARER_SELF_CHECK_CONSTANTS.gid;
	const pyarrowVersion = value.runtime.pyarrow_version === DATASET_PREPARER_SELF_CHECK_CONSTANTS.pyarrowVersion;
	const dockerSocketAbsent = value.observations.docker_socket_paths_present.length === 0;
	const sensitiveEnvironmentAbsent = value.observations.sensitive_environment_names_present.length === 0;

	if (value.checks.image_id_bound !== imageIdBound) {
		throw new Error("Dataset Preparer image binding check does not match its observation");
	}
	if (value.checks.runtime_user !== runtimeUser) {
		throw new Error("Dataset Preparer runtime-user check does not match uid/gid");
	}
	if (value.checks.pyarrow_version !== pyarrowVersion) {
		throw new Error("Dataset Preparer pyarrow check does not match the runtime version");
	}
	if (value.checks.docker_socket_absent !== dockerSocketAbsent) {
		throw new Error("Dataset Preparer Docker-socket check does not match observed paths");
	}
	if (value.checks.sensitive_environment_absent !== sensitiveEnvironmentAbsent) {
		throw new Error("Dataset Preparer sensitive-environment check does not match observed names");
	}

	const directoriesExist = Object.values(value.checks.data_directories_exist).every((exists) => exists);
	const passed =
		imageIdBound &&
		runtimeUser &&
		value.runtime.python_version === DATASET_PREPARER_SELF_CHECK_CONSTANTS.pythonVersion &&
		pyarrowVersion &&
		directoriesExist &&
		dockerSocketAbsent &&
		sensitiveEnvironmentAbsent &&
		value.errors.length === 0;
	if (value.status !== (passed ? "pass" : "fail")) {
		throw new Error("Dataset Preparer self-check status does not match its hard-gate evidence");
	}
	return value;
}
