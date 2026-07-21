import { describe, expect, it } from "vitest";
import {
	MODEL_VISIBLE_STAGE_OUTPUT_LIMIT,
	MODEL_VISIBLE_TOOL_OUTPUT_LIMIT,
	RepoToolOutputBudget,
} from "../src/sandbox/repo-tools.ts";

describe("RepoFix repository-tool context budget", () => {
	it("caps one tool result at 12 KiB and all stage-visible results at 48 KiB", () => {
		const budget = new RepoToolOutputBudget();
		budget.startStage("LOCALIZE");
		expect(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT).toBe(12 * 1_024);
		expect(MODEL_VISIBLE_STAGE_OUTPUT_LIMIT).toBe(48 * 1_024);
		expect(budget.allocate(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT)).toBe(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT);
		expect(budget.allocate(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT)).toBe(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT);
		expect(budget.allocate(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT)).toBe(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT);
		expect(budget.allocate(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT)).toBe(MODEL_VISIBLE_TOOL_OUTPUT_LIMIT);
		expect(budget.allocate(1)).toBe(0);
		expect(budget.snapshot).toEqual({
			stage: "LOCALIZE",
			visible_chars: MODEL_VISIBLE_STAGE_OUTPUT_LIMIT,
			truncated_calls: 1,
		});
	});
});
