import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/canonical-json.ts";
import { HttpRepoToolTransport, type RepoToolTransport } from "../controller/client.ts";

const DEFAULT_TIMEOUT_MS = 310_000;
const DEFAULT_RESPONSE_LIMIT = 12_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export interface RuntimePreflightBinding {
	readonly task_environment_lock_id: string;
	readonly task_environment_lock_sha256: string;
	readonly candidate_sha256: string;
	readonly base_commit: string;
}

export interface RuntimePreparedWorker {
	readonly leaseId: string;
}

export interface RuntimeVerificationCandidate {
	readonly candidateId: string;
	readonly description: string;
}

export interface RuntimeVerificationCatalog {
	readonly catalogId: string;
	readonly sourceSha256: string;
	readonly entries: readonly RuntimeVerificationCandidate[];
}

export type RuntimeVerificationStatus =
	| "passed"
	| "test_failed"
	| "command_invalid"
	| "environment_failure"
	| "timed_out";

export interface RuntimeVerificationObservation {
	readonly status: RuntimeVerificationStatus;
	readonly reasonCode: string | null;
	readonly safeHint: string | null;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated: boolean;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

export interface RuntimeVerificationResult {
	readonly catalogId: string;
	readonly candidateId: string;
	readonly status: RuntimeVerificationStatus;
	readonly reasonCode: string | null;
	readonly safeHint: string | null;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated: boolean;
	readonly timedOut: boolean;
	readonly durationMs: number;
	/** Test result on the unmodified base commit, run in a separate isolated clone. */
	readonly baseline: RuntimeVerificationObservation;
}

export interface RuntimePatchFile {
	readonly path: string;
	readonly status: "added" | "modified" | "deleted" | "renamed";
}

export interface RuntimePatchSnapshot {
	readonly snapshotId: string;
	readonly patch: Uint8Array;
	readonly patchSha256: string;
	readonly baseCommit: string;
	readonly baseTree: { readonly algorithm: "git-sha1"; readonly value: string };
	readonly candidateTree: { readonly algorithm: "git-sha1"; readonly value: string };
	readonly files: readonly RuntimePatchFile[];
	readonly policy: { readonly status: "pass" | "fail"; readonly violations: readonly string[] };
	readonly createdAt: string;
}

export interface RuntimeCleanup {
	readonly clean: boolean;
}

export interface RuntimeEvaluationJob {
	readonly jobId: string;
}

export interface RuntimeJobStatus {
	readonly status: "queued" | "running" | "completed" | "failed";
	readonly resolved: boolean | null;
	readonly errorClass: string | null;
}

export interface RuntimeArtifact {
	readonly name: string;
	readonly content: Uint8Array;
	readonly sha256: string;
}

export interface RuntimeArtifactSet {
	readonly artifactSetSha256: string;
	readonly artifacts: readonly RuntimeArtifact[];
}

export interface RuntimeController {
	preflight(
		attemptId: string,
		operationId: string,
		candidateId: string,
		instanceId: string,
	): Promise<RuntimePreflightBinding>;
	prepare(
		attemptId: string,
		operationId: string,
		candidateId: string,
		instanceId: string,
	): Promise<RuntimePreparedWorker>;
	toolTransport(attemptId: string): RepoToolTransport;
	verificationCatalog?(attemptId: string, operationId: string, leaseId: string): Promise<RuntimeVerificationCatalog>;
	verifyCatalogEntry?(
		attemptId: string,
		operationId: string,
		leaseId: string,
		catalogId: string,
		candidateId: string,
	): Promise<RuntimeVerificationResult>;
	snapshot(attemptId: string, operationId: string, leaseId: string): Promise<RuntimePatchSnapshot>;
	destroy(attemptId: string, operationId: string, leaseId: string): Promise<RuntimeCleanup>;
	startEvaluation(
		attemptId: string,
		operationId: string,
		runId: string,
		snapshotId: string,
	): Promise<RuntimeEvaluationJob>;
	getJob(attemptId: string, jobId: string): Promise<RuntimeJobStatus>;
	getArtifacts(attemptId: string, jobId: string): Promise<RuntimeArtifactSet>;
	acknowledge(
		attemptId: string,
		operationId: string,
		jobId: string,
		artifactSetSha256: string,
	): Promise<RuntimeCleanup>;
	abort(attemptId: string, operationId: string): Promise<RuntimeCleanup>;
}

interface HttpRuntimeControllerOptions {
	readonly controllerUrl: string;
	readonly fetchFn?: typeof fetch;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
}

type JsonRecord = Record<string, unknown>;

function canonicalSha256(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} has unexpected fields`);
	}
}

function stringField(value: JsonRecord, key: string, pattern?: RegExp): string {
	const field = value[key];
	if (typeof field !== "string" || (pattern !== undefined && !pattern.test(field)))
		throw new Error(`Controller field ${key} is invalid`);
	return field;
}

function boolField(value: JsonRecord, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean") throw new Error(`Controller field ${key} is invalid`);
	return field;
}

function nullableString(value: JsonRecord, key: string): string | null {
	const field = value[key];
	if (field !== null && typeof field !== "string") throw new Error(`Controller field ${key} is invalid`);
	return field;
}

function verificationObservation(value: JsonRecord, label: string): RuntimeVerificationObservation {
	exactKeys(
		value,
		["status", "reason_code", "safe_hint", "exit_code", "stdout", "stderr", "truncated", "timed_out", "duration_ms"],
		label,
	);
	const status = stringField(value, "status");
	if (
		!(["passed", "test_failed", "command_invalid", "environment_failure", "timed_out"] as const).includes(
			status as RuntimeVerificationStatus,
		)
	)
		throw new Error("Controller verification status is invalid");
	const exitCode = value.exit_code;
	if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)))
		throw new Error("Controller verification exit code is invalid");
	if (typeof value.duration_ms !== "number" || !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0)
		throw new Error("Controller verification duration is invalid");
	return {
		status: status as RuntimeVerificationStatus,
		reasonCode: nullableString(value, "reason_code"),
		safeHint: nullableString(value, "safe_hint"),
		exitCode,
		stdout: stringField(value, "stdout"),
		stderr: stringField(value, "stderr"),
		truncated: boolField(value, "truncated"),
		timedOut: boolField(value, "timed_out"),
		durationMs: value.duration_ms,
	};
}

function strictBase64(value: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		throw new Error("Controller artifact is not canonical base64");
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) throw new Error("Controller artifact base64 round-trip failed");
	return bytes;
}

export class HttpRuntimeController implements RuntimeController {
	private readonly controllerUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;

	constructor(options: HttpRuntimeControllerOptions) {
		this.controllerUrl = options.controllerUrl;
		this.fetchFn = options.fetchFn ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT;
	}

	async preflight(
		attemptId: string,
		operationId: string,
		candidateId: string,
		instanceId: string,
	): Promise<RuntimePreflightBinding> {
		const body = await this.write(
			"/internal/v1/runtime/preflight",
			attemptId,
			operationId,
			{
				request_type: "runtime_preflight",
				candidate_id: candidateId,
				instance_id: instanceId,
			},
			{ candidate_id: candidateId, instance_id: instanceId },
		);
		exactKeys(
			body,
			["schema_version", "response_type", "attempt_id", "operation_id", "request_sha256", "status", "manifest"],
			"Preflight response",
		);
		if (stringField(body, "response_type") !== "runtime_preflight" || stringField(body, "status") !== "ready")
			throw new Error("Controller preflight did not return ready");
		const manifest = record(body.manifest, "Preflight manifest");
		exactKeys(
			manifest,
			[
				"manifest_id",
				"candidate_id",
				"instance_id",
				"policy_sha256",
				"tools",
				"capacity",
				"task_environment_lock_id",
				"task_environment_lock_sha256",
				"candidate_sha256",
				"base_commit",
			],
			"Preflight manifest",
		);
		if (stringField(manifest, "candidate_id") !== candidateId || stringField(manifest, "instance_id") !== instanceId)
			throw new Error("Controller preflight binding drifted");
		return {
			task_environment_lock_id: stringField(manifest, "task_environment_lock_id", IDENTIFIER),
			task_environment_lock_sha256: stringField(manifest, "task_environment_lock_sha256", SHA256),
			candidate_sha256: stringField(manifest, "candidate_sha256", SHA256),
			base_commit: stringField(manifest, "base_commit", GIT_SHA1),
		};
	}

	async prepare(
		attemptId: string,
		operationId: string,
		candidateId: string,
		instanceId: string,
	): Promise<RuntimePreparedWorker> {
		const body = await this.write(
			"/internal/v1/runtime/workers/prepare",
			attemptId,
			operationId,
			{
				request_type: "runtime_prepare_worker",
				candidate_id: candidateId,
				instance_id: instanceId,
			},
			{ candidate_id: candidateId, instance_id: instanceId },
		);
		this.verifyWriteResponse(body, "runtime_worker_prepared", "prepared");
		return { leaseId: stringField(body, "lease_id", IDENTIFIER) };
	}

	toolTransport(attemptId: string): RepoToolTransport {
		return new HttpRepoToolTransport({ controllerUrl: this.controllerUrl, attemptId, fetchFn: this.fetchFn });
	}

	async verificationCatalog(
		attemptId: string,
		operationId: string,
		leaseId: string,
	): Promise<RuntimeVerificationCatalog> {
		const body = await this.write(
			`/internal/v1/runtime/workers/${encodeURIComponent(leaseId)}/verification-catalog`,
			attemptId,
			operationId,
			{ request_type: "runtime_verification_catalog" },
			{ lease_id: leaseId },
		);
		this.verifyWriteResponse(body, "runtime_verification_catalog", "ready");
		if (stringField(body, "lease_id", IDENTIFIER) !== leaseId)
			throw new Error("Controller verification catalog lease drifted");
		const catalog = record(body.catalog, "Verification catalog");
		exactKeys(catalog, ["catalog_id", "source_sha256", "entries"], "Verification catalog");
		const entriesValue = catalog.entries;
		if (!Array.isArray(entriesValue) || entriesValue.length > 16)
			throw new Error("Controller verification catalog entries are invalid");
		const entries = entriesValue.map((value) => {
			const entry = record(value, "Verification catalog entry");
			exactKeys(entry, ["candidate_id", "description"], "Verification catalog entry");
			return {
				candidateId: stringField(entry, "candidate_id", IDENTIFIER),
				description: stringField(entry, "description"),
			} satisfies RuntimeVerificationCandidate;
		});
		if (new Set(entries.map((entry) => entry.candidateId)).size !== entries.length)
			throw new Error("Controller verification catalog contains duplicate candidates");
		return {
			catalogId: stringField(catalog, "catalog_id", IDENTIFIER),
			sourceSha256: stringField(catalog, "source_sha256", SHA256),
			entries,
		};
	}

	async verifyCatalogEntry(
		attemptId: string,
		operationId: string,
		leaseId: string,
		catalogId: string,
		candidateId: string,
	): Promise<RuntimeVerificationResult> {
		const body = await this.write(
			`/internal/v1/runtime/workers/${encodeURIComponent(leaseId)}/verify`,
			attemptId,
			operationId,
			{
				request_type: "runtime_verify_catalog",
				catalog_id: catalogId,
				candidate_id: candidateId,
			},
			{ lease_id: leaseId, catalog_id: catalogId, candidate_id: candidateId },
		);
		this.verifyWriteResponse(body, "runtime_verification_result", "completed");
		if (stringField(body, "lease_id", IDENTIFIER) !== leaseId)
			throw new Error("Controller verification result lease drifted");
		const result = record(body.result, "Verification result");
		exactKeys(
			result,
			[
				"catalog_id",
				"candidate_id",
				"status",
				"reason_code",
				"safe_hint",
				"exit_code",
				"stdout",
				"stderr",
				"truncated",
				"timed_out",
				"duration_ms",
				"baseline",
			],
			"Verification result",
		);
		if (
			stringField(result, "catalog_id", IDENTIFIER) !== catalogId ||
			stringField(result, "candidate_id", IDENTIFIER) !== candidateId
		)
			throw new Error("Controller verification result identity drifted");
		const candidate = verificationObservation(
			{
				status: result.status,
				reason_code: result.reason_code,
				safe_hint: result.safe_hint,
				exit_code: result.exit_code,
				stdout: result.stdout,
				stderr: result.stderr,
				truncated: result.truncated,
				timed_out: result.timed_out,
				duration_ms: result.duration_ms,
			},
			"Verification candidate result",
		);
		const baseline = verificationObservation(
			record(result.baseline, "Verification baseline result"),
			"Verification baseline result",
		);
		return { catalogId, candidateId, ...candidate, baseline };
	}

	async snapshot(attemptId: string, operationId: string, leaseId: string): Promise<RuntimePatchSnapshot> {
		const body = await this.write(
			`/internal/v1/runtime/workers/${encodeURIComponent(leaseId)}/snapshot`,
			attemptId,
			operationId,
			{ request_type: "runtime_snapshot_patch" },
			{ lease_id: leaseId },
		);
		this.verifyWriteResponse(body, "runtime_patch_snapshot", "snapshotted");
		const patch = strictBase64(stringField(body, "patch_base64"));
		if (patch.byteLength > 2_097_152) throw new Error("Controller patch exceeds the v1 snapshot byte limit");
		const patchSha256 = stringField(body, "patch_sha256", SHA256);
		if (
			patch.byteLength !== body.patch_bytes ||
			canonicalRawSha256(patch) !== patchSha256 ||
			boolField(body, "empty") !== (patch.byteLength === 0)
		)
			throw new Error("Controller patch bytes do not match snapshot metadata");
		const baseTree = this.gitTree(body.base_tree, "base_tree");
		const candidateTree = this.gitTree(body.candidate_tree, "candidate_tree");
		const filesValue = body.files;
		if (!Array.isArray(filesValue)) throw new Error("Controller snapshot files are invalid");
		const files = filesValue.map((item) => {
			const file = record(item, "Snapshot file");
			exactKeys(file, ["path", "status"], "Snapshot file");
			const status = stringField(file, "status");
			if (status !== "added" && status !== "modified" && status !== "deleted" && status !== "renamed")
				throw new Error("Snapshot file status is invalid");
			return { path: stringField(file, "path"), status } satisfies RuntimePatchFile;
		});
		const policyValue = record(body.policy, "Snapshot policy");
		exactKeys(policyValue, ["status", "violations"], "Snapshot policy");
		const policyStatus = stringField(policyValue, "status");
		if (policyStatus !== "pass" && policyStatus !== "fail") throw new Error("Snapshot policy status is invalid");
		if (!Array.isArray(policyValue.violations) || !policyValue.violations.every((item) => typeof item === "string"))
			throw new Error("Snapshot policy violations are invalid");
		return {
			snapshotId: stringField(body, "snapshot_id", IDENTIFIER),
			patch,
			patchSha256,
			baseCommit: stringField(body, "base_commit", GIT_SHA1),
			baseTree,
			candidateTree,
			files,
			policy: { status: policyStatus, violations: policyValue.violations },
			createdAt: stringField(body, "created_at"),
		};
	}

	async destroy(attemptId: string, operationId: string, leaseId: string): Promise<RuntimeCleanup> {
		const body = await this.write(
			`/internal/v1/runtime/workers/${encodeURIComponent(leaseId)}/destroy`,
			attemptId,
			operationId,
			{ request_type: "runtime_destroy_worker" },
			{ lease_id: leaseId },
		);
		this.verifyWriteResponse(body, "runtime_worker_destroyed", stringField(body, "status"));
		const cleanup = record(body.cleanup, "Worker cleanup");
		return { clean: boolField(cleanup, "clean") };
	}

	async startEvaluation(
		attemptId: string,
		operationId: string,
		runId: string,
		snapshotId: string,
	): Promise<RuntimeEvaluationJob> {
		const body = await this.write(
			"/internal/v1/runtime/evaluations",
			attemptId,
			operationId,
			{ request_type: "runtime_start_evaluation", run_id: runId, snapshot_id: snapshotId },
			{ run_id: runId, snapshot_id: snapshotId },
		);
		this.verifyWriteResponse(body, "runtime_evaluation_started", "started");
		if (stringField(body, "snapshot_id") !== snapshotId)
			throw new Error("Controller evaluation snapshot binding drifted");
		return { jobId: stringField(body, "job_id", IDENTIFIER) };
	}

	async getJob(attemptId: string, jobId: string): Promise<RuntimeJobStatus> {
		const body = await this.read(`/internal/v1/runtime/jobs/${encodeURIComponent(jobId)}`);
		if (
			stringField(body, "response_type") !== "runtime_job_status" ||
			stringField(body, "attempt_id") !== attemptId ||
			stringField(body, "job_id") !== jobId
		)
			throw new Error("Controller job identity drifted");
		const status = stringField(body, "status");
		if (status !== "queued" && status !== "running" && status !== "completed" && status !== "failed")
			throw new Error("Controller job status is invalid");
		const resolved = body.resolved;
		if (resolved !== null && typeof resolved !== "boolean")
			throw new Error("Controller job resolved value is invalid");
		return { status, resolved, errorClass: nullableString(body, "error_class") };
	}

	async getArtifacts(attemptId: string, jobId: string): Promise<RuntimeArtifactSet> {
		const body = await this.read(`/internal/v1/runtime/jobs/${encodeURIComponent(jobId)}/artifacts`);
		if (
			stringField(body, "response_type") !== "runtime_job_artifacts" ||
			stringField(body, "attempt_id") !== attemptId ||
			stringField(body, "job_id") !== jobId ||
			stringField(body, "status") !== "ready"
		)
			throw new Error("Controller artifact set identity drifted");
		const artifactsValue = body.artifacts;
		if (!Array.isArray(artifactsValue)) throw new Error("Controller artifact set is invalid");
		const artifacts = artifactsValue.map((item) => {
			const artifact = record(item, "Evaluation artifact");
			exactKeys(artifact, ["name", "sha256", "size_bytes", "content_base64"], "Evaluation artifact");
			const content = strictBase64(stringField(artifact, "content_base64"));
			const artifactSha256 = stringField(artifact, "sha256", SHA256);
			if (artifact.size_bytes !== content.byteLength || canonicalRawSha256(content) !== artifactSha256)
				throw new Error("Evaluation artifact bytes do not match descriptor");
			return { name: stringField(artifact, "name"), content, sha256: artifactSha256 };
		});
		const identity = artifacts.map((artifact) => ({
			name: artifact.name,
			sha256: artifact.sha256,
			size_bytes: artifact.content.byteLength,
		}));
		const artifactSetSha256 = stringField(body, "artifact_set_sha256", SHA256);
		if (
			canonicalSha256(identity) !== artifactSetSha256 ||
			new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length
		)
			throw new Error("Controller artifact set hash or names are invalid");
		return { artifactSetSha256, artifacts };
	}

	async acknowledge(
		attemptId: string,
		operationId: string,
		jobId: string,
		artifactSetSha256: string,
	): Promise<RuntimeCleanup> {
		const body = await this.write(
			`/internal/v1/runtime/jobs/${encodeURIComponent(jobId)}/ack`,
			attemptId,
			operationId,
			{ request_type: "runtime_ack_artifacts", artifact_set_sha256: artifactSetSha256 },
			{ job_id: jobId, artifact_set_sha256: artifactSetSha256 },
		);
		this.verifyWriteResponse(body, "runtime_artifacts_acknowledged", stringField(body, "status"));
		const cleanup = record(body.cleanup, "Evaluation cleanup");
		return { clean: boolField(cleanup, "clean") };
	}

	async abort(attemptId: string, operationId: string): Promise<RuntimeCleanup> {
		const body = await this.write(
			`/internal/v1/runtime/attempts/${encodeURIComponent(attemptId)}/abort`,
			attemptId,
			operationId,
			{ request_type: "runtime_abort_attempt" },
			{},
		);
		this.verifyWriteResponse(body, "runtime_attempt_aborted", stringField(body, "status"));
		const cleanup = record(body.cleanup, "Attempt abort cleanup");
		exactKeys(
			cleanup,
			["residual_container_count", "residual_volume_count", "error_count", "clean"],
			"Attempt abort cleanup",
		);
		for (const key of ["residual_container_count", "residual_volume_count", "error_count"] as const) {
			if (!Number.isSafeInteger(cleanup[key]) || Number(cleanup[key]) < 0)
				throw new Error("Attempt abort cleanup counters are invalid");
		}
		const clean = boolField(cleanup, "clean");
		if (
			clean !==
			(cleanup.residual_container_count === 0 && cleanup.residual_volume_count === 0 && cleanup.error_count === 0)
		)
			throw new Error("Attempt abort cleanup semantics are invalid");
		return { clean };
	}

	private gitTree(value: unknown, label: string): { algorithm: "git-sha1"; value: string } {
		const tree = record(value, label);
		exactKeys(tree, ["algorithm", "value"], label);
		if (tree.algorithm !== "git-sha1") throw new Error(`Controller ${label} algorithm is invalid`);
		return { algorithm: "git-sha1", value: stringField(tree, "value", GIT_SHA1) };
	}

	private verifyWriteResponse(body: JsonRecord, responseType: string, status: string): void {
		if (stringField(body, "response_type") !== responseType || stringField(body, "status") !== status)
			throw new Error(`Controller returned unexpected ${responseType} state`);
	}

	private async write(
		path: string,
		attemptId: string,
		operationId: string,
		fields: JsonRecord,
		hashFields: JsonRecord,
	): Promise<JsonRecord> {
		if (!IDENTIFIER.test(attemptId) || !IDENTIFIER.test(operationId))
			throw new Error("Runtime write identity is invalid");
		const unsigned = { schema_version: "v1", ...fields, attempt_id: attemptId, operation_id: operationId };
		const requestSha256 = canonicalSha256({ ...unsigned, ...hashFields });
		const body = await this.request(path, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ ...unsigned, request_sha256: requestSha256 }),
		});
		if (
			stringField(body, "attempt_id") !== attemptId ||
			stringField(body, "operation_id") !== operationId ||
			stringField(body, "request_sha256") !== requestSha256
		)
			throw new Error("Controller write response identity drifted");
		return body;
	}

	private read(path: string): Promise<JsonRecord> {
		return this.request(path, { method: "GET", headers: { accept: "application/json" } });
	}

	private async request(path: string, init: RequestInit): Promise<JsonRecord> {
		const response = await this.fetchFn(new URL(path, this.controllerUrl), {
			...init,
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			const text = (await response.text()).slice(0, 4_096);
			let detail = text;
			try {
				const parsed: unknown = JSON.parse(text);
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					"detail" in parsed &&
					typeof (parsed as { detail: unknown }).detail === "string"
				) {
					detail = (parsed as { detail: string }).detail;
				}
			} catch {
				// A non-JSON Controller error is still useful diagnostic evidence.
			}
			throw new Error(`Controller runtime returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
		}
		if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
			throw new Error("Controller runtime returned non-JSON content");
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null && Number(contentLength) > this.maxResponseBytes)
			throw new Error("Controller runtime response exceeded the byte limit");
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > this.maxResponseBytes)
			throw new Error("Controller runtime response exceeded the byte limit");
		try {
			return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "Controller response");
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Controller")) throw error;
			throw new Error("Controller runtime returned malformed UTF-8 JSON");
		}
	}
}

function canonicalRawSha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}
