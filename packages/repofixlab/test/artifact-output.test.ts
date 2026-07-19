import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveArtifactInputPath, resolveArtifactOutputPath, writeArtifactReportAtomically } from "../src/cli/main.ts";

describe("artifact output boundary", () => {
	it("rejects a symbolic-link escape from the artifacts root", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "repofixlab-artifacts-"));
		const artifactsRoot = join(temporaryRoot, "artifacts");
		const outsideRoot = join(temporaryRoot, "outside");
		try {
			await mkdir(artifactsRoot);
			await mkdir(outsideRoot);
			await symlink(outsideRoot, join(artifactsRoot, "escape"), "dir");

			await expect(resolveArtifactOutputPath(artifactsRoot, "escape/report.json")).rejects.toThrow("symbolic link");
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("rejects an input symbolic-link escape from the artifacts root", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "repofixlab-input-"));
		const artifactsRoot = join(temporaryRoot, "artifacts");
		const outsideRoot = join(temporaryRoot, "outside");
		try {
			await mkdir(artifactsRoot);
			await mkdir(outsideRoot);
			await symlink(outsideRoot, join(artifactsRoot, "escape"), "dir");

			await expect(resolveArtifactInputPath(artifactsRoot, "escape/candidate.json")).rejects.toThrow(
				"symbolic link",
			);
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("publishes a synced immutable report without overwriting", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "repofixlab-report-"));
		const reportPath = join(temporaryRoot, "report.json");
		try {
			await writeArtifactReportAtomically(reportPath, "first\n");
			expect(await readFile(reportPath, "utf8")).toBe("first\n");
			expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
			await expect(writeArtifactReportAtomically(reportPath, "second\n")).rejects.toMatchObject({
				code: "EEXIST",
			});
			expect(await readFile(reportPath, "utf8")).toBe("first\n");
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("publishes an explicitly public catalog without widening the default", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "repofixlab-catalog-"));
		const catalogPath = join(temporaryRoot, "candidate.json");
		const privateReportPath = join(temporaryRoot, "factory-report.json");
		try {
			await writeArtifactReportAtomically(catalogPath, "catalog\n", 0o644);
			await writeArtifactReportAtomically(privateReportPath, "private\n");
			expect((await stat(catalogPath)).mode & 0o777).toBe(0o644);
			expect((await stat(privateReportPath)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});
});
