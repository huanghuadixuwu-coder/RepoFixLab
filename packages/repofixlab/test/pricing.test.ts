import { describe, expect, it } from "vitest";
import { estimateGlm45AirCost, FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256 } from "../src/runner/pricing.ts";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
	};
}

describe("frozen GLM-4.5-Air CNY pricing", () => {
	it("binds the frozen specification and short-context output boundary", () => {
		expect(FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256).toMatch(/^[a-f0-9]{64}$/);
		expect(estimateGlm45AirCost(usage(1_000, 199))).toEqual({
			complete: true,
			estimatedCostCnyNano: 1_198_000,
		});
		expect(estimateGlm45AirCost(usage(1_000, 200))).toEqual({
			complete: true,
			estimatedCostCnyNano: 2_000_000,
		});
	});

	it("switches tiers at 32K prompt tokens including cache tokens", () => {
		expect(estimateGlm45AirCost(usage(32_767, 1))).toEqual({
			complete: true,
			estimatedCostCnyNano: 26_215_600,
		});
		expect(estimateGlm45AirCost(usage(32_767, 1, 1))).toEqual({
			complete: true,
			estimatedCostCnyNano: 39_328_640,
		});
	});

	it("prices cache reads separately and rejects incomplete or out-of-range usage", () => {
		expect(estimateGlm45AirCost(usage(1_000, 10, 500))).toEqual({
			complete: true,
			estimatedCostCnyNano: 900_000,
		});
		expect(estimateGlm45AirCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 })).toEqual({
			complete: false,
			estimatedCostCnyNano: null,
		});
		expect(estimateGlm45AirCost(usage(131_073, 1))).toEqual({
			complete: false,
			estimatedCostCnyNano: null,
		});
	});
});
