import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stableStringify } from "../contracts/canonical-json.ts";
import { type RunResult, verifyRunResult } from "../contracts/run-contracts.ts";
import type { BatchRunSpec, BatchRunState } from "../runner/batch-state.ts";
import { BatchStateStore } from "../runner/batch-state.ts";
import { M7_ARTIFACT_DIRECTORY, M7_CONTINUATION_SOURCE_DIRECTORY } from "./batch-runner.ts";

const SOURCE_RUN_COUNT = 74;
const CONTINUATION_RUN_COUNT = 61;

type ObservationStatus = "retained_64_turn" | "continued_128_turn" | "continuation_failed";

export interface M7ContinuationObservation {
	readonly source_run_id: string;
	readonly continuation_run_id: string | null;
	readonly group_id: string;
	readonly instance_id: string;
	readonly config_id: BatchRunSpec["config_id"];
	readonly replicate: number;
	readonly max_model_turns: 64 | 128;
	readonly status: ObservationStatus;
	readonly terminal_reason: string;
	readonly resolved: boolean | null;
	readonly result_sha256: string | null;
}

export interface M7ContinuationStratum {
	readonly max_model_turns: 64 | 128;
	readonly config_id: BatchRunSpec["config_id"];
	readonly denominator: number;
	readonly completed_result_count: number;
	readonly failed_count: number;
	readonly resolved_count: number;
	readonly accounted_tokens: number;
}

export interface M7ContinuationReport {
	readonly schema_version: "v1";
	readonly report_type: "m7_continuation_report";
	readonly status: "pass";
	readonly source_protocol_revision: "repofixlab-m7-v1.7.2";
	readonly continuation_protocol_revision: "repofixlab-m7-v1.7.3";
	readonly source_batch_state_sha256: string;
	readonly continuation_batch_state_sha256: string;
	readonly source_batch_ledger_reconciliation_required: true;
	readonly expected_original_run_count: number;
	readonly terminal_observation_count: number;
	readonly observations: readonly M7ContinuationObservation[];
	readonly strata: readonly M7ContinuationStratum[];
	readonly comparison_scope: "turn_limit_stratified_no_cross_stratum_pairing";
	readonly report_sha256: string;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function logicalKey(spec: Pick<BatchRunSpec, "group_id" | "instance_id" | "config_id" | "replicate">): string {
	return `${spec.group_id}\u0000${spec.instance_id}\u0000${spec.config_id}\u0000${spec.replicate}`;
}

function assertStateSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} state SHA-256 is invalid`);
	return value;
}

async function readBatchStateSha256(root: string, label: string): Promise<string> {
	const value: unknown = JSON.parse(await readFile(join(root, "batch-state.json"), "utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("state_sha256" in value)) {
		throw new Error(`${label} batch state is malformed`);
	}
	return assertStateSha256(value.state_sha256, label);
}

async function readCompletedResult(root: string, state: BatchRunState): Promise<RunResult> {
	if (state.status !== "completed" || state.result_sha256 === null || state.attempt_id === null) {
		throw new Error(`Run ${state.run_id} is not a completed result`);
	}
	const result = verifyRunResult(
		JSON.parse(await readFile(join(root, "results", `${state.run_id}.json`), "utf8")) as unknown,
	);
	if (
		result.run_id !== state.run_id ||
		result.attempt_id !== state.attempt_id ||
		result.result_sha256 !== state.result_sha256
	) {
		throw new Error(`Completed result binding drifted for ${state.run_id}`);
	}
	return result;
}

export function createM7ContinuationReport(
	sourceStates: readonly BatchRunState[],
	continuationStates: readonly BatchRunState[],
	sourceResults: ReadonlyMap<string, RunResult>,
	continuationResults: ReadonlyMap<string, RunResult>,
	sourceBatchStateSha256: string,
	continuationBatchStateSha256: string,
): M7ContinuationReport {
	if (sourceStates.length !== SOURCE_RUN_COUNT || continuationStates.length !== CONTINUATION_RUN_COUNT) {
		throw new Error("M7 continuation report requires the fixed 74-run source and 61-run continuation states");
	}
	const continuationByKey = new Map(continuationStates.map((state) => [logicalKey(state), state]));
	if (continuationByKey.size !== continuationStates.length)
		throw new Error("M7 continuation report has duplicate continuation identities");
	const observations = sourceStates
		.map((source): M7ContinuationObservation => {
			if (source.status === "completed") {
				const result = sourceResults.get(source.run_id);
				if (result === undefined) throw new Error(`Retained source result is missing: ${source.run_id}`);
				return {
					source_run_id: source.run_id,
					continuation_run_id: null,
					group_id: source.group_id,
					instance_id: source.instance_id,
					config_id: source.config_id,
					replicate: source.replicate,
					max_model_turns: 64,
					status: "retained_64_turn",
					terminal_reason: result.termination_reason,
					resolved: result.resolved,
					result_sha256: result.result_sha256,
				};
			}
			const continuation = continuationByKey.get(logicalKey(source));
			if (continuation === undefined || (continuation.status !== "completed" && continuation.status !== "failed")) {
				throw new Error(`Continuation terminal evidence is missing for ${source.run_id}`);
			}
			if (continuation.status === "completed") {
				const result = continuationResults.get(continuation.run_id);
				if (result === undefined) throw new Error(`Continuation result is missing: ${continuation.run_id}`);
				return {
					source_run_id: source.run_id,
					continuation_run_id: continuation.run_id,
					group_id: source.group_id,
					instance_id: source.instance_id,
					config_id: source.config_id,
					replicate: source.replicate,
					max_model_turns: 128,
					status: "continued_128_turn",
					terminal_reason: result.termination_reason,
					resolved: result.resolved,
					result_sha256: result.result_sha256,
				};
			}
			return {
				source_run_id: source.run_id,
				continuation_run_id: continuation.run_id,
				group_id: source.group_id,
				instance_id: source.instance_id,
				config_id: source.config_id,
				replicate: source.replicate,
				max_model_turns: 128,
				status: "continuation_failed",
				terminal_reason: continuation.terminal_reason ?? "continuation_terminal_reason_missing",
				resolved: null,
				result_sha256: null,
			};
		})
		.sort((left, right) => left.source_run_id.localeCompare(right.source_run_id));
	const configIds = ["pi-general", "repofix-full", "repofix-no-localize", "repofix-no-verify-feedback"] as const;
	const strata = ([64, 128] as const).flatMap((maxModelTurns) =>
		configIds
			.map((configId): M7ContinuationStratum | null => {
				const members = observations.filter(
					(value) => value.max_model_turns === maxModelTurns && value.config_id === configId,
				);
				if (members.length === 0) return null;
				const results = members.flatMap((value) => {
					if (value.result_sha256 === null) return [];
					const runId = value.continuation_run_id ?? value.source_run_id;
					const result = (value.max_model_turns === 64 ? sourceResults : continuationResults).get(runId);
					return result === undefined ? [] : [result];
				});
				return {
					max_model_turns: maxModelTurns,
					config_id: configId,
					denominator: members.length,
					completed_result_count: results.length,
					failed_count: members.filter((value) => value.status === "continuation_failed").length,
					resolved_count: results.filter((result) => result.resolved).length,
					accounted_tokens: results.reduce((total, result) => total + result.usage.accounted_tokens, 0),
				};
			})
			.filter((value): value is M7ContinuationStratum => value !== null),
	);
	const unsigned = {
		schema_version: "v1" as const,
		report_type: "m7_continuation_report" as const,
		status: "pass" as const,
		source_protocol_revision: "repofixlab-m7-v1.7.2" as const,
		continuation_protocol_revision: "repofixlab-m7-v1.7.3" as const,
		source_batch_state_sha256: sourceBatchStateSha256,
		continuation_batch_state_sha256: continuationBatchStateSha256,
		source_batch_ledger_reconciliation_required: true as const,
		expected_original_run_count: SOURCE_RUN_COUNT,
		terminal_observation_count: observations.length,
		observations,
		strata,
		comparison_scope: "turn_limit_stratified_no_cross_stratum_pairing" as const,
	};
	return { ...unsigned, report_sha256: sha256(unsigned) };
}

async function writeImmutable(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporary, path);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		if ((await readFile(path, "utf8")) !== content) throw new Error(`Immutable report conflict: ${path}`);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function publishM7ContinuationReport(
	artifactsRoot: string,
): Promise<{ readonly report: M7ContinuationReport; readonly path: string }> {
	const root = resolve(artifactsRoot);
	const sourceRoot = join(root, M7_CONTINUATION_SOURCE_DIRECTORY);
	const continuationRoot = join(root, M7_ARTIFACT_DIRECTORY);
	const [sourceStore, continuationStore, sourceStateSha256, continuationStateSha256] = await Promise.all([
		BatchStateStore.open(sourceRoot),
		BatchStateStore.open(continuationRoot),
		readBatchStateSha256(sourceRoot, "source"),
		readBatchStateSha256(continuationRoot, "continuation"),
	]);
	const sourceResults = new Map<string, RunResult>();
	for (const state of sourceStore.values) {
		if (state.status === "completed") sourceResults.set(state.run_id, await readCompletedResult(sourceRoot, state));
	}
	const continuationResults = new Map<string, RunResult>();
	for (const state of continuationStore.values) {
		if (state.status === "completed")
			continuationResults.set(state.run_id, await readCompletedResult(continuationRoot, state));
	}
	const report = createM7ContinuationReport(
		sourceStore.values,
		continuationStore.values,
		sourceResults,
		continuationResults,
		sourceStateSha256,
		continuationStateSha256,
	);
	const path = join(continuationRoot, "report", `continuation-${report.report_sha256}.json`);
	await writeImmutable(path, stableStringify(report));
	return { report, path };
}
