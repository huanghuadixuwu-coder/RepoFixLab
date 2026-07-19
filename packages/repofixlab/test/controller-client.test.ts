import { describe, expect, it } from "vitest";
import { HttpRepoToolTransport, RepoToolTransportError } from "../src/controller/client.ts";
import { HttpRuntimeController } from "../src/runner/controller-runtime.ts";

function parseRequest(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function successBody(
	request: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema_version: "v1",
		response_type: "runtime_tool_result",
		status: "completed",
		attempt_id: request.attempt_id,
		operation_id: request.operation_id,
		request_sha256: request.request_sha256,
		lease_id: "lease-1",
		tool: request.tool,
		input: request.input,
		result: {
			tool: request.tool,
			exit_code: 0,
			stdout: "export const a = 1;",
			stderr: "",
			truncated: false,
			timed_out: false,
			duration_ms: 7,
		},
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("HTTP Repo tool transport", () => {
	it("posts the canonical request to the lease-bound Controller endpoint", async () => {
		let observedUrl = "";
		let observedBody: Record<string, unknown> = {};
		const fetchFn: typeof fetch = async (input, init) => {
			observedUrl = String(input);
			observedBody = parseRequest(init);
			return jsonResponse(successBody(observedBody));
		};
		const transport = new HttpRepoToolTransport({
			controllerUrl: "http://controller:8080/control-plane/",
			attemptId: "attempt-1",
			fetchFn,
		});

		const result = await transport.execute({
			leaseId: "lease-1",
			operationId: "tool:call-1",
			tool: "repo_read",
			input: { path: "src/a.ts" },
		});

		expect(observedUrl).toBe("http://controller:8080/internal/v1/runtime/workers/lease-1/tools");
		expect(observedBody).toEqual({
			schema_version: "v1",
			request_type: "runtime_execute_tool",
			attempt_id: "attempt-1",
			operation_id: "tool:call-1",
			tool: "repo_read",
			input: { path: "src/a.ts" },
			request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(result).toEqual({
			tool: "repo_read",
			result: {
				tool: "repo_read",
				exit_code: 0,
				stdout: "export const a = 1;",
				stderr: "",
				truncated: false,
				timed_out: false,
				duration_ms: 7,
			},
		});
	});

	it("rejects unknown response fields instead of accepting protocol drift", async () => {
		const fetchFn: typeof fetch = async (_input, init) =>
			jsonResponse(successBody(parseRequest(init), { debug: true }));
		const transport = new HttpRepoToolTransport({
			controllerUrl: "http://controller:8080",
			attemptId: "attempt-1",
			fetchFn,
		});

		await expect(
			transport.execute({
				leaseId: "lease-1",
				operationId: "tool:call-1",
				tool: "repo_read",
				input: { path: "src/a.ts" },
			}),
		).rejects.toThrow("invalid v1 response");
	});

	it("binds the canonical request hash to the path lease without duplicating lease_id in the body", async () => {
		const hashes: string[] = [];
		const fetchFn: typeof fetch = async (input, init) => {
			const request = parseRequest(init);
			hashes.push(String(request.request_sha256));
			const leaseId = String(input).includes("/lease-2/") ? "lease-2" : "lease-1";
			return jsonResponse(successBody(request, { lease_id: leaseId }));
		};
		const transport = new HttpRepoToolTransport({
			controllerUrl: "http://controller:8080",
			attemptId: "attempt-1",
			fetchFn,
		});
		const request = {
			operationId: "tool:stable-call",
			tool: "repo_read" as const,
			input: { path: "src/a.ts" },
		};

		await transport.execute({ leaseId: "lease-1", ...request });
		await transport.execute({ leaseId: "lease-2", ...request });

		expect(hashes).toHaveLength(2);
		expect(hashes[0]).not.toBe(hashes[1]);
	});

	it("rejects drift in every echoed request identity", async () => {
		const cases: Array<{ field: string; value: unknown; message: string }> = [
			{
				field: "attempt_id",
				value: "attempt-other",
				message: "mismatched attempt_id",
			},
			{
				field: "operation_id",
				value: "tool:call-other",
				message: "mismatched operation_id",
			},
			{
				field: "request_sha256",
				value: "0".repeat(64),
				message: "mismatched request_sha256",
			},
			{
				field: "lease_id",
				value: "lease-other",
				message: "mismatched lease_id",
			},
		];

		for (const testCase of cases) {
			const fetchFn: typeof fetch = async (_input, init) =>
				jsonResponse(successBody(parseRequest(init), { [testCase.field]: testCase.value }));
			const transport = new HttpRepoToolTransport({
				controllerUrl: "http://controller:8080",
				attemptId: "attempt-1",
				fetchFn,
			});
			await expect(
				transport.execute({
					leaseId: "lease-1",
					operationId: "tool:call-1",
					tool: "repo_read",
					input: { path: "src/a.ts" },
				}),
			).rejects.toThrow(testCase.message);
		}
	});

	it("rejects mismatched tool, input, and result bindings", async () => {
		const toolFetch: typeof fetch = async (_input, init) => {
			const request = parseRequest(init);
			return jsonResponse(
				successBody(request, {
					tool: "repo_diff",
					input: {},
					result: {
						tool: "repo_diff",
						exit_code: 0,
						stdout: "",
						stderr: "",
						truncated: false,
						timed_out: false,
						duration_ms: 1,
					},
				}),
			);
		};
		const toolTransport = new HttpRepoToolTransport({
			controllerUrl: "http://controller:8080",
			attemptId: "attempt-1",
			fetchFn: toolFetch,
		});
		await expect(
			toolTransport.execute({
				leaseId: "lease-1",
				operationId: "tool:call-1",
				tool: "repo_read",
				input: { path: "src/a.ts" },
			}),
		).rejects.toThrow("mismatched tool");

		const inputFetch: typeof fetch = async (_input, init) => {
			const request = parseRequest(init);
			return jsonResponse(successBody(request, { input: { path: "src/other.ts" } }));
		};
		const inputTransport = new HttpRepoToolTransport({
			controllerUrl: "http://controller:8080",
			attemptId: "attempt-1",
			fetchFn: inputFetch,
		});
		await expect(
			inputTransport.execute({
				leaseId: "lease-1",
				operationId: "tool:call-1",
				tool: "repo_read",
				input: { path: "src/a.ts" },
			}),
		).rejects.toThrow("mismatched input");
	});

	it("maps non-success HTTP responses to a typed transport error", async () => {
		const fetchFn: typeof fetch = async () => new Response("worker lease expired", { status: 409 });
		const transport = new HttpRepoToolTransport({
			controllerUrl: "http://controller:8080",
			attemptId: "attempt-1",
			fetchFn,
		});

		const error = await transport
			.execute({
				leaseId: "lease-1",
				operationId: "tool:call-1",
				tool: "repo_diff",
				input: {},
			})
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(RepoToolTransportError);
		if (error instanceof RepoToolTransportError) {
			expect(error.status).toBe(409);
			expect(error.message).toContain("worker lease expired");
		}
	});

	it("accepts the Controller's patch_bytes snapshot contract", async () => {
		const emptyPatchSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		const fetchFn: typeof fetch = async (_input, init) => {
			const request = parseRequest(init);
			return jsonResponse({
				schema_version: "v1",
				response_type: "runtime_patch_snapshot",
				status: "snapshotted",
				attempt_id: request.attempt_id,
				operation_id: request.operation_id,
				request_sha256: request.request_sha256,
				snapshot_id: `snapshot-${emptyPatchSha256}`,
				patch_sha256: emptyPatchSha256,
				patch_bytes: 0,
				patch_base64: "",
				empty: true,
				base_commit: "a".repeat(40),
				base_tree: { algorithm: "git-sha1", value: "a".repeat(40) },
				candidate_tree: { algorithm: "git-sha1", value: "b".repeat(40) },
				files: [],
				policy: { status: "pass", violations: [] },
				created_at: "2026-07-19T00:00:00.000Z",
			});
		};
		const controller = new HttpRuntimeController({ controllerUrl: "http://controller:8080", fetchFn });

		const snapshot = await controller.snapshot("attempt-1", "attempt-1:snapshot", "lease-1");

		expect(snapshot.patch.byteLength).toBe(0);
		expect(snapshot.patchSha256).toBe(emptyPatchSha256);
	});
});
