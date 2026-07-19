#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { checkGeneratedSchemas, getSchemaDirectory, writeGeneratedSchemas } from "./schema-generator.ts";

const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === "--check";

if (args.length > 0 && !checkOnly) {
	throw new Error(`Usage: generate-schemas.ts [--check]`);
}

const schemaDirectory = getSchemaDirectory();

if (checkOnly) {
	const failures = checkGeneratedSchemas(schemaDirectory);
	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exitCode = 1;
	} else {
		console.log("RepoFixLab v1 schemas are current.");
	}
} else {
	mkdirSync(schemaDirectory, { recursive: true });
	writeGeneratedSchemas(schemaDirectory);
	console.log("Generated RepoFixLab v1 schemas.");
}
