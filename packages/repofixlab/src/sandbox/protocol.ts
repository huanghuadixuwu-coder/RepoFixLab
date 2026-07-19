import type { Static } from "typebox";
import { Type } from "typebox";

const RelativePathSchema = Type.String({
	minLength: 1,
	maxLength: 4_096,
	pattern: String.raw`^(?:\.|(?!.*(?:^|/)\.{1,2}(?:/|$))[^/\\\u0000]+(?:/[^/\\\u0000]+)*)$`,
});

const FilePathSchema = Type.String({
	minLength: 1,
	maxLength: 4_096,
	pattern: String.raw`^(?!.*(?:^|/)\.{1,2}(?:/|$))[^/\\\u0000]+(?:/[^/\\\u0000]+)*$`,
});

export const REPO_TOOL_NAMES = [
	"repo_list",
	"repo_read",
	"repo_search",
	"repo_edit",
	"repo_exec",
	"repo_diff",
] as const;

export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

const RepoToolNameSchema = Type.Union([
	Type.Literal("repo_list"),
	Type.Literal("repo_read"),
	Type.Literal("repo_search"),
	Type.Literal("repo_edit"),
	Type.Literal("repo_exec"),
	Type.Literal("repo_diff"),
]);

export const RepoListInputSchema = Type.Object(
	{ path: Type.Optional(RelativePathSchema) },
	{ additionalProperties: false },
);

export const RepoReadInputSchema = Type.Object({ path: FilePathSchema }, { additionalProperties: false });

export const RepoSearchInputSchema = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 1_024 }),
		path: Type.Optional(RelativePathSchema),
	},
	{ additionalProperties: false },
);

export const RepoEditInputSchema = Type.Union([
	Type.Object(
		{
			path: FilePathSchema,
			content: Type.String({
				maxLength: 262_144,
				description: "Complete content for a new file only; existing files must use old_text and new_text.",
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: FilePathSchema,
			old_text: Type.String({
				minLength: 1,
				maxLength: 262_144,
				description: "Exact text that occurs once in the existing file.",
			}),
			new_text: Type.String({
				maxLength: 262_144,
				description: "Replacement text for old_text; it may be empty.",
			}),
		},
		{ additionalProperties: false },
	),
]);

export const RepoExecInputSchema = Type.Object(
	{
		argv: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
			minItems: 1,
			maxItems: 64,
		}),
		timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
	},
	{ additionalProperties: false },
);

export const RepoDiffInputSchema = Type.Object({}, { additionalProperties: false });

export const RepoToolResultSchema = Type.Object(
	{
		tool: RepoToolNameSchema,
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		stdout: Type.String({ maxLength: 65_536 }),
		stderr: Type.String({ maxLength: 65_536 }),
		truncated: Type.Boolean(),
		timed_out: Type.Boolean(),
		duration_ms: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export type RepoListInput = Static<typeof RepoListInputSchema>;
export type RepoReadInput = Static<typeof RepoReadInputSchema>;
export type RepoSearchInput = Static<typeof RepoSearchInputSchema>;
export type RepoEditInput = Static<typeof RepoEditInputSchema>;
export type RepoExecInput = Static<typeof RepoExecInputSchema>;
export type RepoDiffInput = Static<typeof RepoDiffInputSchema>;
export type RepoToolResult = Static<typeof RepoToolResultSchema>;

interface RepoToolRequestIdentity {
	leaseId: string;
	operationId: string;
}

export type RepoToolRequest =
	| (RepoToolRequestIdentity & { tool: "repo_list"; input: RepoListInput })
	| (RepoToolRequestIdentity & { tool: "repo_read"; input: RepoReadInput })
	| (RepoToolRequestIdentity & { tool: "repo_search"; input: RepoSearchInput })
	| (RepoToolRequestIdentity & { tool: "repo_edit"; input: RepoEditInput })
	| (RepoToolRequestIdentity & { tool: "repo_exec"; input: RepoExecInput })
	| (RepoToolRequestIdentity & { tool: "repo_diff"; input: RepoDiffInput });

export type RepoToolResponse = {
	tool: RepoToolName;
	result: RepoToolResult;
};

export const RepoToolHttpResponseSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		response_type: Type.Literal("runtime_tool_result"),
		status: Type.Literal("completed"),
		attempt_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$" }),
		operation_id: Type.String({
			pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
		}),
		request_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		lease_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$" }),
		tool: RepoToolNameSchema,
		input: Type.Union([
			RepoListInputSchema,
			RepoReadInputSchema,
			RepoSearchInputSchema,
			RepoEditInputSchema,
			RepoExecInputSchema,
			RepoDiffInputSchema,
		]),
		result: RepoToolResultSchema,
	},
	{ additionalProperties: false },
);

export type RepoToolHttpResponse = Static<typeof RepoToolHttpResponseSchema>;
