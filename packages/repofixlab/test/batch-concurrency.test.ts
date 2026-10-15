/** Exercise concurrent dispatch and durable writes using deterministic gates. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunResult } from "../src/contracts/run-contracts.ts";
import { executeBatch } from "../src/runner/batch-runner.ts";
import { type BatchRunSpec, BatchStateStore } from "../src/runner/batch-state.ts";
import { GlobalBudgetLedger } from "../src/runner/global-budget-ledger.ts";
import { PreProviderBatchFailure } from "../src/runner/pre-provider-failure.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "repofixlab-concurrency-"));
	directories.push(path);
	return path;
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function result(runId: string, attemptId: string, tokens = 20) {
	return createRunResult({
		schema_version: "v1",
		result_type: "run",
		run_id: runId,
		attempt_id: attemptId,
		manifest_sha256: "a".repeat(64),
		terminal_status: "completed",
		termination_reason: "official_unresolved",
		resolved: false,
		started_at: "2026-10-11T00:00:00.000Z",
		finished_at: "2026-10-11T00:00:01.000Z",
		wall_time_ms: 1000,
		usage: {
			accounted_tokens: tokens,
			provider_actual_tokens: tokens,
			usage_complete: true,
			cost_complete: true,
			estimated_cost_cny_nano: 0,
			model_turns: 1,
			tool_calls: 0,
		},
		attempt_sha256: "b".repeat(64),
		patch_snapshot_sha256: "c".repeat(64),
		evaluation_result_sha256: "d".repeat(64),
		artifact_index_sha256: "e".repeat(64),
		failure: null,
	});
}

const specs: readonly BatchRunSpec[] = ["a", "b", "c"].map((id) => ({
	run_id: `run-${id}`,
	group_id: "dev",
	instance_id: `repo__task-${id}`,
	config_id: "repofix-full",
	replicate: 1,
}));

describe("bounded concurrent batch execution", () => {
	it("overlaps two admitted runs, bounds execution and publishes their own results", async () => {
		const root = await directory();
		const started = gate(),
			finish = gate();
		let active = 0,
			peak = 0;
		const calls: string[] = [];
		const execution = executeBatch(
			root,
			specs,
			{
				execute: async (spec, attemptId, hooks) => {
					calls.push(spec.run_id);
					active += 1;
					peak = Math.max(peak, active);
					if (active === 2) started.release();
					await finish.promise;
					await hooks.agentFinished();
					await hooks.evaluating();
					active -= 1;
					return result(spec.run_id, attemptId);
				},
			},
			{
				concurrency: 2,
				budget_admission: {
					ledger_path: join(root, "budget.json"),
					cap_tokens: 300,
					per_run_reservation_tokens: 100,
				},
			},
		);
		await started.promise;
		expect(calls).toEqual(["run-a", "run-b"]);
		expect(JSON.parse(await readFile(join(root, "budget.json"), "utf8"))).toMatchObject({ reserved_tokens: 200 });
		finish.release();
		const summary = await execution;
		expect(peak).toBe(2);
		expect(summary.completed_run_ids).toEqual(["run-a", "run-b", "run-c"]);
		for (const spec of specs) {
			const stored = JSON.parse(await readFile(join(root, "results", `${spec.run_id}.json`), "utf8"));
			expect(stored.run_id).toBe(spec.run_id);
			expect(stored.attempt_id).toContain("attempt-execution-");
		}
		expect((await GlobalBudgetLedger.open(join(root, "budget.json"), 300)).snapshot).toMatchObject({
			accounted_tokens: 60,
			reserved_tokens: 0,
			reconciliation_required: false,
		});
		expect((await BatchStateStore.open(root)).values.every((state) => state.status === "completed")).toBe(true);
	});

	it("waits for temporary reservations to settle before denying queued work", async () => {
		const root = await directory();
		const summary = await executeBatch(
			root,
			specs,
			{
				execute: async (spec, attemptId, hooks) => {
					await hooks.agentFinished();
					await hooks.evaluating();
					return result(spec.run_id, attemptId, 20);
				},
			},
			{
				concurrency: 2,
				budget_admission: {
					ledger_path: join(root, "budget.json"),
					cap_tokens: 300,
					per_run_reservation_tokens: 200,
				},
			},
		);
		expect(summary.completed_run_ids).toHaveLength(3);
		expect(summary.failed_run_ids).toEqual([]);
		expect((await GlobalBudgetLedger.open(join(root, "budget.json"), 300)).snapshot.accounted_tokens).toBe(60);
	});

	it("cancels queued work while in-flight runs complete and settle normally", async () => {
		const root = await directory();
		const started = gate(),
			finish = gate();
		const cancellation = new AbortController();
		const calls: string[] = [];
		const execution = executeBatch(
			root,
			specs,
			{
				execute: async (spec, attemptId, hooks) => {
					calls.push(spec.run_id);
					if (calls.length === 2) started.release();
					await finish.promise;
					await hooks.agentFinished();
					await hooks.evaluating();
					return result(spec.run_id, attemptId);
				},
			},
			{ concurrency: 2, signal: cancellation.signal },
		);
		await started.promise;
		cancellation.abort();
		finish.release();
		const summary = await execution;
		expect(calls).toEqual(["run-a", "run-b"]);
		expect(summary.completed_run_ids).toEqual(["run-a", "run-b"]);
		expect(summary.failed_run_ids).toEqual(["run-c"]);
		expect((await BatchStateStore.open(root)).values[2]).toMatchObject({
			attempt_id: null,
			terminal_reason: "batch_queue_cancelled",
		});
	});

	it("refunds a reservation when dispatch stops while its durable write is in flight", async () => {
		const root = await directory();
		const secondReserved = gate(),
			resumeDispatch = gate();
		const reserve = GlobalBudgetLedger.prototype.reserve;
		let count = 0;
		vi.spyOn(GlobalBudgetLedger.prototype, "reserve").mockImplementation(async function (
			this: GlobalBudgetLedger,
			tokens,
		) {
			const admitted = await reserve.call(this, tokens);
			if (++count === 2) {
				secondReserved.release();
				await resumeDispatch.promise;
			}
			return admitted;
		});
		const calls: string[] = [];
		const execution = executeBatch(
			root,
			specs,
			{
				execute: async (spec) => {
					calls.push(spec.run_id);
					await secondReserved.promise;
					throw new PreProviderBatchFailure("prepare_failed");
				},
			},
			{
				concurrency: 2,
				stop_on_pre_provider_failure: true,
				budget_admission: {
					ledger_path: join(root, "budget.json"),
					cap_tokens: 300,
					per_run_reservation_tokens: 100,
				},
			},
		);
		await vi.waitFor(async () => {
			expect((await BatchStateStore.open(root)).values[0]?.status).toBe("failed");
		});
		resumeDispatch.release();
		await execution;
		expect(calls).toEqual(["run-a"]);
		expect((await GlobalBudgetLedger.open(join(root, "budget.json"), 300)).snapshot).toMatchObject({
			accounted_tokens: 0,
			reserved_tokens: 0,
		});
		expect((await BatchStateStore.open(root)).values.slice(1).every((state) => state.status === "queued")).toBe(true);
	});

	it("drains admitted work before stopping dispatch after setup failure", async () => {
		const root = await directory();
		const secondStarted = gate();
		const calls: string[] = [];
		const summary = await executeBatch(
			root,
			specs,
			{
				execute: async (spec, attemptId, hooks) => {
					calls.push(spec.run_id);
					if (spec.run_id === "run-a") {
						await secondStarted.promise;
						throw new PreProviderBatchFailure("prepare_failed");
					}
					secondStarted.release();
					await hooks.agentFinished();
					await hooks.evaluating();
					return result(spec.run_id, attemptId);
				},
			},
			{ concurrency: 2, stop_on_pre_provider_failure: true },
		);
		expect(calls).toEqual(["run-a", "run-b"]);
		expect(summary.completed_run_ids).toEqual(["run-b"]);
		expect((await BatchStateStore.open(root)).values[2]?.status).toBe("queued");
	});
});

describe("serialized persistent accounting", () => {
	it("never over-reserves and persists all concurrent settlements", async () => {
		const root = await directory();
		const ledger = await GlobalBudgetLedger.open(join(root, "budget.json"), 100);
		const reservations = await Promise.all(Array.from({ length: 50 }, () => ledger.reserve(3)));
		expect(reservations.filter(Boolean)).toHaveLength(33);
		expect(ledger.snapshot.reserved_tokens).toBe(99);
		await Promise.all(reservations.filter(Boolean).map(() => ledger.settle(3, 1)));
		expect((await GlobalBudgetLedger.open(join(root, "budget.json"), 100)).snapshot).toMatchObject({
			accounted_tokens: 33,
			reserved_tokens: 0,
			reconciliation_required: false,
		});
	});

	it("preserves known settlements and blocks admission after concurrent unknown usage", async () => {
		const root = await directory();
		const ledger = await GlobalBudgetLedger.open(join(root, "budget.json"), 100);
		await Promise.all([ledger.reserve(40), ledger.reserve(40)]);
		await Promise.all([ledger.chargeUnverified(40), ledger.settle(40, 20)]);
		expect(await ledger.reserve(1)).toBe(false);
		expect((await GlobalBudgetLedger.open(join(root, "budget.json"), 100)).snapshot).toMatchObject({
			accounted_tokens: 60,
			reserved_tokens: 0,
			reconciliation_required: true,
		});
	});

	it("keeps contiguous batch events and valid snapshots under simultaneous writes", async () => {
		const root = await directory();
		const store = await BatchStateStore.open(root);
		await Promise.all(specs.map((spec) => store.register(spec)));
		await Promise.all(
			specs.map(async (spec) => {
				await store.transition(spec.run_id, "preparing", `attempt-${spec.run_id}`);
				await store.transition(spec.run_id, "running", `attempt-${spec.run_id}`);
				await store.transition(spec.run_id, "failed", `attempt-${spec.run_id}`, "test_complete");
			}),
		);
		const events = (await readFile(join(root, "batch-events.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sequence: number });
		expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 12 }, (_, index) => index));
		expect((await BatchStateStore.open(root)).values.map((state) => state.status)).toEqual([
			"failed",
			"failed",
			"failed",
		]);
		expect(JSON.parse(await readFile(join(root, "batch-state.json"), "utf8"))).toMatchObject({ event_count: 12 });
	});
});
