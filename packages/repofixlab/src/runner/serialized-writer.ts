/** Serialize a store's validation, mutation and durable writes in call order. */
export class SerializedWriter {
	private tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
