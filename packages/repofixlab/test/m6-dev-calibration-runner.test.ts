import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createM6DevCalibrationBatch } from "../src/m6/calibration-cohort.ts";
import {
	runM6DevCalibration,
	type M6CalibrationRunReceipt,
	type M6DevCalibrationDependencies,
} from "../src/m6/dev-calibration-runner.ts";
import type { M3SplitManifest } from "../src/m3/split.ts";
import { stableStringify } from "../src/contracts/canonical-json.ts";
import { GlobalBudgetLedger } from "../src/runner/global-budget-ledger.ts";

const CALIBRATION_BATCH = createM6DevCalibrationBatch({
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
	const settled = {
		...open,
		event_type: "reservation_settled",
		accounted_tokens: 150,
		provider_prompt_tokens: 100,
		provider_completion_tokens: 50,
		provider_total_tokens: 150,
	};
	return `${JSON.stringify(open)}\n${JSON.stringify(settled)}\n`;
}

function completedM4(runDirectory: string, logicalRun: (typeof CALIBRATION_BATCH.logical_runs)[number]) {
	return {
		schema_version: "v1" as const,
		summary_type: "m4_dev_workflow" as const,
		run_id: `m4-${logicalRun.run_id}`,
		attempt_id: `attempt-${logicalRun.run_id}`,
		instance_id: logicalRun.instance_id,
		config_id: logicalRun.config_id,
		terminal_status: "completed" as const,
		run_directory: runDirectory,
		p0_patch_sha256: null,
		p1_patch_sha256: null,
		controlled_verification_sha256: null,
	};
}

function canonicalHash(value: unknown): string {
	const normalized = JSON.parse(stableStringify(value));
	return createHash("sha256").update(`${JSON.stringify(normalized)}\n`).digest("hex");
}

function journalLine(value: Record<string, unknown>): string {
	const event = { ...value, event_sha256: canonicalHash(value) };
	return `${JSON.stringify(JSON.parse(stableStringify(event)))}\n`;
}

function dependencies(calls: number[]): M6DevCalibrationDependencies {
	return {
		runM4: async ({ artifacts_root, logical_run, accounted_admission_cap_tokens }) => {
			calls.push(accounted_admission_cap_tokens);
			const runDirectory = join(artifacts_root, "m4-dev", "runs", `m4-${logical_run.run_id}`);
			await mkdir(runDirectory, { recursive: true });
			await writeFile(join(runDirectory, "token-ledger.jsonl"), settledLedger(logical_run.run_id), "utf8");
			return completedM4(runDirectory, logical_run);
		},
		runProviderSmoke: async ({ project_cap_tokens }) => {
			expect(project_cap_tokens).toBe(10_000);
			return { run_id: "m6-smoke-test", status: "pass", accounted_tokens: 100, token_ledger_sha256: "e".repeat(64) };
		},
		readFile,
		now: () => new Date("2026-07-20T04:30:00.000Z"),
		randomId: () => "00000000-0000-4000-8000-000000000000",
	};
}

describe("M6 v2 Dev calibration runner", () => {
	it("runs exactly six bounded logical runs after a accounted Provider smoke", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "repofixlab-m6-calibration-"));
		try {
			const calls: number[] = [];
			const summary = await runM6DevCalibration(
				{ artifacts_root: temporaryDirectory, calibration_batch: CALIBRATION_BATCH },
				dependencies(calls),
			);
			expect(summary.terminal_status).toBe("completed");
			expect(calls).toHaveLength(6);
			expect(calls.every((cap) => cap === 3_500_000)).toBe(true);
			const report = JSON.parse(await readFile(join(summary.run_directory, "calibration-report.json"), "utf8")) as {
				status: string;
				protocol_revision: string;
				run_receipts: readonly unknown[];
				aggregate: { accounted_tokens: number; global_budget: { accounted_tokens: number; reserved_tokens: number } };
				calibrated_estimator: { multiplier: number; framing_margin_tokens: number };
			};
			expect(report.status).toBe("pass");
			expect(report.protocol_revision).toBe("repofixlab-protocol-1.5-deepseek-v4-flash");
			expect(report.run_receipts).toHaveLength(6);
			expect(report.aggregate.accounted_tokens).toBe(1_000);
			expect(report.aggregate.global_budget).toMatchObject({ accounted_tokens: 1_000, reserved_tokens: 0 });
			expect(report.calibrated_estimator).toMatchObject({ multiplier: 1.1, framing_margin_tokens: 4_096 });
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("stops before M4 when Provider smoke fails and does not charge a logical run", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "repofixlab-m6-calibration-"));
		try {
			const calls: number[] = [];
			const failingDependencies: M6DevCalibrationDependencies = {
				...dependencies(calls),
				runProviderSmoke: async () => ({ run_id: "m6-smoke-test", status: "fail", accounted_tokens: 100, token_ledger_sha256: "f".repeat(64) }),
			};
			const summary = await runM6DevCalibration(
				{ artifacts_root: temporaryDirectory, calibration_batch: CALIBRATION_BATCH },
				failingDependencies,
			);
			expect(summary.terminal_status).toBe("failed");
			expect(calls).toEqual([]);
			const report = JSON.parse(await readFile(join(summary.run_directory, "calibration-report.json"), "utf8")) as {
				batch_failure_reasons: readonly string[];
			};
			expect(report.batch_failure_reasons).toContain("provider_smoke_failed");
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("resumes only queued logical runs after a durable completed receipt", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "repofixlab-m6-calibration-"));
		try {
			const runId = "m6-calibration-run-00000000-0000-4000-8000-000000000001";
			const stagingDirectory = join(temporaryDirectory, "m6-calibration", "runs", `.staging-${runId}`);
			const firstRun = CALIBRATION_BATCH.logical_runs[0]!;
			await mkdir(join(stagingDirectory, "receipts"), { recursive: true });
			await writeFile(join(stagingDirectory, "calibration-batch.json"), stableStringify(CALIBRATION_BATCH), "utf8");
			const firstReceipt: M6CalibrationRunReceipt = {
				logical_run: firstRun,
				m4_run_id: "m4-first",
				m4_artifact_relative_path: "m4-dev/runs/m4-first",
				terminal_status: "completed",
				accounted_tokens: 150,
				token_ledger_sha256: "f".repeat(64),
				request_count: 1,
				observations: [{ request_id: "first:provider:0000", base_input_tokens: 100, reserved_input_tokens: 500, reservation_tokens: 16_884, provider_prompt_tokens: 100, provider_completion_tokens: 50, provider_total_tokens: 150 }],
				budget_protocol_valid: true,
				requires_reconciliation: false,
				failure_reasons: [],
				repofix_context_budget: null,
			};
			const receiptContent = stableStringify(firstReceipt);
			await writeFile(join(stagingDirectory, "receipts", `${firstRun.run_id}.json`), receiptContent, "utf8");
			const smoke = { run_id: "m6-smoke-test", status: "pass" as const, accounted_tokens: 100, token_ledger_sha256: "e".repeat(64) };
			const journalBase = { schema_version: "v2", run_id: runId, calibration_batch_sha256: CALIBRATION_BATCH.calibration_batch_sha256 };
			const events = [
				{ ...journalBase, event_type: "initialized", logical_run_id: null, receipt_path: null, receipt_sha256: null, smoke: null },
				{ ...journalBase, event_type: "smoke_started", logical_run_id: null, receipt_path: null, receipt_sha256: null, smoke: null },
				{ ...journalBase, event_type: "smoke_completed", logical_run_id: null, receipt_path: null, receipt_sha256: null, smoke },
				{ ...journalBase, event_type: "run_started", logical_run_id: firstRun.run_id, receipt_path: null, receipt_sha256: null, smoke: null },
				{ ...journalBase, event_type: "run_terminal", logical_run_id: firstRun.run_id, receipt_path: `receipts/${firstRun.run_id}.json`, receipt_sha256: createHash("sha256").update(receiptContent).digest("hex"), smoke: null },
			];
			await writeFile(join(stagingDirectory, "m6-events.jsonl"), events.map(journalLine).join(""), "utf8");
			const budget = await GlobalBudgetLedger.open(join(stagingDirectory, "global-budget.json"), 22_000_000);
			await budget.recordObserved(250);
			const calls: number[] = [];
			const resumeDependencies: M6DevCalibrationDependencies = {
				...dependencies(calls),
				runProviderSmoke: async () => {
					throw new Error("resume must not repeat the paid Provider smoke");
				},
			};
			const summary = await runM6DevCalibration(
				{ artifacts_root: temporaryDirectory, calibration_batch: CALIBRATION_BATCH, resume_directory: stagingDirectory },
				resumeDependencies,
			);
			expect(summary.terminal_status).toBe("completed");
			expect(calls).toHaveLength(5);
			const report = JSON.parse(await readFile(join(summary.run_directory, "calibration-report.json"), "utf8")) as {
				run_receipts: readonly { logical_run: { run_id: string } }[];
			};
			expect(report.run_receipts).toHaveLength(6);
			expect(report.run_receipts.filter((receipt) => receipt.logical_run.run_id === firstRun.run_id)).toHaveLength(1);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
