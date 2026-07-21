import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stableStringify } from "../contracts/canonical-json.ts";

export interface GlobalBudgetState {
	readonly schema_version: "v1";
	readonly ledger_type: "global_budget";
	readonly cap_tokens: number;
	readonly accounted_tokens: number;
	readonly reserved_tokens: number;
	readonly reconciliation_required: boolean;
	readonly state_sha256: string;
}

export class GlobalBudgetWriterLease {
	private readonly path: string;
	private released = false;

	private constructor(path: string) {
		this.path = path;
	}

	static async acquire(ledgerPath: string): Promise<GlobalBudgetWriterLease> {
		const path = `${resolve(ledgerPath)}.lease`;
		await mkdir(dirname(path), { recursive: true });
		let file;
		try {
			file = await open(path, "wx", 0o600);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
				throw new Error("global_budget_locked: another Orchestrator owns the budget writer");
			}
			throw error;
		}
		try {
			await file.writeFile(`${stableStringify({ schema_version: "v1", ledger_type: "global_budget_writer" })}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		return new GlobalBudgetWriterLease(path);
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		await unlink(this.path);
	}
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function assertTokens(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

async function writeAtomic(path: string, content: string): Promise<void> {
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
}

export class GlobalBudgetLedger {
	private readonly path: string;
	private state: Omit<GlobalBudgetState, "state_sha256">;

	private constructor(path: string, state: Omit<GlobalBudgetState, "state_sha256">) {
		this.path = path;
		this.state = state;
	}

	static async open(path: string, capTokens: number): Promise<GlobalBudgetLedger> {
		assertTokens(capTokens, "cap_tokens");
		if (capTokens === 0) throw new Error("cap_tokens must be positive");
		const resolved = resolve(path);
		const existing = await readFile(resolved, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
			throw error;
		});
		if (existing === null) {
			const ledger = new GlobalBudgetLedger(resolved, {
				schema_version: "v1",
				ledger_type: "global_budget",
				cap_tokens: capTokens,
				accounted_tokens: 0,
				reserved_tokens: 0,
				reconciliation_required: false,
			});
			await ledger.persist();
			return ledger;
		}
		const value: unknown = JSON.parse(existing);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Global budget ledger is malformed");
		const record = value as GlobalBudgetState;
		const { state_sha256: actual, ...unsigned } = record;
		if (
			record.schema_version !== "v1" ||
			record.ledger_type !== "global_budget" ||
			record.cap_tokens !== capTokens ||
			typeof actual !== "string" ||
			actual !== sha256(unsigned) ||
			!Number.isSafeInteger(record.accounted_tokens) ||
			!Number.isSafeInteger(record.reserved_tokens) ||
			record.accounted_tokens + record.reserved_tokens > record.cap_tokens
		) {
			throw new Error("Global budget ledger binding or balance is invalid");
		}
		return new GlobalBudgetLedger(resolved, unsigned);
	}

	get snapshot(): GlobalBudgetState {
		return { ...this.state, state_sha256: sha256(this.state) };
	}

	async reserve(tokens: number): Promise<boolean> {
		assertTokens(tokens, "reservation_tokens");
		if (tokens === 0 || this.state.reconciliation_required || this.state.accounted_tokens + this.state.reserved_tokens + tokens > this.state.cap_tokens) {
			return false;
		}
		this.state = { ...this.state, reserved_tokens: this.state.reserved_tokens + tokens };
		await this.persist();
		return true;
	}

	async settle(reservedTokens: number, actualTokens: number): Promise<void> {
		assertTokens(reservedTokens, "reserved_tokens");
		assertTokens(actualTokens, "actual_tokens");
		if (actualTokens > reservedTokens || reservedTokens > this.state.reserved_tokens) {
			this.state = { ...this.state, reconciliation_required: true };
			await this.persist();
			throw new Error("Global budget settlement is invalid and requires reconciliation");
		}
		this.state = {
			...this.state,
			accounted_tokens: this.state.accounted_tokens + actualTokens,
			reserved_tokens: this.state.reserved_tokens - reservedTokens,
		};
		await this.persist();
	}

	async chargeUnverified(reservedTokens: number): Promise<void> {
		assertTokens(reservedTokens, "reserved_tokens");
		if (reservedTokens > this.state.reserved_tokens) throw new Error("Unknown budget reservation is not open");
		this.state = {
			...this.state,
			accounted_tokens: this.state.accounted_tokens + reservedTokens,
			reserved_tokens: this.state.reserved_tokens - reservedTokens,
			reconciliation_required: true,
		};
		await this.persist();
	}

	async recordObserved(actualTokens: number): Promise<void> {
		assertTokens(actualTokens, "actual_tokens");
		if (this.state.reconciliation_required || this.state.reserved_tokens !== 0) {
			throw new Error("Observed usage cannot be recorded while budget reconciliation or a reservation is active");
		}
		if (!Number.isSafeInteger(this.state.accounted_tokens + actualTokens) || this.state.accounted_tokens + actualTokens > this.state.cap_tokens) {
			throw new Error("Observed usage exceeds the global budget ledger representation limit");
		}
		this.state = { ...this.state, accounted_tokens: this.state.accounted_tokens + actualTokens };
		await this.persist();
	}

	async markReconciliationRequired(): Promise<void> {
		this.state = { ...this.state, reconciliation_required: true };
		await this.persist();
	}

	private async persist(): Promise<void> {
		await writeAtomic(this.path, stableStringify(this.snapshot));
	}
}
