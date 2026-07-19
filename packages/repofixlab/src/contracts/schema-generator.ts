import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { V1_SCHEMAS } from "./v1.ts";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface GeneratedSchemaFile {
	content: string;
	fileName: string;
}

function normalizeJson(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeJson);
	}
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nestedValue]) => [key, normalizeJson(nestedValue)]),
		);
	}
	throw new Error(`Cannot serialize non-JSON schema value of type ${typeof value}`);
}

export function stableStringify(value: unknown): string {
	return `${JSON.stringify(normalizeJson(value), undefined, "\t")}\n`;
}

function renderSchema(schema: TSchema): string {
	return stableStringify({
		$schema: JSON_SCHEMA_DIALECT,
		...schema,
	});
}

export function getGeneratedSchemaFiles(): GeneratedSchemaFile[] {
	return V1_SCHEMAS.map(({ fileName, schema }) => ({ fileName, content: renderSchema(schema) }));
}

export function getSchemaDirectory(): string {
	return fileURLToPath(new URL("../../schemas/v1/", import.meta.url));
}

export function checkGeneratedSchemas(schemaDirectory = getSchemaDirectory()): string[] {
	const expectedFiles = getGeneratedSchemaFiles();
	const expectedNames = new Set(expectedFiles.map(({ fileName }) => fileName));
	const failures: string[] = [];

	for (const { content, fileName } of expectedFiles) {
		const path = join(schemaDirectory, fileName);
		if (!existsSync(path)) {
			failures.push(`missing ${fileName}`);
			continue;
		}
		if (readFileSync(path, "utf8") !== content) {
			failures.push(`stale ${fileName}`);
		}
	}

	if (existsSync(schemaDirectory)) {
		for (const fileName of readdirSync(schemaDirectory)
			.filter((name) => name.endsWith(".schema.json"))
			.sort()) {
			if (!expectedNames.has(fileName)) failures.push(`unexpected ${fileName}`);
		}
	}

	return failures;
}

export function writeGeneratedSchemas(schemaDirectory = getSchemaDirectory()): void {
	mkdirSync(schemaDirectory, { recursive: true });
	for (const { content, fileName } of getGeneratedSchemaFiles()) {
		const path = join(schemaDirectory, fileName);
		if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
			writeFileSync(path, content, "utf8");
		}
	}
}
