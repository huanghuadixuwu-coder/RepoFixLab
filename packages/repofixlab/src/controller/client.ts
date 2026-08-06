/**
 * HTTP client for the trusted RepoFix Controller repository-tool endpoint.
 *
 * This module:
 * - Converts model-selected repository operations into identity-bound requests
 * - Applies request timeouts and hard response-size limits
 * - Validates the complete versioned Controller response schema
 * - Rejects mismatched attempt, lease, operation, tool, hash, or input data
 *
 * The client transports authorized operations; it does not execute repository
 * commands or decide which tools are allowed in the active workflow stage.
 */

import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { stableStringify } from "../contracts/schema-generator.ts";
import {
	type RepoToolHttpResponse,
	RepoToolHttpResponseSchema,
	type RepoToolRequest,
	type RepoToolResponse,
} from "../sandbox/protocol.ts";

const repoToolHttpResponseValidator = Compile(RepoToolHttpResponseSchema);
const DEFAULT_REQUEST_TIMEOUT_MS = 310_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_500_000;
const ERROR_BODY_LIMIT = 4_096;

/** Transport contract used by model-facing repository-tool wrappers. */
export interface RepoToolTransport {
	execute(request: RepoToolRequest, signal?: AbortSignal): Promise<RepoToolResponse>;
}

/** Configuration for one attempt-scoped HTTP Controller transport. */
export interface HttpRepoToolTransportOptions {
	controllerUrl: string;
	attemptId: string;
	requestTimeoutMs?: number;
	maxResponseBytes?: number;
	fetchFn?: typeof fetch;
}

/** Error raised when the Controller transport or response contract fails. */
export class RepoToolTransportError extends Error {
	readonly status: number | undefined;

	/** Preserve the optional HTTP status alongside a stable transport error. */
	constructor(message: string, status?: number) {
		super(message);
		this.name = "RepoToolTransportError";
		this.status = status;
	}
}

/** Validate a positive integer used for a local transport limit. */
function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return value;
}

/** Remove HTTP envelope fields after the full response has been validated. */
function toRepoToolResponse(response: RepoToolHttpResponse): RepoToolResponse {
	return { tool: response.tool, result: response.result };
}

/**
 * Controller operation IDs are durable and globally keyed. A model tool-call
 * ID is only unique inside an Agent attempt, so bind it to that attempt before
 * it crosses the Controller boundary while preserving retry determinism.
 */
export function controllerToolOperationId(attemptId: string, toolCallOperationId: string): string {
	const scopedAttemptId = requireIdentifier(attemptId, "attemptId");
	const scopedToolCallOperationId = requireIdentifier(toolCallOperationId, "operationId");
	return `tool-${createHash("sha256")
		.update(scopedAttemptId, "utf8")
		.update("\0", "utf8")
		.update(scopedToolCallOperationId, "utf8")
		.digest("hex")}`;
}

/** Attempt-scoped HTTP implementation of the repository-tool transport. */
export class HttpRepoToolTransport implements RepoToolTransport {
	private readonly controllerUrl: string;
	private readonly attemptId: string;
	private readonly requestTimeoutMs: number;
	private readonly maxResponseBytes: number;
	private readonly fetchFn: typeof fetch;

	/** Initialize immutable endpoint, identity, timeout, and byte-limit settings. */
	constructor(options: HttpRepoToolTransportOptions) {
		this.controllerUrl = options.controllerUrl;
		this.attemptId = requireIdentifier(options.attemptId, "attemptId");
		this.requestTimeoutMs = requirePositiveInteger(
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			"requestTimeoutMs",
		);
		this.maxResponseBytes = requirePositiveInteger(
			options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
			"maxResponseBytes",
		);
		this.fetchFn = options.fetchFn ?? fetch;
	}

	/** Send one identity-bound tool request and validate the complete response. */
	async execute(request: RepoToolRequest, signal?: AbortSignal): Promise<RepoToolResponse> {
		const leaseId = requireIdentifier(request.leaseId, "leaseId");
		const operationId = controllerToolOperationId(this.attemptId, request.operationId);
		const unsignedRequest = {
			schema_version: "v1" as const,
			request_type: "runtime_execute_tool" as const,
			attempt_id: this.attemptId,
			operation_id: operationId,
			tool: request.tool,
			input: request.input,
		};
		const requestSha256 = canonicalSha256({
			...unsignedRequest,
			lease_id: leaseId,
		});
		const endpoint = new URL(
			`/internal/v1/runtime/workers/${encodeURIComponent(leaseId)}/tools`,
			this.controllerUrl,
		).toString();
		const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const response = await this.fetchFn(endpoint, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				...unsignedRequest,
				request_sha256: requestSha256,
			}),
			signal: requestSignal,
		});

		if (!response.ok) {
			const responseText = (await response.text()).slice(0, ERROR_BODY_LIMIT);
			throw new RepoToolTransportError(
				`Repo tool Controller returned HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`,
				response.status,
			);
		}

		const contentType = response.headers.get("content-type")?.toLowerCase();
		if (!contentType?.includes("application/json")) {
			throw new RepoToolTransportError("Repo tool Controller returned a non-JSON response", response.status);
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength !== null && Number(contentLength) > this.maxResponseBytes) {
			throw new RepoToolTransportError("Repo tool Controller response exceeded the byte limit", response.status);
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > this.maxResponseBytes) {
			throw new RepoToolTransportError("Repo tool Controller response exceeded the byte limit", response.status);
		}

		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new RepoToolTransportError("Repo tool Controller returned invalid UTF-8 JSON", response.status);
		}

		if (!repoToolHttpResponseValidator.Check(body)) {
			throw new RepoToolTransportError("Repo tool Controller returned an invalid v1 response", response.status);
		}
		if (body.attempt_id !== this.attemptId) {
			throw new RepoToolTransportError("Repo tool Controller returned a mismatched attempt_id", response.status);
		}
		if (body.operation_id !== operationId) {
			throw new RepoToolTransportError("Repo tool Controller returned a mismatched operation_id", response.status);
		}
		if (body.request_sha256 !== requestSha256) {
			throw new RepoToolTransportError("Repo tool Controller returned a mismatched request_sha256", response.status);
		}
		if (body.lease_id !== leaseId) {
			throw new RepoToolTransportError("Repo tool Controller returned a mismatched lease_id", response.status);
		}
		if (body.tool !== request.tool) {
			throw new RepoToolTransportError("Repo tool Controller returned a mismatched tool", response.status);
		}
		if (body.result.tool !== request.tool) {
			throw new RepoToolTransportError("Repo tool Controller returned a mismatched result tool", response.status);
		}
		if (stableStringify(body.input) !== stableStringify(request.input)) {
			throw new RepoToolTransportError("Repo tool Controller returned mismatched input", response.status);
		}

		return toRepoToolResponse(body);
	}
}

/** Enforce the shared bounded identifier syntax used by runtime contracts. */
function requireIdentifier(value: string, name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) {
		throw new Error(`${name} must satisfy the runtime identifier contract`);
	}
	return value;
}

/** Hash a value after canonical key ordering for cross-language comparison. */
function canonicalSha256(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}
