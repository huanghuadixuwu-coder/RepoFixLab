#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, statfs, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createExperimentDryRunSummary,
	type ExperimentPlan,
	parseExperimentPlan,
} from "../contracts/experiment-plan.ts";
import { stableStringify } from "../contracts/schema-generator.ts";
import {
	createTaskEnvironmentCandidate,
	createTaskRoleFactoryProbeRequest,
	verifyTaskEnvironmentCandidate,
	verifyTaskRoleFactoryProbeReport,
} from "../contracts/task-role-factory-probe.ts";
import { verifyOfficialImageSourceLockSelfContained } from "../contracts/official-image-source-lock.ts";
import { DATASET_PREPARER_SELF_CHECK_CONSTANTS, SWE_BENCH_HARNESS_REVISION } from "../contracts/v1.ts";
import { verifyDatasetLockForTaskEnvironment } from "../contracts/task-environment-lock.ts";
import { readControllerBootstrapHealth } from "../controller/bootstrap-health.ts";
import {
	createBootstrapImageProvenanceLockFile,
	parseBootstrapImageProvenanceLockFile,
} from "../doctor/image-provenance-lock-file.ts";
import {
	type BootstrapDoctorDependencies,
	createBootstrapDoctorReport,
	runBootstrapDoctor,
	runSmokeDoctor,
} from "../doctor/index.ts";
import { createDefaultM1RunnerDependencies, type M1RunSummary, runM1Experiment } from "../runner/run-m1.ts";
import { parseCliArgs } from "./args.ts";
import {
	smokeDoctorEvidenceInput,
	smokeDoctorEvidenceManifestPaths,
	verifyDistinctSmokeDoctorEvidencePaths,
	verifySmokeDoctorEvidenceManifest,
} from "./smoke-doctor.ts";
import {
	createTaskEnvironmentLockFromRawEvidence,
	loadTaskEnvironmentLockRawEvidence,
	verifyTaskEnvironmentLockEvidenceManifest,
} from "./task-environment-lock.ts";
import {
	createM3RepoStratifiedSplit,
	parseM3SamplingMetadataJsonl,
	verifyM3EligibilityManifest,
	verifyM3RepoStratifiedSplit,
	type M3SplitManifest,
} from "../m3/split.ts";
import { createM6DevCalibrationBatch, verifyM6DevCalibrationBatch } from "../m6/calibration-cohort.ts";
import { createDefaultM6DevCalibrationDependencies, runM6DevCalibration } from "../m6/dev-calibration-runner.ts";
import { runM6DevCalibrationContinuation } from "../m6/dev-calibration-continuation.ts";

const DEFAULT_ARTIFACTS_ROOT = "/artifacts";
const DEFAULT_CONTROLLER_URL = "http://controller:8000";
const DEFAULT_IMAGE_PROVENANCE_LOCK_PATH = "locks/bootstrap-image-provenance-lock.v1.json";
const IMAGE_PROVENANCE_LOCK_PATH_PATTERN =
	/^locks\/bootstrap-image-provenance-lock\.v1(?:-[a-z0-9][a-z0-9-]{0,63})?\.json$/;
export const FACTORY_PROBE_TIMEOUT_MS = 3_900_000;
export const M3_IMAGE_RESOLUTION_TIMEOUT_MS = 3_900_000;
export const M3_IMAGE_RESOLUTION_REQUEST_TIMEOUT_MS = 120_000;
export const M3_IMAGE_RESOLUTION_POLL_INTERVAL_MS = 2_000;

export type ArtifactOutputMode = 0o600 | 0o644;

const PRIVATE_ARTIFACT_MODE: ArtifactOutputMode = 0o600;
const PUBLIC_CATALOG_MODE: ArtifactOutputMode = 0o644;

export interface FactoryProbeControllerRequest {
	readonly operation_id: string;
	readonly candidate_id: string;
	readonly instance_id: string;
}

export interface FactoryProbeControllerResponse {
	readonly status: number;
	readonly contentType: string | null;
	readonly idempotentReplay: string | null;
	readonly body: string;
}

export interface M3ImageResolutionControllerRequest {
	readonly schema_version: "v1";
	readonly request_type: "m3_official_image_resolution";
	readonly operation_id: string;
	readonly dataset_revision: string;
	readonly instance_ids: readonly string[];
}

export interface M3ImageResolutionControllerResponse {
	readonly status: number;
	readonly contentType: string | null;
	readonly idempotentReplay: string | null;
	readonly body: string;
}

interface M3ImageResolutionStatusRecord {
	readonly operation_id: string;
	readonly request_sha256: string;
	readonly status: "running" | "completed" | "failed";
	readonly total_image_count: number;
	readonly completed_image_count: number;
	readonly official_image_source_lock: unknown | null;
}

/**
 * The active control-plane lock is selected by Compose, while every lock file
 * remains immutable. A versioned path lets a rebuilt image advance without
 * overwriting the provenance evidence used by an earlier run.
 */
export function imageProvenanceLockPath(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment.REPOFIX_IMAGE_PROVENANCE_LOCK_PATH;
	if (configured === undefined) return DEFAULT_IMAGE_PROVENANCE_LOCK_PATH;
	if (!IMAGE_PROVENANCE_LOCK_PATH_PATTERN.test(configured)) {
		throw new Error("REPOFIX_IMAGE_PROVENANCE_LOCK_PATH must name a versioned lock beneath artifacts/locks");
	}
	return configured;
}

function readPackageVersion(): string {
	const value: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string") {
		throw new Error("RepoFixLab package.json does not contain a valid version");
	}
	return value.version;
}

const PACKAGE_VERSION = readPackageVersion();

const GENERAL_HELP = `RepoFixLab

Usage:
  repofixlab doctor --profile bootstrap [--output <path>]
  repofixlab doctor --profile smoke --input <smoke-manifest.json> --output <report.json>
  repofixlab doctor --profile formal [--output <path>]
  repofixlab candidate-create --input <build-input.json> --output <candidate.json>
  repofixlab environment-lock-create --input <evidence-manifest.json> --output <lock.json>
  repofixlab m3-split-create --input <dataset-lock.json> --eligibility <preflight-eligibility.json> --output <split-manifest.json>
  repofixlab m3-image-resolve --input <split-manifest.json> --eligibility <preflight-eligibility.json> --operation-id <id> --output <official-image-lock.json>
  repofixlab m6-batch-create --input <split-manifest.json> --output <calibration-batch.json>
  repofixlab m6-run --input <calibration-batch.json> [--resume <staging-run-directory>]
  repofixlab m6-continue --source-report <calibration-report.json> [--resume <staging-run-directory>]
  repofixlab factory-probe --candidate <candidate.json> --operation-id <id> --output <report.json>
  repofixlab provenance-lock --input <candidate.json> --output <lock.json>
  repofixlab run --config <experiment.yaml> [--dry-run]
  repofixlab --help
  repofixlab --version
`;

const DOCTOR_HELP = `Usage:
  repofixlab doctor --profile bootstrap [--output <path>]
  repofixlab doctor --profile smoke --input <smoke-manifest.json> --output <report.json>
  repofixlab doctor --profile formal [--output <path>]

Output paths are resolved beneath REPOFIX_ARTIFACTS_PATH.
Unavailable profiles fail closed; they never report a pass.
`;

const RUN_HELP = `Usage:
  repofixlab run --config <experiment.yaml> [--dry-run]

The config may be beneath REPOFIX_ARTIFACTS_PATH or one of the versioned
configs/experiments files in the RepoFixLab package. Dry-run validates the
matrix and reports its exact run and admission-cap totals without execution.
Non-dry-run executes the admitted M1 lifecycle and prints its terminal summary.
`;

export interface CliRuntime {
	readonly controllerUrl: string;
	readonly artifactsRoot: string;
	readonly now: () => Date;
	readonly randomId: () => string;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly readArtifactsStatFs: BootstrapDoctorDependencies["readArtifactsStatFs"];
	readonly readControllerHealth: BootstrapDoctorDependencies["readControllerHealth"];
	readonly readImageProvenanceLock: NonNullable<BootstrapDoctorDependencies["readImageProvenanceLock"]>;
	readonly readInputFile: (path: string) => Promise<string>;
	readonly readM3SamplingMetadata: () => Promise<string>;
	readonly requestFactoryProbe: (
		controllerUrl: string,
		request: FactoryProbeControllerRequest,
		timeoutMs: number,
	) => Promise<FactoryProbeControllerResponse>;
	readonly requestM3ImageResolution: (
		controllerUrl: string,
		request: M3ImageResolutionControllerRequest,
		timeoutMs: number,
	) => Promise<M3ImageResolutionControllerResponse>;
	readonly runExperiment: (
		plan: ExperimentPlan,
		artifactsRoot: string,
		controllerUrl: string,
	) => Promise<M1RunSummary>;
	readonly resolveInputPath: (artifactsRoot: string, requestedPath: string) => Promise<string>;
	readonly resolveRunConfigPath: (artifactsRoot: string, requestedPath: string) => Promise<string>;
	readonly resolveOutputPath: (artifactsRoot: string, requestedPath: string) => Promise<string>;
	readonly stderr: (text: string) => void;
	readonly stdout: (text: string) => void;
	readonly writeOutput: (path: string, content: string, mode: ArtifactOutputMode) => Promise<void>;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonContentType(value: string | null): boolean {
	if (value === null) return false;
	const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function parseM3ImageResolutionStatusRecord(
	value: unknown,
	request: M3ImageResolutionControllerRequest,
): M3ImageResolutionStatusRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Controller M3 image resolution returned an invalid status record");
	}
	const record = value as Record<string, unknown>;
	const status = record.status;
	const operationId = record.operation_id;
	const requestSha256 = record.request_sha256;
	const totalImageCount = record.total_image_count;
	const completedImageCount = record.completed_image_count;
	if (
		(status !== "running" && status !== "completed" && status !== "failed") ||
		operationId !== request.operation_id ||
		typeof requestSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(requestSha256) ||
		totalImageCount !== request.instance_ids.length ||
		typeof completedImageCount !== "number" ||
		!Number.isInteger(completedImageCount) ||
		completedImageCount < 0 ||
		completedImageCount > totalImageCount
	) {
		throw new Error("Controller M3 image resolution status does not bind the requested sealed task set");
	}
	const sourceLock = record.official_image_source_lock;
	if (status === "completed" && sourceLock === undefined) {
		throw new Error("Controller M3 image resolution completed without a source lock");
	}
	return {
		operation_id: operationId,
		request_sha256: requestSha256,
		status,
		total_image_count: totalImageCount,
		completed_image_count: completedImageCount,
		official_image_source_lock: sourceLock ?? null,
	};
}

async function requestFactoryProbe(
	controllerUrl: string,
	request: FactoryProbeControllerRequest,
	timeoutMs: number,
): Promise<FactoryProbeControllerResponse> {
	let response: Response;
	try {
		response = await fetch(new URL("/v1/factory/task-role-probes", controllerUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name =
			typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
				? error.name
				: "";
		if (name === "AbortError" || name === "TimeoutError") {
			throw new Error("Controller factory probe request timed out");
		}
		throw new Error("Controller factory probe request failed");
	}
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		idempotentReplay: response.headers.get("x-repofixlab-idempotent-replay"),
		body: await response.text(),
	};
}

async function requestM3ImageResolution(
	controllerUrl: string,
	request: M3ImageResolutionControllerRequest,
	timeoutMs: number,
): Promise<M3ImageResolutionControllerResponse> {
	let response: Response;
	try {
		response = await fetch(new URL("/v1/m3/official-images", controllerUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name =
			typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
				? error.name
				: "";
		if (name === "AbortError" || name === "TimeoutError") {
			throw new Error("Controller M3 image resolution request timed out");
		}
		throw new Error("Controller M3 image resolution request failed");
	}
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		idempotentReplay: response.headers.get("x-repofixlab-idempotent-replay"),
		body: await response.text(),
	};
}

function assertPathWithin(root: string, candidate: string): void {
	const relativePath = relative(root, candidate);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Output path must name a file beneath ${root}`);
	}
}

export async function resolveArtifactOutputPath(artifactsRoot: string, requestedPath: string): Promise<string> {
	const root = resolve(artifactsRoot);
	const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
	assertPathWithin(root, candidate);
	await mkdir(root, { recursive: true });
	const realRoot = await realpath(root);
	let current = root;
	for (const segment of relative(root, dirname(candidate))
		.split(sep)
		.filter((value) => value.length > 0)) {
		current = join(current, segment);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink()) throw new Error(`Output path traverses symbolic link ${current}`);
			if (!stats.isDirectory()) throw new Error(`Output parent is not a directory: ${current}`);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			break;
		}
	}
	await mkdir(dirname(candidate), { recursive: true });
	assertPathWithin(realRoot, await realpath(dirname(candidate)));
	try {
		await lstat(candidate);
		throw new Error(`Refusing to overwrite existing report ${candidate}`);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
	}
	return candidate;
}

export async function resolveArtifactInputPath(artifactsRoot: string, requestedPath: string): Promise<string> {
	const root = resolve(artifactsRoot);
	const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
	assertPathWithin(root, candidate);
	const realRoot = await realpath(root);
	const segments = relative(root, candidate)
		.split(sep)
		.filter((value) => value.length > 0);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		const stats = await lstat(current);
		if (stats.isSymbolicLink()) throw new Error(`Input path traverses symbolic link ${current}`);
		const isTarget = index === segments.length - 1;
		if (!isTarget && !stats.isDirectory()) throw new Error(`Input parent is not a directory: ${current}`);
		if (isTarget && !stats.isFile()) throw new Error(`Input path is not a regular file: ${current}`);
	}
	const realCandidate = await realpath(candidate);
	assertPathWithin(realRoot, realCandidate);
	return candidate;
}

/** Resolve a pre-existing, non-symlinked artifact directory for safe resume. */
export async function resolveArtifactInputDirectory(artifactsRoot: string, requestedPath: string): Promise<string> {
	const root = resolve(artifactsRoot);
	const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
	assertPathWithin(root, candidate);
	const realRoot = await realpath(root);
	const segments = relative(root, candidate)
		.split(sep)
		.filter((value) => value.length > 0);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		const stats = await lstat(current);
		if (stats.isSymbolicLink()) throw new Error(`Input directory traverses symbolic link ${current}`);
		if (!stats.isDirectory()) {
			throw new Error(index === segments.length - 1 ? `Input path is not a directory: ${current}` : `Input parent is not a directory: ${current}`);
		}
	}
	const realCandidate = await realpath(candidate);
	assertPathWithin(realRoot, realCandidate);
	return candidate;
}

export async function resolveRunConfigPath(artifactsRoot: string, requestedPath: string): Promise<string> {
	const normalizedPath = requestedPath.replaceAll("\\", "/");
	const repositoryConfigMatch =
		/^(?:packages\/repofixlab\/)?configs\/experiments\/([A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml)$/.exec(normalizedPath);
	if (repositoryConfigMatch === null) {
		if (
			normalizedPath.startsWith("configs/experiments/") ||
			normalizedPath.startsWith("packages/repofixlab/configs/experiments/")
		) {
			throw new Error("Repository experiment config path must name one YAML file without traversal");
		}
		return resolveArtifactInputPath(artifactsRoot, requestedPath);
	}

	const configRoot = fileURLToPath(new URL("../../configs/experiments/", import.meta.url));
	const candidate = join(configRoot, repositoryConfigMatch[1]!);
	const configRootStats = await lstat(configRoot);
	const candidateStats = await lstat(candidate);
	if (!configRootStats.isDirectory() || configRootStats.isSymbolicLink()) {
		throw new Error("Repository experiment config root is not a regular directory");
	}
	if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
		throw new Error("Repository experiment config is not a regular file");
	}
	const realConfigRoot = await realpath(configRoot);
	const realCandidate = await realpath(candidate);
	assertPathWithin(realConfigRoot, realCandidate);
	return candidate;
}

export async function writeArtifactReportAtomically(
	path: string,
	content: string,
	mode: ArtifactOutputMode = PRIVATE_ARTIFACT_MODE,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let published = false;
	try {
		const file = await open(temporaryPath, "wx", mode);
		try {
			await file.writeFile(content, "utf8");
			await file.chmod(mode);
			await file.sync();
		} finally {
			await file.close();
		}
		await link(temporaryPath, path);
		published = true;
		await unlink(temporaryPath);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		if (!published)
			await unlink(temporaryPath).catch((error: unknown) => {
				if (!isMissingPathError(error)) throw error;
			});
	}
}

function defaultRuntime(): CliRuntime {
	const artifactsRoot = process.env.REPOFIX_ARTIFACTS_PATH ?? DEFAULT_ARTIFACTS_ROOT;
	const controllerUrl = process.env.REPOFIX_CONTROLLER_URL ?? DEFAULT_CONTROLLER_URL;
	const provenanceLockPath = imageProvenanceLockPath();
	return {
		artifactsRoot,
		controllerUrl,
		now: () => new Date(),
		randomId: randomUUID,
		sleep: async (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
		readArtifactsStatFs: async (path) => {
			const reading = await statfs(path, { bigint: true });
			return { availableBlocks: reading.bavail, blockSize: reading.bsize };
		},
		readControllerHealth: () => readControllerBootstrapHealth(controllerUrl),
		readImageProvenanceLock: async () => {
			const lockPath = await resolveArtifactInputPath(artifactsRoot, provenanceLockPath);
			return parseBootstrapImageProvenanceLockFile(await readFile(lockPath, "utf8"));
		},
		readInputFile: (path) => readFile(path, "utf8"),
		readM3SamplingMetadata: () => readFile("/data/control/sampling.jsonl", "utf8"),
		requestFactoryProbe,
		requestM3ImageResolution,
		runExperiment: (plan, runArtifactsRoot, runControllerUrl) =>
			runM1Experiment(
				plan,
				{ artifactsRoot: runArtifactsRoot },
				createDefaultM1RunnerDependencies(runControllerUrl),
			),
		resolveInputPath: resolveArtifactInputPath,
		resolveRunConfigPath,
		resolveOutputPath: resolveArtifactOutputPath,
		stderr: (text) => process.stderr.write(text),
		stdout: (text) => process.stdout.write(text),
		writeOutput: writeArtifactReportAtomically,
	};
}

export async function runCli(args: readonly string[], runtime: CliRuntime = defaultRuntime()): Promise<number> {
	const parsed = parseCliArgs(args);
	if (!parsed.ok) {
		runtime.stderr(`${parsed.error.message}\n`);
		return 2;
	}
	if (parsed.command.kind === "help") {
		runtime.stdout(
			parsed.command.topic === "doctor" ? DOCTOR_HELP : parsed.command.topic === "run" ? RUN_HELP : GENERAL_HELP,
		);
		return 0;
	}
	if (parsed.command.kind === "version") {
		runtime.stdout(`${PACKAGE_VERSION}\n`);
		return 0;
	}
	if (parsed.command.kind === "run") {
		const configPath = await runtime.resolveRunConfigPath(runtime.artifactsRoot, parsed.command.config);
		const plan = parseExperimentPlan(await runtime.readInputFile(configPath));
		if (parsed.command.dryRun) {
			runtime.stdout(stableStringify(createExperimentDryRunSummary(plan)));
			return 0;
		}
		if (plan.runtime_status !== "m1_single_run_available") {
			runtime.stderr(`Run lifecycle is unavailable for experiment ${plan.experiment_id}; refusing execution.\n`);
			return 3;
		}
		const summary = await runtime.runExperiment(plan, runtime.artifactsRoot, runtime.controllerUrl);
		runtime.stdout(stableStringify(summary));
		return summary.terminal_status === "completed" ? 0 : 1;
	}
	if (parsed.command.kind === "m6-batch-create") {
		const inputPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const split = JSON.parse(await runtime.readInputFile(inputPath)) as M3SplitManifest;
		const content = stableStringify(createM6DevCalibrationBatch(split));
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PUBLIC_CATALOG_MODE);
		runtime.stdout(content);
		return 0;
	}
	if (parsed.command.kind === "m6-run") {
		const inputPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const calibrationBatch = verifyM6DevCalibrationBatch(JSON.parse(await runtime.readInputFile(inputPath)));
		const resumeDirectory =
			parsed.command.resume === undefined
				? undefined
				: await resolveArtifactInputDirectory(runtime.artifactsRoot, parsed.command.resume);
		const summary = await runM6DevCalibration(
			{ artifacts_root: runtime.artifactsRoot, calibration_batch: calibrationBatch, ...(resumeDirectory === undefined ? {} : { resume_directory: resumeDirectory }) },
			createDefaultM6DevCalibrationDependencies(runtime.controllerUrl),
		);
		runtime.stdout(stableStringify(summary));
		return summary.terminal_status === "completed" ? 0 : 1;
	}
	if (parsed.command.kind === "m6-continue") {
		const sourceReportPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.sourceReport);
		const sourceReportRelative = relative(resolve(runtime.artifactsRoot), sourceReportPath).replaceAll("\\", "/");
		if (basename(sourceReportRelative) !== "calibration-report.json") {
			throw new Error("m6-continue --source-report must name a sealed calibration-report.json artifact");
		}
		const sourceBatchRelative = `${dirname(sourceReportRelative).replaceAll("\\", "/")}/calibration-batch.json`;
		const sourceBatchPath = await runtime.resolveInputPath(runtime.artifactsRoot, sourceBatchRelative);
		const [sourceReportBytes, sourceBatchContent] = await Promise.all([
			readFile(sourceReportPath),
			runtime.readInputFile(sourceBatchPath),
		]);
		const sourceReport = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceReportBytes));
		const calibrationBatch = verifyM6DevCalibrationBatch(JSON.parse(sourceBatchContent));
		const resumeDirectory =
			parsed.command.resume === undefined
				? undefined
				: await resolveArtifactInputDirectory(runtime.artifactsRoot, parsed.command.resume);
		const summary = await runM6DevCalibrationContinuation(
			{
				artifacts_root: runtime.artifactsRoot,
				calibration_batch: calibrationBatch,
				source_report: sourceReport,
				source_report_bytes: sourceReportBytes,
				source_report_relative_path: sourceReportRelative,
				...(resumeDirectory === undefined ? {} : { resume_directory: resumeDirectory }),
			},
			createDefaultM6DevCalibrationDependencies(runtime.controllerUrl),
		);
		runtime.stdout(stableStringify(summary));
		return summary.terminal_status === "completed" ? 0 : 1;
	}
	if (parsed.command.kind === "provenance-lock") {
		const inputPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const content = createBootstrapImageProvenanceLockFile(await runtime.readInputFile(inputPath));
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PRIVATE_ARTIFACT_MODE);
		runtime.stdout(content);
		return 0;
	}
	if (parsed.command.kind === "candidate-create") {
		const inputPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const input: unknown = JSON.parse(await runtime.readInputFile(inputPath));
		const content = stableStringify(createTaskEnvironmentCandidate(input));
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PUBLIC_CATALOG_MODE);
		runtime.stdout(content);
		return 0;
	}
	if (parsed.command.kind === "environment-lock-create") {
		const manifestPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const manifest = verifyTaskEnvironmentLockEvidenceManifest(JSON.parse(await runtime.readInputFile(manifestPath)));
		const { evidence } = await loadTaskEnvironmentLockRawEvidence(manifest, runtime);
		const content = stableStringify(createTaskEnvironmentLockFromRawEvidence(evidence, runtime.now().toISOString()));
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PUBLIC_CATALOG_MODE);
		runtime.stdout(content);
		return 0;
	}
	if (parsed.command.kind === "m3-split-create") {
		const datasetLockPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const datasetLock = verifyDatasetLockForTaskEnvironment(JSON.parse(await runtime.readInputFile(datasetLockPath)));
		const eligibilityPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.eligibility);
		const eligibility = verifyM3EligibilityManifest(JSON.parse(await runtime.readInputFile(eligibilityPath)));
		const samplingMetadataContent = await runtime.readM3SamplingMetadata();
		const records = parseM3SamplingMetadataJsonl(samplingMetadataContent, datasetLock.dataset.revision);
		const content = stableStringify(
			createM3RepoStratifiedSplit(records, {
				datasetLockId: datasetLock.lock_id,
				datasetLockSealSha256: datasetLock.seal.sha256,
				samplingMetadataContent,
				eligibilityManifest: eligibility,
			}),
		);
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PUBLIC_CATALOG_MODE);
		runtime.stdout(content);
		return 0;
	}
	if (parsed.command.kind === "m3-image-resolve") {
		const splitPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const eligibilityPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.eligibility);
		const split = verifyM3RepoStratifiedSplit(
			JSON.parse(await runtime.readInputFile(splitPath)),
			JSON.parse(await runtime.readInputFile(eligibilityPath)),
		);
		const request: M3ImageResolutionControllerRequest = {
			schema_version: "v1",
			request_type: "m3_official_image_resolution",
			operation_id: parsed.command.operationId,
			dataset_revision: DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision,
			instance_ids: split.assignments.map((assignment) => assignment.instance_id),
		};
		const deadline = Date.now() + M3_IMAGE_RESOLUTION_TIMEOUT_MS;
		let responseValue: unknown;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Controller M3 image resolution request timed out");
			const response = await runtime.requestM3ImageResolution(
				runtime.controllerUrl,
				request,
				Math.min(remaining, M3_IMAGE_RESOLUTION_REQUEST_TIMEOUT_MS),
			);
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`Controller M3 image resolution failed with HTTP ${response.status}`);
			}
			if (response.idempotentReplay !== "false" && response.idempotentReplay !== "true") {
				throw new Error("Controller M3 image resolution returned an invalid idempotent replay header");
			}
			if (!isJsonContentType(response.contentType)) {
				throw new Error("Controller M3 image resolution returned a non-JSON response");
			}
			try {
				responseValue = JSON.parse(response.body);
			} catch {
				throw new Error("Controller M3 image resolution returned malformed JSON");
			}
			const status = parseM3ImageResolutionStatusRecord(responseValue, request);
			if (status.status === "failed") {
				throw new Error("Controller M3 image resolution completed with a failed status");
			}
			if (status.status === "completed") {
				responseValue = status.official_image_source_lock;
				break;
			}
			await runtime.sleep(Math.min(M3_IMAGE_RESOLUTION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
		}
		const lock = verifyOfficialImageSourceLockSelfContained(responseValue);
		if (
			lock.dataset_revision !== DATASET_PREPARER_SELF_CHECK_CONSTANTS.datasetRevision ||
			lock.harness_revision !== SWE_BENCH_HARNESS_REVISION ||
			JSON.stringify(lock.images.map((image) => image.image_key)) !== JSON.stringify(request.instance_ids)
		) {
			throw new Error("Controller M3 image resolution response does not bind the sealed eligible-task split");
		}
		const content = stableStringify(lock);
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PUBLIC_CATALOG_MODE);
		runtime.stdout(content);
		return 0;
	}
	if (parsed.command.kind === "factory-probe") {
		const candidatePath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.candidate);
		const candidate: unknown = JSON.parse(await runtime.readInputFile(candidatePath));
		const verifiedCandidate = verifyTaskEnvironmentCandidate(candidate);
		const request = createTaskRoleFactoryProbeRequest(verifiedCandidate, parsed.command.operationId);
		const controllerRequest: FactoryProbeControllerRequest = {
			operation_id: request.operation_id,
			candidate_id: request.candidate_id,
			instance_id: verifiedCandidate.instance_id,
		};
		const response = await runtime.requestFactoryProbe(
			runtime.controllerUrl,
			controllerRequest,
			FACTORY_PROBE_TIMEOUT_MS,
		);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Controller factory probe failed with HTTP ${response.status}`);
		}
		if (response.idempotentReplay !== "false" && response.idempotentReplay !== "true") {
			throw new Error("Controller factory probe returned an invalid idempotent replay header");
		}
		if (!isJsonContentType(response.contentType)) {
			throw new Error("Controller factory probe returned a non-JSON response");
		}
		let report: unknown;
		try {
			report = JSON.parse(response.body);
		} catch {
			throw new Error("Controller factory probe returned malformed JSON");
		}
		const verifiedReport = verifyTaskRoleFactoryProbeReport(report, verifiedCandidate, request);
		const content = stableStringify(verifiedReport);
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PRIVATE_ARTIFACT_MODE);
		runtime.stdout(content);
		return verifiedReport.status === "pass" ? 0 : 1;
	}
	if (parsed.command.profile === "smoke") {
		const startedAt = runtime.now().toISOString();
		const smokeManifestPath = await runtime.resolveInputPath(runtime.artifactsRoot, parsed.command.input);
		const smokeManifest = verifySmokeDoctorEvidenceManifest(
			JSON.parse(await runtime.readInputFile(smokeManifestPath)),
		);
		const requestedTopLevelPaths = smokeDoctorEvidenceManifestPaths(smokeManifest);
		const resolvedTopLevelPaths = await Promise.all(
			requestedTopLevelPaths.map((path) => runtime.resolveInputPath(runtime.artifactsRoot, path)),
		);
		if (new Set(resolvedTopLevelPaths).size !== resolvedTopLevelPaths.length) {
			throw new Error("Smoke Doctor top-level evidence paths must be distinct");
		}
		const topLevelContents = await Promise.all(resolvedTopLevelPaths.map((path) => runtime.readInputFile(path)));
		const contentByRequestedPath = new Map(
			requestedTopLevelPaths.map((path, index) => [path, topLevelContents[index]!] as const),
		);
		const contentFor = (path: string): string => {
			const content = contentByRequestedPath.get(path);
			if (content === undefined) {
				throw new Error(`Smoke Doctor evidence was not loaded: ${path}`);
			}
			return content;
		};
		const environmentManifest = verifyTaskEnvironmentLockEvidenceManifest(
			JSON.parse(contentFor(smokeManifest.environment_lock_evidence_manifest)),
		);
		const loadedEnvironmentEvidence = await loadTaskEnvironmentLockRawEvidence(environmentManifest, runtime);
		verifyDistinctSmokeDoctorEvidencePaths([
			smokeManifestPath,
			...resolvedTopLevelPaths,
			...loadedEnvironmentEvidence.resolvedPaths,
		]);
		const report = runSmokeDoctor(
			smokeDoctorEvidenceInput(
				contentFor(smokeManifest.bootstrap_doctor_report),
				contentFor(smokeManifest.bootstrap_provenance_lock),
				contentFor(smokeManifest.task_environment_lock),
				loadedEnvironmentEvidence.evidence,
			),
			{
				reportId: `smoke-${runtime.randomId()}`,
				startedAt,
				finishedAt: runtime.now().toISOString(),
			},
		);
		const content = `${JSON.stringify(report, undefined, 2)}\n`;
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PRIVATE_ARTIFACT_MODE);
		runtime.stdout(content);
		return report.status === "pass" ? 0 : 1;
	}
	if (parsed.command.profile !== "bootstrap") {
		runtime.stderr(`Doctor profile ${parsed.command.profile} is not implemented; refusing to report pass.\n`);
		return 3;
	}

	const startedAt = runtime.now().toISOString();
	const assessment = await runBootstrapDoctor({
		now: runtime.now,
		readArtifactsStatFs: runtime.readArtifactsStatFs,
		readControllerHealth: runtime.readControllerHealth,
		readImageProvenanceLock: runtime.readImageProvenanceLock,
	});
	const report = createBootstrapDoctorReport(assessment, startedAt, `bootstrap-${runtime.randomId()}`);
	const content = `${JSON.stringify(report, undefined, 2)}\n`;
	if (parsed.command.output !== undefined) {
		const outputPath = await runtime.resolveOutputPath(runtime.artifactsRoot, parsed.command.output);
		await runtime.writeOutput(outputPath, content, PRIVATE_ARTIFACT_MODE);
	}
	runtime.stdout(content);
	return report.status === "pass" ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCli(process.argv.slice(2)).then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : "Unknown RepoFixLab failure"}\n`);
			process.exitCode = 1;
		},
	);
}
