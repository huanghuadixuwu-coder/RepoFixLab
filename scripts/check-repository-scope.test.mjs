// Repository guards must skip ignored downloads and still inspect new source.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const [script, name, invalid, valid] of [
	["check-pinned-deps.mjs", "package.json", '{"dependencies":{"external":"^1.2.3"}}', '{"dependencies":{"external":"1.2.3"}}'],
	["check-ts-relative-imports.mjs", "source.ts", 'import "./module.js";', 'import "./module.ts";'],
]) {
	test(`${script} honors ignored cache and checks tracked and new files`, () => {
		const directory = mkdtempSync(join(tmpdir(), "repofix-wf1-guard-"));
		const path = fileURLToPath(new URL(script, import.meta.url));
		const check = () => spawnSync(process.execPath, [path], { cwd: directory, encoding: "utf8" });
		try {
			execFileSync("git", ["init", "--quiet"], { cwd: directory });
			writeFileSync(join(directory, ".gitignore"), ".repofixlab-cache/\n");
			mkdirSync(join(directory, ".repofixlab-cache"));
			writeFileSync(join(directory, ".repofixlab-cache", name), invalid);
			assert.equal(check().status, 0);
			mkdirSync(join(directory, "new"));
			writeFileSync(join(directory, "new", name), invalid);
			assert.equal(check().status, 1);
			execFileSync("git", ["add", `new/${name}`], { cwd: directory });
			assert.equal(check().status, 1);
			writeFileSync(join(directory, "new", name), valid);
			assert.equal(check().status, 0);
		} finally {
			assert.ok(directory.startsWith(join(tmpdir(), "repofix-wf1-guard-")));
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
