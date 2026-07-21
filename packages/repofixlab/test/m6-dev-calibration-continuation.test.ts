import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/contracts/canonical-json.ts";
import { createM6DevCalibrationBatch, type M6CalibrationRun } from "../src/m6/calibration-cohort.ts";
import {
	runM6DevCalibrationContinuation,
	type M6DevCalibrationContinuationSummary,
} from "../src/m6/dev-calibration-continuation.ts";
import type { M6CalibrationRunReceipt, M6DevCalibrationDependencies, M6DevCalibrationReport } from "../src/m6/dev-calibration-runner.ts";
import type { M3SplitManifest } from "../src/m3/split.ts";

const BATCH = createM6DevCalibrationBatch({
	schema_version: "v1",
	manifest_type: "m3_repo_stratified_split",
	dataset_lock_id: "dataset-lock",
	dataset_lock_seal_sha256: "a".repeat(64),
	eligibility_manifest_sha256: "b".repeat(64),
	sampling_metadata_sha256: "c".repeat(64),
	split_seed: "test-seed",
	target_counts: { dev: 3, validation: 0, test: 0 },
	assignments: [
		{ instance_id: "axios__axios-5892", split: "dev" },
		{ instance_id: "mrdoob__three.js-26589", split: "dev" },
		{ instance_id: "preactjs__preact-4182", split: "dev" },
	],
	assignment_sha256: "d".repeat(64),
} satisfies M3SplitManifest);

function canonicalHash(value: unknown): string {
	const normalized = JSON.parse(stableStringify(value));
	return createHash("sha256").update(`${JSON.stringify(normalized)}\n`).digest("hex");
}

function receipt(logicalRun: M6CalibrationRun, clean: boolean): M6CalibrationRunReceipt {
	return {
		logical_run: logicalRun,
		m4_run_id: `m4-${logicalRun.run_id}`,
		m4_artifact_relative_path: `m4-dev/runs/m4-${logicalRun.run_id}`,
		terminal_status: "completed",
		accounted_tokens: 150,
		token_ledger_sha256: "e".repeat(64),
		request_count: 1,
		observations: [
			{
				request_id: `${logicalRun.run_id}:provider:0000`,
				base_input_tokens: 100,
				reserved_input_tokens: 500,
				reservation_tokens: 16_884,
				provider_prompt_tokens: 100,
				provider_completion_tokens: 50,
				provider_total_tokens: 150,
			},
		],
		budget_protocol_valid: clean,
		requires_reconciliation: false,
		failure_reasons: clean ? [] : ["budget_exhausted"],
		repofix_context_budget: null,
	};
}

function sealedSourceReport(): M6DevCalibrationReport {
	const inherited = BATCH.logical_runs.filter((run) => run.instance_id !== "preactjs__preact-4182").map((run) => receipt(run, true));
	const piPreact = BATCH.logical_runs.find(
		(run) => run.instance_id === "preactjs__preact-4182" && run.config_id === "pi-general",
	);
	if (piPreact === undefined) throw new Error("Test batch lacks the Preact pi-general run");
	const unsigned = {
		schema_version: "v2" as const,
		report_type: "m6_dev_calibration" as const,
		protocol_revision: "repofixlab-protocol-1.5-deepseek-v4-flash" as const,
		calibration_batch_sha256: BATCH.calibration_batch_sha256,
		run_id: "m6-calibration-run-source",
		started_at: "2026-07-21T00:00:00.000Z",
		finished_at: "2026-07-21T00:05:00.000Z",
		status: "fail" as const,
		cost_admission: "enforced" as const,
		budget_caps: { per_logical_run_tokens: 3_500_000, project_tokens: 22_000_000, provider_smoke_tokens: 10_000 },
		provider_smoke: { run_id: "m6-smoke-source", status: "pass" as const, accounted_tokens: 100, token_ledger_sha256: "f".repeat(64) },
		provisional_estimator: {
			version: "m6-deepseek-v4-flash-calibration-provisional-v1" as const,
			multiplier: 1.25,
			framing_margin_tokens: 512,
		},
		calibrated_estimator: null,
		batch_failure_reasons: ["budget_exhausted"],
		run_receipts: [...inherited, receipt(piPreact, false)],
		aggregate: {
			expected_logical_runs: 6,
			completed_logical_runs: 4,
			failed_logical_runs: 2,
			budget_exhausted_runs: 1,
			request_count: 5,
			accounted_tokens: 700,
			maximum_base_input_tokens: 100,
			maximum_provider_prompt_tokens: 100,
			maximum_provider_total_tokens: 150,
			maximum_prompt_residual_tokens: 0,
			context_truncation: { repofix_run_count: 0, truncated_calls: 0, maximum_visible_chars: 0 },
			global_budget: {
				schema_version: "v1" as const,
				ledger_type: "global_budget" as const,
				cap_tokens: 22_000_000,
				accounted_tokens: 700,
				reserved_tokens: 0,
				reconciliation_required: false,
				state_sha256: "g".repeat(64),
			},
		},
	};
	const report = { ...unsigned, calibration_evidence_sha256: canonicalHash(unsigned), report_sha256: "" };
	const { report_sha256: _reportSha256, ...semanticReport } = report;
	return { ...report, report_sha256: canonicalHash(semanticReport) };
}

function settledLedger(runId: string): string {
	const open = {
		event_type: "reservation_open",
		request_id: `${runId}:provider:0000`,
		reservation_tokens: 16_884,
		accounted_tokens: null,
		base_input_tokens: 100,
		estimated_input_tokens: 500,
		provider_prompt_tokens: null,
		provider_completion_tokens: null,
		provider_total_tokens: null,
		reason: null,
	};
	return `${JSON.stringify(open)}\n${JSON.stringify({
		...open,
		event_type: "reservation_settled",
		accounted_tokens: 150,
		provider_prompt_tokens: 100,
		provider_completion_tokens: 50,
		provider_total_tokens: 150,
	})}\n`;
}

describe("M6 continuation calibration", () => {
	it("inherits only four sealed receipts and runs exactly the two pending Preact configurations at 5M", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "repofixlab-m6-continuation-"));
		try {
			const source = sealedSourceReport();
			const sourceBytes = new TextEncoder().encode(stableStringify(source));
			const caps: number[] = [];
			const dependencies: M6DevCalibrationDependencies = {
				runM4: async ({ artifacts_root, logical_run, accounted_admission_cap_tokens }) => {
					caps.push(accounted_admission_cap_tokens);
					const runDirectory = join(artifacts_root, "m4-dev", "runs", `m4-${logical_run.run_id}`);
					await mkdir(runDirectory, { recursive: true });
					await writeFile(join(runDirectory, "token-ledger.jsonl"), settledLedger(logical_run.run_id), "utf8");
					return {
						schema_version: "v1",
						summary_type: "m4_dev_workflow",
						run_id: `m4-${logical_run.run_id}`,
						attempt_id: `attempt-${logical_run.run_id}`,
						instance_id: logical_run.instance_id,
						config_id: logical_run.config_id,
						terminal_status: "completed",
						run_directory: runDirectory,
						p0_patch_sha256: null,
						p1_patch_sha256: null,
						controlled_verification_sha256: null,
					};
				},
				runProviderSmoke: async ({ project_cap_tokens }) => {
					expect(project_cap_tokens).toBe(10_000);
					return { run_id: "m6-smoke-continuation", status: "pass", accounted_tokens: 100, token_ledger_sha256: "h".repeat(64) };
				},
				readFile,
				now: () => new Date("2026-07-21T06:00:00.000Z"),
				randomId: () => "00000000-0000-4000-8000-000000000002",
			};
			const summary: M6DevCalibrationContinuationSummary = await runM6DevCalibrationContinuation(
				{
					artifacts_root: temporaryDirectory,
					calibration_batch: BATCH,
					source_report: source,
					source_report_bytes: sourceBytes,
					source_report_relative_path: "m6-deepseek-flash-calibration/runs/m6-calibration-run-source/calibration-report.json",
				},
				dependencies,
			);
			expect(summary.terminal_status).toBe("completed");
			expect(caps).toEqual([5_000_000, 5_000_000]);
			const report = JSON.parse(await readFile(join(summary.run_directory, "continuation-report.json"), "utf8")) as {
				status: string;
				budget_policy: { project_tokens: null; per_logical_run_tokens: number };
				inherited_run_receipts: readonly unknown[];
				continuation_run_receipts: readonly unknown[];
				aggregate: { continuation_spend_tokens: number; continuation_usage_ledger: { reconciliation_required: boolean } };
			};
			expect(report.status).toBe("pass");
			expect(report.budget_policy).toEqual({ per_logical_run_tokens: 5_000_000, project_tokens: null, provider_smoke_tokens: 10_000 });
			expect(report.inherited_run_receipts).toHaveLength(4);
			expect(report.continuation_run_receipts).toHaveLength(2);
			expect(report.aggregate.continuation_spend_tokens).toBe(400);
			expect(report.aggregate.continuation_usage_ledger.reconciliation_required).toBe(false);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
