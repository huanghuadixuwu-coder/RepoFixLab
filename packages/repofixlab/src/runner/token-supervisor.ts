/**
 * Reservation-based Provider token supervision for RepoFix sessions.
 *
 * This module:
 * - Estimates prompt size before each Provider request.
 * - Durably reserves worst-case input and output usage.
 * - Settles reservations from exact terminal Provider usage.
 * - Charges uncertain requests conservatively and blocks further admission.
 *
 * Ownership boundary:
 * - Token policy, accounting state, and ledger evidence stay in the Node
 *   Orchestrator; the Controller does not receive budget authority.
 */

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

export const TOKEN_SUPERVISOR_ERROR = "repofixlab_token_supervisor_rejected";

export interface TokenLedgerEvent {
	readonly schema_version: "v1";
	readonly event_type:
		| "reservation_open"
		| "reservation_settled"
		| "reservation_charged_unverified"
		| "budget_protocol_invalid"
		| "admission_rejected";
	readonly request_id: string;
	readonly run_id: string;
	readonly reservation_tokens: number | null;
	readonly accounted_tokens: number | null;
	readonly base_input_tokens: number | null;
	readonly estimated_input_tokens: number | null;
	readonly provider_prompt_tokens: number | null;
	readonly provider_completion_tokens: number | null;
	readonly provider_total_tokens: number | null;
	readonly reason: string | null;
}

export interface TokenLedgerSink {
	append(event: TokenLedgerEvent): void;
}

/** Collect token-ledger events in memory for local or non-production consumers. */
export class InMemoryTokenLedgerSink implements TokenLedgerSink {
	readonly events: TokenLedgerEvent[] = [];

	/** Record one token-accounting transition in insertion order. */
	append(event: TokenLedgerEvent): void {
		this.events.push(event);
	}
}

/**
 * The formal runner opens this writer before the first provider request. Each
 * reservation transition is appended and fsynced before control returns to the
 * caller, so a request is never sent before its budget charge is durable.
 */
export class FsyncTokenLedgerSink implements TokenLedgerSink {
	private readonly descriptor: number;

	/** Open the append-only ledger file with owner-only permissions. */
	constructor(path: string) {
		this.descriptor = openSync(path, "a", 0o600);
	}

	/** Append and fsync one reservation transition before returning. */
	append(event: TokenLedgerEvent): void {
		writeSync(this.descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
		fsyncSync(this.descriptor);
	}

	/** Close the durable ledger after all Provider requests have settled. */
	close(): void {
		closeSync(this.descriptor);
	}
}

export interface TokenSupervisorLimits {
	readonly per_run_accounted_cap_tokens: number;
	readonly project_accounted_cap_tokens: number;
}

export interface TokenReservation {
	readonly request_id: string;
	readonly run_id: string;
	readonly base_input_tokens: number;
	readonly reserved_input_tokens: number;
	readonly max_output_tokens: number;
	readonly reservation_tokens: number;
}

export type TokenAdmission =
	| { readonly admitted: true; readonly reservation: TokenReservation }
	| { readonly admitted: false; readonly reason: "budget_exhausted" | "reconciliation_required" };

export interface TokenUsage {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_read_tokens?: number;
	readonly cache_write_tokens?: number;
	readonly total_tokens: number;
}

/** Validate token quantities that must be positive safe integers. */
function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

/** Validate token quantities that may be zero. */
function assertNonNegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

/**
 * Track open Provider reservations and exact accounted usage for one
 * Orchestrator process, with independent per-run and project-wide caps.
 */
export class TokenReservationLedger {
	private readonly reservations = new Map<string, TokenReservation>();
	private readonly runAccountedTokens = new Map<string, number>();
	private projectAccountedTokens = 0;
	private reconciliationRequired = false;
	private readonly sink: TokenLedgerSink;
	private readonly limits: TokenSupervisorLimits;

	/** Bind the ledger to fixed caps and an append-only evidence sink. */
	constructor(limits: TokenSupervisorLimits, sink: TokenLedgerSink) {
		assertPositiveSafeInteger(limits.per_run_accounted_cap_tokens, "per_run_accounted_cap_tokens");
		assertPositiveSafeInteger(limits.project_accounted_cap_tokens, "project_accounted_cap_tokens");
		this.limits = limits;
		this.sink = sink;
	}

	/**
	 * Reserve estimated input plus maximum output before a Provider request.
	 * Returns a rejection without calling the Provider when a cap is exhausted
	 * or earlier uncertain usage requires reconciliation.
	 */
	reserve(input: {
		readonly request_id: string;
		readonly run_id: string;
		readonly base_input_tokens?: number;
		readonly estimated_input_tokens: number;
		readonly max_output_tokens: number;
	}): TokenAdmission {
		assertPositiveSafeInteger(input.estimated_input_tokens, "estimated_input_tokens");
		const baseInputTokens = input.base_input_tokens ?? input.estimated_input_tokens;
		assertPositiveSafeInteger(baseInputTokens, "base_input_tokens");
		assertPositiveSafeInteger(input.max_output_tokens, "max_output_tokens");
		if (input.request_id.length === 0 || input.run_id.length === 0) {
			throw new Error("Token reservation request_id and run_id are required");
		}
		if (this.reservations.has(input.request_id)) throw new Error(`Duplicate token reservation request_id: ${input.request_id}`);
		if (this.reconciliationRequired) {
			this.reject(input.request_id, input.run_id, "reconciliation_required");
			return { admitted: false, reason: "reconciliation_required" };
		}
		const reservationTokens = input.estimated_input_tokens + input.max_output_tokens;
		if (!Number.isSafeInteger(reservationTokens)) throw new Error("Token reservation exceeds safe integer precision");
		const runAccounted = this.runAccountedTokens.get(input.run_id) ?? 0;
		if (
			runAccounted + reservationTokens > this.limits.per_run_accounted_cap_tokens ||
			this.projectAccountedTokens + reservationTokens > this.limits.project_accounted_cap_tokens
		) {
			this.reject(input.request_id, input.run_id, "budget_exhausted");
			return { admitted: false, reason: "budget_exhausted" };
		}
		const reservation: TokenReservation = {
			request_id: input.request_id,
			run_id: input.run_id,
			base_input_tokens: baseInputTokens,
			reserved_input_tokens: input.estimated_input_tokens,
			max_output_tokens: input.max_output_tokens,
			reservation_tokens: reservationTokens,
		};
		this.reservations.set(reservation.request_id, reservation);
		this.runAccountedTokens.set(reservation.run_id, runAccounted + reservation.reservation_tokens);
		this.projectAccountedTokens += reservation.reservation_tokens;
		this.sink.append({
			schema_version: "v1",
			event_type: "reservation_open",
			request_id: reservation.request_id,
			run_id: reservation.run_id,
			reservation_tokens: reservation.reservation_tokens,
			accounted_tokens: null,
			base_input_tokens: reservation.base_input_tokens,
			estimated_input_tokens: reservation.reserved_input_tokens,
			provider_prompt_tokens: null,
			provider_completion_tokens: null,
			provider_total_tokens: null,
			reason: null,
		});
		return { admitted: true, reservation };
	}

	/** Settle an open reservation against exact, internally consistent usage. */
	settle(reservation: TokenReservation, usage: TokenUsage): void {
		this.assertOpen(reservation);
		try {
			assertNonNegativeSafeInteger(usage.input_tokens, "usage.input_tokens");
			assertNonNegativeSafeInteger(usage.output_tokens, "usage.output_tokens");
			assertNonNegativeSafeInteger(usage.cache_read_tokens ?? 0, "usage.cache_read_tokens");
			assertNonNegativeSafeInteger(usage.cache_write_tokens ?? 0, "usage.cache_write_tokens");
			assertNonNegativeSafeInteger(usage.total_tokens, "usage.total_tokens");
			if (
				usage.total_tokens !==
				usage.input_tokens +
					usage.output_tokens +
					(usage.cache_read_tokens ?? 0) +
					(usage.cache_write_tokens ?? 0)
			) {
				throw new Error("Provider usage total does not equal input, output, and cache tokens");
			}
			if (
				usage.input_tokens > reservation.reserved_input_tokens ||
				usage.total_tokens > reservation.reservation_tokens
			) {
				throw new Error("Provider usage exceeded the durable token reservation");
			}
		} catch (error) {
			this.protocolInvalid(reservation, error instanceof Error ? error.message : "Unknown usage protocol error");
			throw error;
		}
		this.reservations.delete(reservation.request_id);
		const released = reservation.reservation_tokens - usage.total_tokens;
		this.runAccountedTokens.set(
			reservation.run_id,
			(this.runAccountedTokens.get(reservation.run_id) ?? 0) - released,
		);
		this.projectAccountedTokens -= released;
		this.sink.append({
			schema_version: "v1",
			event_type: "reservation_settled",
			request_id: reservation.request_id,
			run_id: reservation.run_id,
			reservation_tokens: reservation.reservation_tokens,
			accounted_tokens: usage.total_tokens,
			base_input_tokens: reservation.base_input_tokens,
			estimated_input_tokens: reservation.reserved_input_tokens,
			provider_prompt_tokens: usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0),
			provider_completion_tokens: usage.output_tokens,
			provider_total_tokens: usage.total_tokens,
			reason: null,
		});
	}

	/**
	 * Charge the full reservation when exact Provider usage cannot be proven
	 * and require reconciliation before another request is admitted.
	 */
	chargeUnverified(reservation: TokenReservation, reason: string): void {
		this.assertOpen(reservation);
		this.reservations.delete(reservation.request_id);
		this.reconciliationRequired = true;
		this.sink.append({
			schema_version: "v1",
			event_type: "reservation_charged_unverified",
			request_id: reservation.request_id,
			run_id: reservation.run_id,
			reservation_tokens: reservation.reservation_tokens,
			accounted_tokens: reservation.reservation_tokens,
			base_input_tokens: reservation.base_input_tokens,
			estimated_input_tokens: reservation.reserved_input_tokens,
			provider_prompt_tokens: null,
			provider_completion_tokens: null,
			provider_total_tokens: null,
			reason,
		});
	}

	/** Report whether uncertain accounting has blocked further admission. */
	get requiresReconciliation(): boolean {
		return this.reconciliationRequired;
	}

	/** Return project-wide tokens currently held or finally accounted. */
	get projectAccounted(): number {
		return this.projectAccountedTokens;
	}

	/** Prove that a caller is settling the exact reservation still held. */
	private assertOpen(reservation: TokenReservation): void {
		if (this.reservations.get(reservation.request_id) !== reservation) {
			throw new Error(`Token reservation ${reservation.request_id} is not open`);
		}
	}

	/** Close an invalid reservation conservatively and record protocol failure. */
	private protocolInvalid(reservation: TokenReservation, reason: string): void {
		this.reservations.delete(reservation.request_id);
		this.reconciliationRequired = true;
		this.sink.append({
			schema_version: "v1",
			event_type: "budget_protocol_invalid",
			request_id: reservation.request_id,
			run_id: reservation.run_id,
			reservation_tokens: reservation.reservation_tokens,
			accounted_tokens: reservation.reservation_tokens,
			base_input_tokens: reservation.base_input_tokens,
			estimated_input_tokens: reservation.reserved_input_tokens,
			provider_prompt_tokens: null,
			provider_completion_tokens: null,
			provider_total_tokens: null,
			reason,
		});
	}

	/** Record a request rejected before Provider admission. */
	private reject(requestId: string, runId: string, reason: "budget_exhausted" | "reconciliation_required"): void {
		this.sink.append({
			schema_version: "v1",
			event_type: "admission_rejected",
			request_id: requestId,
			run_id: runId,
			reservation_tokens: null,
			accounted_tokens: null,
			base_input_tokens: null,
			estimated_input_tokens: null,
			provider_prompt_tokens: null,
			provider_completion_tokens: null,
			provider_total_tokens: null,
			reason,
		});
	}
}

export interface TokenSupervisedSession {
	readonly agent: {
		streamFn: (
			model: Model<Api>,
			context: Context,
			streamOptions?: SimpleStreamOptions,
		) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	};
}

export interface TokenSupervisorOptions {
	readonly ledger: TokenReservationLedger;
	readonly run_id: string;
	readonly max_output_tokens: number;
	readonly estimate_input_tokens: (context: Context) => number;
	readonly estimate_base_input_tokens?: (context: Context) => number;
	readonly next_request_id: () => string;
}

export interface TokenAdmissionEstimatorSpec {
	readonly version: string;
	readonly multiplier: number;
	readonly framing_margin_tokens: number;
}

export interface TokenAdmissionEstimator {
	readonly spec: TokenAdmissionEstimatorSpec;
	baseEstimate(context: Context): number;
	estimate(context: Context): number;
}

/** Create a deterministic prompt estimator with an explicit safety margin. */
export function createTokenAdmissionEstimator(spec: TokenAdmissionEstimatorSpec): TokenAdmissionEstimator {
	if (!Number.isFinite(spec.multiplier) || spec.multiplier < 1) {
		throw new Error("Token estimator multiplier must be finite and at least 1");
	}
	assertNonNegativeSafeInteger(spec.framing_margin_tokens, "framing_margin_tokens");
	if (spec.version.length === 0) throw new Error("Token estimator version is required");
	return {
		spec: { ...spec },
		/** Return the unsmoothed serialized-context estimate used in evidence. */
		baseEstimate(context: Context): number {
			return estimateContextTokens(context);
		},
		/** Apply the configured multiplier and framing margin for admission. */
		estimate(context: Context): number {
			const estimate = Math.ceil(this.baseEstimate(context) * spec.multiplier) + spec.framing_margin_tokens;
			assertPositiveSafeInteger(estimate, "estimated_input_tokens");
			return estimate;
		},
	};
}

/** Construct a zero-usage assistant error for a local admission failure. */
function errorMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** Wrap a local admission failure in Pi's assistant event-stream protocol. */
function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const error = errorMessage(model, message);
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error });
	return stream;
}

/** Convert Pi assistant usage fields into the ledger's usage contract. */
function usageFromMessage(message: AssistantMessage): TokenUsage {
	return {
		input_tokens: message.usage.input,
		output_tokens: message.usage.output,
		cache_read_tokens: message.usage.cacheRead,
		cache_write_tokens: message.usage.cacheWrite,
		total_tokens: message.usage.totalTokens,
	};
}

/**
 * Wrap a session stream so every Provider request is estimated, reserved
 * before dispatch, and settled or conservatively charged on termination.
 */
export function installTokenSupervisor(session: TokenSupervisedSession, options: TokenSupervisorOptions): void {
	assertPositiveSafeInteger(options.max_output_tokens, "max_output_tokens");
	const original = session.agent.streamFn;
	session.agent.streamFn = (model, context, streamOptions) => {
		let estimatedInputTokens: number;
		let baseInputTokens: number;
		try {
			estimatedInputTokens = options.estimate_input_tokens(context);
			baseInputTokens = options.estimate_base_input_tokens?.(context) ?? estimatedInputTokens;
		} catch (error) {
			return errorStream(model, `${TOKEN_SUPERVISOR_ERROR}: estimator_failure: ${String(error)}`);
		}
		const admission = options.ledger.reserve({
			request_id: options.next_request_id(),
			run_id: options.run_id,
			base_input_tokens: baseInputTokens,
			estimated_input_tokens: estimatedInputTokens,
			max_output_tokens: options.max_output_tokens,
		});
		if (!admission.admitted) return errorStream(model, `${TOKEN_SUPERVISOR_ERROR}: ${admission.reason}`);
		const output = createAssistantMessageEventStream();
		void (async () => {
			let terminalEventSeen = false;
			try {
				const source = await original(model, context, streamOptions);
				for await (const event of source) {
					if (event.type === "done") {
						terminalEventSeen = true;
						try {
							options.ledger.settle(admission.reservation, usageFromMessage(event.message));
							output.push(event);
						} catch (error) {
							output.push({
								type: "error",
								reason: "error",
								error: errorMessage(model, `${TOKEN_SUPERVISOR_ERROR}: ${String(error)}`),
							});
						}
					} else if (event.type === "error") {
						terminalEventSeen = true;
						options.ledger.chargeUnverified(admission.reservation, "provider_stream_error");
						output.push(event);
					} else {
						output.push(event);
					}
				}
				if (!terminalEventSeen) {
					options.ledger.chargeUnverified(admission.reservation, "provider_stream_ended_without_terminal_event");
					output.push({
						type: "error",
						reason: "error",
						error: errorMessage(model, `${TOKEN_SUPERVISOR_ERROR}: provider_stream_ended_without_terminal_event`),
					});
				}
			} catch (error) {
				try {
					options.ledger.chargeUnverified(
						admission.reservation,
						terminalEventSeen ? "provider_stream_exception" : "provider_preflight_failure",
					);
				} catch {
					// A prior terminal event already closed the reservation.
				}
				output.push({
					type: "error",
					reason: "error",
					error: errorMessage(model, `${TOKEN_SUPERVISOR_ERROR}: provider_stream_exception: ${String(error)}`),
				});
			}
		})();
		return output;
	};
}

/** Estimate prompt tokens conservatively from serialized context bytes. */
export function estimateContextTokens(context: Context): number {
	const bytes = new TextEncoder().encode(JSON.stringify(context)).byteLength;
	return Math.max(1, Math.ceil(bytes / 4));
}
