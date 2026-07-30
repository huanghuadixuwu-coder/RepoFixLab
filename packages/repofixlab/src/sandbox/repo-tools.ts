import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type { RepoToolTransport } from "../controller/client.ts";
import {
	REPO_TOOL_NAMES,
	RepoDiffInputSchema,
	type RepoEditInput,
	RepoEditInputSchema,
	type RepoEditToolWireInput,
	RepoEditToolWireSchema,
	RepoExecInputSchema,
	RepoListInputSchema,
	RepoReadInputSchema,
	RepoSearchInputSchema,
	type RepoToolResponse,
} from "./protocol.ts";

export const MODEL_VISIBLE_TOOL_OUTPUT_LIMIT = 12 * 1_024;
export const MODEL_VISIBLE_STAGE_OUTPUT_LIMIT = 48 * 1_024;

const repoEditInputValidator = Compile(RepoEditInputSchema);

export interface RepoToolOutputBudgetSnapshot {
	readonly stage: string | null;
	readonly visible_chars: number;
	readonly truncated_calls: number;
}

/** Mutable per-session accounting. Raw Controller results remain in details. */
export class RepoToolOutputBudget {
	private activeStage: string | null = null;
	private visibleChars = 0;
	private truncatedCalls = 0;

	startStage(stage: string): void {
		this.activeStage = stage;
		this.visibleChars = 0;
		this.truncatedCalls = 0;
	}

	allocate(requestedChars: number): number {
		const allowance = Math.max(0, Math.min(requestedChars, MODEL_VISIBLE_STAGE_OUTPUT_LIMIT - this.visibleChars));
		this.visibleChars += allowance;
		if (allowance < requestedChars) this.truncatedCalls += 1;
		return allowance;
	}

	get snapshot(): RepoToolOutputBudgetSnapshot {
		return { stage: this.activeStage, visible_chars: this.visibleChars, truncated_calls: this.truncatedCalls };
	}
}

function assertExpectedTool(response: RepoToolResponse, expectedTool: RepoToolResponse["tool"]): RepoToolResponse {
	if (response.tool !== expectedTool) {
		throw new Error(`Repo tool transport returned ${response.tool} for ${expectedTool}`);
	}
	return response;
}

function formatToolResult(response: RepoToolResponse, visibleCharacterLimit: number): string {
	const raw = [
		`tool: ${response.result.tool}`,
		`exit_code: ${response.result.exit_code === null ? "null" : response.result.exit_code}`,
		`timed_out: ${response.result.timed_out}`,
		`truncated: ${response.result.truncated}`,
		"model_output_truncated: false",
		`duration_ms: ${response.result.duration_ms}`,
		"stdout:",
		response.result.stdout.length === 0 ? "<empty>" : response.result.stdout,
		"stderr:",
		response.result.stderr.length === 0 ? "<empty>" : response.result.stderr,
	].join("\n");
	if (raw.length <= visibleCharacterLimit) return raw;
	const marker = "\nmodel_output_truncated: true\n<full Controller output retained in trajectory details>";
	if (visibleCharacterLimit <= marker.length) return marker.slice(0, visibleCharacterLimit);
	return `${raw.slice(0, visibleCharacterLimit - marker.length)}${marker}`;
}

function toToolResult(response: RepoToolResponse, outputBudget: RepoToolOutputBudget | undefined) {
	const requested = Math.min(
		MODEL_VISIBLE_TOOL_OUTPUT_LIMIT,
		Math.max(1, response.result.stdout.length + response.result.stderr.length + 512),
	);
	const visibleLimit = outputBudget?.allocate(requested) ?? requested;
	return {
		content: [{ type: "text" as const, text: formatToolResult(response, visibleLimit) }],
		details: response.result,
	};
}

function normalizeRepoEditInput(input: RepoEditToolWireInput): RepoEditInput {
	if (!repoEditInputValidator.Check(input)) {
		throw new Error(
			"repo_edit requires exactly one of { path, content } for a new file or { path, old_text, new_text } for an exact replacement.",
		);
	}
	return input;
}

export function toolCallOperationId(toolCallId: string): string {
	if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,154}$/.test(toolCallId)) {
		return `tool:${toolCallId}`;
	}
	return `tool:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

export function createRepoTools(
	leaseId: string,
	transport: RepoToolTransport,
	outputBudget?: RepoToolOutputBudget,
): ToolDefinition[] {
	if (leaseId.length === 0) {
		throw new Error("leaseId must not be empty");
	}

	return [
		defineTool({
			name: REPO_TOOL_NAMES[0],
			label: "List repository",
			description: "List files and directories within the leased repository workspace.",
			promptSnippet: "List repository files and directories",
			parameters: RepoListInputSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_list",
								input: params,
							},
							signal,
						),
						"repo_list",
					),
					outputBudget,
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[1],
			label: "Read repository file",
			description: "Read a UTF-8 repository-relative file with bounded output.",
			promptSnippet: "Read repository files",
			parameters: RepoReadInputSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_read",
								input: params,
							},
							signal,
						),
						"repo_read",
					),
					outputBudget,
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[2],
			label: "Search repository",
			description: "Search repository text and return bounded file-and-line matches.",
			promptSnippet: "Search text in the repository",
			parameters: RepoSearchInputSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_search",
								input: params,
							},
							signal,
						),
						"repo_search",
					),
					outputBudget,
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[3],
			label: "Edit repository file",
			description:
				"Create a new repository-relative UTF-8 source file with complete content, or atomically replace exactly one old_text occurrence in an existing source file. In this controlled evaluation, test paths and standalone test files are prohibited because a private test patch is applied later. Never send a fragment as content for an existing file.",
			promptSnippet: "Create a new file or make one exact, atomic text replacement",
			parameters: RepoEditToolWireSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_edit",
								input: normalizeRepoEditInput(params),
							},
							signal,
						),
						"repo_edit",
					),
					outputBudget,
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[4],
			label: "Execute repository command",
			description:
				'Execute a bounded non-shell command inside the leased repository worker. argv is required and must be a JSON string array, for example ["node", "test/unit/adapters/http.js"]; never pass a shell command string.',
			promptSnippet: "Run a command with argv as a JSON string array",
			parameters: RepoExecInputSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_exec",
								input: params,
							},
							signal,
						),
						"repo_exec",
					),
					outputBudget,
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[5],
			label: "Show repository diff",
			description: "Return the current bounded unified diff from the leased repository workspace.",
			promptSnippet: "Inspect the current repository diff",
			parameters: RepoDiffInputSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_diff",
								input: params,
							},
							signal,
						),
						"repo_diff",
					),
					outputBudget,
				),
		}),
	];
}
