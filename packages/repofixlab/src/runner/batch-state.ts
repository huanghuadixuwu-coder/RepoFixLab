import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepoFixConfigId } from "../agent/repofix-config.ts";
import { stableStringify } from "../contracts/canonical-json.ts";

export const BATCH_RUN_STATUSES = [
	"queued",
	"preparing",
	"running",
	"agent_finished",
	"evaluating",
	"completed",
	"failed",
] as const;

export type BatchRunStatus = (typeof BATCH_RUN_STATUSES)[number];

export interface BatchRunSpec {
	readonly run_id: string;
	readonly group_id: string;
	readonly instance_id: string;
	readonly config_id: RepoFixConfigId;
	readonly replicate: number;
}

export interface BatchRunState extends BatchRunSpec {
	readonly status: BatchRunStatus;
	readonly attempt_id: string | null;
	readonly terminal_reason: string | null;
	readonly result_sha256: string | null;
}

export interface BatchStateEvent {
	readonly schema_version: "v1";
	readonly event_type: "run_registered" | "run_transition";
	readonly sequence: number;
	readonly run_id: string;
	readonly from_status: BatchRunStatus | null;
	readonly to_status: BatchRunStatus;
	readonly attempt_id: string | null;
	readonly terminal_reason: string | null;
	readonly result_sha256: string | null;
	readonly spec: BatchRunSpec | null;
	readonly event_sha256: string;
}

export interface BatchStateSnapshot {
	readonly schema_version: "v1";
	readonly state_type: "batch_state";
	readonly event_count: number;
	readonly runs: readonly BatchRunState[];
	readonly state_sha256: string;
}

const TRANSITIONS: Readonly<Record<BatchRunStatus, readonly BatchRunStatus[]>> = {
	queued: ["preparing", "failed"],
	preparing: ["running", "failed"],
	running: ["agent_finished", "failed"],
	agent_finished: ["evaluating", "failed"],
	evaluating: ["completed", "failed"],
	completed: [],
	failed: [],
};

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function assertIdentifier(value: string, name: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw new Error(`${name} is invalid`);
}

function assertSha256(value: string | null, name: string): void {
	if (value !== null && !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 or null`);
}

function assertTransition(from: BatchRunStatus, to: BatchRunStatus): void {
	if (!TRANSITIONS[from].includes(to)) throw new Error(`Invalid M5 transition: ${from} -> ${to}`);
}

function isBatchRunStatus(value: unknown): value is BatchRunStatus {
	return typeof value === "string" && (BATCH_RUN_STATUSES as readonly string[]).includes(value);
}

function verifySpec(value: unknown): BatchRunSpec {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Batch run spec is invalid");
	const spec = value as Partial<BatchRunSpec>;
	const replicate = spec.replicate;
	if (
		typeof spec.run_id !== "string" ||
		typeof spec.group_id !== "string" ||
		typeof spec.instance_id !== "string" ||
		typeof spec.config_id !== "string" ||
		typeof replicate !== "number" ||
		!Number.isSafeInteger(replicate) ||
		replicate < 1
	) {
		throw new Error("Batch run spec does not satisfy the v1 contract");
	}
	assertIdentifier(spec.run_id, "run_id");
	assertIdentifier(spec.group_id, "group_id");
	assertIdentifier(spec.instance_id, "instance_id");
	return spec as BatchRunSpec;
}

function createEvent(input: Omit<BatchStateEvent, "event_sha256">): BatchStateEvent {
	return { ...input, event_sha256: sha256(input) };
}

function verifyEvent(value: unknown): BatchStateEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Batch state event is invalid");
	const event = value as Partial<BatchStateEvent>;
	if (
		event.schema_version !== "v1" ||
		(event.event_type !== "run_registered" && event.event_type !== "run_transition") ||
		!Number.isSafeInteger(event.sequence) ||
		(event.from_status !== null && !isBatchRunStatus(event.from_status)) ||
		!isBatchRunStatus(event.to_status) ||
		typeof event.run_id !== "string" ||
		(event.attempt_id !== null && typeof event.attempt_id !== "string") ||
		(event.terminal_reason !== null && typeof event.terminal_reason !== "string") ||
		(event.result_sha256 !== null && typeof event.result_sha256 !== "string") ||
		(event.spec !== null && (typeof event.spec !== "object" || Array.isArray(event.spec))) ||
		typeof event.event_sha256 !== "string"
	) {
		throw new Error("Batch state event does not satisfy the v1 contract");
	}
	const { event_sha256: actual, ...unsigned } = event as BatchStateEvent;
	if (actual !== sha256(unsigned)) throw new Error("Batch state event SHA-256 is invalid");
	return event as BatchStateEvent;
}

function stateFromEvents(events: readonly BatchStateEvent[]): Map<string, BatchRunState> {
	const runs = new Map<string, BatchRunState>();
	for (const [index, event] of events.entries()) {
		if (event.sequence !== index) throw new Error("Batch state event sequence is not monotonic");
		if (event.event_type === "run_registered") {
			if (event.from_status !== null || event.to_status !== "queued" || runs.has(event.run_id)) {
				throw new Error("Batch run registration is invalid");
			}
			if (event.spec === null || event.terminal_reason !== null || event.result_sha256 !== null) {
				throw new Error("Batch run registration is missing immutable spec evidence");
			}
			const spec = verifySpec(event.spec);
			if (spec.run_id !== event.run_id || spec.replicate < 1)
				throw new Error("Batch run registration identity drifted");
			runs.set(spec.run_id, {
				...spec,
				status: "queued",
				attempt_id: null,
				terminal_reason: null,
				result_sha256: null,
			});
			continue;
		}
		if (event.spec !== null) throw new Error("Batch transition must not alter its immutable spec");
		const existing = runs.get(event.run_id);
		if (existing === undefined || event.from_status !== existing.status)
			throw new Error("Batch run transition predecessor drifted");
		assertTransition(existing.status, event.to_status);
		runs.set(event.run_id, {
			...existing,
			status: event.to_status,
			attempt_id: event.attempt_id,
			terminal_reason: event.terminal_reason,
			result_sha256: event.result_sha256,
		});
	}
	return runs;
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export class ExperimentOwnerLease {
	private readonly path: string;
	private released = false;

	private constructor(path: string) {
		this.path = path;
	}

	static async acquire(root: string): Promise<ExperimentOwnerLease> {
		const path = join(resolve(root), "experiment-owner.lease");
		await mkdir(dirname(path), { recursive: true });
		let handle;
		try {
			handle = await open(path, "wx", 0o600);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
				throw new Error("experiment_locked: another Orchestrator owns this experiment");
			}
			throw error;
		}
		try {
			await handle.writeFile(`${JSON.stringify({ schema_version: "v1", owner_id: randomUUID() })}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return new ExperimentOwnerLease(path);
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		await unlink(this.path);
	}

	async heartbeat(): Promise<void> {
		if (this.released) throw new Error("Cannot heartbeat a released experiment owner lease");
		const now = new Date();
		await utimes(this.path, now, now);
	}
}

export class BatchStateStore {
	private readonly root: string;
	private readonly eventsPath: string;
	private readonly snapshotPath: string;
	private events: BatchStateEvent[];
	private runs: Map<string, BatchRunState>;

	private constructor(root: string, events: BatchStateEvent[]) {
		this.root = root;
		this.eventsPath = join(root, "batch-events.jsonl");
		this.snapshotPath = join(root, "batch-state.json");
		this.events = events;
		this.runs = stateFromEvents(events);
	}

	static async open(rootPath: string): Promise<BatchStateStore> {
		const root = resolve(rootPath);
		await mkdir(root, { recursive: true });
		const eventsPath = join(root, "batch-events.jsonl");
		const raw = await readFile(eventsPath, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
			throw error;
		});
		const events =
			raw.trim().length === 0
				? []
				: raw
						.trim()
						.split("\n")
						.map((line) => verifyEvent(JSON.parse(line)));
		const store = new BatchStateStore(root, events);
		await store.writeSnapshot();
		return store;
	}

	get values(): readonly BatchRunState[] {
		return [...this.runs.values()].sort((left, right) => left.run_id.localeCompare(right.run_id));
	}

	async register(spec: BatchRunSpec): Promise<void> {
		assertIdentifier(spec.run_id, "run_id");
		assertIdentifier(spec.group_id, "group_id");
		assertIdentifier(spec.instance_id, "instance_id");
		if (!Number.isSafeInteger(spec.replicate) || spec.replicate < 1) throw new Error("replicate must be positive");
		if (this.runs.has(spec.run_id)) throw new Error(`Run is already registered: ${spec.run_id}`);
		await this.append(
			createEvent({
				schema_version: "v1",
				event_type: "run_registered",
				sequence: this.events.length,
				run_id: spec.run_id,
				from_status: null,
				to_status: "queued",
				attempt_id: null,
				terminal_reason: null,
				result_sha256: null,
				spec,
			}),
		);
	}

	async transition(
		runId: string,
		toStatus: Exclude<BatchRunStatus, "queued">,
		attemptId: string | null,
		terminalReason: string | null = null,
		resultSha256: string | null = null,
	): Promise<void> {
		const current = this.runs.get(runId);
		if (current === undefined) throw new Error(`Unknown registered run: ${runId}`);
		assertTransition(current.status, toStatus);
		if ((toStatus === "completed" || toStatus === "failed") !== (terminalReason !== null)) {
			throw new Error("Terminal batch transition must carry exactly one terminal reason");
		}
		assertSha256(resultSha256, "result_sha256");
		if ((toStatus === "completed") !== (resultSha256 !== null)) {
			throw new Error("Completed batch transition must carry exactly one immutable result SHA-256");
		}
		if (toStatus !== "completed" && resultSha256 !== null) {
			throw new Error("Only a completed batch transition may carry a result SHA-256");
		}
		await this.append(
			createEvent({
				schema_version: "v1",
				event_type: "run_transition",
				sequence: this.events.length,
				run_id: runId,
				from_status: current.status,
				to_status: toStatus,
				attempt_id: attemptId,
				terminal_reason: terminalReason,
				result_sha256: resultSha256,
				spec: null,
			}),
		);
	}

	private async append(event: BatchStateEvent): Promise<void> {
		const file = await open(this.eventsPath, "a", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		this.events.push(event);
		this.runs = stateFromEvents(this.events);
		await this.writeSnapshot();
	}

	private async writeSnapshot(): Promise<void> {
		const unsigned = {
			schema_version: "v1" as const,
			state_type: "batch_state" as const,
			event_count: this.events.length,
			runs: this.values,
		};
		const snapshot: BatchStateSnapshot = { ...unsigned, state_sha256: sha256(unsigned) };
		await atomicWrite(this.snapshotPath, stableStringify(snapshot));
	}
}

export interface AttemptRecoveryCheckpoint {
	readonly attempt_id: string;
	readonly status: Exclude<BatchRunStatus, "queued" | "completed" | "failed">;
	readonly worker_lease_id: string;
	readonly session_sha256: string;
	readonly stage_sha256: string;
	readonly trace_offset: number;
	readonly token_ledger_offset: number;
	readonly checkpoint_sha256: string;
	readonly quiescent: boolean;
	readonly in_flight_operations: number;
	readonly open_reservations: number;
}

export interface AttemptRecoveryDecision {
	readonly action: "resume_same_attempt" | "abort_and_create_new_attempt";
	readonly reason: string;
}

/**
 * A stale process never implies a safe resume. The Controller-specific M6
 * executor may resume only after every independently persisted binding proves
 * it is at a committed, quiescent boundary.
 */
export function evaluateAttemptRecovery(checkpoint: AttemptRecoveryCheckpoint): AttemptRecoveryDecision {
	const status: unknown = checkpoint.status;
	if (!isBatchRunStatus(status) || status === "queued" || status === "completed" || status === "failed") {
		return { action: "abort_and_create_new_attempt", reason: "checkpoint_status_invalid" };
	}
	try {
		assertIdentifier(checkpoint.attempt_id, "attempt_id");
		assertIdentifier(checkpoint.worker_lease_id, "worker_lease_id");
		assertSha256(checkpoint.session_sha256, "session_sha256");
		assertSha256(checkpoint.stage_sha256, "stage_sha256");
		assertSha256(checkpoint.checkpoint_sha256, "checkpoint_sha256");
	} catch (error) {
		return {
			action: "abort_and_create_new_attempt",
			reason: error instanceof Error ? error.message : "checkpoint_identity_invalid",
		};
	}
	if (!Number.isSafeInteger(checkpoint.trace_offset) || checkpoint.trace_offset < 0) {
		return { action: "abort_and_create_new_attempt", reason: "trace_offset_invalid" };
	}
	if (!Number.isSafeInteger(checkpoint.token_ledger_offset) || checkpoint.token_ledger_offset < 0) {
		return { action: "abort_and_create_new_attempt", reason: "token_ledger_offset_invalid" };
	}
	if (!Number.isSafeInteger(checkpoint.in_flight_operations) || checkpoint.in_flight_operations !== 0) {
		return { action: "abort_and_create_new_attempt", reason: "in_flight_operation_present" };
	}
	if (!Number.isSafeInteger(checkpoint.open_reservations) || checkpoint.open_reservations !== 0) {
		return { action: "abort_and_create_new_attempt", reason: "open_reservation_present" };
	}
	if (!checkpoint.quiescent) return { action: "abort_and_create_new_attempt", reason: "checkpoint_not_quiescent" };
	return { action: "resume_same_attempt", reason: "all_checkpoint_bindings_verified" };
}
