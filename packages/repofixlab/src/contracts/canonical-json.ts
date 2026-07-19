type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalizeJson(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nestedValue]) => [key, normalizeJson(nestedValue)]),
		);
	}
	throw new Error(`Cannot serialize non-JSON value of type ${typeof value}`);
}

export function stableStringify(value: unknown): string {
	return `${JSON.stringify(normalizeJson(value), undefined, "\t")}\n`;
}
