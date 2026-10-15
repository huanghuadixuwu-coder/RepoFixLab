import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpRuntimeController } from "../src/runner/controller-runtime.ts";

describe("runtime response recovery", () => {
	it("retrieves a lost restoration response without consuming another recovery", async () => {
		const requests: string[] = [];
		const digest = "a".repeat(64);
		const controller = new HttpRuntimeController({
			controllerUrl: "http://controller.invalid",
			fetchFn: async (_input, init) => {
				requests.push(String(init?.body));
				if (requests.length === 1) throw new TypeError("restoration response lost");
				return Response.json({
					...JSON.parse(requests[1]!),
					response_type: "runtime_worker_restored",
					status: "restored",
					lease_id: "lease-b",
					snapshot_id: `snapshot-${digest}`,
					patch_sha256: digest,
					worker_recoveries: 1,
				});
			},
		});
		expect(await controller.restoreWorker("attempt-a", "restore-a", "lease-a", `snapshot-${digest}`)).toEqual({
			leaseId: "lease-b",
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]).toBe(requests[1]);
	});
	it("retrieves a lost snapshot response with the same operation identity", async () => {
		const requests: string[] = [];
		const controller = new HttpRuntimeController({
			controllerUrl: "http://controller.invalid",
			fetchFn: async (_input, init) => {
				requests.push(String(init?.body));
				if (requests.length === 1) throw new TypeError("response lost after snapshot commit");
				const request = JSON.parse(requests[1]!) as Record<string, unknown>;
				const digest = createHash("sha256").update("").digest("hex");
				return Response.json({
					...request,
					response_type: "runtime_patch_snapshot",
					status: "snapshotted",
					snapshot_id: `snapshot-${digest}`,
					patch_base64: "",
					patch_sha256: digest,
					patch_bytes: 0,
					empty: true,
					base_commit: "a".repeat(40),
					base_tree: { algorithm: "git-sha1", value: "b".repeat(40) },
					candidate_tree: { algorithm: "git-sha1", value: "b".repeat(40) },
					files: [],
					policy: { status: "pass", violations: [] },
					created_at: "2026-10-14T00:00:00.000Z",
				});
			},
		});
		const snapshot = await controller.snapshot("attempt-a", "snapshot-a", "lease-a");
		expect(snapshot.patch.byteLength).toBe(0);
		expect(requests).toHaveLength(2);
		expect(requests[0]).toBe(requests[1]);
	});

	it("stops after a second transport failure", async () => {
		let requests = 0;
		const controller = new HttpRuntimeController({
			controllerUrl: "http://controller.invalid",
			fetchFn: async () => {
				requests += 1;
				throw new TypeError("offline");
			},
		});
		await expect(controller.snapshot("attempt-a", "snapshot-a", "lease-a")).rejects.toThrow("response was lost");
		expect(requests).toBe(2);
	});

	it("does not retry a rejected snapshot or an invalid response", async () => {
		for (const response of [
			Response.json({ detail: "runtime_image_blocked" }, { status: 503 }),
			Response.json({ wrong: "identity" }),
		]) {
			let requests = 0;
			const controller = new HttpRuntimeController({
				controllerUrl: "http://controller.invalid",
				fetchFn: async () => {
					requests += 1;
					return response;
				},
			});
			await expect(controller.snapshot("attempt-a", "snapshot-a", "lease-a")).rejects.toThrow();
			expect(requests).toBe(1);
		}
	});

	it("reads an existing completed evaluation after losing its response", async () => {
		const urls: string[] = [];
		const controller = new HttpRuntimeController({
			controllerUrl: "http://controller.invalid",
			fetchFn: async (input) => {
				urls.push(String(input));
				if (urls.length === 1) throw new TypeError("completed result response lost");
				return Response.json({
					response_type: "runtime_job_status",
					attempt_id: "attempt-a",
					job_id: "job-a",
					status: "completed",
					resolved: false,
					error_class: null,
				});
			},
		});
		expect(await controller.getJob("attempt-a", "job-a")).toEqual({
			status: "completed",
			resolved: false,
			errorClass: null,
		});
		expect(urls).toHaveLength(2);
		expect(urls[0]).toBe(urls[1]);
	});
});
