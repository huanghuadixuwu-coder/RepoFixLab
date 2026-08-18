/**
 * Repository tool protocol shared by the Orchestrator and Controller client.
 *
 * This module defines:
 * - The fixed names and strict input schemas for repository tools
 * - Pagination fields for bounded file reads and text searches
 * - Result and HTTP response schemas returned by the Controller
 * - TypeScript request and response types derived from those schemas
 *
 * These contracts reject unknown fields and unsafe repository-relative paths
 * before a request is sent across the trusted Controller boundary.
 */

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

/** Input contract for a bounded, line-oriented repository file read. */
export const RepoReadInputSchema = Type.Object(
	{
		path: FilePathSchema,
		start_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
		line_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
	},
	{ additionalProperties: false },
);

/** Input contract for a bounded repository search page. */
export const RepoSearchInputSchema = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 1_024 }),
		path: Type.Optional(RelativePathSchema),
		cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
		max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
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

/**
 * Provider-facing form of repo_edit. Some OpenAI-compatible providers reject a
 * top-level union in a function schema, so this remains an object while the
 * stricter RepoEditInputSchema is enforced before a Controller request.
 */
export const RepoEditToolWireSchema = Type.Object(
	{
		path: FilePathSchema,
		content: Type.Optional(
			Type.String({
				maxLength: 262_144,
				description: "Complete content for a new file only; existing files must use old_text and new_text.",
			}),
		),
		old_text: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 262_144,
				description: "Exact text that occurs once in the existing file.",
			}),
		),
		new_text: Type.Optional(
			Type.String({
				maxLength: 262_144,
				description: "Replacement text for old_text; it may be empty.",
			}),
		),
	},
	{ additionalProperties: false },
);

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

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const RepoLineSpanSchema = Type.Object(
	{
		start_line: Type.Integer({ minimum: 1 }),
		end_line_exclusive: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const RepoReadMetadataSchema = Type.Object(
	{
		path: FilePathSchema,
		returned_range: Type.Union([RepoLineSpanSchema, Type.Null()]),
		total_lines: Type.Integer({ minimum: 0 }),
		file_sha256: Sha256Schema,
		source_sha256: Sha256Schema,
		complete: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const RepoCreateMetadataSchema = Type.Object(
	{
		path: FilePathSchema,
		edit_kind: Type.Literal("create"),
		before_range: Type.Null(),
		before_total_lines: Type.Null(),
		before_file_sha256: Type.Null(),
		after_range: RepoLineSpanSchema,
		after_total_lines: Type.Integer({ minimum: 0 }),
		after_file_sha256: Sha256Schema,
		line_delta: Type.Null(),
	},
	{ additionalProperties: false },
);

const RepoReplaceMetadataSchema = Type.Object(
	{
		path: FilePathSchema,
		edit_kind: Type.Literal("replace"),
		before_range: RepoLineSpanSchema,
		before_total_lines: Type.Integer({ minimum: 1 }),
		before_file_sha256: Sha256Schema,
		after_range: RepoLineSpanSchema,
		after_total_lines: Type.Integer({ minimum: 0 }),
		after_file_sha256: Sha256Schema,
		line_delta: Type.Integer(),
	},
	{ additionalProperties: false },
);

export const RepoEditMetadataSchema = Type.Union([RepoCreateMetadataSchema, RepoReplaceMetadataSchema]);

const RepoToolResultCommon = {
	exit_code: Type.Union([Type.Integer(), Type.Null()]),
	stdout: Type.String({ maxLength: 65_536 }),
	stderr: Type.String({ maxLength: 65_536 }),
	truncated: Type.Boolean(),
	timed_out: Type.Boolean(),
	duration_ms: Type.Integer({ minimum: 0 }),
};

export const RepoToolResultSchema = Type.Union([
	Type.Object(
		{ tool: Type.Literal("repo_read"), ...RepoToolResultCommon, read_metadata: RepoReadMetadataSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ tool: Type.Literal("repo_edit"), ...RepoToolResultCommon, edit_metadata: RepoEditMetadataSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			tool: Type.Union([
				Type.Literal("repo_list"),
				Type.Literal("repo_search"),
				Type.Literal("repo_exec"),
				Type.Literal("repo_diff"),
			]),
			...RepoToolResultCommon,
		},
		{ additionalProperties: false },
	),
]);

export type RepoListInput = Static<typeof RepoListInputSchema>;
export type RepoReadInput = Static<typeof RepoReadInputSchema>;
export type RepoSearchInput = Static<typeof RepoSearchInputSchema>;
export type RepoEditInput = Static<typeof RepoEditInputSchema>;
export type RepoEditToolWireInput = Static<typeof RepoEditToolWireSchema>;
export type RepoExecInput = Static<typeof RepoExecInputSchema>;
export type RepoDiffInput = Static<typeof RepoDiffInputSchema>;
export type RepoLineSpan = Static<typeof RepoLineSpanSchema>;
export type RepoReadMetadata = Static<typeof RepoReadMetadataSchema>;
export type RepoEditMetadata = Static<typeof RepoEditMetadataSchema>;
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
		request_sha256: Sha256Schema,
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
