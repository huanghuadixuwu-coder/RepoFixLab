import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkGeneratedSchemas,
	getGeneratedSchemaFiles,
	getSchemaDirectory,
} from "../src/contracts/schema-generator.ts";

describe("RepoFixLab schema generation", () => {
	it("matches every committed v1 schema byte-for-byte", () => {
		expect(checkGeneratedSchemas()).toEqual([]);
	});

	it("emits standalone JSON Schema 2020-12 documents", () => {
		const schemaDirectory = getSchemaDirectory();
		for (const { content, fileName } of getGeneratedSchemaFiles()) {
			expect(readFileSync(join(schemaDirectory, fileName), "utf8")).toBe(content);
			const document = JSON.parse(content) as Record<string, unknown>;
			expect(document.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
			expect(document.$id).toMatch(/^urn:repofixlab:schema:v1:/);
		}
	});

	it("does not emit Draft 7 tuple keywords in 2020-12 documents", () => {
		for (const { content } of getGeneratedSchemaFiles()) {
			expect(content).not.toMatch(/"items"\s*:\s*\[/);
			expect(content).not.toContain('"additionalItems"');
		}
	});
});
