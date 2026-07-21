import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseExperimentPlan } from "../src/contracts/experiment-plan.ts";
import { createEvaluationResult, createRunResult, type RunResult } from "../src/contracts/run-contracts.ts";
import {
	createExperimentAggregate,
	createStaticExperimentReport,
	publishExperimentReport,
} from "../src/report/experiment-report.ts";
import { createBatchRunSpecs, executeBatch, type BatchRunExecutor } from "../src/runner/batch-runner.ts";
import {
	BatchStateStore,
	evaluateAttemptRecovery,
	ExperimentOwnerLease,
	type BatchRunSpec,
} from "../src/runner/batch-state.ts";
import { GlobalBudgetLedger } from "../src/runner/global-budget-ledger.ts";

const directories: string[] = [];

afterEach(async () => {
	while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function directory(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "repofixlab-m5-"));
	directories.push(value);
	return value;
}

function result(runId: string, attemptId: string, resolved: boolean, wallTime = 100): RunResult {
	return createRunResult({
		schema_version: "v1",
		result_type: "run",
		run_id: runId,
		attempt_id: attemptId,
		manifest_sha256: "a".repeat(64),
		terminal_status: "completed",
		termination_reason: resolved ? "official_resolved" : "official_unresolved",
		resolved,
		started_at: "2026-07-20T00:00:00.000Z",
		finished_at: "2026-07-20T00:00:01.000Z",
		wall_time_ms: wallTime,
		usage: {
			accounted_tokens: 100,
			provider_actual_tokens: 90,
			usage_complete: true,
			cost_complete: true,
			estimated_cost_cny_nano: 8,
			model_turns: 1,
			tool_calls: 2,
		},
		attempt_sha256: "b".repeat(64),
		patch_snapshot_sha256: "c".repeat(64),
		evaluation_result_sha256: "d".repeat(64),
		artifact_index_sha256: "e".repeat(64),
		failure: null,
	});
}

function evaluation(runId: string, attemptId: string) {
	return createEvaluationResult({
		schema_version: "v1",
		result_type: "evaluation",
		evaluation_id: `evaluation-${runId}`,
		job_id: `job-${runId}`,
		run_id: runId,
		attempt_id: attemptId,
		instance_id: "axios__axios-5892",
		harness_mode: "adapted",
		harness_revision: "f".repeat(40),
		status: "completed",
		resolved: false,
		candidate_patch_sha256: "a".repeat(64),
		candidate_patch_apply_status: "applied",
		test_patch_apply_status: "applied",
		test_executed: true,
		test_collected: true,
		fail_to_pass: { success: ["targeted regression"], failure: ["remaining regression"] },
		pass_to_pass: { success: ["unrelated regression"], failure: ["collateral regression"] },
		exit_code: 1,
		timed_out: false,
		duration_ms: 100,
		test_log: null,
		official_report_sha256: null,
		error_class: null,
		finished_at: "2026-07-20T00:00:01.000Z",
	});
}

const specs: readonly BatchRunSpec[] = [
	{ run_id: "run-a", group_id: "dev", instance_id: "axios__axios-5892", config_id: "pi-general", replicate: 1 },
	{ run_id: "run-b", group_id: "dev", instance_id: "axios__axios-5892", config_id: "repofix-full", replicate: 1 },
];

describe("M5 durable batch state and report", () => {
	it("fsyncs a transition event before rebuilding its atomic state snapshot and refuses terminal mutation", async () => {
		const root = await directory();
		const store = await BatchStateStore.open(root);
		await store.register(specs[0]!);
		await store.transition("run-a", "preparing", "attempt-run-a-001");
		const eventLines = (await readFile(join(root, "batch-events.jsonl"), "utf8")).trim().split("\n");
		expect(eventLines).toHaveLength(2);
		expect(JSON.parse(await readFile(join(root, "batch-state.json"), "utf8"))).toMatchObject({ event_count: 2 });
		const reopened = await BatchStateStore.open(root);
		expect(reopened.values).toEqual([
			expect.objectContaining({ run_id: "run-a", status: "preparing", attempt_id: "attempt-run-a-001" }),
		]);
		await reopened.transition("run-a", "failed", "attempt-run-a-001", "interrupted_attempt_requires_recovery");
		await expect(reopened.transition("run-a", "preparing", "attempt-run-a-002")).rejects.toThrow(/Invalid M5 transition/);
	});

	it("serializes one batch owner and records queued through official evaluation transitions", async () => {
		const root = await directory();
		const lease = await ExperimentOwnerLease.acquire(root);
		await expect(ExperimentOwnerLease.acquire(root)).rejects.toThrow("experiment_locked");
		await lease.release();
		const calls: string[] = [];
		const executor: BatchRunExecutor = {
			execute: async (spec, attemptId, hooks) => {
				calls.push(`${spec.run_id}:start`);
				await hooks.agentFinished();
				await hooks.evaluating();
				calls.push(`${spec.run_id}:end`);
				return result(spec.run_id, attemptId, spec.run_id === "run-b");
			},
		};
		const summary = await executeBatch(root, specs, executor);
		expect(summary.completed_run_ids).toEqual(["run-a", "run-b"]);
		expect(summary.failed_run_ids).toEqual([]);
		expect(await readFile(summary.report.json_path, "utf8")).toContain(summary.report.aggregate_sha256);
		expect(calls).toEqual(["run-a:start", "run-a:end", "run-b:start", "run-b:end"]);
		const state = await BatchStateStore.open(root);
		expect(state.values.map((value) => value.status)).toEqual(["completed", "completed"]);
		const rerunCalls: string[] = [];
		const rerun = await executeBatch(root, specs, {
			execute: async () => {
				rerunCalls.push("unexpected");
				throw new Error("Completed runs must load immutable results instead of re-executing");
			},
		});
		expect(rerun.completed_run_ids).toEqual(["run-a", "run-b"]);
		expect(rerunCalls).toEqual([]);
	});

	it("rebuilds and publishes a deterministic offline aggregate with the fixed missing-run denominator", async () => {
		const partial = { "run-a": result("run-a", "attempt-run-a-001", false, 125) };
		const first = createExperimentAggregate(specs, partial);
		const second = createExperimentAggregate(specs, partial);
		expect(first.aggregate_sha256).toBe(second.aggregate_sha256);
		expect(first.missing_run_ids).toEqual(["run-b"]);
		expect(first.configurations.find((value) => value.config_id === "pi-general")).toMatchObject({
			denominator: 1,
			resolved_count: 0,
			accounted_tokens: 100,
		});
		expect(createStaticExperimentReport(first)).toContain(first.aggregate_sha256);
		const reportRoot = await directory();
		const published = await publishExperimentReport(reportRoot, specs, partial);
		expect(JSON.parse(await readFile(published.json_path, "utf8"))).toMatchObject({
			aggregate_sha256: first.aggregate_sha256,
		});
		expect(await readFile(published.html_path, "utf8")).toContain(first.aggregate_sha256);
		await expect(publishExperimentReport(reportRoot, specs, partial)).resolves.toMatchObject({
			json_path: published.json_path,
			html_path: published.html_path,
		});
	});

	it("reports F2P, P2P, failure categories, stability, and safety only from bound evidence", () => {
		const partial = { "run-a": result("run-a", "attempt-run-a-001", false, 125) };
		const aggregate = createExperimentAggregate(specs, partial, {
			"run-a": {
				run_id: "run-a",
				evaluation: evaluation("run-a", "attempt-run-a-001"),
				security: { blocked_operation_count: 2, policy_violation_count: 0, sandbox_escape_attempt_count: 0 },
			},
		});
		expect(aggregate.metrics.tests).toMatchObject({
			evaluation_evidence_run_count: 1,
			fail_to_pass: { passed: 1, total: 2, rate: 0.5 },
			pass_to_pass: { passed: 1, total: 2, rate: 0.5 },
		});
		expect(aggregate.metrics.failure_categories).toEqual({ repair_unresolved: 1 });
		expect(aggregate.metrics.security).toMatchObject({
			evidence_run_count: 1,
			blocked_operation_count: 2,
			evidence_missing_run_ids: ["run-b"],
		});
	});

	it("persists the global reservation balance and pauses new admission after unknown usage", async () => {
		const ledger = await GlobalBudgetLedger.open(join(await directory(), "global-budget.json"), 100);
		expect(await ledger.reserve(60)).toBe(true);
		await ledger.settle(60, 45);
		expect(ledger.snapshot).toMatchObject({ accounted_tokens: 45, reserved_tokens: 0, reconciliation_required: false });
		expect(await ledger.reserve(40)).toBe(true);
		await ledger.chargeUnverified(40);
		expect(ledger.snapshot).toMatchObject({ accounted_tokens: 85, reserved_tokens: 0, reconciliation_required: true });
		expect(await ledger.reserve(1)).toBe(false);
	});

	it("fails closed after an interrupted preparing, running, or evaluating attempt and never invokes its executor", async () => {
		const root = await directory();
		const interrupted: readonly BatchRunSpec[] = [
			{ run_id: "run-preparing", group_id: "dev", instance_id: "a", config_id: "pi-general", replicate: 1 },
			{ run_id: "run-running", group_id: "dev", instance_id: "b", config_id: "pi-general", replicate: 1 },
			{ run_id: "run-evaluating", group_id: "dev", instance_id: "c", config_id: "pi-general", replicate: 1 },
		];
		const store = await BatchStateStore.open(root);
		for (const spec of interrupted) await store.register(spec);
		await store.transition("run-preparing", "preparing", "attempt-run-preparing-001");
		await store.transition("run-running", "preparing", "attempt-run-running-001");
		await store.transition("run-running", "running", "attempt-run-running-001");
		await store.transition("run-evaluating", "preparing", "attempt-run-evaluating-001");
		await store.transition("run-evaluating", "running", "attempt-run-evaluating-001");
		await store.transition("run-evaluating", "agent_finished", "attempt-run-evaluating-001");
		await store.transition("run-evaluating", "evaluating", "attempt-run-evaluating-001");
		const summary = await executeBatch(root, interrupted, {
			execute: async () => {
				throw new Error("Interrupted attempt must not be resumed without a verified checkpoint");
			},
		});
		expect(summary.completed_run_ids).toEqual([]);
		expect(summary.failed_run_ids).toEqual(["run-evaluating", "run-preparing", "run-running"]);
		expect((await BatchStateStore.open(root)).values.map((state) => state.terminal_reason)).toEqual([
			"interrupted_attempt_requires_recovery",
			"interrupted_attempt_requires_recovery",
			"interrupted_attempt_requires_recovery",
		]);
	});

	it("admits only affordable runs and freezes later admission after an executor leaves usage unknown", async () => {
		const root = await directory();
		let calls = 0;
		const bounded = await executeBatch(root, specs, {
			execute: async (spec, attemptId, hooks) => {
				calls += 1;
				await hooks.agentFinished();
				await hooks.evaluating();
				return result(spec.run_id, attemptId, false);
			},
		}, {
			budget_admission: {
				ledger_path: join(root, "budget.json"),
				cap_tokens: 150,
				per_run_reservation_tokens: 100,
			},
		});
		expect(calls).toBe(1);
		expect(bounded.completed_run_ids).toEqual(["run-a"]);
		expect(bounded.failed_run_ids).toEqual(["run-b"]);

		const unknownRoot = await directory();
		const unknown = await executeBatch(unknownRoot, specs, {
			execute: async () => {
				throw new Error("transport result is unknown");
			},
		}, {
			budget_admission: {
				ledger_path: join(unknownRoot, "budget.json"),
				cap_tokens: 200,
				per_run_reservation_tokens: 100,
			},
		});
		expect(unknown.failed_run_ids).toEqual(["run-a", "run-b"]);
		expect((await GlobalBudgetLedger.open(join(unknownRoot, "budget.json"), 200)).snapshot).toMatchObject({
			accounted_tokens: 100,
			reconciliation_required: true,
		});
	});

	it("derives deterministic runs only from the explicit frozen cohort and requires every recovery binding", () => {
		const plan = parseExperimentPlan(`
schema_version: v1
plan_type: experiment_capacity
experiment_id: demo
task_selection:
  status: frozen
  declared_task_count: 2
  instance_ids: [repo__one-1, repo__two-2]
matrix:
  - group_id: dev
    task_count: 2
    config_ids: [pi-general, repofix-full]
    replicates: 1
budget:
  per_run_accounted_admission_cap_tokens: null
  total_accounted_admission_cap_tokens: null
runtime_status: lifecycle_unavailable
`);
		const assignments = [{ group_id: "dev", instance_ids: ["repo__one-1", "repo__two-2"] }] as const;
		expect(createBatchRunSpecs(plan, assignments)).toEqual(createBatchRunSpecs(plan, assignments));
		expect(createBatchRunSpecs(plan, assignments)).toHaveLength(4);
		expect(() => createBatchRunSpecs(plan, [{ group_id: "dev", instance_ids: ["repo__one-1", "not-frozen"] }])).toThrow(
			"unfrozen task",
		);
		const valid = evaluateAttemptRecovery({
			attempt_id: "attempt-run-a-001",
			status: "running",
			worker_lease_id: "worker-lease-1",
			session_sha256: "a".repeat(64),
			stage_sha256: "b".repeat(64),
			trace_offset: 8,
			token_ledger_offset: 4,
			checkpoint_sha256: "c".repeat(64),
			quiescent: true,
			in_flight_operations: 0,
			open_reservations: 0,
		});
		expect(valid.action).toBe("resume_same_attempt");
		expect(
			evaluateAttemptRecovery({
				attempt_id: "attempt-run-a-001",
				status: "running",
				worker_lease_id: "worker-lease-1",
				session_sha256: "a".repeat(64),
				stage_sha256: "b".repeat(64),
				trace_offset: 8,
				token_ledger_offset: 4,
				checkpoint_sha256: "c".repeat(64),
				quiescent: true,
				in_flight_operations: 0,
				open_reservations: 1,
			}).reason,
		).toBe("open_reservation_present");
	});
});
