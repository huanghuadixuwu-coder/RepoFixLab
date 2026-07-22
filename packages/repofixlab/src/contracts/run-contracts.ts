import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { stableStringify } from "./canonical-json.ts";

const SHA256_PATTERN = "^[a-f0-9]{64}$";
const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$";
const RELATIVE_PATH_PATTERN = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$";
const GIT_SHA1_PATTERN = "^[a-f0-9]{40}$";
const UTC_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T.*Z$";

const Sha256Schema = Type.String({ pattern: SHA256_PATTERN });
const IdentifierSchema = Type.String({ pattern: IDENTIFIER_PATTERN });
const RelativePathSchema = Type.String({ pattern: RELATIVE_PATH_PATTERN });
const TimestampSchema = Type.String({ pattern: UTC_TIMESTAMP_PATTERN, minLength: 20, maxLength: 64 });
const NullableSha256Schema = Type.Union([Sha256Schema, Type.Null()]);
const NullableIdentifierSchema = Type.Union([IdentifierSchema, Type.Null()]);
const NullableTimestampSchema = Type.Union([TimestampSchema, Type.Null()]);

export const RUN_CONFIG_IDS = [
	"pi-general",
	"repofix-full",
	"repofix-no-localize",
	"repofix-no-verify-feedback",
] as const;

const RunConfigIdSchema = Type.Union([
	Type.Literal("pi-general"),
	Type.Literal("repofix-full"),
	Type.Literal("repofix-no-localize"),
	Type.Literal("repofix-no-verify-feedback"),
]);

const RunBudgetSchema = Type.Object(
	{
		accounted_admission_cap_tokens: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		max_model_turns: Type.Integer({ minimum: 1 }),
		max_tool_calls: Type.Integer({ minimum: 1 }),
		max_wall_time_ms: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const FrozenModelSchema = Type.Union([
	Type.Object(
		{
			provider: Type.Literal("zhipu-standard"),
			model_id: Type.Literal("glm-4.5-air"),
			model_spec_sha256: Sha256Schema,
			pricing_spec_sha256: Sha256Schema,
			system_prompt_sha256: Sha256Schema,
			tool_schema_sha256: Sha256Schema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			provider: Type.Literal("deepseek"),
			model_id: Type.Literal("deepseek-v4-flash"),
			model_spec_sha256: Sha256Schema,
			pricing_spec_sha256: Sha256Schema,
			system_prompt_sha256: Sha256Schema,
			tool_schema_sha256: Sha256Schema,
		},
		{ additionalProperties: false },
	),
]);

export const RunManifestSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		manifest_type: Type.Literal("run_manifest"),
		manifest_id: IdentifierSchema,
		experiment_id: IdentifierSchema,
		run_id: IdentifierSchema,
		config_id: RunConfigIdSchema,
		instance_id: Type.String({ minLength: 1, maxLength: 200 }),
		replicate: Type.Integer({ minimum: 1 }),
		public_task_manifest_id: IdentifierSchema,
		public_task_manifest_sha256: Sha256Schema,
		task_environment_lock_id: IdentifierSchema,
		task_environment_lock_sha256: Sha256Schema,
		model: FrozenModelSchema,
		budget: RunBudgetSchema,
		created_at: TimestampSchema,
		manifest_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:run-manifest",
		additionalProperties: false,
	},
);

const AttemptStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("preparing"),
	Type.Literal("running"),
	Type.Literal("evaluating"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("aborted"),
]);

const AttemptTerminationReasonSchema = Type.Union([
	Type.Literal("agent_completed"),
	Type.Literal("model_error"),
	Type.Literal("tool_error"),
	Type.Literal("budget_exhausted"),
	Type.Literal("wall_time_exceeded"),
	Type.Literal("policy_violation"),
	Type.Literal("infrastructure_error"),
	Type.Literal("evaluation_error"),
	Type.Literal("user_abort"),
]);

export const AttemptSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		record_type: Type.Literal("attempt"),
		attempt_id: IdentifierSchema,
		run_id: IdentifierSchema,
		attempt_number: Type.Integer({ minimum: 1 }),
		status: AttemptStatusSchema,
		started_at: NullableTimestampSchema,
		finished_at: NullableTimestampSchema,
		worker_lease_id: NullableIdentifierSchema,
		evaluator_job_id: NullableIdentifierSchema,
		termination_reason: Type.Union([AttemptTerminationReasonSchema, Type.Null()]),
		accounted_tokens: Type.Integer({ minimum: 0 }),
		provider_actual_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		usage_complete: Type.Boolean(),
		attempt_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:attempt",
		additionalProperties: false,
	},
);

const RunStageSchema = Type.Union([
	Type.Literal("orchestrator"),
	Type.Literal("agent"),
	Type.Literal("snapshot"),
	Type.Literal("cleanup"),
	Type.Literal("official_evaluate"),
	Type.Literal("report"),
]);

const RunEventTypeSchema = Type.Union([
	Type.Literal("manifest_loaded"),
	Type.Literal("attempt_started"),
	Type.Literal("worker_prepared"),
	Type.Literal("tool_started"),
	Type.Literal("tool_finished"),
	Type.Literal("agent_finished"),
	Type.Literal("patch_snapshotted"),
	Type.Literal("worker_destroyed"),
	Type.Literal("evaluation_started"),
	Type.Literal("evaluation_finished"),
	Type.Literal("artifact_published"),
	Type.Literal("run_finished"),
	Type.Literal("failure"),
]);

export const RunEventSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		record_type: Type.Literal("run_event"),
		run_id: IdentifierSchema,
		attempt_id: IdentifierSchema,
		sequence: Type.Integer({ minimum: 0 }),
		at: TimestampSchema,
		stage: RunStageSchema,
		event_type: RunEventTypeSchema,
		status: Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("error")]),
		operation_id: NullableIdentifierSchema,
		subject: Type.String({ minLength: 1, maxLength: 200 }),
		message: Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()]),
		parameters_sha256: NullableSha256Schema,
		result_sha256: NullableSha256Schema,
		artifact_sha256: NullableSha256Schema,
		previous_record_sha256: NullableSha256Schema,
		event_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:run-event",
		additionalProperties: false,
	},
);

const GitTreeSchema = Type.Object(
	{
		algorithm: Type.Literal("git-sha1"),
		value: Type.String({ pattern: GIT_SHA1_PATTERN }),
	},
	{ additionalProperties: false },
);

const PatchFileSchema = Type.Object(
	{
		path: RelativePathSchema,
		status: Type.Union([
			Type.Literal("added"),
			Type.Literal("modified"),
			Type.Literal("deleted"),
			Type.Literal("renamed"),
		]),
	},
	{ additionalProperties: false },
);

export const PatchSnapshotSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		snapshot_type: Type.Literal("patch"),
		snapshot_id: IdentifierSchema,
		run_id: IdentifierSchema,
		attempt_id: IdentifierSchema,
		label: Type.Union([Type.Literal("candidate"), Type.Literal("P0"), Type.Literal("P1")]),
		base_commit: Type.String({ pattern: GIT_SHA1_PATTERN }),
		base_tree: GitTreeSchema,
		candidate_tree: GitTreeSchema,
		patch_sha256: Sha256Schema,
		patch_bytes: Type.Integer({ minimum: 0, maximum: 2_097_152 }),
		files: Type.Array(PatchFileSchema, { maxItems: 1_000 }),
		policy: Type.Object(
			{
				status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
				violations: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 }),
			},
			{ additionalProperties: false },
		),
		created_at: TimestampSchema,
		snapshot_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:patch-snapshot",
		additionalProperties: false,
	},
);

const TestPartitionSchema = Type.Object(
	{
		success: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 10_000 }),
		failure: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 10_000 }),
	},
	{ additionalProperties: false },
);

const ArtifactReferenceSchema = Type.Object(
	{
		path: RelativePathSchema,
		bytes: Type.Integer({ minimum: 0 }),
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);

export const EvaluationResultSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		result_type: Type.Literal("evaluation"),
		evaluation_id: IdentifierSchema,
		job_id: IdentifierSchema,
		run_id: IdentifierSchema,
		attempt_id: IdentifierSchema,
		instance_id: Type.String({ minLength: 1, maxLength: 200 }),
		harness_mode: Type.Literal("adapted"),
		harness_revision: Type.String({ pattern: GIT_SHA1_PATTERN }),
		status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
		resolved: Type.Boolean(),
		candidate_patch_sha256: Sha256Schema,
		candidate_patch_apply_status: Type.Union([
			Type.Literal("applied"),
			Type.Literal("rejected"),
			Type.Literal("error"),
		]),
		test_patch_apply_status: Type.Union([
			Type.Literal("applied"),
			Type.Literal("rejected"),
			Type.Literal("error"),
			Type.Literal("not_run"),
		]),
		test_executed: Type.Boolean(),
		test_collected: Type.Boolean(),
		fail_to_pass: TestPartitionSchema,
		pass_to_pass: TestPartitionSchema,
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		timed_out: Type.Boolean(),
		duration_ms: Type.Integer({ minimum: 0 }),
		test_log: Type.Union([ArtifactReferenceSchema, Type.Null()]),
		official_report_sha256: Type.Union([Sha256Schema, Type.Null()]),
		error_class: Type.Union([Type.String({ pattern: "^[a-z][a-z0-9_]{0,99}$" }), Type.Null()]),
		finished_at: TimestampSchema,
		evaluation_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:evaluation-result",
		additionalProperties: false,
	},
);

const ArtifactEntrySchema = Type.Object(
	{
		name: Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,99}$" }),
		path: RelativePathSchema,
		media_type: Type.String({ pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$" }),
		bytes: Type.Integer({ minimum: 0 }),
		sha256: Sha256Schema,
		sensitivity: Type.Union([Type.Literal("public"), Type.Literal("internal"), Type.Literal("private")]),
		generated_by: Type.Union([
			Type.Literal("orchestrator"),
			Type.Literal("agent"),
			Type.Literal("controller"),
			Type.Literal("evaluator"),
		]),
	},
	{ additionalProperties: false },
);

export const ArtifactIndexSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		index_type: Type.Literal("artifact_index"),
		run_id: IdentifierSchema,
		attempt_id: IdentifierSchema,
		artifacts: Type.Array(ArtifactEntrySchema, { minItems: 1, maxItems: 10_000 }),
		created_at: TimestampSchema,
		index_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:artifact-index",
		additionalProperties: false,
	},
);

const RunTerminationReasonSchema = Type.Union([
	Type.Literal("official_resolved"),
	Type.Literal("official_unresolved"),
	Type.Literal("no_patch"),
	Type.Literal("model_error"),
	Type.Literal("tool_error"),
	Type.Literal("budget_exhausted"),
	Type.Literal("wall_time_exceeded"),
	Type.Literal("policy_violation"),
	Type.Literal("infrastructure_error"),
	Type.Literal("evaluation_error"),
	Type.Literal("user_abort"),
]);

export const RunResultSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		result_type: Type.Literal("run"),
		run_id: IdentifierSchema,
		attempt_id: IdentifierSchema,
		manifest_sha256: Sha256Schema,
		terminal_status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")]),
		termination_reason: RunTerminationReasonSchema,
		resolved: Type.Boolean(),
		started_at: TimestampSchema,
		finished_at: TimestampSchema,
		wall_time_ms: Type.Integer({ minimum: 0 }),
		usage: Type.Object(
			{
				accounted_tokens: Type.Integer({ minimum: 0 }),
				provider_actual_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
				usage_complete: Type.Boolean(),
				cost_complete: Type.Boolean(),
				estimated_cost_cny_nano: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
				model_turns: Type.Integer({ minimum: 0 }),
				tool_calls: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		attempt_sha256: Sha256Schema,
		patch_snapshot_sha256: NullableSha256Schema,
		evaluation_result_sha256: NullableSha256Schema,
		artifact_index_sha256: Sha256Schema,
		failure: Type.Union([
			Type.Object(
				{
					stage: RunStageSchema,
					message: Type.String({ minLength: 1, maxLength: 2_000 }),
				},
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
		result_sha256: Sha256Schema,
	},
	{
		$id: "urn:repofixlab:schema:v1:run-result",
		additionalProperties: false,
	},
);

export type RunManifest = Static<typeof RunManifestSchema>;
export type Attempt = Static<typeof AttemptSchema>;
export type RunEvent = Static<typeof RunEventSchema>;
export type PatchSnapshot = Static<typeof PatchSnapshotSchema>;
export type EvaluationResult = Static<typeof EvaluationResultSchema>;
export type ArtifactIndex = Static<typeof ArtifactIndexSchema>;
export type RunResult = Static<typeof RunResultSchema>;

const runManifestValidator = Compile(RunManifestSchema);
const attemptValidator = Compile(AttemptSchema);
const runEventValidator = Compile(RunEventSchema);
const patchSnapshotValidator = Compile(PatchSnapshotSchema);
const evaluationResultValidator = Compile(EvaluationResultSchema);
const artifactIndexValidator = Compile(ArtifactIndexSchema);
const runResultValidator = Compile(RunResultSchema);

export function canonicalContractSha256(value: unknown): string {
	const normalized: unknown = JSON.parse(stableStringify(value));
	return createHash("sha256")
		.update(`${JSON.stringify(normalized)}\n`)
		.digest("hex");
}

function validTimestamp(value: string): boolean {
	return value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

export function createRunManifest(input: Omit<RunManifest, "manifest_sha256">): RunManifest {
	return verifyRunManifest({ ...input, manifest_sha256: canonicalContractSha256(input) });
}

export function verifyRunManifest(value: unknown): RunManifest {
	if (!runManifestValidator.Check(value)) throw new Error("Run manifest does not satisfy the strict v1 schema");
	const { manifest_sha256: actual, ...unsigned } = value;
	if (!validTimestamp(value.created_at) || actual !== canonicalContractSha256(unsigned)) {
		throw new Error("Run manifest canonical SHA-256 or timestamp is invalid");
	}
	return value;
}

export function createAttempt(input: Omit<Attempt, "attempt_sha256">): Attempt {
	return verifyAttempt({ ...input, attempt_sha256: canonicalContractSha256(input) });
}

export function verifyAttempt(value: unknown): Attempt {
	if (!attemptValidator.Check(value)) throw new Error("Attempt does not satisfy the strict v1 schema");
	const { attempt_sha256: actual, ...unsigned } = value;
	if (actual !== canonicalContractSha256(unsigned)) throw new Error("Attempt canonical SHA-256 is invalid");
	const terminal = value.status === "completed" || value.status === "failed" || value.status === "aborted";
	if (
		(value.started_at !== null && !validTimestamp(value.started_at)) ||
		(value.finished_at !== null && !validTimestamp(value.finished_at)) ||
		terminal !== (value.finished_at !== null && value.termination_reason !== null) ||
		(!terminal && (value.finished_at !== null || value.termination_reason !== null)) ||
		(value.provider_actual_tokens !== null && value.accounted_tokens < value.provider_actual_tokens)
	) {
		throw new Error("Attempt lifecycle, usage, or timestamp semantics are invalid");
	}
	return value;
}

export function createRunEvent(input: Omit<RunEvent, "event_sha256">): RunEvent {
	return verifyRunEvent({ ...input, event_sha256: canonicalContractSha256(input) });
}

export function verifyRunEvent(value: unknown): RunEvent {
	if (!runEventValidator.Check(value)) throw new Error("Run event does not satisfy the strict v1 schema");
	const { event_sha256: actual, ...unsigned } = value;
	if (!validTimestamp(value.at) || actual !== canonicalContractSha256(unsigned)) {
		throw new Error("Run event canonical SHA-256 or timestamp is invalid");
	}
	return value;
}

export function verifyRunEventChain(values: readonly unknown[]): RunEvent[] {
	const events = values.map(verifyRunEvent);
	if (events.length === 0) throw new Error("Run event chain must contain sequence 0");
	for (const [index, event] of events.entries()) {
		const previous = index === 0 ? undefined : events[index - 1];
		if (
			event.sequence !== index ||
			event.previous_record_sha256 !== (previous?.event_sha256 ?? null) ||
			(previous !== undefined && (event.run_id !== previous.run_id || event.attempt_id !== previous.attempt_id))
		) {
			throw new Error("Run events are not a monotonic, single-attempt hash chain");
		}
	}
	return events;
}

export function createPatchSnapshot(input: Omit<PatchSnapshot, "snapshot_sha256">): PatchSnapshot {
	return verifyPatchSnapshot({ ...input, snapshot_sha256: canonicalContractSha256(input) });
}

export function verifyPatchSnapshot(value: unknown): PatchSnapshot {
	if (!patchSnapshotValidator.Check(value)) throw new Error("Patch snapshot does not satisfy the strict v1 schema");
	const { snapshot_sha256: actual, ...unsigned } = value;
	const paths = value.files.map((file) => file.path);
	if (
		!validTimestamp(value.created_at) ||
		actual !== canonicalContractSha256(unsigned) ||
		new Set(paths).size !== paths.length ||
		(value.policy.status === "pass") !== (value.policy.violations.length === 0)
	) {
		throw new Error("Patch snapshot hash, files, policy, or timestamp semantics are invalid");
	}
	return value;
}

export function createEvaluationResult(input: Omit<EvaluationResult, "evaluation_sha256">): EvaluationResult {
	return verifyEvaluationResult({ ...input, evaluation_sha256: canonicalContractSha256(input) });
}

export function verifyEvaluationResult(value: unknown): EvaluationResult {
	if (!evaluationResultValidator.Check(value)) {
		throw new Error("Evaluation result does not satisfy the strict v1 schema");
	}
	const { evaluation_sha256: actual, ...unsigned } = value;
	const resolvedSemantics =
		value.status === "completed" &&
		value.candidate_patch_apply_status === "applied" &&
		value.test_patch_apply_status === "applied" &&
		value.test_executed &&
		value.test_collected &&
		!value.timed_out &&
		value.exit_code === 0 &&
		value.fail_to_pass.failure.length === 0 &&
		value.pass_to_pass.failure.length === 0 &&
		value.error_class === null;
	if (
		!validTimestamp(value.finished_at) ||
		actual !== canonicalContractSha256(unsigned) ||
		(value.resolved && !resolvedSemantics)
	) {
		throw new Error("Evaluation result hash, resolution, or timestamp semantics are invalid");
	}
	return value;
}

export function createArtifactIndex(input: Omit<ArtifactIndex, "index_sha256">): ArtifactIndex {
	return verifyArtifactIndex({ ...input, index_sha256: canonicalContractSha256(input) });
}

export function verifyArtifactIndex(value: unknown): ArtifactIndex {
	if (!artifactIndexValidator.Check(value)) throw new Error("Artifact index does not satisfy the strict v1 schema");
	const { index_sha256: actual, ...unsigned } = value;
	const names = value.artifacts.map((artifact) => artifact.name);
	const paths = value.artifacts.map((artifact) => artifact.path);
	if (
		!validTimestamp(value.created_at) ||
		actual !== canonicalContractSha256(unsigned) ||
		new Set(names).size !== names.length ||
		new Set(paths).size !== paths.length
	) {
		throw new Error("Artifact index hash, identity, or timestamp semantics are invalid");
	}
	return value;
}

export function createRunResult(input: Omit<RunResult, "result_sha256">): RunResult {
	return verifyRunResult({ ...input, result_sha256: canonicalContractSha256(input) });
}

export function verifyRunResult(value: unknown): RunResult {
	if (!runResultValidator.Check(value)) throw new Error("Run result does not satisfy the strict v1 schema");
	const { result_sha256: actual, ...unsigned } = value;
	const completed = value.terminal_status === "completed";
	const officialReason =
		value.termination_reason === "official_resolved" || value.termination_reason === "official_unresolved";
	if (
		!validTimestamp(value.started_at) ||
		!validTimestamp(value.finished_at) ||
		actual !== canonicalContractSha256(unsigned) ||
		completed !== officialReason ||
		completed !== (value.failure === null) ||
		(completed && value.evaluation_result_sha256 === null) ||
		value.resolved !== (value.termination_reason === "official_resolved") ||
		value.usage.cost_complete !== (value.usage.estimated_cost_cny_nano !== null) ||
		(!value.usage.usage_complete && value.usage.cost_complete) ||
		(value.usage.provider_actual_tokens !== null && value.usage.accounted_tokens < value.usage.provider_actual_tokens)
	) {
		throw new Error("Run result hash, terminal state, usage, or timestamp semantics are invalid");
	}
	return value;
}
