import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { stableStringify } from "../contracts/canonical-json.ts";
import { type M4DevWorkflowSummary, M4PreProviderInputError } from "../runner/m4-dev-workflow.ts";
import type { RepoToolOutputBudgetSnapshot } from "../sandbox/repo-tools.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import {
	M6_CALIBRATION_INSTANCE_IDS,
	M6_CALIBRATION_RUN_COUNT,
	M6_PROVIDER_SMOKE_CAP_TOKENS,
	type M6CalibrationRun,
	type M6DevCalibrationBatch,
	verifyM6DevCalibrationBatch,
} from "./calibration-cohort.ts";
import {
	createM6CalibratedTokenEstimator,
	createM6M4Receipt,
	inspectM6TokenLedger,
	type M6CalibratedTokenEstimator,
	type M6CalibrationRunReceipt,
	type M6DevCalibrationDependencies,
	type M6DevCalibrationReport,
	type M6ProviderSmokeReceipt,
	type M6ProviderSmokeResult,
	parseM6TokenLedger,
	verifyM6DevCalibrationReport,
} from "./dev-calibration-runner.ts";

export const M6_CONTINUATION_PROTOCOL_REVISION = "repofixlab-protocol-1.6-deepseek-v4-flash-continuation" as const;
export const M6_CONTINUATION_PER_RUN_CAP_TOKENS = 5_000_000;

const CONTINUATION_ROOT = "m6-deepseek-flash-continuation";
const JOURNAL_PATH = "m6-continuation-events.jsonl";
const USAGE_LEDGER_PATH = "continuation-usage.jsonl";

type PendingRunReason = "budget_exhausted_retry" | "not_started";

export interface M6DevCalibrationContinuationManifest {
	readonly schema_version: "v1";
	readonly manifest_type: "m6_dev_calibration_continuation";
	readonly protocol_revision: typeof M6_CONTINUATION_PROTOCOL_REVISION;
	readonly calibration_batch_sha256: string;
	readonly source_report_relative_path: string;
	readonly source_report_file_sha256: string;
	readonly source_report_sha256: string;
	readonly inherited_logical_run_ids: readonly string[];
	readonly pending_runs: readonly {
		readonly logical_run: M6CalibrationRun;
		readonly reason: PendingRunReason;
	}[];
	readonly budget_policy: {
		readonly per_logical_run_tokens: typeof M6_CONTINUATION_PER_RUN_CAP_TOKENS;
		readonly project_tokens: null;
		readonly provider_smoke_tokens: typeof M6_PROVIDER_SMOKE_CAP_TOKENS;
	};
	readonly continuation_manifest_sha256: string;
}

export interface M6ContinuationUsageRecord {
	readonly schema_version: "v1";
	readonly ledger_type: "m6_continuation_usage";
	readonly event_type: "provider_smoke" | "logical_run";
	readonly run_id: string;
	readonly logical_run_id: string | null;
	readonly accounted_tokens: number;
	readonly event_sha256: string;
}

export interface M6DevCalibrationContinuationReport {
	readonly schema_version: "v1";
	readonly report_type: "m6_dev_calibration_continuation";
	readonly protocol_revision: typeof M6_CONTINUATION_PROTOCOL_REVISION;
	readonly continuation_manifest_sha256: string;
	readonly run_id: string;
	readonly started_at: string;
	readonly finished_at: string;
	readonly status: "pass" | "fail";
	readonly cost_admission: "per_run_enforced_no_project_cap";
	readonly budget_policy: M6DevCalibrationContinuationManifest["budget_policy"];
	readonly source: {
		readonly report_relative_path: string;
		readonly report_file_sha256: string;
		readonly report_sha256: string;
		readonly calibration_batch_sha256: string;
	};
	readonly provider_smoke: M6ProviderSmokeReceipt | null;
	readonly inherited_run_receipts: readonly M6CalibrationRunReceipt[];
	readonly continuation_run_receipts: readonly M6CalibrationRunReceipt[];
	readonly calibrated_estimator: M6CalibratedTokenEstimator | null;
	readonly batch_failure_reasons: readonly string[];
	readonly aggregate: {
		readonly expected_logical_runs: number;
		readonly inherited_clean_runs: number;
		readonly continuation_completed_runs: number;
		readonly failed_logical_runs: number;
		readonly request_count: number;
		readonly observed_logical_run_tokens: number;
		readonly continuation_spend_tokens: number;
		readonly continuation_usage_ledger: {
			readonly accounted_tokens: number;
			readonly entry_count: number;
			readonly reconciliation_required: boolean;
		};
		readonly maximum_base_input_tokens: number | null;
		readonly maximum_provider_prompt_tokens: number | null;
		readonly maximum_provider_total_tokens: number | null;
		readonly context_truncation: {
			readonly repofix_run_count: number;
			readonly truncated_calls: number;
			readonly maximum_visible_chars: number;
		};
	};
	readonly calibration_evidence_sha256: string;
	readonly report_sha256: string;
}

export interface M6DevCalibrationContinuationSummary {
	readonly schema_version: "v1";
	readonly summary_type: "m6_dev_calibration_continuation";
	readonly run_id: string;
	readonly terminal_status: "completed" | "failed";
	readonly run_directory: string;
	readonly calibration_evidence_sha256: string;
	readonly report_sha256: string;
}

interface JournalEvent {
	readonly schema_version: "v1";
	readonly event_type: "initialized" | "smoke_started" | "smoke_completed" | "run_started" | "run_terminal";
	readonly run_id: string;
	readonly continuation_manifest_sha256: string;
	readonly logical_run_id: string | null;
	readonly receipt_path: string | null;
	readonly receipt_sha256: string | null;
	readonly smoke: M6ProviderSmokeReceipt | null;
	readonly event_sha256: string;
}

interface JournalState {
	readonly run_id: string;
	readonly smoke_started: boolean;
	readonly smoke: M6ProviderSmokeReceipt | null;
	readonly started: ReadonlySet<string>;
	readonly terminal: ReadonlyMap<string, { readonly receipt_path: string; readonly receipt_sha256: string }>;
}

interface SourceSelection {
	readonly inherited: readonly M6CalibrationRunReceipt[];
	readonly pending: readonly { readonly logical_run: M6CalibrationRun; readonly reason: PendingRunReason }[];
}

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function bytesSha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonLine(value: unknown): string {
	return `${JSON.stringify(JSON.parse(stableStringify(value)))}\n`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafeTokenCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCleanReceipt(receipt: M6CalibrationRunReceipt): boolean {
	return (
		receipt.terminal_status === "completed" &&
		receipt.budget_protocol_valid &&
		!receipt.requires_reconciliation &&
		receipt.observations.length > 0 &&
		receipt.failure_reasons.length === 0
	);
}

function receiptPath(logicalRun: M6CalibrationRun): string {
	return `receipts/${logicalRun.run_id}.json`;
}

function emptyReceipt(
	logicalRun: M6CalibrationRun,
	reason: string,
	requiresReconciliation = false,
): M6CalibrationRunReceipt {
	return {
		logical_run: logicalRun,
		m4_run_id: null,
		m4_artifact_relative_path: null,
		terminal_status: "failed",
		accounted_tokens: 0,
		token_ledger_sha256: null,
		request_count: 0,
		observations: [],
		budget_protocol_valid: false,
		requires_reconciliation: requiresReconciliation,
		failure_reasons: [reason],
		repofix_context_budget: null,
	};
}

function sourceSelection(batch: M6DevCalibrationBatch, sourceReport: M6DevCalibrationReport): SourceSelection {
	if (sourceReport.status !== "fail")
		throw new Error("M6 continuation requires a sealed failed source calibration report");
	if (sourceReport.calibration_batch_sha256 !== batch.calibration_batch_sha256) {
		throw new Error("M6 continuation source report does not bind the supplied calibration batch");
	}
	if (sourceReport.provider_smoke?.status !== "pass") {
		throw new Error("M6 continuation source report lacks a successful Provider smoke receipt");
	}
	const receipts = new Map<string, M6CalibrationRunReceipt>();
	for (const receipt of sourceReport.run_receipts) {
		if (receipts.has(receipt.logical_run.run_id))
			throw new Error("M6 continuation source report has duplicate logical-run receipts");
		const expected = batch.logical_runs.find((run) => run.run_id === receipt.logical_run.run_id);
		if (
			expected === undefined ||
			expected.instance_id !== receipt.logical_run.instance_id ||
			expected.config_id !== receipt.logical_run.config_id ||
			expected.replicate !== receipt.logical_run.replicate
		) {
			throw new Error("M6 continuation source receipt is not bound to the frozen calibration batch");
		}
		receipts.set(receipt.logical_run.run_id, receipt);
	}
	const inheritedRuns = batch.logical_runs.filter((run) => run.instance_id !== "preactjs__preact-4182");
	const inherited = inheritedRuns.map((run) => {
		const receipt = receipts.get(run.run_id);
		if (receipt === undefined || !isCleanReceipt(receipt)) {
			throw new Error("M6 continuation can inherit only four clean non-Preact receipts");
		}
		return receipt;
	});
	if (inherited.length !== 4)
		throw new Error("M6 continuation source report must provide exactly four clean inherited receipts");
	const pending = batch.logical_runs
		.filter((run) => run.instance_id === "preactjs__preact-4182")
		.map((logicalRun) => {
			const prior = receipts.get(logicalRun.run_id);
			if (prior === undefined) return { logical_run: logicalRun, reason: "not_started" as const };
			if (prior.failure_reasons.includes("budget_exhausted") && !prior.budget_protocol_valid) {
				return { logical_run: logicalRun, reason: "budget_exhausted_retry" as const };
			}
			throw new Error("M6 continuation source Preact receipt is neither unstarted nor a budget-exhausted retry");
		});
	if (pending.length !== 2) throw new Error("M6 continuation must contain exactly two pending Preact runs");
	return { inherited, pending };
}

function manifestSubset(
	manifest: M6DevCalibrationContinuationManifest,
): Omit<M6DevCalibrationContinuationManifest, "continuation_manifest_sha256"> {
	const { continuation_manifest_sha256: _continuationManifestSha256, ...semantic } = manifest;
	return semantic;
}

export function createM6DevCalibrationContinuationManifest(input: {
	readonly calibration_batch: M6DevCalibrationBatch;
	readonly source_report: M6DevCalibrationReport;
	readonly source_report_bytes: Uint8Array;
	readonly source_report_relative_path: string;
}): M6DevCalibrationContinuationManifest {
	const batch = verifyM6DevCalibrationBatch(input.calibration_batch);
	const source = verifyM6DevCalibrationReport(input.source_report);
	const selected = sourceSelection(batch, source);
	const normalizedPath = input.source_report_relative_path.replaceAll("\\", "/");
	if (
		normalizedPath.length === 0 ||
		normalizedPath.startsWith("/") ||
		normalizedPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error("M6 continuation source report path must be a safe artifact-relative file path");
	}
	const draft: Omit<M6DevCalibrationContinuationManifest, "continuation_manifest_sha256"> = {
		schema_version: "v1",
		manifest_type: "m6_dev_calibration_continuation",
		protocol_revision: M6_CONTINUATION_PROTOCOL_REVISION,
		calibration_batch_sha256: batch.calibration_batch_sha256,
		source_report_relative_path: normalizedPath,
		source_report_file_sha256: bytesSha256(input.source_report_bytes),
		source_report_sha256: source.report_sha256,
		inherited_logical_run_ids: selected.inherited.map((receipt) => receipt.logical_run.run_id),
		pending_runs: selected.pending,
		budget_policy: {
			per_logical_run_tokens: M6_CONTINUATION_PER_RUN_CAP_TOKENS,
			project_tokens: null,
			provider_smoke_tokens: M6_PROVIDER_SMOKE_CAP_TOKENS,
		},
	};
	return { ...draft, continuation_manifest_sha256: canonicalHash(draft) };
}

export function verifyM6DevCalibrationContinuationManifest(value: unknown): M6DevCalibrationContinuationManifest {
	const record = asRecord(value, "M6 continuation manifest");
	const typed = record as unknown as M6DevCalibrationContinuationManifest;
	if (
		typed.schema_version !== "v1" ||
		typed.manifest_type !== "m6_dev_calibration_continuation" ||
		typed.protocol_revision !== M6_CONTINUATION_PROTOCOL_REVISION ||
		!isSha256(typed.calibration_batch_sha256) ||
		!isSha256(typed.source_report_file_sha256) ||
		!isSha256(typed.source_report_sha256) ||
		!isSha256(typed.continuation_manifest_sha256) ||
		!Array.isArray(typed.inherited_logical_run_ids) ||
		!Array.isArray(typed.pending_runs) ||
		typed.budget_policy.per_logical_run_tokens !== M6_CONTINUATION_PER_RUN_CAP_TOKENS ||
		typed.budget_policy.project_tokens !== null ||
		typed.budget_policy.provider_smoke_tokens !== M6_PROVIDER_SMOKE_CAP_TOKENS ||
		canonicalHash(manifestSubset(typed)) !== typed.continuation_manifest_sha256
	) {
		throw new Error("M6 continuation manifest is malformed or has an invalid binding");
	}
	return typed;
}

function unsignedJournalEvent(value: Omit<JournalEvent, "event_sha256">): JournalEvent {
	return { ...value, event_sha256: canonicalHash(value) };
}

function verifyJournalEvent(value: unknown, manifest: M6DevCalibrationContinuationManifest): JournalEvent {
	const event = asRecord(value, "M6 continuation journal event") as Partial<JournalEvent>;
	if (
		event.schema_version !== "v1" ||
		typeof event.event_type !== "string" ||
		typeof event.run_id !== "string" ||
		event.continuation_manifest_sha256 !== manifest.continuation_manifest_sha256 ||
		typeof event.event_sha256 !== "string"
	) {
		throw new Error("M6 continuation journal event is malformed");
	}
	const { event_sha256: actual, ...unsigned } = event as JournalEvent;
	if (actual !== canonicalHash(unsigned)) throw new Error("M6 continuation journal event hash is invalid");
	return event as JournalEvent;
}

async function appendJournal(store: ArtifactStore, event: JournalEvent): Promise<void> {
	const file = await open(store.resolvePath(JOURNAL_PATH), "a", 0o600);
	try {
		await file.writeFile(canonicalJsonLine(event), "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

async function readJournal(
	store: ArtifactStore,
	manifest: M6DevCalibrationContinuationManifest,
): Promise<JournalState | null> {
	const raw = await readFile(store.resolvePath(JOURNAL_PATH), "utf8").catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (raw === null || raw.trim().length === 0) return null;
	const events = raw
		.trim()
		.split("\n")
		.map((line) => verifyJournalEvent(JSON.parse(line), manifest));
	const initial = events[0];
	if (initial?.event_type !== "initialized" || initial.logical_run_id !== null || initial.smoke !== null) {
		throw new Error("M6 continuation journal lacks a valid initialization event");
	}
	let smokeStarted = false;
	let smoke: M6ProviderSmokeReceipt | null = null;
	const started = new Set<string>();
	const terminal = new Map<string, { readonly receipt_path: string; readonly receipt_sha256: string }>();
	for (const event of events.slice(1)) {
		if (event.run_id !== initial.run_id) throw new Error("M6 continuation journal run identity drifted");
		if (event.event_type === "smoke_started") {
			if (smokeStarted || smoke !== null) throw new Error("M6 continuation smoke journal transition is invalid");
			smokeStarted = true;
			continue;
		}
		if (event.event_type === "smoke_completed") {
			if (!smokeStarted || smoke !== null || event.smoke === null) {
				throw new Error("M6 continuation smoke receipt is invalid");
			}
			smoke = event.smoke;
			continue;
		}
		if (event.logical_run_id === null) throw new Error("M6 continuation logical-run event is missing its run ID");
		if (event.event_type === "run_started") {
			if (started.has(event.logical_run_id))
				throw new Error("M6 continuation logical run was started more than once");
			started.add(event.logical_run_id);
			continue;
		}
		if (event.event_type === "run_terminal") {
			if (
				!started.has(event.logical_run_id) ||
				terminal.has(event.logical_run_id) ||
				event.receipt_path === null ||
				event.receipt_sha256 === null
			) {
				throw new Error("M6 continuation logical-run terminal event is invalid");
			}
			terminal.set(event.logical_run_id, {
				receipt_path: event.receipt_path,
				receipt_sha256: event.receipt_sha256,
			});
			continue;
		}
		throw new Error("M6 continuation journal event type is invalid");
	}
	return { run_id: initial.run_id, smoke_started: smokeStarted, smoke, started, terminal };
}

async function writeReceipt(
	store: ArtifactStore,
	receipt: M6CalibrationRunReceipt,
): Promise<{ readonly path: string; readonly sha256: string }> {
	const path = receiptPath(receipt.logical_run);
	const artifact = await store.writeNew(path, stableStringify(receipt), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	return { path, sha256: artifact.sha256 };
}

async function readReceipt(
	store: ArtifactStore,
	path: string,
	expectedSha256: string,
): Promise<M6CalibrationRunReceipt> {
	const bytes = await readFile(store.resolvePath(path));
	if (bytesSha256(bytes) !== expectedSha256) throw new Error("M6 continuation receipt SHA-256 drifted during resume");
	const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as M6CalibrationRunReceipt;
	if (typeof receipt !== "object" || receipt === null || !Array.isArray(receipt.failure_reasons)) {
		throw new Error("M6 continuation receipt is malformed during resume");
	}
	return receipt;
}

function smokeReceipt(report: M6ProviderSmokeResult): M6ProviderSmokeReceipt {
	return {
		run_id: report.run_id,
		status: report.status,
		accounted_tokens: report.accounted_tokens,
		token_ledger_sha256: report.token_ledger_sha256,
	};
}

function unsignedUsageRecord(
	eventType: M6ContinuationUsageRecord["event_type"],
	runId: string,
	logicalRunId: string | null,
	accountedTokens: number,
): M6ContinuationUsageRecord {
	const unsigned = {
		schema_version: "v1" as const,
		ledger_type: "m6_continuation_usage" as const,
		event_type: eventType,
		run_id: runId,
		logical_run_id: logicalRunId,
		accounted_tokens: accountedTokens,
	};
	return { ...unsigned, event_sha256: canonicalHash(unsigned) };
}

async function appendUsageRecord(store: ArtifactStore, record: M6ContinuationUsageRecord): Promise<void> {
	const file = await open(store.resolvePath(USAGE_LEDGER_PATH), "a", 0o600);
	try {
		await file.writeFile(canonicalJsonLine(record), "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

async function readUsageRecords(store: ArtifactStore): Promise<readonly M6ContinuationUsageRecord[]> {
	const raw = await readFile(store.resolvePath(USAGE_LEDGER_PATH), "utf8").catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (raw === null || raw.trim().length === 0) return [];
	return raw
		.trim()
		.split("\n")
		.map((line, index) => {
			const record = asRecord(
				JSON.parse(line),
				`M6 continuation usage record ${String(index + 1)}`,
			) as Partial<M6ContinuationUsageRecord>;
			if (
				record.schema_version !== "v1" ||
				record.ledger_type !== "m6_continuation_usage" ||
				(record.event_type !== "provider_smoke" && record.event_type !== "logical_run") ||
				typeof record.run_id !== "string" ||
				(record.logical_run_id !== null && typeof record.logical_run_id !== "string") ||
				!isSafeTokenCount(record.accounted_tokens) ||
				typeof record.event_sha256 !== "string"
			) {
				throw new Error("M6 continuation usage record is malformed");
			}
			const { event_sha256: actual, ...unsigned } = record as M6ContinuationUsageRecord;
			if (actual !== canonicalHash(unsigned)) throw new Error("M6 continuation usage record hash is invalid");
			return record as M6ContinuationUsageRecord;
		});
}

function reportEvidenceSubset(
	value: M6DevCalibrationContinuationReport,
): Omit<M6DevCalibrationContinuationReport, "calibration_evidence_sha256" | "report_sha256"> {
	const { calibration_evidence_sha256: _calibrationEvidenceSha256, report_sha256: _reportSha256, ...semantic } = value;
	return semantic;
}

function reportSubset(
	value: M6DevCalibrationContinuationReport,
): Omit<M6DevCalibrationContinuationReport, "report_sha256"> {
	const { report_sha256: _reportSha256, ...semantic } = value;
	return semantic;
}

export async function runM6DevCalibrationContinuation(
	options: {
		readonly artifacts_root: string;
		readonly calibration_batch: M6DevCalibrationBatch;
		readonly source_report: M6DevCalibrationReport;
		readonly source_report_bytes: Uint8Array;
		readonly source_report_relative_path: string;
		readonly resume_directory?: string;
	},
	dependencies: M6DevCalibrationDependencies,
): Promise<M6DevCalibrationContinuationSummary> {
	const batch = verifyM6DevCalibrationBatch(options.calibration_batch);
	const manifest = createM6DevCalibrationContinuationManifest({
		calibration_batch: batch,
		source_report: options.source_report,
		source_report_bytes: options.source_report_bytes,
		source_report_relative_path: options.source_report_relative_path,
	});
	const source = verifyM6DevCalibrationReport(options.source_report);
	const selected = sourceSelection(batch, source);
	let store: ArtifactStore;
	let runId: string;
	let runDirectory: string;
	let startedAt: string;
	let state: JournalState | null;
	if (options.resume_directory === undefined) {
		runId = `m6-continuation-run-${dependencies.randomId()}`;
		runDirectory = resolve(options.artifacts_root, CONTINUATION_ROOT, "runs", runId);
		store = await ArtifactStore.createNew(
			resolve(options.artifacts_root, CONTINUATION_ROOT, "runs", `.staging-${runId}`),
		);
		startedAt = dependencies.now().toISOString();
		await store.writeNew("continuation-manifest.json", stableStringify(manifest), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v1",
				event_type: "initialized",
				run_id: runId,
				continuation_manifest_sha256: manifest.continuation_manifest_sha256,
				logical_run_id: null,
				receipt_path: null,
				receipt_sha256: null,
				smoke: null,
			}),
		);
		state = await readJournal(store, manifest);
	} else {
		store = await ArtifactStore.openExisting(options.resume_directory);
		const persistedManifest = verifyM6DevCalibrationContinuationManifest(
			JSON.parse(await readFile(store.resolvePath("continuation-manifest.json"), "utf8")),
		);
		if (persistedManifest.continuation_manifest_sha256 !== manifest.continuation_manifest_sha256) {
			throw new Error("M6 continuation resume manifest does not match the requested source evidence");
		}
		state = await readJournal(store, manifest);
		if (state === null) throw new Error("M6 continuation resume directory has no durable journal");
		runId = state.run_id;
		runDirectory = resolve(dirname(store.rootPath), runId);
		startedAt = dependencies.now().toISOString();
	}
	if (state === null) throw new Error("M6 continuation journal initialization failed");
	const receipts = new Map<string, M6CalibrationRunReceipt>();
	for (const [logicalRunId, terminal] of state.terminal) {
		receipts.set(logicalRunId, await readReceipt(store, terminal.receipt_path, terminal.receipt_sha256));
	}
	const failures = new Set<string>();
	let stopBatch = false;
	let reconciliationRequired = false;
	if (state.started.size !== state.terminal.size) {
		for (const pending of manifest.pending_runs) {
			if (state.started.has(pending.logical_run.run_id) && !state.terminal.has(pending.logical_run.run_id)) {
				const receipt = emptyReceipt(pending.logical_run, "interrupted_unreconciled", true);
				const saved = await writeReceipt(store, receipt);
				await appendJournal(
					store,
					unsignedJournalEvent({
						schema_version: "v1",
						event_type: "run_terminal",
						run_id: runId,
						continuation_manifest_sha256: manifest.continuation_manifest_sha256,
						logical_run_id: pending.logical_run.run_id,
						receipt_path: saved.path,
						receipt_sha256: saved.sha256,
						smoke: null,
					}),
				);
				receipts.set(pending.logical_run.run_id, receipt);
				failures.add("interrupted_unreconciled");
				reconciliationRequired = true;
				stopBatch = true;
			}
		}
	}
	let smoke = state.smoke;
	if (state.smoke_started && smoke === null) {
		failures.add("provider_smoke_interrupted_unreconciled");
		reconciliationRequired = true;
		stopBatch = true;
	}
	if (smoke === null && !stopBatch) {
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v1",
				event_type: "smoke_started",
				run_id: runId,
				continuation_manifest_sha256: manifest.continuation_manifest_sha256,
				logical_run_id: null,
				receipt_path: null,
				receipt_sha256: null,
				smoke: null,
			}),
		);
		const smokeResult = await dependencies.runProviderSmoke({
			artifacts_root: store.rootPath,
			project_cap_tokens: M6_PROVIDER_SMOKE_CAP_TOKENS,
		});
		smoke = smokeReceipt(smokeResult);
		await appendUsageRecord(store, unsignedUsageRecord("provider_smoke", runId, null, smoke.accounted_tokens));
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v1",
				event_type: "smoke_completed",
				run_id: runId,
				continuation_manifest_sha256: manifest.continuation_manifest_sha256,
				logical_run_id: null,
				receipt_path: null,
				receipt_sha256: null,
				smoke,
			}),
		);
	}
	if (smoke === null) {
		failures.add("provider_smoke_missing");
		stopBatch = true;
	} else if (
		smoke.status !== "pass" ||
		smoke.accounted_tokens < 1 ||
		smoke.accounted_tokens > M6_PROVIDER_SMOKE_CAP_TOKENS
	) {
		failures.add(
			smoke.status !== "pass"
				? "provider_smoke_failed"
				: smoke.accounted_tokens < 1
					? "provider_smoke_usage_missing"
					: "provider_smoke_budget_exceeded",
		);
		stopBatch = true;
	}
	for (const pending of manifest.pending_runs) {
		const logicalRun = pending.logical_run;
		if (receipts.has(logicalRun.run_id) || stopBatch) continue;
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v1",
				event_type: "run_started",
				run_id: runId,
				continuation_manifest_sha256: manifest.continuation_manifest_sha256,
				logical_run_id: logicalRun.run_id,
				receipt_path: null,
				receipt_sha256: null,
				smoke: null,
			}),
		);
		let receipt: M6CalibrationRunReceipt;
		let usageToRecord: number | null = null;
		try {
			const m4 = await dependencies.runM4({
				artifacts_root: store.rootPath,
				logical_run: logicalRun,
				accounted_admission_cap_tokens: M6_CONTINUATION_PER_RUN_CAP_TOKENS,
				token_admission_estimator: {
					version: "m6-deepseek-v4-flash-calibration-provisional-v1",
					multiplier: 1.25,
					framing_margin_tokens: 512,
				},
			});
			const ledgerBytes = await dependencies.readFile(resolve(m4.run_directory, "token-ledger.jsonl"));
			const ledger = inspectM6TokenLedger(parseM6TokenLedger(ledgerBytes));
			receipt = createM6M4Receipt(logicalRun, m4, ledgerBytes, ledger, store.rootPath);
			usageToRecord = ledger.accounted_tokens;
			if (ledger.requires_reconciliation) reconciliationRequired = true;
		} catch (error) {
			if (error instanceof M4PreProviderInputError) {
				receipt = emptyReceipt(logicalRun, "m4_pre_provider_input_failure");
			} else {
				receipt = emptyReceipt(logicalRun, "continuation_runner_exception", true);
				reconciliationRequired = true;
			}
		}
		const saved = await writeReceipt(store, receipt);
		if (usageToRecord !== null) {
			await appendUsageRecord(store, unsignedUsageRecord("logical_run", runId, logicalRun.run_id, usageToRecord));
		}
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v1",
				event_type: "run_terminal",
				run_id: runId,
				continuation_manifest_sha256: manifest.continuation_manifest_sha256,
				logical_run_id: logicalRun.run_id,
				receipt_path: saved.path,
				receipt_sha256: saved.sha256,
				smoke: null,
			}),
		);
		receipts.set(logicalRun.run_id, receipt);
		if (!isCleanReceipt(receipt)) {
			for (const reason of receipt.failure_reasons) failures.add(reason);
			stopBatch = true;
		}
	}
	const continuationReceipts = manifest.pending_runs.flatMap((pending) => {
		const receipt = receipts.get(pending.logical_run.run_id);
		return receipt === undefined ? [] : [receipt];
	});
	const allReceipts = [...selected.inherited, ...continuationReceipts];
	const completedRuns = allReceipts.filter(isCleanReceipt).length;
	const observations = allReceipts.flatMap((receipt) => receipt.observations);
	const contextBudgets: RepoToolOutputBudgetSnapshot[] = allReceipts.flatMap((receipt) =>
		receipt.repofix_context_budget === null ? [] : [receipt.repofix_context_budget],
	);
	const usageRecords = await readUsageRecords(store);
	const usageTokens = usageRecords.reduce((total, record) => total + record.accounted_tokens, 0);
	const usageRunIds = new Set(
		usageRecords
			.filter((record) => record.event_type === "logical_run" && record.logical_run_id !== null)
			.map((record) => record.logical_run_id),
	);
	if (
		(smoke !== null && usageRecords.filter((record) => record.event_type === "provider_smoke").length !== 1) ||
		continuationReceipts.some(
			(receipt) => receipt.accounted_tokens > 0 && !usageRunIds.has(receipt.logical_run.run_id),
		)
	) {
		failures.add("continuation_usage_ledger_incomplete");
		reconciliationRequired = true;
	}
	if (continuationReceipts.some((receipt) => receipt.requires_reconciliation)) reconciliationRequired = true;
	const calibrated =
		failures.size === 0 && completedRuns === M6_CALIBRATION_RUN_COUNT && !reconciliationRequired
			? createM6CalibratedTokenEstimator(observations)
			: null;
	const unsignedReport = {
		schema_version: "v1" as const,
		report_type: "m6_dev_calibration_continuation" as const,
		protocol_revision: M6_CONTINUATION_PROTOCOL_REVISION,
		continuation_manifest_sha256: manifest.continuation_manifest_sha256,
		run_id: runId,
		started_at: startedAt,
		finished_at: dependencies.now().toISOString(),
		status: (failures.size === 0 &&
		completedRuns === M6_CALIBRATION_RUN_COUNT &&
		calibrated !== null &&
		!reconciliationRequired
			? "pass"
			: "fail") as "pass" | "fail",
		cost_admission: "per_run_enforced_no_project_cap" as const,
		budget_policy: manifest.budget_policy,
		source: {
			report_relative_path: manifest.source_report_relative_path,
			report_file_sha256: manifest.source_report_file_sha256,
			report_sha256: manifest.source_report_sha256,
			calibration_batch_sha256: manifest.calibration_batch_sha256,
		},
		provider_smoke: smoke,
		inherited_run_receipts: selected.inherited,
		continuation_run_receipts: continuationReceipts,
		calibrated_estimator: calibrated,
		batch_failure_reasons: [...failures].sort(),
		aggregate: {
			expected_logical_runs: M6_CALIBRATION_RUN_COUNT,
			inherited_clean_runs: selected.inherited.length,
			continuation_completed_runs: continuationReceipts.filter(isCleanReceipt).length,
			failed_logical_runs: M6_CALIBRATION_RUN_COUNT - completedRuns,
			request_count: observations.length,
			observed_logical_run_tokens: allReceipts.reduce((total, receipt) => total + receipt.accounted_tokens, 0),
			continuation_spend_tokens: usageTokens,
			continuation_usage_ledger: {
				accounted_tokens: usageTokens,
				entry_count: usageRecords.length,
				reconciliation_required: reconciliationRequired,
			},
			maximum_base_input_tokens:
				observations.length === 0 ? null : Math.max(...observations.map((item) => item.base_input_tokens)),
			maximum_provider_prompt_tokens:
				observations.length === 0 ? null : Math.max(...observations.map((item) => item.provider_prompt_tokens)),
			maximum_provider_total_tokens:
				observations.length === 0 ? null : Math.max(...observations.map((item) => item.provider_total_tokens)),
			context_truncation: {
				repofix_run_count: contextBudgets.length,
				truncated_calls: contextBudgets.reduce((total, item) => total + item.truncated_calls, 0),
				maximum_visible_chars:
					contextBudgets.length === 0 ? 0 : Math.max(...contextBudgets.map((item) => item.visible_chars)),
			},
		},
	};
	const report: M6DevCalibrationContinuationReport = {
		...unsignedReport,
		calibration_evidence_sha256: canonicalHash(unsignedReport),
		report_sha256: "",
	};
	const sealedReport: M6DevCalibrationContinuationReport = {
		...report,
		report_sha256: canonicalHash(reportSubset(report)),
	};
	await store.registerClosedFile(JOURNAL_PATH, {
		mediaType: "application/x-ndjson",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	if (usageRecords.length > 0) {
		await store.registerClosedFile(USAGE_LEDGER_PATH, {
			mediaType: "application/x-ndjson",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
	}
	await store.writeNew("continuation-report.json", stableStringify(sealedReport), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	const summary: M6DevCalibrationContinuationSummary = {
		schema_version: "v1",
		summary_type: "m6_dev_calibration_continuation",
		run_id: runId,
		terminal_status: sealedReport.status === "pass" ? "completed" : "failed",
		run_directory: runDirectory,
		calibration_evidence_sha256: sealedReport.calibration_evidence_sha256,
		report_sha256: sealedReport.report_sha256,
	};
	await store.writeNew("m6-continuation-summary.json", stableStringify(summary), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	if (basename(store.rootPath).startsWith(".staging-")) await store.publishTo(runDirectory);
	return summary;
}
