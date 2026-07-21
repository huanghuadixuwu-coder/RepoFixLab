import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const selectedTasks = ["axios__axios-5892", "mrdoob__three.js-26589", "preactjs__preact-4182"];
const artifactRoots = [
	"/artifacts/m6-deepseek-flash-calibration-v3-input",
	"/artifacts/m6-deepseek-flash-calibration",
	"/artifacts/m6-deepseek-flash-provider-smoke",
];

accessSync("/run/secrets/deepseek_api_key", constants.R_OK);
for (const task of selectedTasks) {
	accessSync(`/data/public/tasks/${task}.json`, constants.R_OK);
}
for (const root of artifactRoots) {
	mkdirSync(root, { recursive: true });
	const token = randomUUID();
	const temporary = join(root, `.staging-${token}`);
	const finalPath = join(root, `ready-${token}.json`);
	writeFileSync(temporary, `${JSON.stringify({ status: "ready" })}\n`, { flag: "wx", mode: 0o600 });
	renameSync(temporary, finalPath);
}
process.stdout.write(`${JSON.stringify({ schema_version: "v1", status: "pass", secret_mount: "readable", task_files: "readable", artifact_rename: "pass" })}\n`);
