import { describe, expect, it } from "vitest";
import type { RunManifest, RunResult } from "../src/contracts/run-contracts.ts";
import { createStaticRunReport } from "../src/report/static-report.ts";
import type { StoredArtifact } from "../src/storage/artifact-store.ts";

const SHA = "a".repeat(64);

function manifest(): RunManifest {
	return {
		schema_version: "v1",
		manifest_type: "run_manifest",
		manifest_id: "manifest-run-1",
		experiment_id: "m1-axios",
		run_id: "run-1",
		config_id: "pi-general",
		instance_id: "axios__axios-5892",
		replicate: 1,
		public_task_manifest_id: "public-task-1",
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
			max_wall_time_ms: 3_600_000,
		},
		created_at: "2026-07-19T00:00:00.000Z",
		manifest_sha256: SHA,
	};
}

function terminal(): Pick<RunResult, "terminal_status" | "termination_reason" | "resolved" | "wall_time_ms" | "usage"> {
	return {
		terminal_status: "completed",
		termination_reason: "official_unresolved",
		resolved: false,
		wall_time_ms: 62_345,
		usage: {
			accounted_tokens: 12_345,
			provider_actual_tokens: 12_000,
			usage_complete: true,
			cost_complete: true,
			estimated_cost_cny_nano: 9_876_543,
			model_turns: 7,
			tool_calls: 11,
		},
	};
}

describe("static run report", () => {
	it("renders a self-contained, accessible evidence dashboard with complete audit values", () => {
		const artifact: StoredArtifact = {
			path: "evaluator/evaluation.json",
			bytes: 12_345,
			sha256: "b".repeat(64),
			mediaType: "application/json",
			sensitivity: "private",
			generatedBy: "evaluator",
		};
		const html = createStaticRunReport(manifest(), terminal(), [artifact]);
		expect(html).toContain("M1 single-task boundary");
		expect(html).toContain("NOT RESOLVED");
		expect(html).toContain("1m 2.3s");
		expect(html).toContain("12,345");
		expect(html).toContain("¥0.009876543");
		expect(html).toContain("accounted_admission_cap_tokens");
		expect(html).toContain("pricing_spec_sha256");
		expect(html).toContain("evaluator/evaluation.json");
		expect(html).toContain("b".repeat(64));
		expect(html).toContain("private");
		expect(html).toContain("evaluator");
		expect(html).toContain("<caption>Indexed evidence artifacts</caption>");
		expect(html).toContain('href="#main-content"');
		expect(html).toContain("@media print");
		expect(html).not.toMatch(/<script\b/i);
		expect(html).not.toMatch(/<link\b/i);
	});

	it("escapes hostile dynamic values without truncating their visible text", () => {
		const hostilePath = '</code><img src=x onerror="alert(1)">\'&';
		const hostileArtifact: StoredArtifact = {
			path: hostilePath,
			bytes: 1,
			sha256: "c".repeat(64),
			mediaType: "text/plain",
			sensitivity: "internal",
			generatedBy: "agent",
		};
		const html = createStaticRunReport({ ...manifest(), run_id: '<svg onload="alert(2)">' }, terminal(), [
			hostileArtifact,
		]);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<svg");
		expect(html).toContain("&lt;/code&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;");
		expect(html).toContain("c".repeat(64));
	});

	it("labels an uncapped functional validation as non-comparable", () => {
		const html = createStaticRunReport(
			{
				...manifest(),
				budget: { ...manifest().budget, accounted_admission_cap_tokens: null },
			},
			terminal(),
			[],
		);
		expect(html).toContain("unbounded functional validation");
		expect(html).toContain("not evidence for a fair budget comparison");
	});
});
