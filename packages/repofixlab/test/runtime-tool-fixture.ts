/** Successful single-file responses for faux Controller transports. */
import { createHash } from "node:crypto";
import type { RepoToolRequest, RepoToolResponse } from "../src/sandbox/protocol.ts";

export function successfulToolResult(
	request: RepoToolRequest,
	stdout = "ok",
	exitCode = 0,
	durationMs = 1,
): RepoToolResponse["result"] {
	const common = {
		exit_code: exitCode,
		stdout,
		stderr: "",
		truncated: false,
		timed_out: false,
		duration_ms: durationMs,
	};
	if (request.tool === "repo_read") {
		const lines = stdout.length ? stdout.split("\n").length : 0;
		const sha256 = createHash("sha256").update(stdout).digest("hex");
		return {
			...common,
			tool: "repo_read",
			read_metadata: {
				path: request.input.path,
				returned_range: lines ? { start_line: 1, end_line_exclusive: lines + 1 } : null,
				total_lines: lines,
				file_sha256: sha256,
				source_sha256: sha256,
				complete: true,
			},
		};
	}
	if (request.tool === "repo_edit") {
		const content = "content" in request.input ? request.input.content : request.input.new_text;
		const lines = content.length ? content.split("\n").length : 0;
		const after = {
			path: request.input.path,
			after_range: { start_line: 1, end_line_exclusive: lines + 1 },
			after_total_lines: lines,
			after_file_sha256: createHash("sha256").update(content).digest("hex"),
		};
		const editMetadata =
			"content" in request.input
				? {
						...after,
						edit_kind: "create" as const,
						before_range: null,
						before_total_lines: null,
						before_file_sha256: null,
						line_delta: null,
					}
				: {
						...after,
						edit_kind: "replace" as const,
						before_range: { start_line: 1, end_line_exclusive: request.input.old_text.split("\n").length + 1 },
						before_total_lines: request.input.old_text.split("\n").length,
						before_file_sha256: createHash("sha256").update(request.input.old_text).digest("hex"),
						line_delta: lines - request.input.old_text.split("\n").length,
					};
		return { ...common, tool: "repo_edit", edit_metadata: editMetadata };
	}
	return { ...common, tool: request.tool };
}
