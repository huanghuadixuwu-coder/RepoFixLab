/**
 * Marks a failure that is proven to have occurred before the first Provider
 * request. Batch accounting can therefore release its local reservation
 * without treating unspent capacity as unknown Provider usage.
 */
export class PreProviderBatchFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PreProviderBatchFailure";
	}
}

/** A terminal failure after every Provider reservation has settled exactly. */
export class KnownProviderUsageBatchFailure extends Error {
	readonly accountedTokens: number;

	constructor(message: string, accountedTokens: number) {
		super(message);
		if (!Number.isSafeInteger(accountedTokens) || accountedTokens < 0) {
			throw new Error("Known Provider usage must be a non-negative safe integer");
		}
		this.name = "KnownProviderUsageBatchFailure";
		this.accountedTokens = accountedTokens;
	}
}
