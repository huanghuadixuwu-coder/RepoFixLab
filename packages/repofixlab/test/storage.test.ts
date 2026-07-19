import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/storage/artifact-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("immutable artifact store", () => {
	it("atomically publishes top-level and append-only artifacts", async () => {
		const parent = await mkdtemp(join(tmpdir(), "repofixlab-store-"));
		roots.push(parent);
		const store = await ArtifactStore.createNew(join(parent, "run"));
		const run = await store.writeNew("run.json", "{}\n", {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		const events = await store.createAppendOnlyFile("events.jsonl");
		await events.append('{"sequence":0}\n');
		const closed = await events.close({
			mediaType: "application/x-ndjson",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		expect(run.bytes).toBe(3);
		expect(closed.bytes).toBeGreaterThan(0);
		expect(store.listArtifacts().map((artifact) => artifact.path)).toEqual(["events.jsonl", "run.json"]);
	});

	it("rejects overwrite and traversal", async () => {
		const parent = await mkdtemp(join(tmpdir(), "repofixlab-store-"));
		roots.push(parent);
		const store = await ArtifactStore.createNew(join(parent, "run"));
		const options = { mediaType: "text/plain", sensitivity: "internal", generatedBy: "orchestrator" } as const;
		await store.writeNew("evidence.txt", "first", options);
		await expect(store.writeNew("evidence.txt", "second", options)).rejects.toThrow(/already registered|EEXIST/);
		await expect(store.writeNew("../escape.txt", "x", options)).rejects.toThrow(/unsafe/);
	});

	it("publishes an admitted staging directory with one sibling rename", async () => {
		const parent = await mkdtemp(join(tmpdir(), "repofixlab-store-"));
		roots.push(parent);
		const store = await ArtifactStore.createNew(join(parent, ".staging-run"));
		await store.writeNew("run.json", "{}\n", {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await store.publishTo(join(parent, "run"));
		expect(store.rootPath).toBe(join(parent, "run"));
		await store.writeNew("result.json", "{}\n", {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		expect(store.listArtifacts().map((artifact) => artifact.path)).toEqual(["result.json", "run.json"]);
	});

	it("refuses to publish a staging directory while an append-only file remains open", async () => {
		const parent = await mkdtemp(join(tmpdir(), "repofixlab-store-"));
		roots.push(parent);
		const store = await ArtifactStore.createNew(join(parent, ".staging-run"));
		const events = await store.createAppendOnlyFile("events.jsonl");
		await events.append('{"sequence":0}\n');
		await expect(store.publishTo(join(parent, "run"))).rejects.toThrow(/append-only files to be closed/);
		await events.close({
			mediaType: "application/x-ndjson",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		});
		await store.publishTo(join(parent, "run"));
		expect(store.rootPath).toBe(join(parent, "run"));
	});
});
