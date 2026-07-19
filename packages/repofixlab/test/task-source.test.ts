import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FilePublicTaskSource, FileTaskEnvironmentLockSource } from "../src/runner/task-source.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M1 task admission sources", () => {
	it("loads the sealed packaged TaskEnvironmentLock and exact DatasetLock bytes", async () => {
		const source = new FileTaskEnvironmentLockSource();
		const binding = await source.load("axios__axios-5892");
		expect(binding.lockId).toBe("task-environment-v1-axios-5892-e412c03204cb3ae4");
		expect(binding.lockSha256).toBe("e412c03204cb3ae4dfed277216bde5ebe182f5c0179e02e549835c1b6639bc1f");
		const datasetPath = fileURLToPath(new URL("../configs/runtime/axios-5892/dataset-lock.json", import.meta.url));
		const datasetBytes = await readFile(datasetPath);
		expect(datasetBytes.byteLength).toBe(21_370);
		expect(createHash("sha256").update(datasetBytes).digest("hex")).toBe(
			"003c0a34cd85c9254e651ab639a29171677f98e1bb06a8393b14d5893fdef95f",
		);
		expect(binding.datasetLockBytes).toEqual(datasetBytes);
		expect(binding.datasetLockFileSha256).toBe("003c0a34cd85c9254e651ab639a29171677f98e1bb06a8393b14d5893fdef95f");
	});

	it("rejects a DatasetLock whose exact bytes drift from the frozen candidate binding", async () => {
		const directory = await mkdtemp(join(tmpdir(), "repofixlab-lock-source-"));
		temporaryDirectories.push(directory);
		const taskLockPath = fileURLToPath(
			new URL("../configs/runtime/axios-5892/task-environment-lock.json", import.meta.url),
		);
		const corruptedDatasetPath = join(directory, "dataset-lock.json");
		await writeFile(corruptedDatasetPath, "{}\n", "utf8");
		await expect(
			new FileTaskEnvironmentLockSource(taskLockPath, corruptedDatasetPath).load("axios__axios-5892"),
		).rejects.toThrow(/frozen candidate byte binding/);
	});

	it("rejects a public task before parsing when its byte binding is not frozen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "repofixlab-public-source-"));
		temporaryDirectories.push(directory);
		await writeFile(join(directory, "placeholder"), "x", "utf8");
		await expect(new FilePublicTaskSource(directory).load("../private", {} as never)).rejects.toThrow(/unsafe/);
	});
});
