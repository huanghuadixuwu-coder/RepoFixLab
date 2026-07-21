import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import {
	createHarnessEquivalenceReport,
	verifyHarnessEquivalenceReport,
	verifyHarnessProbeReport,
	verifyOfficialHarnessSourceLock,
} from "../contracts/harness-equivalence.ts";
import {
	officialImageSourceLockFileSha256,
	officialImageSourceLockSemanticSha256,
	verifyOfficialImageSourceLock,
} from "../contracts/official-image-source-lock.ts";
import { verifyPristineRuntimeLock } from "../contracts/pristine-runtime-lock.ts";
import { stableStringify } from "../contracts/schema-generator.ts";
import {
	taskEnvironmentEvidenceFileHash,
	taskEnvironmentLockFileHash,
	taskEnvironmentVerificationEvidenceHash,
	verifyDatasetLockForTaskEnvironment,
	verifyTaskEnvironmentLock,
} from "../contracts/task-environment-lock.ts";
import {
	controllerExecutionMountsMatchExactAllowlist,
	createTaskRoleFactoryProbeRequest,
	verifyTaskEnvironmentCandidate,
	verifyTaskRoleFactoryProbeReport,
} from "../contracts/task-role-factory-probe.ts";
import {
	AXIOS_HARNESS_ADAPTER_SHA256,
	AXIOS_SMOKE_INSTANCE_ID,
	CONTRACT_VERSION,
	DATASET_PREPARER_SELF_CHECK_CONSTANTS,
	type DatasetLock,
	type HarnessEquivalenceReport,
	type HarnessProbeReport,
	type OfficialHarnessSourceLock,
	type OfficialImageSourceLock,
	OfficialImageSourceLockSchema,
	type PristineRuntimeLock,
	type SmokeDoctorReport,
	SmokeDoctorReportSchema,
	SWE_BENCH_HARNESS_REVISION,
	type TaskEnvironmentCandidate,
	type TaskEnvironmentLock,
	type TaskRoleFactoryProbeReport,
} from "../contracts/v1.ts";
import type { BootstrapImageProvenanceLock } from "./image-provenance.ts";
import { parseBootstrapImageProvenanceLockFile } from "./image-provenance-lock-file.ts";
import { verifyBootstrapDoctorReport } from "./report.ts";

export interface SmokeDoctorEvidenceInput {
	readonly bootstrap_doctor_report_json: string;
	readonly bootstrap_provenance_lock_json: string;
	readonly dataset_lock_json: string;
	readonly official_image_source_lock_json: string;
	readonly task_environment_lock_json: string;
	readonly candidate: unknown;
	readonly factory_probe_report: unknown;
	readonly pristine_runtime_lock_json: string;
	readonly official_harness_source_lock_json: string;
	readonly harness_equivalence_report: unknown;
	readonly harness_probe_reports: unknown;
}

export interface SmokeDoctorRunMetadata {
	readonly reportId: string;
	readonly startedAt: string;
	readonly finishedAt: string;
}

type SmokeDoctorHardGate = SmokeDoctorReport["checks"][keyof SmokeDoctorReport["checks"]];
type SmokeDoctorArtifact = SmokeDoctorHardGate["artifacts"][number];
type SmokeDoctorFact = SmokeDoctorHardGate["facts"][number];

interface HardGateDraft {
	readonly artifacts: SmokeDoctorArtifact[];
	readonly facts: SmokeDoctorFact[];
	readonly errors: string[];
}

const officialImageSourceLockValidator = Compile(OfficialImageSourceLockSchema);
const smokeDoctorReportValidator = Compile(SmokeDoctorReportSchema);
const PROBE_ORDER = ["base", "no_op", "malformed", "gold"] as const;
const HARNESS_MODES = ["pristine", "adapted"] as const;
const FACTORY_EXECUTION_ORDER = ["worker", "evaluator"] as const;

export function factoryProbeExecutionOrderIsExact(value: readonly unknown[]): boolean {
	return (
		value.length === FACTORY_EXECUTION_ORDER.length &&
		value[0] === FACTORY_EXECUTION_ORDER[0] &&
		value[1] === FACTORY_EXECUTION_ORDER[1]
	);
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function smokeDoctorReportHash(value: Omit<SmokeDoctorReport, "report_sha256">): string {
	return sha256(stableStringify(value));
}

function parseRawJson(value: unknown, label: string): unknown {
	if (typeof value !== "string") {
		throw new Error(`${label} must be supplied as raw JSON text`);
	}
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${label} is not valid JSON text`);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createGate(): HardGateDraft {
	return { artifacts: [], facts: [], errors: [] };
}

function addArtifact(gate: HardGateDraft, name: string, value: string): void {
	gate.artifacts.push({ name, sha256: value });
}

function asFactValue(value: string | number | boolean | null | undefined): string | null {
	return value === null || value === undefined ? null : String(value);
}

function addFact(
	gate: HardGateDraft,
	name: string,
	expected: string | number | boolean | null,
	actual: string | number | boolean | null | undefined,
): void {
	const expectedValue = asFactValue(expected);
	const actualValue = asFactValue(actual);
	gate.facts.push({
		name,
		expected: expectedValue,
		actual: actualValue,
		matched: expectedValue !== null && actualValue !== null && expectedValue === actualValue,
	});
}

function addError(gate: HardGateDraft, label: string, error: unknown): void {
	gate.errors.push(`${label}: ${errorMessage(error)}`);
}

function finishGate(gate: HardGateDraft): SmokeDoctorHardGate {
	gate.artifacts.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	gate.facts.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	gate.errors.sort();
	return {
		state: gate.errors.length === 0 && gate.facts.every((fact) => fact.matched) ? "pass" : "fail",
		artifacts: gate.artifacts,
		facts: gate.facts,
		errors: gate.errors,
	};
}

function operationIdFrom(value: unknown): string | null {
	if (
		typeof value === "object" &&
		value !== null &&
		"operation_id" in value &&
		typeof value.operation_id === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value.operation_id)
	) {
		return value.operation_id;
	}
	return null;
}

function isValidTimestamp(value: string): boolean {
	return value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function verifyOfficialImageLock(value: unknown): OfficialImageSourceLock {
	if (!officialImageSourceLockValidator.Check(value)) {
		throw new Error("Official image source lock does not satisfy the strict v1 schema");
	}
	const image = value.images[0];
	if (value.images.length !== 1 || image === undefined) {
		throw new Error("Official image source lock must contain exactly one Axios image");
	}
	return verifyOfficialImageSourceLock(value, {
		datasetRevision: DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision,
		harnessRevision: SWE_BENCH_HARNESS_REVISION,
		images: [
			{
				imageKey: AXIOS_SMOKE_INSTANCE_ID,
				requestedReference: image.requested_reference,
				repositoryDigest: image.repository_digest,
				localImageId: image.local_image_id,
				platform: image.platform,
				registryResponseSha256: image.registry_response_sha256,
			},
		],
	});
}

function expectedDatasetFiles(): readonly Pick<DatasetLock["files"][number], "scope" | "path">[] {
	return [
		{ scope: "control", path: `tasks/${AXIOS_SMOKE_INSTANCE_ID}.json` },
		{ scope: "private", path: `tasks/${AXIOS_SMOKE_INSTANCE_ID}.json` },
		{ scope: "public", path: `tasks/${AXIOS_SMOKE_INSTANCE_ID}.json` },
	];
}

function hasRequiredDatasetFiles(lock: DatasetLock): boolean {
	const actual = new Set(lock.files.map(({ scope, path }) => `${scope}:${path}`));
	return expectedDatasetFiles().every(({ scope, path }) => actual.has(`${scope}:${path}`));
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

function addBootstrapServiceFacts(
	gate: HardGateDraft,
	service: "controller" | "orchestrator",
	lock: BootstrapImageProvenanceLock,
	report: ReturnType<typeof verifyBootstrapDoctorReport>,
): void {
	const expected = lock.services[service];
	const actual = report.checks.base_images.services[service];
	addFact(gate, `${service}.state`, "pass", actual.state);
	addFact(gate, `${service}.expected_image_id`, expected.expectedImageId, actual.expected_image_id);
	addFact(gate, `${service}.actual_image_id`, expected.expectedImageId, actual.actual_image_id);
	addFact(
		gate,
		`${service}.expected_compose_config_sha256`,
		expected.composeConfigSha256,
		actual.expected_compose_config_sha256,
	);
	addFact(
		gate,
		`${service}.actual_compose_config_sha256`,
		expected.composeConfigSha256,
		actual.actual_compose_config_sha256,
	);
}

export function runSmokeDoctor(input: SmokeDoctorEvidenceInput, metadata: SmokeDoctorRunMetadata): SmokeDoctorReport {
	const bootstrapGate = createGate();
	const datasetGate = createGate();
	const officialImageGate = createGate();
	const taskEnvironmentGate = createGate();
	const factoryGate = createGate();
	const controllerIdentityGate = createGate();
	const pristineRuntimeGate = createGate();
	const harnessMatrixGate = createGate();
	const harnessEquivalenceGate = createGate();
	const crossBindingsGate = createGate();

	let bootstrapReport: ReturnType<typeof verifyBootstrapDoctorReport> | undefined;
	let bootstrapLock: BootstrapImageProvenanceLock | undefined;
	let datasetLock: DatasetLock | undefined;
	let officialImageLock: OfficialImageSourceLock | undefined;
	let officialHarnessSourceLock: OfficialHarnessSourceLock | undefined;
	let candidate: TaskEnvironmentCandidate | undefined;
	let factoryReport: TaskRoleFactoryProbeReport | undefined;
	let taskEnvironmentLock: TaskEnvironmentLock | undefined;
	let pristineRuntimeLock: PristineRuntimeLock | undefined;
	let pristineRuntimeLockFileSha256: string | undefined;
	let officialHarnessSourceLockFileSha256: string | undefined;
	let equivalenceReport: HarnessEquivalenceReport | undefined;
	let recomputedEquivalence: HarnessEquivalenceReport | undefined;
	const probeReports = new Map<string, HarnessProbeReport>();
	const operationId = operationIdFrom(input.factory_probe_report);

	if (typeof input.bootstrap_doctor_report_json === "string") {
		addArtifact(bootstrapGate, "bootstrap_doctor_report.file", sha256(input.bootstrap_doctor_report_json));
	}
	try {
		bootstrapReport = verifyBootstrapDoctorReport(
			parseRawJson(input.bootstrap_doctor_report_json, "Bootstrap doctor report"),
		);
		addArtifact(bootstrapGate, "bootstrap_doctor_report.semantic", bootstrapReport.report_sha256);
	} catch (error) {
		addError(bootstrapGate, "bootstrap doctor report", error);
	}
	addFact(bootstrapGate, "bootstrap_doctor_report.contract_valid", true, bootstrapReport !== undefined);

	if (typeof input.bootstrap_provenance_lock_json === "string") {
		addArtifact(bootstrapGate, "bootstrap_provenance_lock.file", sha256(input.bootstrap_provenance_lock_json));
	}
	try {
		if (typeof input.bootstrap_provenance_lock_json !== "string") {
			throw new Error("Bootstrap provenance lock must be supplied as raw JSON text");
		}
		bootstrapLock = parseBootstrapImageProvenanceLockFile(input.bootstrap_provenance_lock_json);
		addArtifact(bootstrapGate, "bootstrap_provenance_lock.semantic", bootstrapLock.lockSha256);
	} catch (error) {
		addError(bootstrapGate, "bootstrap provenance lock", error);
	}
	addFact(bootstrapGate, "bootstrap_provenance_lock.contract_valid", true, bootstrapLock !== undefined);
	addFact(bootstrapGate, "bootstrap_doctor_report.status", "pass", bootstrapReport?.status);
	addFact(
		bootstrapGate,
		"bootstrap_provenance_lock.sha256",
		bootstrapLock?.lockSha256 ?? null,
		bootstrapReport?.checks.base_images.lock_sha256,
	);
	if (bootstrapReport !== undefined && bootstrapLock !== undefined) {
		addBootstrapServiceFacts(bootstrapGate, "controller", bootstrapLock, bootstrapReport);
		addBootstrapServiceFacts(bootstrapGate, "orchestrator", bootstrapLock, bootstrapReport);
	}

	if (typeof input.dataset_lock_json === "string") {
		addArtifact(datasetGate, "dataset_lock.file", taskEnvironmentEvidenceFileHash(input.dataset_lock_json));
	}
	try {
		datasetLock = verifyDatasetLockForTaskEnvironment(parseRawJson(input.dataset_lock_json, "Dataset lock"));
		addArtifact(datasetGate, "dataset_lock.aggregate", datasetLock.aggregate_sha256);
		addArtifact(datasetGate, "dataset_lock.ready", datasetLock.ready.sha256);
		addArtifact(datasetGate, "dataset_lock.seal", datasetLock.seal.sha256);
	} catch (error) {
		addError(datasetGate, "dataset lock", error);
	}
	addFact(datasetGate, "contract_valid", true, datasetLock !== undefined);
	addFact(datasetGate, "dataset_name", DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetName, datasetLock?.dataset.name);
	addFact(
		datasetGate,
		"dataset_revision",
		DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision,
		datasetLock?.dataset.revision,
	);
	addFact(
		datasetGate,
		"record_count",
		DATASET_PREPARER_SELF_CHECK_CONSTANTS.expectedRecordCount,
		datasetLock?.record_count,
	);
	addFact(
		datasetGate,
		"required_axios_descriptors_present",
		true,
		datasetLock === undefined ? null : hasRequiredDatasetFiles(datasetLock),
	);

	if (typeof input.official_image_source_lock_json === "string") {
		addArtifact(
			officialImageGate,
			"official_image_source_lock.file",
			officialImageSourceLockFileSha256(input.official_image_source_lock_json),
		);
	}
	try {
		officialImageLock = verifyOfficialImageLock(
			parseRawJson(input.official_image_source_lock_json, "Official image source lock"),
		);
		addArtifact(
			officialImageGate,
			"official_image_source_lock.semantic",
			officialImageSourceLockSemanticSha256(officialImageLock),
		);
	} catch (error) {
		addError(officialImageGate, "official image source lock", error);
	}
	const officialImage = officialImageLock?.images[0];
	addFact(officialImageGate, "contract_valid", true, officialImageLock !== undefined);
	addFact(
		officialImageGate,
		"dataset_revision",
		DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision,
		officialImageLock?.dataset_revision,
	);
	addFact(officialImageGate, "harness_revision", SWE_BENCH_HARNESS_REVISION, officialImageLock?.harness_revision);
	addFact(officialImageGate, "image_key", AXIOS_SMOKE_INSTANCE_ID, officialImage?.image_key);
	addFact(officialImageGate, "platform", "linux/amd64", officialImage?.platform);

	try {
		candidate = verifyTaskEnvironmentCandidate(input.candidate);
	} catch (error) {
		addError(factoryGate, "task environment candidate", error);
	}
	addFact(factoryGate, "candidate.contract_valid", true, candidate !== undefined);
	let factoryRequest: ReturnType<typeof createTaskRoleFactoryProbeRequest> | undefined;
	if (candidate !== undefined && operationId !== null) {
		try {
			factoryRequest = createTaskRoleFactoryProbeRequest(candidate, operationId);
			addArtifact(factoryGate, "factory_probe.request", factoryRequest.request_sha256);
			factoryReport = verifyTaskRoleFactoryProbeReport(input.factory_probe_report, candidate, factoryRequest);
			addArtifact(factoryGate, "factory_probe.report", factoryReport.report_sha256);
		} catch (error) {
			addError(factoryGate, "factory probe", error);
		}
	} else {
		addError(factoryGate, "factory probe", "A verified candidate and valid operation ID are required");
	}
	addFact(factoryGate, "report.contract_valid", true, factoryReport !== undefined);
	addFact(factoryGate, "report.status", "pass", factoryReport?.status);
	const expectedFactoryExecutionOrder = stableStringify(FACTORY_EXECUTION_ORDER);
	addFact(
		factoryGate,
		"execution_order",
		expectedFactoryExecutionOrder,
		factoryReport === undefined
			? null
			: factoryProbeExecutionOrderIsExact(factoryReport.execution_order)
				? expectedFactoryExecutionOrder
				: stableStringify(factoryReport.execution_order),
	);
	addFact(
		factoryGate,
		"worker.cleanup_residual_containers",
		0,
		factoryReport?.roles.worker.cleanup.residual_container_ids.length,
	);
	addFact(
		factoryGate,
		"worker.cleanup_residual_volumes",
		0,
		factoryReport?.roles.worker.cleanup.residual_volume_names.length,
	);
	addFact(factoryGate, "worker.cleanup_errors", 0, factoryReport?.roles.worker.cleanup.errors.length);
	addFact(
		factoryGate,
		"evaluator.cleanup_residual_containers",
		0,
		factoryReport?.roles.evaluator.cleanup.residual_container_ids.length,
	);
	addFact(
		factoryGate,
		"evaluator.cleanup_residual_volumes",
		0,
		factoryReport?.roles.evaluator.cleanup.residual_volume_names.length,
	);
	addFact(factoryGate, "evaluator.cleanup_errors", 0, factoryReport?.roles.evaluator.cleanup.errors.length);
	addFact(
		factoryGate,
		"role_container_ids_distinct",
		true,
		factoryReport?.roles.worker.container_id !== null &&
			factoryReport?.roles.evaluator.container_id !== null &&
			factoryReport?.roles.worker.container_id !== factoryReport?.roles.evaluator.container_id,
	);
	const workerVolumes = factoryReport?.roles.worker.cleanup.created_volume_names ?? [];
	const evaluatorVolumes = factoryReport?.roles.evaluator.cleanup.created_volume_names ?? [];
	addFact(
		factoryGate,
		"role_created_volumes_independent",
		true,
		factoryReport === undefined
			? null
			: workerVolumes.length === 1 && evaluatorVolumes.length === 1 && workerVolumes[0] !== evaluatorVolumes[0],
	);
	addFact(
		bootstrapGate,
		"finished_before_factory_started",
		true,
		bootstrapReport === undefined || factoryReport === undefined
			? null
			: Date.parse(bootstrapReport.finished_at) <= Date.parse(factoryReport.started_at),
	);

	if (bootstrapLock !== undefined) {
		addArtifact(controllerIdentityGate, "bootstrap_provenance_lock.semantic", bootstrapLock.lockSha256);
	}
	if (factoryReport !== undefined) {
		addArtifact(controllerIdentityGate, "factory_probe.report", factoryReport.report_sha256);
	}
	const controllerExecution = factoryReport?.controller_execution;
	addFact(controllerIdentityGate, "identity_available", true, controllerExecution !== undefined);
	addFact(
		controllerIdentityGate,
		"controller_image_id",
		bootstrapLock?.services.controller.expectedImageId ?? null,
		controllerExecution?.image_id,
	);
	addFact(
		controllerIdentityGate,
		"controller_compose_config_sha256",
		bootstrapLock?.services.controller.composeConfigSha256 ?? null,
		controllerExecution?.compose_config_sha256,
	);
	addFact(
		controllerIdentityGate,
		"bootstrap_report_controller_image_id",
		bootstrapReport?.checks.base_images.services.controller.actual_image_id ?? null,
		controllerExecution?.image_id,
	);
	addFact(
		controllerIdentityGate,
		"bootstrap_report_controller_compose_config_sha256",
		bootstrapReport?.checks.base_images.services.controller.actual_compose_config_sha256 ?? null,
		controllerExecution?.compose_config_sha256,
	);
	addFact(
		controllerIdentityGate,
		"compose_project",
		bootstrapLock?.composeProject ?? null,
		controllerExecution?.compose_project,
	);
	addFact(
		controllerIdentityGate,
		"controller_mount_allowlist_exact",
		true,
		controllerExecution === undefined ? null : controllerExecutionMountsMatchExactAllowlist(controllerExecution),
	);

	if (typeof input.pristine_runtime_lock_json === "string") {
		pristineRuntimeLockFileSha256 = taskEnvironmentEvidenceFileHash(input.pristine_runtime_lock_json);
		addArtifact(pristineRuntimeGate, "pristine_runtime_lock.file", pristineRuntimeLockFileSha256);
	}
	try {
		pristineRuntimeLock = verifyPristineRuntimeLock(
			parseRawJson(input.pristine_runtime_lock_json, "Pristine runtime lock"),
		);
		addArtifact(pristineRuntimeGate, "pristine_runtime_lock.semantic", pristineRuntimeLock.semantic_sha256);
		addArtifact(pristineRuntimeGate, "pristine_runtime_image", pristineRuntimeLock.image.id.slice("sha256:".length));
	} catch (error) {
		addError(pristineRuntimeGate, "pristine runtime lock", error);
	}
	addFact(pristineRuntimeGate, "contract_valid", true, pristineRuntimeLock !== undefined);
	addFact(pristineRuntimeGate, "platform", "linux/amd64", pristineRuntimeLock?.image.platform);
	addFact(pristineRuntimeGate, "runtime_user", "65532:65532", pristineRuntimeLock?.image.configured_user);
	addFact(pristineRuntimeGate, "oracle_runtime_user", "0:0", pristineRuntimeLock?.image.oracle_runtime_user);
	addFact(
		pristineRuntimeGate,
		"harness_revision",
		SWE_BENCH_HARNESS_REVISION,
		pristineRuntimeLock?.provenance.upstream_revision,
	);

	if (typeof input.official_harness_source_lock_json === "string") {
		officialHarnessSourceLockFileSha256 = taskEnvironmentEvidenceFileHash(input.official_harness_source_lock_json);
		addArtifact(pristineRuntimeGate, "official_harness_source_lock.file", officialHarnessSourceLockFileSha256);
	}
	try {
		officialHarnessSourceLock = verifyOfficialHarnessSourceLock(
			parseRawJson(input.official_harness_source_lock_json, "Official harness source lock"),
		);
		addArtifact(pristineRuntimeGate, "official_harness_source_lock.semantic", officialHarnessSourceLock.lock_sha256);
	} catch (error) {
		addError(pristineRuntimeGate, "official harness source lock", error);
	}
	addFact(
		pristineRuntimeGate,
		"official_harness_source_lock.contract_valid",
		true,
		officialHarnessSourceLock !== undefined,
	);
	addFact(
		pristineRuntimeGate,
		"official_harness_source_lock.file_sha256",
		officialHarnessSourceLockFileSha256 ?? null,
		pristineRuntimeLock?.provenance.source_lock_file_sha256,
	);
	addFact(
		pristineRuntimeGate,
		"official_harness_source_lock.semantic_sha256",
		officialHarnessSourceLock?.lock_sha256 ?? null,
		pristineRuntimeLock?.provenance.source_lock_sha256,
	);

	try {
		equivalenceReport = verifyHarnessEquivalenceReport(input.harness_equivalence_report);
		addArtifact(harnessEquivalenceGate, "harness_equivalence.report", equivalenceReport.report_sha256);
	} catch (error) {
		addError(harnessEquivalenceGate, "harness equivalence", error);
	}
	addFact(harnessEquivalenceGate, "contract_valid", true, equivalenceReport !== undefined);
	addFact(harnessEquivalenceGate, "status", "pass", equivalenceReport?.status);
	addFact(harnessEquivalenceGate, "probe_count", 4, equivalenceReport?.probes.length);
	addFact(
		harnessEquivalenceGate,
		"pristine_runtime_lock_sha256",
		pristineRuntimeLockFileSha256 ?? null,
		equivalenceReport?.pristine_runtime_lock_sha256,
	);
	addFact(
		harnessEquivalenceGate,
		"official_source_lock_sha256",
		officialHarnessSourceLock?.lock_sha256 ?? null,
		equivalenceReport?.official_source_lock_sha256,
	);

	if (!Array.isArray(input.harness_probe_reports)) {
		addError(harnessMatrixGate, "harness probe matrix", "Harness probe reports must be an array");
	} else {
		for (const [index, value] of input.harness_probe_reports.entries()) {
			try {
				const report = verifyHarnessProbeReport(value);
				const key = `${report.harness_mode}:${report.probe_kind}`;
				if (probeReports.has(key)) {
					throw new Error(`Duplicate harness probe scenario ${key}`);
				}
				probeReports.set(key, report);
				addArtifact(harnessMatrixGate, `probe.${report.harness_mode}.${report.probe_kind}`, report.report_sha256);
			} catch (error) {
				addError(harnessMatrixGate, `harness probe ${index}`, error);
			}
		}
	}
	addFact(
		harnessMatrixGate,
		"input_count",
		8,
		Array.isArray(input.harness_probe_reports) ? input.harness_probe_reports.length : null,
	);
	addFact(harnessMatrixGate, "unique_scenario_count", 8, probeReports.size);
	for (const mode of HARNESS_MODES) {
		for (const kind of PROBE_ORDER) {
			const report = probeReports.get(`${mode}:${kind}`);
			addFact(harnessMatrixGate, `${mode}.${kind}.present`, true, report !== undefined);
			addFact(
				harnessMatrixGate,
				`${mode}.${kind}.runtime_lock`,
				pristineRuntimeLockFileSha256 ?? null,
				report?.pristine_runtime_lock_sha256,
			);
			addFact(
				harnessMatrixGate,
				`${mode}.${kind}.official_source_lock`,
				officialHarnessSourceLock?.lock_sha256 ?? null,
				report?.official_source_lock_sha256,
			);
			addFact(
				harnessMatrixGate,
				`${mode}.${kind}.adapter_sha256`,
				mode === "pristine" ? "none" : AXIOS_HARNESS_ADAPTER_SHA256,
				report === undefined ? null : (report.adapter_sha256 ?? "none"),
			);
		}
	}
	const pristineReports = PROBE_ORDER.map((kind) => probeReports.get(`pristine:${kind}`));
	const adaptedReports = PROBE_ORDER.map((kind) => probeReports.get(`adapted:${kind}`));
	if (
		pristineReports.every((report) => report !== undefined) &&
		adaptedReports.every((report) => report !== undefined)
	) {
		try {
			recomputedEquivalence = createHarnessEquivalenceReport(pristineReports, adaptedReports);
			addArtifact(harnessMatrixGate, "harness_equivalence.recomputed", recomputedEquivalence.report_sha256);
		} catch (error) {
			addError(harnessMatrixGate, "recomputed harness equivalence", error);
		}
	}
	addFact(harnessMatrixGate, "recomputed_equivalence.status", "pass", recomputedEquivalence?.status);
	addFact(
		harnessMatrixGate,
		"supplied_equivalence_matches_recomputed",
		true,
		equivalenceReport === undefined || recomputedEquivalence === undefined
			? null
			: sameCanonicalValue(equivalenceReport, recomputedEquivalence),
	);

	addArtifact(
		taskEnvironmentGate,
		"task_environment_lock.file",
		taskEnvironmentEvidenceFileHash(input.task_environment_lock_json),
	);
	if (factoryRequest !== undefined) {
		try {
			taskEnvironmentLock = verifyTaskEnvironmentLock(
				parseRawJson(input.task_environment_lock_json, "Task environment lock"),
				{
					dataset_lock_json: input.dataset_lock_json,
					official_image_source_lock_json: input.official_image_source_lock_json,
					candidate: input.candidate,
					factory_probe_request: factoryRequest,
					factory_probe_report: input.factory_probe_report,
					harness_equivalence_report: input.harness_equivalence_report,
				},
			);
			addArtifact(
				taskEnvironmentGate,
				"task_environment_lock.canonical",
				taskEnvironmentLockFileHash(taskEnvironmentLock),
			);
			addArtifact(taskEnvironmentGate, "task_environment_lock.seal", taskEnvironmentLock.seal_sha256);
		} catch (error) {
			addError(taskEnvironmentGate, "task environment lock", error);
		}
	} else {
		addError(
			taskEnvironmentGate,
			"task environment lock",
			"A canonical factory probe request could not be reconstructed",
		);
	}
	addFact(taskEnvironmentGate, "contract_valid", true, taskEnvironmentLock !== undefined);
	addFact(taskEnvironmentGate, "instance_id", AXIOS_SMOKE_INSTANCE_ID, taskEnvironmentLock?.instance_id);
	addFact(taskEnvironmentGate, "candidate_id", candidate?.candidate_id ?? null, taskEnvironmentLock?.candidate_id);
	addFact(taskEnvironmentGate, "factory_probe_passed", true, taskEnvironmentLock?.verification.factory_probe_passed);
	addFact(taskEnvironmentGate, "equivalence_passed", true, taskEnvironmentLock?.verification.equivalence_passed);

	addFact(
		crossBindingsGate,
		"dataset_lock_file_sha256",
		typeof input.dataset_lock_json === "string" ? taskEnvironmentEvidenceFileHash(input.dataset_lock_json) : null,
		candidate?.dataset_lock.lock_sha256,
	);
	addFact(
		crossBindingsGate,
		"official_image_source_lock_file_sha256",
		typeof input.official_image_source_lock_json === "string"
			? taskEnvironmentEvidenceFileHash(input.official_image_source_lock_json)
			: null,
		candidate?.official_image_source_lock.lock_sha256,
	);
	addFact(crossBindingsGate, "dataset_lock_id", datasetLock?.lock_id ?? null, candidate?.dataset_lock.lock_id);
	addFact(
		crossBindingsGate,
		"official_image_source_lock_id",
		officialImageLock?.lock_id ?? null,
		candidate?.official_image_source_lock.lock_id,
	);
	addFact(crossBindingsGate, "candidate_id", candidate?.candidate_id ?? null, taskEnvironmentLock?.candidate_id);
	addFact(
		crossBindingsGate,
		"factory_probe_report_sha256",
		factoryReport?.report_sha256 ?? null,
		taskEnvironmentLock?.verification.factory_probe_report_sha256,
	);
	let taskEnvironmentEvidenceSha256: string | undefined;
	if (factoryRequest !== undefined) {
		try {
			taskEnvironmentEvidenceSha256 = taskEnvironmentVerificationEvidenceHash({
				dataset_lock_json: input.dataset_lock_json,
				official_image_source_lock_json: input.official_image_source_lock_json,
				candidate: input.candidate,
				factory_probe_request: factoryRequest,
				factory_probe_report: input.factory_probe_report,
				harness_equivalence_report: input.harness_equivalence_report,
			});
		} catch (error) {
			addError(crossBindingsGate, "task environment evidence", error);
		}
	}
	addFact(
		crossBindingsGate,
		"task_environment_evidence_sha256",
		taskEnvironmentEvidenceSha256 ?? null,
		taskEnvironmentLock?.verification.evidence_sha256,
	);
	addFact(
		crossBindingsGate,
		"source_image_id",
		officialImage?.local_image_id ?? null,
		taskEnvironmentLock?.source_image.local_image_id,
	);
	addFact(
		crossBindingsGate,
		"pristine_runtime_lock_sha256",
		pristineRuntimeLockFileSha256 ?? null,
		equivalenceReport?.pristine_runtime_lock_sha256,
	);
	addFact(
		crossBindingsGate,
		"official_harness_source_lock_sha256",
		officialHarnessSourceLock?.lock_sha256 ?? null,
		equivalenceReport?.official_source_lock_sha256,
	);

	const checks: SmokeDoctorReport["checks"] = {
		bootstrap_control_plane: finishGate(bootstrapGate),
		dataset_lock: finishGate(datasetGate),
		official_image_source_lock: finishGate(officialImageGate),
		task_environment_lock: finishGate(taskEnvironmentGate),
		factory_probe: finishGate(factoryGate),
		factory_controller_identity: finishGate(controllerIdentityGate),
		pristine_runtime_lock: finishGate(pristineRuntimeGate),
		harness_probe_matrix: finishGate(harnessMatrixGate),
		harness_equivalence: finishGate(harnessEquivalenceGate),
		cross_bindings: finishGate(crossBindingsGate),
	};
	const unsignedReport: Omit<SmokeDoctorReport, "report_sha256"> = {
		schema_version: CONTRACT_VERSION,
		report_type: "smoke_doctor",
		report_id: metadata.reportId,
		status: Object.values(checks).every((check) => check.state === "pass") ? "pass" : "fail",
		started_at: metadata.startedAt,
		finished_at: metadata.finishedAt,
		instance_id: AXIOS_SMOKE_INSTANCE_ID,
		operation_id: operationId,
		checks,
	};
	return verifySmokeDoctorReport({
		...unsignedReport,
		report_sha256: smokeDoctorReportHash(unsignedReport),
	});
}

function isSortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export function verifySmokeDoctorReport(value: unknown): SmokeDoctorReport {
	if (!smokeDoctorReportValidator.Check(value)) {
		throw new Error("Smoke Doctor report does not satisfy the strict v1 schema");
	}
	if (
		!isValidTimestamp(value.started_at) ||
		!isValidTimestamp(value.finished_at) ||
		Date.parse(value.started_at) > Date.parse(value.finished_at)
	) {
		throw new Error("Smoke Doctor report timestamps are invalid or reversed");
	}
	for (const [name, check] of Object.entries(value.checks)) {
		if (!isSortedUnique(check.artifacts.map((artifact) => artifact.name))) {
			throw new Error(`Smoke Doctor ${name} artifacts must have sorted unique names`);
		}
		if (!isSortedUnique(check.facts.map((fact) => fact.name))) {
			throw new Error(`Smoke Doctor ${name} facts must have sorted unique names`);
		}
		if (!isSortedUnique(check.errors)) {
			throw new Error(`Smoke Doctor ${name} errors must be sorted and unique`);
		}
		for (const fact of check.facts) {
			const expectedMatch = fact.expected !== null && fact.actual !== null && fact.expected === fact.actual;
			if (fact.matched !== expectedMatch) {
				throw new Error(`Smoke Doctor ${name}.${fact.name} matched flag is not derived`);
			}
		}
		const expectedState = check.errors.length === 0 && check.facts.every((fact) => fact.matched) ? "pass" : "fail";
		if (check.state !== expectedState) {
			throw new Error(`Smoke Doctor ${name} state is not derived from its hard-gate evidence`);
		}
	}
	const expectedStatus = Object.values(value.checks).every((check) => check.state === "pass") ? "pass" : "fail";
	if (value.status !== expectedStatus) {
		throw new Error("Smoke Doctor status is not derived from its hard-gate checks");
	}
	const { report_sha256: actualHash, ...unsignedReport } = value;
	if (smokeDoctorReportHash(unsignedReport) !== actualHash) {
		throw new Error("Smoke Doctor report SHA-256 does not match canonical content");
	}
	return value;
}
