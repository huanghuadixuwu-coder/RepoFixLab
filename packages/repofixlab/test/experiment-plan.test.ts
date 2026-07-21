import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExperimentDryRunSummary, parseExperimentPlan } from "../src/contracts/experiment-plan.ts";

function config(name: string): string {
	return readFileSync(new URL(`../configs/experiments/${name}`, import.meta.url), "utf8");
}

describe("experiment plans", () => {
	it("calculates the executable M1 Axios single-run capacity", () => {
		const plan = parseExperimentPlan(config("m1-axios.yaml"));
		const summary = createExperimentDryRunSummary(plan);
		expect(summary).toMatchObject({
			experiment_id: "m1-axios",
			task_selection_status: "frozen",
			declared_task_count: 1,
			logical_run_count: 1,
			per_run_accounted_admission_cap_tokens: null,
			total_accounted_admission_cap_tokens: null,
			runtime_status: "m1_single_run_available",
			lifecycle_available: true,
		});
		expect(plan.task_selection).toEqual({
			status: "frozen",
			declared_task_count: 1,
			instance_ids: ["axios__axios-5892"],
		});
		expect(plan.matrix[0]?.config_ids).toEqual(["pi-general"]);
	});

	it("mechanically calculates the frozen 26-task, 74-run, 14.8M-token matrix", () => {
		const plan = parseExperimentPlan(config("v1.yaml"));
		const summary = createExperimentDryRunSummary(plan);
		expect(summary.logical_run_count).toBe(74);
		expect(summary.total_accounted_admission_cap_tokens).toBe(14_800_000);
		expect(summary.groups).toEqual([
			{
				group_id: "main",
				task_count: 17,
				config_ids: ["pi-general", "repofix-full"],
				replicates: 1,
				logical_run_count: 34,
			},
			{
				group_id: "ablation-no-localize",
				task_count: 8,
				config_ids: ["repofix-no-localize"],
				replicates: 1,
				logical_run_count: 8,
			},
			{
				group_id: "ablation-no-verify-feedback",
				task_count: 8,
				config_ids: ["repofix-no-verify-feedback"],
				replicates: 1,
				logical_run_count: 8,
			},
			{
				group_id: "stability-additional",
				task_count: 6,
				config_ids: ["pi-general", "repofix-full"],
				replicates: 2,
				logical_run_count: 24,
			},
		]);
		expect(plan.task_selection.status).toBe("frozen");
		expect(plan.task_selection.declared_task_count).toBe(26);
		expect(plan.task_selection.instance_ids).toHaveLength(26);
		expect(summary.runtime_status).toBe("lifecycle_unavailable");
		expect(summary.lifecycle_available).toBe(false);
	});

	it("rejects unknown fields, duplicate keys, and inconsistent budgets", () => {
		const m1 = config("m1-axios.yaml");
		expect(() => parseExperimentPlan(`${m1}unknown_field: true\n`)).toThrow(/strict v1 schema/);
		expect(() => parseExperimentPlan(`${m1}schema_version: v1\n`)).toThrow(/YAML is invalid/);
		expect(() =>
			parseExperimentPlan(
				m1.replace("total_accounted_admission_cap_tokens: null", "total_accounted_admission_cap_tokens: 1"),
			),
		).toThrow(/fully bounded or fully unbounded/);
	});
});
