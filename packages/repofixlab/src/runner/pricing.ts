import { canonicalContractSha256 } from "../contracts/run-contracts.ts";

const TOKENS_PER_MILLION = 1_000_000;
const CNY_NANO_PER_CNY = 1_000_000_000;

export const FROZEN_GLM_45_AIR_PRICING_SPEC = {
	schema_version: "v1",
	spec_type: "model_pricing",
	provider: "zhipu-standard",
	model_id: "glm-4.5-air",
	currency: "CNY",
	prices_per_million_tokens: true,
	snapshot_at: "2026-07-19",
	source: "https://bigmodel.cn/pricing",
	tier_selection: {
		prompt_tokens: "input + cache_read + cache_write",
		short_context_upper_exclusive: 32_768,
		long_context_upper_inclusive: 131_072,
		short_output_upper_exclusive: 200,
	},
	tiers: [
		{
			id: "input_lt_32k_output_lt_200",
			input_cny: 0.8,
			output_cny: 2,
			cache_read_cny: 0.16,
			cache_write_cny: 0,
		},
		{
			id: "input_lt_32k_output_gte_200",
			input_cny: 0.8,
			output_cny: 6,
			cache_read_cny: 0.16,
			cache_write_cny: 0,
		},
		{
			id: "input_32k_to_128k",
			input_cny: 1.2,
			output_cny: 8,
			cache_read_cny: 0.24,
			cache_write_cny: 0,
		},
	],
	cache_write_note: "Snapshot price is zero during the current limited-time promotion; it is recorded explicitly.",
} as const;

export const FROZEN_GLM_45_AIR_PRICING_SPEC_SHA256 = canonicalContractSha256(FROZEN_GLM_45_AIR_PRICING_SPEC);

export interface PriceableUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface EstimatedModelCost {
	readonly complete: boolean;
	readonly estimatedCostCnyNano: number | null;
}

function isCompleteUsage(usage: PriceableUsage): boolean {
	const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
	return (
		fields.every((value) => Number.isSafeInteger(value) && value >= 0) &&
		usage.totalTokens === usage.input + usage.output + usage.cacheRead + usage.cacheWrite
	);
}

function nanoPerToken(cnyPerMillionTokens: number): number {
	return (cnyPerMillionTokens * CNY_NANO_PER_CNY) / TOKENS_PER_MILLION;
}

export function estimateGlm45AirCost(usage: PriceableUsage): EstimatedModelCost {
	if (!isCompleteUsage(usage)) return { complete: false, estimatedCostCnyNano: null };
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > FROZEN_GLM_45_AIR_PRICING_SPEC.tier_selection.long_context_upper_inclusive) {
		return { complete: false, estimatedCostCnyNano: null };
	}
	const tier =
		promptTokens >= FROZEN_GLM_45_AIR_PRICING_SPEC.tier_selection.short_context_upper_exclusive
			? FROZEN_GLM_45_AIR_PRICING_SPEC.tiers[2]
			: usage.output >= FROZEN_GLM_45_AIR_PRICING_SPEC.tier_selection.short_output_upper_exclusive
				? FROZEN_GLM_45_AIR_PRICING_SPEC.tiers[1]
				: FROZEN_GLM_45_AIR_PRICING_SPEC.tiers[0];
	const estimatedCostCnyNano =
		usage.input * nanoPerToken(tier.input_cny) +
		usage.output * nanoPerToken(tier.output_cny) +
		usage.cacheRead * nanoPerToken(tier.cache_read_cny) +
		usage.cacheWrite * nanoPerToken(tier.cache_write_cny);
	if (!Number.isSafeInteger(estimatedCostCnyNano)) return { complete: false, estimatedCostCnyNano: null };
	return { complete: true, estimatedCostCnyNano };
}
