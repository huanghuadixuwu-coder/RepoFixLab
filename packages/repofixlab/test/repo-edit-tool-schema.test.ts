import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { RepoToolTransport } from "../src/controller/client.ts";
import { createRepoTools } from "../src/sandbox/repo-tools.ts";
import {
	RepoEditInputSchema,
	RepoEditToolWireSchema,
	type RepoEditInput,
	type RepoToolRequest,
} from "../src/sandbox/protocol.ts";

function repoEditTool(transport: RepoToolTransport) {
	const tool = createRepoTools("lease-test", transport).find((candidate) => candidate.name === "repo_edit");
	if (tool === undefined) throw new Error("repo_edit tool is missing");
	return tool;
}

function successfulEditResponse(request: Extract<RepoToolRequest, { tool: "repo_edit" }>) {
	return {
		tool: "repo_edit" as const,
		result: {
			tool: "repo_edit" as const,
			exit_code: 0,
			stdout: request.input.path,
			stderr: "",
			truncated: false,
			timed_out: false,
			duration_ms: 1,
		},
	};
}

describe("RepoFix repo_edit provider wire schema", () => {
	it("uses an object at the provider boundary while retaining the strict execution contract", () => {
		expect(RepoEditToolWireSchema.type).toBe("object");
		const strictValidator = Compile(RepoEditInputSchema);
		expect(strictValidator.Check({ path: "src/new.ts", content: "export {};" })).toBe(true);
		expect(strictValidator.Check({ path: "src/new.ts", old_text: "old", new_text: "new" })).toBe(true);
		expect(strictValidator.Check({ path: "src/new.ts", content: "new", old_text: "old", new_text: "next" })).toBe(false);
		expect(strictValidator.Check({ path: "src/new.ts", old_text: "old" })).toBe(false);
	});

	it("rejects ambiguous edit parameters before the Controller and forwards only strict variants", async () => {
		const requests: RepoEditInput[] = [];
		const transport: RepoToolTransport = {
			execute: async (request) => {
				if (request.tool !== "repo_edit") throw new Error(`unexpected tool ${request.tool}`);
				requests.push(request.input);
				return successfulEditResponse(request);
			},
		};
		const tool = repoEditTool(transport);

		await expect(
			tool.execute(
				"call-invalid",
				{ path: "src/new.ts", content: "new", old_text: "old", new_text: "next" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/requires exactly one/);
		expect(requests).toEqual([]);

		await tool.execute(
			"call-create",
			{ path: "src/new.ts", content: "export {};" },
			undefined,
			undefined,
			undefined as never,
		);
		await tool.execute(
			"call-replace",
			{ path: "src/existing.ts", old_text: "old", new_text: "new" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(requests).toEqual([
			{ path: "src/new.ts", content: "export {};" },
			{ path: "src/existing.ts", old_text: "old", new_text: "new" },
		]);
	});
});
