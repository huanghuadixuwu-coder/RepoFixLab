import { describe, expect, it } from "vitest";
import {
	createArtifactIndex,
	createAttempt,
	createEvaluationResult,
	createPatchSnapshot,
	createRunEvent,
	createRunManifest,
	createRunResult,
	verifyArtifactIndex,
	verifyAttempt,
	verifyEvaluationResult,
	verifyPatchSnapshot,
	verifyRunEvent,
	verifyRunEventChain,
	verifyRunManifest,
	verifyRunResult,
} from "../src/contracts/run-contracts.ts";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const GIT_SHA = "c".repeat(40);
const AT = "2026-07-19T00:00:00.000Z";

function fixtures() {
	const manifest = createRunManifest({
		schema_version: "v1",
		manifest_type: "run_manifest",
		manifest_id: "manifest-1",
		experiment_id: "m1-axios",
		run_id: "run-1",
		config_id: "repofix-full",
		instance_id: "axios__axios-5892",
		replicate: 1,
		public_task_manifest_id: "task-manifest-1",
		public_task_manifest_sha256: SHA,
		task_environment_lock_id: "environment-lock-1",
		task_environment_lock_sha256: SHA,
		model: {
			provider: "zhipu-standard",
			model_id: "glm-4.5-air",
			model_spec_sha256: SHA,
			pricing_spec_sha256: SHA,
			system_prompt_sha256: SHA,
			tool_schema_sha256: SHA,
		},
		budget: {
			accounted_admission_cap_tokens: 200_000,
			max_model_turns: 100,
			max_tool_calls: 500,
			max_wall_time_ms: 1_800_000,
		},
		created_at: AT,
	});
	const attempt = createAttempt({
		schema_version: "v1",
		record_type: "attempt",
		attempt_id: "attempt-1",
		run_id: "run-1",
		attempt_number: 1,
		status: "completed",
		started_at: AT,
		finished_at: "2026-07-19T00:01:00.000Z",
		worker_lease_id: "lease-1",
		evaluator_job_id: "evaluation-job-1",
		termination_reason: "agent_completed",
		accounted_tokens: 1_000,
		provider_actual_tokens: 900,
		usage_complete: true,
	});
	const patch = createPatchSnapshot({
		schema_version: "v1",
		snapshot_type: "patch",
		snapshot_id: "snapshot-1",
		run_id: "run-1",
		attempt_id: "attempt-1",
		label: "P1",
		base_commit: GIT_SHA,
		base_tree: { algorithm: "git-sha1", value: GIT_SHA },
		candidate_tree: { algorithm: "git-sha1", value: GIT_SHA },
		patch_sha256: SHA,
		patch_bytes: 42,
		files: [{ path: "lib/fix.js", status: "modified" }],
		policy: { status: "pass", violations: [] },
		created_at: AT,
	});
	const evaluation = createEvaluationResult({
		schema_version: "v1",
		result_type: "evaluation",
		evaluation_id: "evaluation-1",
		job_id: "evaluation-job-1",
		run_id: "run-1",
		attempt_id: "attempt-1",
		instance_id: "axios__axios-5892",
		harness_mode: "adapted",
		harness_revision: GIT_SHA,
		status: "completed",
		resolved: true,
		candidate_patch_sha256: patch.patch_sha256,
		candidate_patch_apply_status: "applied",
		test_patch_apply_status: "applied",
		test_executed: true,
		test_collected: true,
		fail_to_pass: { success: ["regression"], failure: [] },
		pass_to_pass: { success: ["existing"], failure: [] },
		exit_code: 0,
		timed_out: false,
		duration_ms: 1_000,
		test_log: { path: "runs/run-1/evaluation.log", bytes: 10, sha256: SHA },
		official_report_sha256: SHA,
		error_class: null,
		finished_at: "2026-07-19T00:02:00.000Z",
	});
	const artifacts = createArtifactIndex({
		schema_version: "v1",
		index_type: "artifact_index",
		run_id: "run-1",
		attempt_id: "attempt-1",
		artifacts: [
			{
				name: "evaluation",
				path: "runs/run-1/evaluation.json",
				media_type: "application/json",
				bytes: 100,
				sha256: evaluation.evaluation_sha256,
				sensitivity: "internal",
				generated_by: "evaluator",
			},
		],
		created_at: "2026-07-19T00:03:00.000Z",
	});
	const result = createRunResult({
		schema_version: "v1",
		result_type: "run",
		run_id: "run-1",
		attempt_id: "attempt-1",
		manifest_sha256: manifest.manifest_sha256,
		terminal_status: "completed",
		termination_reason: "official_resolved",
		resolved: true,
		started_at: AT,
		finished_at: "2026-07-19T00:03:00.000Z",
		wall_time_ms: 180_000,
		usage: {
			accounted_tokens: 1_000,
			provider_actual_tokens: 900,
			usage_complete: true,
			cost_complete: true,
			estimated_cost_cny_nano: 1_234_000,
			model_turns: 4,
			tool_calls: 10,
		},
		attempt_sha256: attempt.attempt_sha256,
		patch_snapshot_sha256: patch.snapshot_sha256,
		evaluation_result_sha256: evaluation.evaluation_sha256,
		artifact_index_sha256: artifacts.index_sha256,
		failure: null,
	});
	return { manifest, attempt, patch, evaluation, artifacts, result };
}

describe("strict v1 run contracts", () => {
	it("creates and verifies all terminal records", () => {
		const values = fixtures();
		expect(verifyRunManifest(values.manifest)).toBe(values.manifest);
		expect(verifyAttempt(values.attempt)).toBe(values.attempt);
		expect(verifyPatchSnapshot(values.patch)).toBe(values.patch);
		expect(verifyEvaluationResult(values.evaluation)).toBe(values.evaluation);
		expect(verifyArtifactIndex(values.artifacts)).toBe(values.artifacts);
		expect(verifyRunResult(values.result)).toBe(values.result);
	});

	it("rejects unknown fields on every record", () => {
		const values = fixtures();
		expect(() => verifyRunManifest({ ...values.manifest, extra: true })).toThrow(/strict v1 schema/);
		expect(() => verifyAttempt({ ...values.attempt, extra: true })).toThrow(/strict v1 schema/);
		expect(() => verifyPatchSnapshot({ ...values.patch, extra: true })).toThrow(/strict v1 schema/);
		expect(() => verifyEvaluationResult({ ...values.evaluation, extra: true })).toThrow(/strict v1 schema/);
		expect(() => verifyArtifactIndex({ ...values.artifacts, extra: true })).toThrow(/strict v1 schema/);
		expect(() => verifyRunResult({ ...values.result, extra: true })).toThrow(/strict v1 schema/);
	});

	it("rejects canonical hash tampering", () => {
		const { manifest } = fixtures();
		expect(() => verifyRunManifest({ ...manifest, instance_id: "tampered" })).toThrow(/canonical SHA-256/);
	});

	it("retains verified evaluation evidence when a later platform step fails", () => {
		const { result } = fixtures();
		const { result_sha256: _resultSha256, ...unsigned } = result;
		const failedResult = createRunResult({
			...unsigned,
			terminal_status: "failed",
			termination_reason: "infrastructure_error",
			resolved: false,
			failure: { stage: "cleanup", message: "Evaluator ACK failed" },
		});
		expect(failedResult.evaluation_result_sha256).toBe(result.evaluation_result_sha256);
		expect(verifyRunResult(failedResult)).toBe(failedResult);
	});

	it("requires every completed run to bind a verified evaluation", () => {
		const { result } = fixtures();
		const { result_sha256: _resultSha256, ...unsigned } = result;
		expect(() => createRunResult({ ...unsigned, evaluation_result_sha256: null })).toThrow(/terminal state/);
	});

	it("rejects a claimed cost when provider usage is incomplete", () => {
		const { result } = fixtures();
		const { result_sha256: _resultSha256, ...unsigned } = result;
		expect(() =>
			createRunResult({
				...unsigned,
				usage: { ...unsigned.usage, usage_complete: false },
			}),
		).toThrow(/usage/);
	});
});

describe("run event chain", () => {
	function event(sequence: number, previousRecordSha256: string | null) {
		return createRunEvent({
			schema_version: "v1",
			record_type: "run_event",
			run_id: "run-1",
			attempt_id: "attempt-1",
			sequence,
			at: AT,
			stage: "orchestrator",
			event_type: sequence === 0 ? "manifest_loaded" : "attempt_started",
			status: "info",
			operation_id: null,
			subject: "run-1",
			message: null,
			parameters_sha256: null,
			result_sha256: null,
			artifact_sha256: null,
			previous_record_sha256: previousRecordSha256,
		});
	}

	it("accepts a monotonic hash-linked chain", () => {
		const first = event(0, null);
		const second = event(1, first.event_sha256);
		expect(verifyRunEvent(first)).toBe(first);
		expect(verifyRunEventChain([first, second])).toEqual([first, second]);
	});

	it("rejects jumps, duplicate sequence numbers, and previous-hash drift", () => {
		const first = event(0, null);
		expect(() => verifyRunEventChain([first, event(2, first.event_sha256)])).toThrow(/monotonic/);
		expect(() => verifyRunEventChain([first, event(0, first.event_sha256)])).toThrow(/monotonic/);
		expect(() => verifyRunEventChain([first, event(1, OTHER_SHA)])).toThrow(/hash chain/);
	});

	it("rejects unknown event fields", () => {
		expect(() => verifyRunEvent({ ...event(0, null), extra: true })).toThrow(/strict v1 schema/);
	});
});
