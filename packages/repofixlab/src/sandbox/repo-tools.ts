import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RepoToolTransport } from "../controller/client.ts";
import {
	REPO_TOOL_NAMES,
	RepoDiffInputSchema,
	RepoEditInputSchema,
	RepoExecInputSchema,
	RepoListInputSchema,
	RepoReadInputSchema,
	RepoSearchInputSchema,
	type RepoToolResponse,
} from "./protocol.ts";

function assertExpectedTool(response: RepoToolResponse, expectedTool: RepoToolResponse["tool"]): RepoToolResponse {
	if (response.tool !== expectedTool) {
		throw new Error(`Repo tool transport returned ${response.tool} for ${expectedTool}`);
	}
	return response;
}

const MODEL_VISIBLE_STREAM_CHAR_LIMIT = 64 * 1_024;

function formatToolResult(response: RepoToolResponse): string {
	const stdout = response.result.stdout.slice(0, MODEL_VISIBLE_STREAM_CHAR_LIMIT);
	const remaining = MODEL_VISIBLE_STREAM_CHAR_LIMIT - stdout.length;
	const stderr = response.result.stderr.slice(0, remaining);
	const modelOutputTruncated =
		stdout.length !== response.result.stdout.length || stderr.length !== response.result.stderr.length;
	return [
		`tool: ${response.result.tool}`,
		`exit_code: ${response.result.exit_code === null ? "null" : response.result.exit_code}`,
		`timed_out: ${response.result.timed_out}`,
		`truncated: ${response.result.truncated}`,
		`model_output_truncated: ${modelOutputTruncated}`,
		`duration_ms: ${response.result.duration_ms}`,
		"stdout:",
		stdout.length === 0 ? "<empty>" : stdout,
		"stderr:",
		stderr.length === 0 ? "<empty>" : stderr,
	].join("\n");
}

function toToolResult(response: RepoToolResponse) {
	return {
		content: [{ type: "text" as const, text: formatToolResult(response) }],
		details: response.result,
	};
}

export function toolCallOperationId(toolCallId: string): string {
	if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,154}$/.test(toolCallId)) {
		return `tool:${toolCallId}`;
	}
	return `tool:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

export function createRepoTools(leaseId: string, transport: RepoToolTransport): ToolDefinition[] {
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
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[3],
			label: "Edit repository file",
			description:
				"Create a new repository-relative UTF-8 source file with complete content, or atomically replace exactly one old_text occurrence in an existing source file. In this controlled evaluation, test paths and standalone test files are prohibited because a private test patch is applied later. Never send a fragment as content for an existing file.",
			promptSnippet: "Create a new file or make one exact, atomic text replacement",
			parameters: RepoEditInputSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal) =>
				toToolResult(
					assertExpectedTool(
						await transport.execute(
							{
								leaseId,
								operationId: toolCallOperationId(toolCallId),
								tool: "repo_edit",
								input: params,
							},
							signal,
						),
						"repo_edit",
					),
				),
		}),
		defineTool({
			name: REPO_TOOL_NAMES[4],
			label: "Execute repository command",
			description:
				"Execute a bounded non-shell command inside the leased repository worker. argv is required and must be a JSON string array, for example [\"node\", \"test/unit/adapters/http.js\"]; never pass a shell command string.",
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
				),
		}),
	];
}
