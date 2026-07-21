import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import {
	createTokenAdmissionEstimator,
	FsyncTokenLedgerSink,
	InMemoryTokenLedgerSink,
	installTokenSupervisor,
	TokenReservationLedger,
	type TokenSupervisedSession,
} from "../src/runner/token-supervisor.ts";

describe("TokenReservationLedger", () => {
	it("durably accounts reservations before use and releases only verified unused capacity", () => {
		const sink = new InMemoryTokenLedgerSink();
		const ledger = new TokenReservationLedger(
			{ per_run_accounted_cap_tokens: 100, project_accounted_cap_tokens: 150 },
			sink,
		);
		const admission = ledger.reserve({
			request_id: "request-1",
			run_id: "run-1",
			estimated_input_tokens: 30,
			max_output_tokens: 40,
		});
		expect(admission.admitted).toBe(true);
		if (!admission.admitted) throw new Error("Expected admission");
		expect(ledger.projectAccounted).toBe(70);
		ledger.settle(admission.reservation, { input_tokens: 20, output_tokens: 30, total_tokens: 50 });
		expect(ledger.projectAccounted).toBe(50);
		expect(sink.events.map((event) => event.event_type)).toEqual(["reservation_open", "reservation_settled"]);
		expect(sink.events[1]?.base_input_tokens).toBe(30);
	});

	it("fails closed on unknown or oversized usage and pauses future admissions", () => {
		const sink = new InMemoryTokenLedgerSink();
		const ledger = new TokenReservationLedger(
			{ per_run_accounted_cap_tokens: 100, project_accounted_cap_tokens: 150 },
			sink,
		);
		const admission = ledger.reserve({
			request_id: "request-1",
			run_id: "run-1",
			estimated_input_tokens: 30,
			max_output_tokens: 40,
		});
		if (!admission.admitted) throw new Error("Expected admission");
		expect(() => ledger.settle(admission.reservation, { input_tokens: 31, output_tokens: 30, total_tokens: 61 })).toThrow(
			/exceeded/,
		);
		expect(ledger.requiresReconciliation).toBe(true);
		expect(
			ledger.reserve({ request_id: "request-2", run_id: "run-2", estimated_input_tokens: 1, max_output_tokens: 1 }),
		).toEqual({ admitted: false, reason: "reconciliation_required" });
		expect(sink.events.map((event) => event.event_type)).toEqual([
			"reservation_open",
			"budget_protocol_invalid",
			"admission_rejected",
		]);
	});

	it("fsyncs each reservation transition and exposes a versioned estimator", async () => {
		const directory = await mkdtemp(join(tmpdir(), "repofixlab-token-ledger-"));
		try {
			const path = join(directory, "ledger.jsonl");
			const sink = new FsyncTokenLedgerSink(path);
			const ledger = new TokenReservationLedger(
				{ per_run_accounted_cap_tokens: 100, project_accounted_cap_tokens: 100 },
				sink,
			);
			const admission = ledger.reserve({
				request_id: "request-1",
				run_id: "run-1",
				estimated_input_tokens: 10,
				max_output_tokens: 10,
			});
			expect(admission.admitted).toBe(true);
			sink.close();
			const events = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			expect(events).toHaveLength(1);
			expect(events[0]?.event_type).toBe("reservation_open");
			const estimator = createTokenAdmissionEstimator({ version: "v1", multiplier: 1.25, framing_margin_tokens: 8 });
			expect(estimator.spec.version).toBe("v1");
			expect(estimator.baseEstimate({ systemPrompt: "x", messages: [] })).toBeGreaterThanOrEqual(1);
			expect(estimator.estimate({ systemPrompt: "x", messages: [] })).toBeGreaterThanOrEqual(9);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("prevents a second provider call when the durable reservation cap is exhausted", async () => {
		const sink = new InMemoryTokenLedgerSink();
		const ledger = new TokenReservationLedger(
			{ per_run_accounted_cap_tokens: 20, project_accounted_cap_tokens: 20 },
			sink,
		);
		let providerCalls = 0;
		const message = {
			...fauxAssistantMessage("done"),
			usage: {
				input: 1,
				output: 9,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const session: TokenSupervisedSession = {
			agent: {
				streamFn: () => {
					providerCalls += 1;
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					return stream;
				},
			},
		};
		let requestNumber = 0;
		installTokenSupervisor(session, {
			ledger,
			run_id: "run-1",
			max_output_tokens: 10,
			estimate_input_tokens: () => 1,
			next_request_id: () => `request-${++requestNumber}`,
		});
		const model = { api: "faux", provider: "faux", id: "faux-model" } as Model<Api>;
		await session.agent.streamFn(model, { messages: [] }).result();
		const blocked = await session.agent.streamFn(model, { messages: [] }).result();
		expect(providerCalls).toBe(1);
		expect(blocked.stopReason).toBe("error");
		expect(blocked.errorMessage).toContain("budget_exhausted");
	});
});
