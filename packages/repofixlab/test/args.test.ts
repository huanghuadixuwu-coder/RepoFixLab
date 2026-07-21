import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.ts";

describe("parseCliArgs", () => {
	it.each(["bootstrap", "formal"] as const)("parses doctor profile %s", (profile) => {
		expect(parseCliArgs(["doctor", "--profile", profile])).toEqual({
			ok: true,
			command: { kind: "doctor", profile },
		});
	});

	it("parses smoke doctor with an explicit evidence manifest and output", () => {
		expect(
			parseCliArgs([
				"doctor",
				"--profile",
				"smoke",
				"--input",
				"smoke/manifest.json",
				"--output",
				"smoke/report.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "doctor",
				profile: "smoke",
				input: "smoke/manifest.json",
				output: "smoke/report.json",
			},
		});
	});

	it("parses a doctor output path", () => {
		expect(parseCliArgs(["doctor", "--profile", "formal", "--output", "artifacts/doctor.json"])).toEqual({
			ok: true,
			command: {
				kind: "doctor",
				profile: "formal",
				output: "artifacts/doctor.json",
			},
		});
	});

	it("parses an external image provenance lock command", () => {
		expect(
			parseCliArgs([
				"provenance-lock",
				"--input",
				"provenance/run/candidate.json",
				"--output",
				"locks/bootstrap-image-provenance-lock.v1.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "provenance-lock",
				input: "provenance/run/candidate.json",
				output: "locks/bootstrap-image-provenance-lock.v1.json",
			},
		});
	});

	it("parses a task environment candidate creation command", () => {
		expect(
			parseCliArgs([
				"candidate-create",
				"--input",
				"candidates/axios-5892.build-input.json",
				"--output",
				"candidates/axios-5892.candidate.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "candidate-create",
				input: "candidates/axios-5892.build-input.json",
				output: "candidates/axios-5892.candidate.json",
			},
		});
	});

	it("parses a task environment lock creation command", () => {
		expect(
			parseCliArgs([
				"environment-lock-create",
				"--input",
				"locks/axios-5892.evidence-manifest.json",
				"--output",
				"locks/axios-5892.task-environment-lock.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "environment-lock-create",
				input: "locks/axios-5892.evidence-manifest.json",
				output: "locks/axios-5892.task-environment-lock.json",
			},
		});
	});

	it("parses the M3 split creation command", () => {
		expect(
			parseCliArgs([
				"m3-split-create",
				"--input",
				"dataset/dataset-lock.json",
				"--eligibility",
				"m3/preflight-eligibility.json",
				"--output",
				"m3/split-manifest.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "m3-split-create",
				input: "dataset/dataset-lock.json",
				eligibility: "m3/preflight-eligibility.json",
				output: "m3/split-manifest.json",
			},
		});
	});

	it("parses M3 official-image resolution", () => {
		expect(
			parseCliArgs([
				"m3-image-resolve",
				"--input",
				"m3/split-manifest.json",
				"--eligibility",
				"m3/preflight-eligibility.json",
				"--operation-id",
				"m3:official-images:20260719",
				"--output",
				"m3/official-image-source-lock.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "m3-image-resolve",
				input: "m3/split-manifest.json",
				eligibility: "m3/preflight-eligibility.json",
				operationId: "m3:official-images:20260719",
				output: "m3/official-image-source-lock.json",
			},
		});
	});

	it("parses M6 batch creation and a bounded resume path", () => {
		expect(parseCliArgs(["m6-batch-create", "--input", "m3/split-manifest.json", "--output", "m6/batch.json"])).toEqual({
			ok: true,
			command: { kind: "m6-batch-create", input: "m3/split-manifest.json", output: "m6/batch.json" },
		});
		expect(parseCliArgs(["m6-run", "--input", "m6/batch.json", "--resume", "m6/runs/.staging-run"])).toEqual({
			ok: true,
			command: { kind: "m6-run", input: "m6/batch.json", resume: "m6/runs/.staging-run" },
		});
	});

	it("parses a sealed M6 continuation source with an optional staging resume", () => {
		expect(
			parseCliArgs([
				"m6-continue",
				"--source-report",
				"m6-deepseek-flash-calibration/runs/m6-calibration-run-source/calibration-report.json",
				"--resume",
				"m6-deepseek-flash-continuation/runs/.staging-m6-continuation-run-source",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "m6-continue",
				sourceReport: "m6-deepseek-flash-calibration/runs/m6-calibration-run-source/calibration-report.json",
				resume: "m6-deepseek-flash-continuation/runs/.staging-m6-continuation-run-source",
			},
		});
	});

	it("parses a minimal factory probe command", () => {
		expect(
			parseCliArgs([
				"factory-probe",
				"--candidate",
				"candidates/axios-5892.candidate.json",
				"--operation-id",
				"factory-probe-axios-5892-01",
				"--output",
				"factory-probes/axios-5892.report.json",
			]),
		).toEqual({
			ok: true,
			command: {
				kind: "factory-probe",
				candidate: "candidates/axios-5892.candidate.json",
				operationId: "factory-probe-axios-5892-01",
				output: "factory-probes/axios-5892.report.json",
			},
		});
	});

	it.each([
		[["run", "--config", "configs/experiments/m1-axios.yaml"], false],
		[["run", "--config", "plans/custom.yaml", "--dry-run"], true],
	] as const)("parses run args %j", (args, dryRun) => {
		expect(parseCliArgs(args)).toEqual({
			ok: true,
			command: { kind: "run", config: args[2], dryRun },
		});
	});

	it.each([
		[["--help"], { kind: "help" }],
		[["-h", "doctor"], { kind: "help", topic: "doctor" }],
		[["help", "doctor"], { kind: "help", topic: "doctor" }],
		[["help", "run"], { kind: "help", topic: "run" }],
		[["--version"], { kind: "version" }],
		[["version"], { kind: "version" }],
	] as const)("parses informational args %j", (args, command) => {
		expect(parseCliArgs(args)).toEqual({ ok: true, command });
	});

	it("rejects an unknown option", () => {
		const result = parseCliArgs(["doctor", "--profile", "bootstrap", "--unknown"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unknown_option");
	});

	it.each(["--profile", "--input", "--candidate", "--operation-id", "--output", "--config"])(
		"rejects a missing value for %s",
		(option) => {
			const result = parseCliArgs(["doctor", option]);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("missing_option_value");
		},
	);

	it("rejects an unsupported doctor profile", () => {
		expect(parseCliArgs(["doctor", "--profile", "production"])).toEqual({
			ok: false,
			error: {
				code: "invalid_profile",
				message: "Invalid doctor profile: production",
			},
		});
	});

	it("requires an explicit doctor profile", () => {
		const result = parseCliArgs(["doctor"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid_profile");
	});

	it.each([
		[["doctor", "--profile", "smoke", "--output", "report.json"], "invalid_input"],
		[["doctor", "--profile", "smoke", "--input", "manifest.json"], "invalid_output"],
		[["doctor", "--profile", "bootstrap", "--input", "manifest.json"], "conflicting_action"],
	] as const)("rejects invalid profile-specific doctor args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it("rejects an empty output path", () => {
		expect(parseCliArgs(["doctor", "--profile", "smoke", "--output", ""])).toEqual({
			ok: false,
			error: {
				code: "invalid_output",
				message: "--output must be a non-empty path",
			},
		});
	});

	it.each([
		[["provenance-lock", "--output", "locks/bootstrap.json"], "invalid_input"],
		[["provenance-lock", "--input", "candidate.json"], "invalid_output"],
		[
			["provenance-lock", "--input", "candidate.json", "--output", "lock.json", "--profile", "bootstrap"],
			"conflicting_action",
		],
	] as const)("rejects invalid provenance-lock args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it.each([
		[["candidate-create", "--output", "candidate.json"], "invalid_input"],
		[["candidate-create", "--input", "build-input.json"], "invalid_output"],
		[
			["candidate-create", "--input", "build-input.json", "--output", "candidate.json", "--profile", "smoke"],
			"conflicting_action",
		],
	] as const)("rejects invalid candidate-create args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it.each([
		[["environment-lock-create", "--output", "lock.json"], "invalid_input"],
		[["environment-lock-create", "--input", "manifest.json"], "invalid_output"],
	] as const)("rejects invalid environment-lock-create args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it.each([
		[["m3-split-create", "--output", "split.json"], "invalid_input"],
		[["m3-split-create", "--input", "dataset-lock.json", "--output", "split.json"], "invalid_eligibility"],
		[["m3-split-create", "--input", "dataset-lock.json", "--eligibility", "eligible.json"], "invalid_output"],
		[
			[
				"m3-split-create",
				"--input",
				"dataset-lock.json",
				"--eligibility",
				"eligible.json",
				"--output",
				"split.json",
				"--candidate",
				"forbidden.json",
			],
			"conflicting_action",
		],
	] as const)("rejects invalid m3-split-create args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it.each([
		[["m3-image-resolve", "--input", "split.json", "--output", "lock.json"], "invalid_eligibility"],
		[["m3-image-resolve", "--input", "split.json", "--eligibility", "eligible.json", "--output", "lock.json"], "invalid_operation_id"],
		[["m3-image-resolve", "--operation-id", "m3:lock", "--output", "lock.json"], "invalid_input"],
		[["m3-image-resolve", "--input", "split.json", "--eligibility", "eligible.json", "--operation-id", "m3:lock"], "invalid_output"],
	] as const)("rejects invalid m3-image-resolve args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it.each([
		[["factory-probe", "--operation-id", "operation-1", "--output", "report.json"], "invalid_candidate"],
		[["factory-probe", "--candidate", "candidate.json", "--output", "report.json"], "invalid_operation_id"],
		[["factory-probe", "--candidate", "candidate.json", "--operation-id", "operation-1"], "invalid_output"],
		[
			[
				"factory-probe",
				"--candidate",
				"candidate.json",
				"--operation-id",
				"operation-1",
				"--output",
				"report.json",
				"--input",
				"forbidden.json",
			],
			"conflicting_action",
		],
	] as const)("rejects invalid factory-probe args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it("rejects caller-supplied Docker controls for factory-probe", () => {
		const result = parseCliArgs([
			"factory-probe",
			"--candidate",
			"candidate.json",
			"--operation-id",
			"operation-1",
			"--output",
			"report.json",
			"--network-mode",
			"host",
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unknown_option");
	});

	it.each([
		[["run"], "invalid_config"],
		[["run", "--config", ""], "invalid_config"],
		[["run", "--config", "plan.yaml", "--profile", "formal"], "conflicting_action"],
		[["doctor", "--profile", "formal", "--dry-run"], "conflicting_action"],
	] as const)("rejects invalid run args %j", (args, errorCode) => {
		const result = parseCliArgs(args);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(errorCode);
	});

	it("rejects an unknown command", () => {
		const result = parseCliArgs(["unsupported"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unknown_command");
	});

	it("rejects conflicting informational actions", () => {
		const result = parseCliArgs(["--help", "--version"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("conflicting_action");
	});
});
