import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../contracts/canonical-json.ts";
import { GlobalBudgetLedger, type GlobalBudgetState } from "../runner/global-budget-ledger.ts";
import {
	createDefaultM4DevWorkflowDependencies,
	type M4DevWorkflowSummary,
	M4PreProviderInputError,
	runM4DevWorkflow,
} from "../runner/m4-dev-workflow.ts";
import { createDeepSeekV4FlashRuntime } from "../runner/runtime-factory.ts";
import { DirectoryTaskEnvironmentLockSource, FilePublicTaskSource } from "../runner/task-source.ts";
import type { TokenAdmissionEstimatorSpec } from "../runner/token-supervisor.ts";
import type { RepoToolOutputBudgetSnapshot } from "../sandbox/repo-tools.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import {
	M6_CALIBRATION_PER_RUN_CAP_TOKENS,
	M6_CALIBRATION_PROJECT_CAP_TOKENS,
	M6_CALIBRATION_PROTOCOL_REVISION,
	M6_CALIBRATION_RUN_COUNT,
	M6_PROVIDER_SMOKE_CAP_TOKENS,
	type M6CalibrationRun,
	type M6DevCalibrationBatch,
	verifyM6DevCalibrationBatch,
} from "./calibration-cohort.ts";
import { runM6ProviderSmoke } from "./provider-smoke.ts";

export const M6_DEV_CALIBRATION_PER_RUN_ADMISSION_CAP_TOKENS = M6_CALIBRATION_PER_RUN_CAP_TOKENS;
export const M6_DEV_CALIBRATION_PROJECT_ADMISSION_CAP_TOKENS = M6_CALIBRATION_PROJECT_CAP_TOKENS;
export const M6_DEV_CALIBRATION_PROVISIONAL_ESTIMATOR = {
	version: "m6-deepseek-v4-flash-calibration-provisional-v1",
	multiplier: 1.25,
	framing_margin_tokens: 512,
} as const satisfies TokenAdmissionEstimatorSpec;
const M6_MAXIMUM_REQUEST_ACTUAL_TOKENS = 147_456;
const FINAL_ESTIMATOR_MARGIN_TOKENS = 4_096;
const FINAL_ESTIMATOR_MULTIPLIER_SAFETY = 0.1;
const M6_TASK_ENVIRONMENT_LOCK_ROOT = fileURLToPath(new URL("../../configs/runtime/m6-26-task-v1", import.meta.url));
const M6_RUNTIME_CONFIG_ROOT = fileURLToPath(new URL("../../configs/runtime", import.meta.url));
const JOURNAL_PATH = "m6-events.jsonl";

type LedgerEventType =
	| "reservation_open"
	| "reservation_settled"
	| "reservation_charged_unverified"
	| "budget_protocol_invalid"
	| "admission_rejected";

export interface ParsedM6TokenLedgerEvent {
	readonly event_type: LedgerEventType;
	readonly request_id: string;
	readonly reservation_tokens: number | null;
	readonly accounted_tokens: number | null;
	readonly base_input_tokens: number | null;
	readonly estimated_input_tokens: number | null;
	readonly provider_prompt_tokens: number | null;
	readonly provider_completion_tokens: number | null;
	readonly provider_total_tokens: number | null;
	readonly reason: string | null;
}

export interface M6CalibrationObservation {
	readonly request_id: string;
	readonly base_input_tokens: number;
	readonly reserved_input_tokens: number;
	readonly reservation_tokens: number;
	readonly provider_prompt_tokens: number;
	readonly provider_completion_tokens: number;
	readonly provider_total_tokens: number;
}

export interface M6CalibrationRunReceipt {
	readonly logical_run: M6CalibrationRun;
	readonly m4_run_id: string | null;
	readonly m4_artifact_relative_path: string | null;
	readonly terminal_status: "completed" | "failed";
	readonly accounted_tokens: number;
	readonly token_ledger_sha256: string | null;
	readonly request_count: number;
	readonly observations: readonly M6CalibrationObservation[];
	readonly budget_protocol_valid: boolean;
	readonly requires_reconciliation: boolean;
	readonly failure_reasons: readonly string[];
	readonly repofix_context_budget: RepoToolOutputBudgetSnapshot | null;
}

export interface M6ProviderSmokeReceipt {
	readonly run_id: string;
	readonly status: "pass" | "fail";
	readonly accounted_tokens: number;
	readonly token_ledger_sha256: string;
}

/** The calibration runner needs only settled smoke accounting, not prompt data. */
export interface M6ProviderSmokeResult {
	readonly run_id: string;
	readonly status: "pass" | "fail";
	readonly accounted_tokens: number;
	readonly token_ledger_sha256: string;
}

export interface M6CalibratedTokenEstimator extends TokenAdmissionEstimatorSpec {
	readonly maximum_request_actual_tokens: typeof M6_MAXIMUM_REQUEST_ACTUAL_TOKENS;
}

export interface M6DevCalibrationReport {
	readonly schema_version: "v2";
	readonly report_type: "m6_dev_calibration";
	readonly protocol_revision: M6DevCalibrationBatch["protocol_revision"];
	readonly calibration_batch_sha256: string;
	readonly run_id: string;
	readonly started_at: string;
	readonly finished_at: string;
	readonly status: "pass" | "fail";
	readonly cost_admission: "enforced";
	readonly budget_caps: {
		readonly per_logical_run_tokens: number;
		readonly project_tokens: number;
		readonly provider_smoke_tokens: number;
	};
	readonly provider_smoke: M6ProviderSmokeReceipt | null;
	readonly provisional_estimator: typeof M6_DEV_CALIBRATION_PROVISIONAL_ESTIMATOR;
	readonly calibrated_estimator: M6CalibratedTokenEstimator | null;
	readonly batch_failure_reasons: readonly string[];
	readonly run_receipts: readonly M6CalibrationRunReceipt[];
	readonly aggregate: {
		readonly expected_logical_runs: number;
		readonly completed_logical_runs: number;
		readonly failed_logical_runs: number;
		readonly budget_exhausted_runs: number;
		readonly request_count: number;
		readonly accounted_tokens: number;
		readonly maximum_base_input_tokens: number | null;
		readonly maximum_provider_prompt_tokens: number | null;
		readonly maximum_provider_total_tokens: number | null;
		readonly maximum_prompt_residual_tokens: number | null;
		readonly context_truncation: {
			readonly repofix_run_count: number;
			readonly truncated_calls: number;
			readonly maximum_visible_chars: number;
		};
		readonly global_budget: GlobalBudgetState;
	};
	readonly calibration_evidence_sha256: string;
	readonly report_sha256: string;
}

export interface M6DevCalibrationSummary {
	readonly schema_version: "v2";
	readonly summary_type: "m6_dev_calibration";
	readonly run_id: string;
	readonly terminal_status: "completed" | "failed";
	readonly run_directory: string;
	readonly calibration_evidence_sha256: string;
	readonly report_sha256: string;
}

export interface M6DevCalibrationDependencies {
	readonly runM4: (input: {
		readonly artifacts_root: string;
		readonly logical_run: M6CalibrationRun;
		readonly accounted_admission_cap_tokens: number;
		readonly token_admission_estimator: TokenAdmissionEstimatorSpec;
	}) => Promise<M4DevWorkflowSummary>;
	readonly runProviderSmoke: (input: {
		readonly artifacts_root: string;
		readonly project_cap_tokens: number;
	}) => Promise<M6ProviderSmokeResult>;
	readonly readFile: (path: string) => Promise<Uint8Array>;
	readonly now: () => Date;
	readonly randomId: () => string;
}

interface JournalEvent {
	readonly schema_version: "v2";
	readonly event_type: "initialized" | "smoke_started" | "smoke_completed" | "run_started" | "run_terminal";
	readonly run_id: string;
	readonly calibration_batch_sha256: string;
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

function canonicalHash(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function canonicalJsonLine(value: unknown): string {
	return `${JSON.stringify(JSON.parse(stableStringify(value)))}\n`;
}

function bytesSha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function nullableSafeInteger(value: unknown, label: string): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error(`${label} must be a non-negative safe integer or null`);
	return value as number;
}

export function parseM6TokenLedger(content: Uint8Array): readonly ParsedM6TokenLedgerEvent[] {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(content).trim();
	if (text.length === 0) return [];
	return text.split("\n").map((line, index) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`Token ledger line ${String(index + 1)} is not JSON`);
		}
		const record = asRecord(parsed, `Token ledger line ${String(index + 1)}`);
		const eventType = record.event_type;
		if (
			eventType !== "reservation_open" &&
			eventType !== "reservation_settled" &&
			eventType !== "reservation_charged_unverified" &&
			eventType !== "budget_protocol_invalid" &&
			eventType !== "admission_rejected"
		)
			throw new Error(`Token ledger line ${String(index + 1)} has an unknown event type`);
		if (typeof record.request_id !== "string" || record.request_id.length === 0) {
			throw new Error(`Token ledger line ${String(index + 1)} has an invalid request ID`);
		}
		if (record.reason !== null && typeof record.reason !== "string")
			throw new Error(`Token ledger line ${String(index + 1)} has an invalid reason`);
		return {
			event_type: eventType,
			request_id: record.request_id,
			reservation_tokens: nullableSafeInteger(record.reservation_tokens, "reservation_tokens"),
			accounted_tokens: nullableSafeInteger(record.accounted_tokens, "accounted_tokens"),
			base_input_tokens: nullableSafeInteger(record.base_input_tokens, "base_input_tokens"),
			estimated_input_tokens: nullableSafeInteger(record.estimated_input_tokens, "estimated_input_tokens"),
			provider_prompt_tokens: nullableSafeInteger(record.provider_prompt_tokens, "provider_prompt_tokens"),
			provider_completion_tokens: nullableSafeInteger(
				record.provider_completion_tokens,
				"provider_completion_tokens",
			),
			provider_total_tokens: nullableSafeInteger(record.provider_total_tokens, "provider_total_tokens"),
			reason: record.reason,
		};
	});
}

export function inspectM6TokenLedger(events: readonly ParsedM6TokenLedgerEvent[]): {
	readonly accounted_tokens: number;
	readonly observations: readonly M6CalibrationObservation[];
	readonly budget_protocol_valid: boolean;
	readonly requires_reconciliation: boolean;
	readonly failure_reasons: readonly string[];
} {
	const opened = new Map<string, ParsedM6TokenLedgerEvent>();
	const terminal = new Set<string>();
	const observations: M6CalibrationObservation[] = [];
	const failures: string[] = [];
	let accountedTokens = 0;
	let requiresReconciliation = false;
	for (const event of events) {
		if (event.event_type === "reservation_open") {
			if (
				opened.has(event.request_id) ||
				event.reservation_tokens === null ||
				event.reservation_tokens < 1 ||
				event.base_input_tokens === null ||
				event.base_input_tokens < 1 ||
				event.estimated_input_tokens === null ||
				event.estimated_input_tokens < 1 ||
				event.accounted_tokens !== null
			)
				failures.push("reservation_open_invalid");
			else opened.set(event.request_id, event);
			continue;
		}
		if (event.event_type === "admission_rejected") {
			failures.push(event.reason === "budget_exhausted" ? "budget_exhausted" : "admission_rejected");
			continue;
		}
		const opening = opened.get(event.request_id);
		if (opening === undefined || terminal.has(event.request_id)) {
			failures.push("reservation_terminal_without_open");
			continue;
		}
		terminal.add(event.request_id);
		const openingBaseInputTokens = opening.base_input_tokens;
		const openingEstimatedInputTokens = opening.estimated_input_tokens;
		const openingReservationTokens = opening.reservation_tokens;
		if (
			openingBaseInputTokens === null ||
			openingEstimatedInputTokens === null ||
			openingReservationTokens === null
		) {
			failures.push("reservation_open_invalid");
			continue;
		}
		if (event.event_type === "reservation_settled") {
			if (
				event.accounted_tokens === null ||
				event.base_input_tokens !== openingBaseInputTokens ||
				event.estimated_input_tokens !== openingEstimatedInputTokens ||
				event.reservation_tokens !== openingReservationTokens ||
				event.provider_prompt_tokens === null ||
				event.provider_completion_tokens === null ||
				event.provider_total_tokens === null ||
				event.provider_total_tokens !== event.provider_prompt_tokens + event.provider_completion_tokens ||
				event.accounted_tokens !== event.provider_total_tokens ||
				event.provider_prompt_tokens > openingEstimatedInputTokens ||
				event.provider_total_tokens > openingReservationTokens
			)
				failures.push("reservation_settlement_invalid");
			else {
				accountedTokens += event.accounted_tokens;
				observations.push({
					request_id: event.request_id,
					base_input_tokens: openingBaseInputTokens,
					reserved_input_tokens: openingEstimatedInputTokens,
					reservation_tokens: openingReservationTokens,
					provider_prompt_tokens: event.provider_prompt_tokens,
					provider_completion_tokens: event.provider_completion_tokens,
					provider_total_tokens: event.provider_total_tokens,
				});
			}
			continue;
		}
		if (event.accounted_tokens === null || event.accounted_tokens !== openingReservationTokens)
			failures.push("unverified_charge_invalid");
		else accountedTokens += event.accounted_tokens;
		requiresReconciliation = true;
		failures.push(
			event.event_type === "budget_protocol_invalid" ? "budget_protocol_invalid" : "provider_usage_unverified",
		);
	}
	for (const requestId of opened.keys()) {
		if (!terminal.has(requestId)) {
			requiresReconciliation = true;
			failures.push("open_reservation");
		}
	}
	return {
		accounted_tokens: accountedTokens,
		observations,
		budget_protocol_valid: failures.length === 0,
		requires_reconciliation: requiresReconciliation,
		failure_reasons: [...new Set(failures)].sort(),
	};
}

export function createM6CalibratedTokenEstimator(
	observations: readonly M6CalibrationObservation[],
): M6CalibratedTokenEstimator | null {
	if (observations.length === 0) return null;
	const maximumRatio = Math.max(...observations.map((item) => item.provider_prompt_tokens / item.base_input_tokens));
	const multiplier = Math.max(1, Math.ceil((maximumRatio + FINAL_ESTIMATOR_MULTIPLIER_SAFETY) * 1_000) / 1_000);
	const estimator: M6CalibratedTokenEstimator = {
		version: "m6-deepseek-v4-flash-calibrated-v1",
		multiplier,
		framing_margin_tokens: FINAL_ESTIMATOR_MARGIN_TOKENS,
		maximum_request_actual_tokens: M6_MAXIMUM_REQUEST_ACTUAL_TOKENS,
	};
	for (const observation of observations) {
		const estimated =
			Math.ceil(observation.base_input_tokens * estimator.multiplier) + estimator.framing_margin_tokens;
		if (
			estimated < observation.provider_prompt_tokens ||
			observation.provider_total_tokens > estimator.maximum_request_actual_tokens
		) {
			throw new Error("M6 calibrated token estimator does not cover sealed calibration evidence");
		}
	}
	return estimator;
}

function receiptPath(logicalRun: M6CalibrationRun): string {
	return `receipts/${logicalRun.run_id}.json`;
}

function emptyReceipt(logicalRun: M6CalibrationRun, reason: string): M6CalibrationRunReceipt {
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
		requires_reconciliation: reason === "interrupted_unreconciled",
		failure_reasons: [reason],
		repofix_context_budget: null,
	};
}

function semanticReportSubset(value: M6DevCalibrationReport): Omit<M6DevCalibrationReport, "report_sha256"> {
	const { report_sha256: _reportSha256, ...semantic } = value;
	return semantic;
}

function calibrationEvidenceSubset(
	value: M6DevCalibrationReport,
): Omit<M6DevCalibrationReport, "calibration_evidence_sha256" | "report_sha256"> {
	const { calibration_evidence_sha256: _calibrationEvidenceSha256, report_sha256: _reportSha256, ...semantic } = value;
	return semantic;
}

/** Verifies the two seals before a later M6 continuation reuses any receipt. */
export function verifyM6DevCalibrationReport(value: unknown): M6DevCalibrationReport {
	const record = asRecord(value, "M6 Dev calibration report");
	const typed = record as unknown as M6DevCalibrationReport;
	if (
		typed.schema_version !== "v2" ||
		typed.report_type !== "m6_dev_calibration" ||
		typed.protocol_revision !== M6_CALIBRATION_PROTOCOL_REVISION ||
		(typed.status !== "pass" && typed.status !== "fail") ||
		typed.cost_admission !== "enforced" ||
		typeof typed.calibration_batch_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(typed.calibration_batch_sha256) ||
		typeof typed.calibration_evidence_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(typed.calibration_evidence_sha256) ||
		typeof typed.report_sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(typed.report_sha256) ||
		!Array.isArray(typed.run_receipts)
	) {
		throw new Error("M6 Dev calibration report is malformed");
	}
	if (
		typed.calibration_evidence_sha256 !== canonicalHash(calibrationEvidenceSubset(typed)) ||
		typed.report_sha256 !== canonicalHash(semanticReportSubset(typed))
	) {
		throw new Error("M6 Dev calibration report seals are invalid");
	}
	return typed;
}

function unsignedJournalEvent(value: Omit<JournalEvent, "event_sha256">): JournalEvent {
	return { ...value, event_sha256: canonicalHash(value) };
}

function verifyJournalEvent(value: unknown, batch: M6DevCalibrationBatch): JournalEvent {
	const event = asRecord(value, "M6 journal event") as Partial<JournalEvent>;
	if (
		event.schema_version !== "v2" ||
		typeof event.event_type !== "string" ||
		typeof event.run_id !== "string" ||
		event.calibration_batch_sha256 !== batch.calibration_batch_sha256 ||
		typeof event.event_sha256 !== "string"
	)
		throw new Error("M6 journal event is malformed");
	const { event_sha256: actual, ...unsigned } = event as JournalEvent;
	if (actual !== canonicalHash(unsigned)) throw new Error("M6 journal event hash is invalid");
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

async function readJournal(store: ArtifactStore, batch: M6DevCalibrationBatch): Promise<JournalState | null> {
	const raw = await readFile(store.resolvePath(JOURNAL_PATH), "utf8").catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (raw === null || raw.trim().length === 0) return null;
	const events = raw
		.trim()
		.split("\n")
		.map((line) => verifyJournalEvent(JSON.parse(line), batch));
	const initial = events[0];
	if (initial?.event_type !== "initialized" || initial.logical_run_id !== null || initial.smoke !== null)
		throw new Error("M6 journal lacks a valid initialization event");
	let smokeStarted = false;
	let smoke: M6ProviderSmokeReceipt | null = null;
	const started = new Set<string>();
	const terminal = new Map<string, { receipt_path: string; receipt_sha256: string }>();
	for (const event of events.slice(1)) {
		if (event.run_id !== initial.run_id) throw new Error("M6 journal run identity drifted");
		if (event.event_type === "smoke_started") {
			if (smokeStarted || smoke !== null) throw new Error("M6 smoke journal transition is invalid");
			smokeStarted = true;
			continue;
		}
		if (event.event_type === "smoke_completed") {
			if (!smokeStarted || event.smoke === null || smoke !== null) throw new Error("M6 smoke receipt is invalid");
			smoke = event.smoke;
			continue;
		}
		if (event.logical_run_id === null) throw new Error("M6 logical run journal event is missing its run ID");
		if (event.event_type === "run_started") {
			if (started.has(event.logical_run_id)) throw new Error("M6 logical run was started more than once");
			started.add(event.logical_run_id);
			continue;
		}
		if (event.event_type === "run_terminal") {
			if (
				!started.has(event.logical_run_id) ||
				terminal.has(event.logical_run_id) ||
				event.receipt_path === null ||
				event.receipt_sha256 === null
			)
				throw new Error("M6 logical run terminal event is invalid");
			terminal.set(event.logical_run_id, { receipt_path: event.receipt_path, receipt_sha256: event.receipt_sha256 });
			continue;
		}
		throw new Error("M6 journal event type is invalid");
	}
	return { run_id: initial.run_id, smoke_started: smokeStarted, smoke, started, terminal };
}

function smokeReceipt(report: M6ProviderSmokeResult): M6ProviderSmokeReceipt {
	return {
		run_id: report.run_id,
		status: report.status,
		accounted_tokens: report.accounted_tokens,
		token_ledger_sha256: report.token_ledger_sha256,
	};
}

async function readReceipt(
	store: ArtifactStore,
	path: string,
	expectedSha256: string,
): Promise<M6CalibrationRunReceipt> {
	const content = await readFile(store.resolvePath(path));
	if (bytesSha256(content) !== expectedSha256) throw new Error("M6 receipt SHA-256 drifted during resume");
	const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as M6CalibrationRunReceipt;
	if (typeof receipt !== "object" || receipt === null || !Array.isArray(receipt.failure_reasons))
		throw new Error("M6 receipt is malformed during resume");
	return receipt;
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

export function createM6M4Receipt(
	logicalRun: M6CalibrationRun,
	m4: M4DevWorkflowSummary,
	ledgerBytes: Uint8Array,
	ledger: ReturnType<typeof inspectM6TokenLedger>,
	root: string,
): M6CalibrationRunReceipt {
	const m4RelativeDirectory = relative(root, resolve(m4.run_directory));
	if (m4RelativeDirectory.length === 0 || m4RelativeDirectory.startsWith("..") || m4RelativeDirectory.includes("\\"))
		throw new Error("M6 calibration M4 artifact escaped its run directory");
	return {
		logical_run: logicalRun,
		m4_run_id: m4.run_id,
		m4_artifact_relative_path: m4RelativeDirectory.replaceAll("\\", "/"),
		terminal_status: m4.terminal_status,
		accounted_tokens: ledger.accounted_tokens,
		token_ledger_sha256: bytesSha256(ledgerBytes),
		request_count: ledger.observations.length,
		observations: ledger.observations,
		budget_protocol_valid: ledger.budget_protocol_valid,
		requires_reconciliation: ledger.requires_reconciliation,
		failure_reasons: [
			...(m4.terminal_status === "completed" ? [] : ["m4_terminal_failure"]),
			...ledger.failure_reasons,
		].sort(),
		repofix_context_budget: m4.repofix_context_budget ?? null,
	};
}

export async function runM6DevCalibration(
	options: {
		readonly artifacts_root: string;
		readonly calibration_batch: M6DevCalibrationBatch;
		readonly resume_directory?: string;
	},
	dependencies: M6DevCalibrationDependencies,
): Promise<M6DevCalibrationSummary> {
	const batch = verifyM6DevCalibrationBatch(options.calibration_batch);
	let store: ArtifactStore;
	let runId: string;
	let runDirectory: string;
	let startedAt: string;
	let state: JournalState | null;
	if (options.resume_directory === undefined) {
		runId = `m6-calibration-run-${dependencies.randomId()}`;
		runDirectory = resolve(options.artifacts_root, "m6-deepseek-flash-calibration", "runs", runId);
		store = await ArtifactStore.createNew(
			resolve(options.artifacts_root, "m6-deepseek-flash-calibration", "runs", `.staging-${runId}`),
		);
		startedAt = dependencies.now().toISOString();
		await store.writeNew("calibration-batch.json", stableStringify(batch), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v2",
				event_type: "initialized",
				run_id: runId,
				calibration_batch_sha256: batch.calibration_batch_sha256,
				logical_run_id: null,
				receipt_path: null,
				receipt_sha256: null,
				smoke: null,
			}),
		);
		state = await readJournal(store, batch);
	} else {
		store = await ArtifactStore.openExisting(options.resume_directory);
		const persistedBatch = verifyM6DevCalibrationBatch(
			JSON.parse(await readFile(store.resolvePath("calibration-batch.json"), "utf8")),
		);
		if (persistedBatch.calibration_batch_sha256 !== batch.calibration_batch_sha256) {
			throw new Error("M6 resume batch hash does not match the staged calibration batch");
		}
		state = await readJournal(store, batch);
		if (state === null) throw new Error("M6 resume directory has no durable journal");
		runId = state.run_id;
		runDirectory = resolve(dirname(store.rootPath), runId);
		startedAt = dependencies.now().toISOString();
	}
	if (state === null) throw new Error("M6 journal initialization failed");
	const budget = await GlobalBudgetLedger.open(
		store.resolvePath("global-budget.json"),
		M6_DEV_CALIBRATION_PROJECT_ADMISSION_CAP_TOKENS,
	);
	let smoke = state.smoke;
	const receipts = new Map<string, M6CalibrationRunReceipt>();
	for (const [logicalRunId, terminal] of state.terminal)
		receipts.set(logicalRunId, await readReceipt(store, terminal.receipt_path, terminal.receipt_sha256));
	const batchFailureReasons = new Set<string>();
	let failed = [...receipts.values()].some(
		(receipt) =>
			receipt.terminal_status !== "completed" ||
			!receipt.budget_protocol_valid ||
			receipt.requires_reconciliation ||
			receipt.observations.length === 0,
	);
	let stopBatch = false;
	if (state.started.size !== state.terminal.size) {
		for (const logicalRun of batch.logical_runs) {
			if (state.started.has(logicalRun.run_id) && !state.terminal.has(logicalRun.run_id)) {
				const receipt = emptyReceipt(logicalRun, "interrupted_unreconciled");
				const saved = await writeReceipt(store, receipt);
				await appendJournal(
					store,
					unsignedJournalEvent({
						schema_version: "v2",
						event_type: "run_terminal",
						run_id: runId,
						calibration_batch_sha256: batch.calibration_batch_sha256,
						logical_run_id: logicalRun.run_id,
						receipt_path: saved.path,
						receipt_sha256: saved.sha256,
						smoke: null,
					}),
				);
				receipts.set(logicalRun.run_id, receipt);
				failed = true;
				stopBatch = true;
				batchFailureReasons.add("interrupted_unreconciled");
			}
		}
	}
	if (state.smoke_started && smoke === null) {
		failed = true;
		stopBatch = true;
		batchFailureReasons.add("provider_smoke_interrupted_unreconciled");
	}
	if (smoke === null && !stopBatch) {
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v2",
				event_type: "smoke_started",
				run_id: runId,
				calibration_batch_sha256: batch.calibration_batch_sha256,
				logical_run_id: null,
				receipt_path: null,
				receipt_sha256: null,
				smoke: null,
			}),
		);
		const report = await dependencies.runProviderSmoke({
			artifacts_root: store.rootPath,
			project_cap_tokens: M6_PROVIDER_SMOKE_CAP_TOKENS,
		});
		smoke = smokeReceipt(report);
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v2",
				event_type: "smoke_completed",
				run_id: runId,
				calibration_batch_sha256: batch.calibration_batch_sha256,
				logical_run_id: null,
				receipt_path: null,
				receipt_sha256: null,
				smoke,
			}),
		);
	}
	if (smoke === null) {
		failed = true;
		stopBatch = true;
		batchFailureReasons.add("provider_smoke_missing");
	} else if (
		smoke.status !== "pass" ||
		smoke.accounted_tokens < 1 ||
		smoke.accounted_tokens > M6_PROVIDER_SMOKE_CAP_TOKENS
	) {
		failed = true;
		stopBatch = true;
		batchFailureReasons.add(
			smoke.status !== "pass"
				? "provider_smoke_failed"
				: smoke.accounted_tokens < 1
					? "provider_smoke_usage_missing"
					: "provider_smoke_budget_exceeded",
		);
	}
	if (
		smoke !== null &&
		!budget.snapshot.reconciliation_required &&
		budget.snapshot.accounted_tokens === 0 &&
		smoke.accounted_tokens > 0
	) {
		await budget.recordObserved(smoke.accounted_tokens);
	}
	for (const logicalRun of batch.logical_runs) {
		if (receipts.has(logicalRun.run_id)) continue;
		if (stopBatch) break;
		const remaining =
			M6_DEV_CALIBRATION_PROJECT_ADMISSION_CAP_TOKENS -
			budget.snapshot.accounted_tokens -
			budget.snapshot.reserved_tokens;
		const effectiveCap = Math.min(M6_DEV_CALIBRATION_PER_RUN_ADMISSION_CAP_TOKENS, remaining);
		if (effectiveCap < 16_385 || budget.snapshot.reconciliation_required) {
			const receipt = emptyReceipt(
				logicalRun,
				budget.snapshot.reconciliation_required ? "reconciliation_required" : "budget_exhausted",
			);
			const saved = await writeReceipt(store, receipt);
			await appendJournal(
				store,
				unsignedJournalEvent({
					schema_version: "v2",
					event_type: "run_started",
					run_id: runId,
					calibration_batch_sha256: batch.calibration_batch_sha256,
					logical_run_id: logicalRun.run_id,
					receipt_path: null,
					receipt_sha256: null,
					smoke: null,
				}),
			);
			await appendJournal(
				store,
				unsignedJournalEvent({
					schema_version: "v2",
					event_type: "run_terminal",
					run_id: runId,
					calibration_batch_sha256: batch.calibration_batch_sha256,
					logical_run_id: logicalRun.run_id,
					receipt_path: saved.path,
					receipt_sha256: saved.sha256,
					smoke: null,
				}),
			);
			receipts.set(logicalRun.run_id, receipt);
			failed = true;
			stopBatch = true;
			batchFailureReasons.add(receipt.failure_reasons[0]!);
			break;
		}
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v2",
				event_type: "run_started",
				run_id: runId,
				calibration_batch_sha256: batch.calibration_batch_sha256,
				logical_run_id: logicalRun.run_id,
				receipt_path: null,
				receipt_sha256: null,
				smoke: null,
			}),
		);
		let receipt: M6CalibrationRunReceipt;
		try {
			const m4 = await dependencies.runM4({
				artifacts_root: store.rootPath,
				logical_run: logicalRun,
				accounted_admission_cap_tokens: effectiveCap,
				token_admission_estimator: M6_DEV_CALIBRATION_PROVISIONAL_ESTIMATOR,
			});
			const ledgerBytes = await dependencies.readFile(resolve(m4.run_directory, "token-ledger.jsonl"));
			const ledger = inspectM6TokenLedger(parseM6TokenLedger(ledgerBytes));
			if (ledger.requires_reconciliation) await budget.markReconciliationRequired();
			else await budget.recordObserved(ledger.accounted_tokens);
			receipt = createM6M4Receipt(logicalRun, m4, ledgerBytes, ledger, store.rootPath);
		} catch (error) {
			if (error instanceof M4PreProviderInputError) {
				receipt = emptyReceipt(logicalRun, "m4_pre_provider_input_failure");
			} else {
				await budget.markReconciliationRequired().catch(() => undefined);
				receipt = emptyReceipt(logicalRun, "calibration_runner_exception");
			}
		}
		const saved = await writeReceipt(store, receipt);
		await appendJournal(
			store,
			unsignedJournalEvent({
				schema_version: "v2",
				event_type: "run_terminal",
				run_id: runId,
				calibration_batch_sha256: batch.calibration_batch_sha256,
				logical_run_id: logicalRun.run_id,
				receipt_path: saved.path,
				receipt_sha256: saved.sha256,
				smoke: null,
			}),
		);
		receipts.set(logicalRun.run_id, receipt);
		if (
			receipt.terminal_status !== "completed" ||
			!receipt.budget_protocol_valid ||
			receipt.requires_reconciliation ||
			receipt.observations.length === 0
		)
			failed = true;
		if (
			receipt.terminal_status !== "completed" ||
			!receipt.budget_protocol_valid ||
			receipt.requires_reconciliation ||
			receipt.observations.length === 0
		) {
			stopBatch = true;
			for (const reason of receipt.failure_reasons) batchFailureReasons.add(reason);
		}
	}
	const orderedReceipts = batch.logical_runs.flatMap((run) => {
		const receipt = receipts.get(run.run_id);
		return receipt === undefined ? [] : [receipt];
	});
	const observations = orderedReceipts.flatMap((receipt) => receipt.observations);
	const completedRuns = orderedReceipts.filter(
		(receipt) =>
			receipt.terminal_status === "completed" &&
			receipt.budget_protocol_valid &&
			!receipt.requires_reconciliation &&
			receipt.observations.length > 0,
	).length;
	const budgetExhaustedRuns = orderedReceipts.filter((receipt) =>
		receipt.failure_reasons.includes("budget_exhausted"),
	).length;
	const contextBudgets = orderedReceipts.flatMap((receipt) =>
		receipt.repofix_context_budget === null ? [] : [receipt.repofix_context_budget],
	);
	if (budget.snapshot.reconciliation_required) batchFailureReasons.add("global_budget_reconciliation_required");
	const calibrated =
		!failed && completedRuns === M6_CALIBRATION_RUN_COUNT && !budget.snapshot.reconciliation_required
			? createM6CalibratedTokenEstimator(observations)
			: null;
	const unsignedReport = {
		schema_version: "v2" as const,
		report_type: "m6_dev_calibration" as const,
		protocol_revision: M6_CALIBRATION_PROTOCOL_REVISION,
		calibration_batch_sha256: batch.calibration_batch_sha256,
		run_id: runId,
		started_at: startedAt,
		finished_at: dependencies.now().toISOString(),
		status: (!failed &&
		completedRuns === M6_CALIBRATION_RUN_COUNT &&
		calibrated !== null &&
		budget.snapshot.accounted_tokens <= M6_DEV_CALIBRATION_PROJECT_ADMISSION_CAP_TOKENS
			? "pass"
			: "fail") as "pass" | "fail",
		cost_admission: "enforced" as const,
		budget_caps: {
			per_logical_run_tokens: M6_DEV_CALIBRATION_PER_RUN_ADMISSION_CAP_TOKENS,
			project_tokens: M6_DEV_CALIBRATION_PROJECT_ADMISSION_CAP_TOKENS,
			provider_smoke_tokens: M6_PROVIDER_SMOKE_CAP_TOKENS,
		},
		provider_smoke: smoke,
		provisional_estimator: M6_DEV_CALIBRATION_PROVISIONAL_ESTIMATOR,
		calibrated_estimator: calibrated,
		batch_failure_reasons: [...batchFailureReasons].sort(),
		run_receipts: orderedReceipts,
		aggregate: {
			expected_logical_runs: M6_CALIBRATION_RUN_COUNT,
			completed_logical_runs: completedRuns,
			failed_logical_runs: M6_CALIBRATION_RUN_COUNT - completedRuns,
			budget_exhausted_runs: budgetExhaustedRuns,
			request_count: observations.length,
			accounted_tokens: budget.snapshot.accounted_tokens,
			maximum_base_input_tokens:
				observations.length === 0 ? null : Math.max(...observations.map((item) => item.base_input_tokens)),
			maximum_provider_prompt_tokens:
				observations.length === 0 ? null : Math.max(...observations.map((item) => item.provider_prompt_tokens)),
			maximum_provider_total_tokens:
				observations.length === 0 ? null : Math.max(...observations.map((item) => item.provider_total_tokens)),
			maximum_prompt_residual_tokens:
				observations.length === 0
					? null
					: Math.max(...observations.map((item) => item.provider_prompt_tokens - item.base_input_tokens)),
			context_truncation: {
				repofix_run_count: contextBudgets.length,
				truncated_calls: contextBudgets.reduce((total, item) => total + item.truncated_calls, 0),
				maximum_visible_chars:
					contextBudgets.length === 0 ? 0 : Math.max(...contextBudgets.map((item) => item.visible_chars)),
			},
			global_budget: budget.snapshot,
		},
	};
	const report: M6DevCalibrationReport = {
		...unsignedReport,
		calibration_evidence_sha256: canonicalHash(unsignedReport),
		report_sha256: "",
	};
	const sealedReport: M6DevCalibrationReport = {
		...report,
		report_sha256: canonicalHash(semanticReportSubset(report)),
	};
	await store.registerClosedFile("global-budget.json", {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await store.registerClosedFile(JOURNAL_PATH, {
		mediaType: "application/x-ndjson",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	await store.writeNew("calibration-report.json", stableStringify(sealedReport), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	const summary: M6DevCalibrationSummary = {
		schema_version: "v2",
		summary_type: "m6_dev_calibration",
		run_id: runId,
		terminal_status: sealedReport.status === "pass" ? "completed" : "failed",
		run_directory: runDirectory,
		calibration_evidence_sha256: sealedReport.calibration_evidence_sha256,
		report_sha256: sealedReport.report_sha256,
	};
	await store.writeNew("m6-calibration-summary.json", stableStringify(summary), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	if (basename(store.rootPath).startsWith(".staging-")) await store.publishTo(runDirectory);
	return summary;
}

export function createDefaultM6DevCalibrationDependencies(controllerUrl: string): M6DevCalibrationDependencies {
	const runtime = createDeepSeekV4FlashRuntime();
	const m4Dependencies = createDefaultM4DevWorkflowDependencies(controllerUrl, runtime);
	const publicTaskSource = new FilePublicTaskSource();
	const environmentLockSource = new DirectoryTaskEnvironmentLockSource(
		process.env.REPOFIX_M6_TASK_ENVIRONMENT_LOCK_ROOT ?? M6_TASK_ENVIRONMENT_LOCK_ROOT,
		{ root_path: M6_RUNTIME_CONFIG_ROOT, relative_path: "axios-5892/dataset-lock.json" },
	);
	return {
		runM4: ({ artifacts_root, logical_run, accounted_admission_cap_tokens, token_admission_estimator }) =>
			runM4DevWorkflow(
				{
					artifactsRoot: artifacts_root,
					instanceId: logical_run.instance_id,
					configId: logical_run.config_id,
					accountedAdmissionCapTokens: accounted_admission_cap_tokens,
					tokenAdmissionEstimator: token_admission_estimator,
				},
				{ ...m4Dependencies, publicTaskSource, environmentLockSource },
			),
		runProviderSmoke: ({ artifacts_root, project_cap_tokens }) =>
			runM6ProviderSmoke({ artifacts_root, project_cap_tokens, runtime }),
		readFile,
		now: () => new Date(),
		randomId: randomUUID,
	};
}
