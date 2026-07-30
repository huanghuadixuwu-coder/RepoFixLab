import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stableStringify } from "../contracts/canonical-json.ts";
import { parseExperimentPlan } from "../contracts/experiment-plan.ts";
import { type RunResult, verifyRunResult } from "../contracts/run-contracts.ts";
import { BatchStateStore } from "../runner/batch-state.ts";
import { createM9RunSpecs, M9_ARTIFACT_DIRECTORY } from "./batch-runner.ts";

const M9_ANALYSIS_REVISION = "repofixlab-m9-analysis-v1" as const;
const M7_CONTINUATION_REPORT =
	"m7-v1.7.3/report/continuation-edf1bdde883e630d3fa184ba85cd1a74c9c9dff8a844db9a20d1ae37550eb542.json";

type M7ConfigId = "pi-general" | "repofix-full";

interface M7Observation {
	readonly source_run_id: string;
	readonly continuation_run_id: string | null;
	readonly group_id: string;
	readonly instance_id: string;
	readonly config_id: M7ConfigId | string;
	readonly max_model_turns: 64 | 128;
	readonly resolved: boolean | null;
	readonly result_sha256: string | null;
}

interface M7ContinuationReportInput {
	readonly report_sha256: string;
	readonly observations: readonly M7Observation[];
}

interface OutcomeEvidence {
	readonly source: "m7_reused" | "m9_new_first_attempt" | "m7_no_final_snapshot" | "m9_controlled_recovery";
	readonly run_id: string | null;
	readonly result_sha256: string | null;
	readonly resolved: boolean;
	readonly observed_max_model_turns: 64 | 128;
}

interface M9TaskPair {
	readonly instance_id: string;
	readonly pi: OutcomeEvidence;
	readonly repofix_first_attempt: OutcomeEvidence;
	readonly repofix_operational_final: OutcomeEvidence;
}

interface PairSummary {
	readonly task_count: number;
	readonly pi_resolved_count: number;
	readonly repofix_resolved_count: number;
	readonly difference_percentage_points: number;
	readonly both_resolved_count: number;
	readonly pi_only_resolved_count: number;
	readonly repofix_only_resolved_count: number;
	readonly neither_resolved_count: number;
	readonly mcnemar_exact_two_sided_p_value: number | null;
}

export interface M9AnalysisReport {
	readonly schema_version: "v1";
	readonly report_type: "m9_26_task_analysis";
	readonly status: "pass";
	readonly method_revision: typeof M9_ANALYSIS_REVISION;
	readonly source: {
		readonly m7_continuation_report_sha256: string;
		readonly m9_batch_state_sha256: string;
		readonly m9_new_run_count: 21;
	};
	readonly task_pairs: readonly M9TaskPair[];
	readonly first_attempt: PairSummary;
	readonly operational_final: PairSummary;
	readonly controlled_recovery: {
		readonly eligible_count: 3;
		readonly resolved_count: number;
		readonly unresolved_count: number;
	};
	readonly resources: {
		readonly m9_new_accounted_tokens: number;
		readonly m9_new_provider_actual_tokens: number;
		readonly m9_new_model_turns: number;
		readonly m9_new_cost_complete: false;
		readonly m9_new_estimated_cost_cny_nano: null;
	};
	readonly conclusion_boundaries: readonly string[];
	readonly report_sha256: string;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shaField(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256`);
	return value;
}

function parseM7ContinuationReport(value: unknown): M7ContinuationReportInput {
	if (!isRecord(value) || !Array.isArray(value.observations))
		throw new Error("M9 source continuation report is malformed");
	const reportSha256 = shaField(value.report_sha256, "M9 source continuation report");
	const { report_sha256: _ignored, ...unsigned } = value;
	if (sha256(unsigned) !== reportSha256) throw new Error("M9 source continuation report hash is invalid");
	const observations = value.observations.map((raw, index): M7Observation => {
		if (!isRecord(raw)) throw new Error(`M9 source observation ${index} is malformed`);
		const resolved = raw.resolved;
		if (resolved !== true && resolved !== false && resolved !== null)
			throw new Error(`M9 source observation ${index} resolution is invalid`);
		if (
			typeof raw.source_run_id !== "string" ||
			(raw.continuation_run_id !== null && typeof raw.continuation_run_id !== "string") ||
			typeof raw.group_id !== "string" ||
			typeof raw.instance_id !== "string" ||
			typeof raw.config_id !== "string" ||
			(raw.max_model_turns !== 64 && raw.max_model_turns !== 128) ||
			(raw.result_sha256 !== null && !/^[a-f0-9]{64}$/.test(String(raw.result_sha256)))
		)
			throw new Error(`M9 source observation ${index} binding is invalid`);
		return {
			source_run_id: raw.source_run_id,
			continuation_run_id: typeof raw.continuation_run_id === "string" ? raw.continuation_run_id : null,
			group_id: raw.group_id,
			instance_id: raw.instance_id,
			config_id: raw.config_id,
			max_model_turns: raw.max_model_turns,
			resolved,
			result_sha256: typeof raw.result_sha256 === "string" ? raw.result_sha256 : null,
		};
	});
	return { report_sha256: reportSha256, observations };
}

async function readVerifiedResult(path: string, runId: string, expectedSha256: string): Promise<RunResult> {
	const result = verifyRunResult(JSON.parse(await readFile(path, "utf8")) as unknown);
	if (result.run_id !== runId || result.result_sha256 !== expectedSha256)
		throw new Error(`M9 result binding drifted: ${runId}`);
	return result;
}

function exactMcNemar(piOnly: number, repofixOnly: number): number | null {
	const discordant = piOnly + repofixOnly;
	if (discordant === 0) return null;
	const smaller = Math.min(piOnly, repofixOnly);
	let term = 2 ** -discordant;
	let cumulative = term;
	for (let index = 1; index <= smaller; index += 1) {
		term *= (discordant - index + 1) / index;
		cumulative += term;
	}
	return Math.min(1, 2 * cumulative);
}

function summarize(
	pairs: readonly M9TaskPair[],
	property: "repofix_first_attempt" | "repofix_operational_final",
): PairSummary {
	let piResolved = 0;
	let repofixResolved = 0;
	let both = 0;
	let piOnly = 0;
	let repofixOnly = 0;
	let neither = 0;
	for (const pair of pairs) {
		const pi = pair.pi.resolved;
		const repofix = pair[property].resolved;
		if (pi) piResolved += 1;
		if (repofix) repofixResolved += 1;
		if (pi && repofix) both += 1;
		else if (pi) piOnly += 1;
		else if (repofix) repofixOnly += 1;
		else neither += 1;
	}
	return {
		task_count: pairs.length,
		pi_resolved_count: piResolved,
		repofix_resolved_count: repofixResolved,
		difference_percentage_points: ((repofixResolved - piResolved) / pairs.length) * 100,
		both_resolved_count: both,
		pi_only_resolved_count: piOnly,
		repofix_only_resolved_count: repofixOnly,
		neither_resolved_count: neither,
		mcnemar_exact_two_sided_p_value: exactMcNemar(piOnly, repofixOnly),
	};
}

function percent(value: number): string {
	return `${value.toFixed(2)}%`;
}

function markdown(report: M9AnalysisReport): string {
	return `# RepoFixLab M9 26-task analysis\n\n## Outcomes\n\n| Metric | Pi-general | RepoFix-full | Difference | Pi-only | RepoFix-only | McNemar exact p |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n| First attempt | ${report.first_attempt.pi_resolved_count}/${report.first_attempt.task_count} | ${report.first_attempt.repofix_resolved_count}/${report.first_attempt.task_count} | ${percent(report.first_attempt.difference_percentage_points)} | ${report.first_attempt.pi_only_resolved_count} | ${report.first_attempt.repofix_only_resolved_count} | ${report.first_attempt.mcnemar_exact_two_sided_p_value?.toFixed(6) ?? "n/a"} |\n| Operational final (one controlled recovery) | ${report.operational_final.pi_resolved_count}/${report.operational_final.task_count} | ${report.operational_final.repofix_resolved_count}/${report.operational_final.task_count} | ${percent(report.operational_final.difference_percentage_points)} | ${report.operational_final.pi_only_resolved_count} | ${report.operational_final.repofix_only_resolved_count} | ${report.operational_final.mcnemar_exact_two_sided_p_value?.toFixed(6) ?? "n/a"} |\n\n- Controlled recovery: ${report.controlled_recovery.resolved_count}/${report.controlled_recovery.eligible_count} resolved.\n- New M9 usage: ${report.resources.m9_new_accounted_tokens} Tokens across ${report.source.m9_new_run_count} runs.\n\n## Boundaries\n\n${report.conclusion_boundaries.map((item) => `- ${item}`).join("\n")}\n\nM9 SHA-256: \`${report.report_sha256}\`\n`;
}

function html(report: M9AnalysisReport): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RepoFixLab M9 analysis</title></head><body><main><h1>RepoFixLab M9 26-task analysis</h1><p>First attempt: Pi ${report.first_attempt.pi_resolved_count}/${report.first_attempt.task_count}; RepoFix ${report.first_attempt.repofix_resolved_count}/${report.first_attempt.task_count}. Operational final: Pi ${report.operational_final.pi_resolved_count}/${report.operational_final.task_count}; RepoFix ${report.operational_final.repofix_resolved_count}/${report.operational_final.task_count}.</p><p>New M9 usage: ${report.resources.m9_new_accounted_tokens} Tokens across 21 runs.</p><p>M9 SHA-256: <code>${report.report_sha256}</code></p></main></body></html>`;
}

async function writeImmutable(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporary, path);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		if ((await readFile(path, "utf8")) !== content) throw new Error(`Immutable M9 report conflict: ${path}`);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function publishM9Analysis(
	artifactsRoot: string,
): Promise<{
	readonly report: M9AnalysisReport;
	readonly json_path: string;
	readonly markdown_path: string;
	readonly html_path: string;
}> {
	const root = resolve(artifactsRoot);
	const plan = parseExperimentPlan(
		await readFile(new URL("../../configs/experiments/m9-v1.yaml", import.meta.url), "utf8"),
	);
	if (plan.task_selection.status !== "frozen") throw new Error("M9 task selection must be frozen");
	const specs = createM9RunSpecs(plan);
	const [m7, m9Store] = await Promise.all([
		readFile(join(root, M7_CONTINUATION_REPORT), "utf8").then((content) =>
			parseM7ContinuationReport(JSON.parse(content) as unknown),
		),
		BatchStateStore.open(join(root, M9_ARTIFACT_DIRECTORY)),
	]);
	const expectedRunIds = new Set(specs.map((spec) => spec.run_id));
	if (
		m9Store.values.length !== 21 ||
		m9Store.values.some(
			(state) => !expectedRunIds.has(state.run_id) || state.status !== "completed" || state.result_sha256 === null,
		)
	) {
		throw new Error("M9 analysis requires 21 completed new runs");
	}
	const m9ByKey = new Map<string, RunResult>();
	for (const state of m9Store.values) {
		const result = await readVerifiedResult(
			join(root, M9_ARTIFACT_DIRECTORY, "results", `${state.run_id}.json`),
			state.run_id,
			state.result_sha256!,
		);
		m9ByKey.set(`${state.group_id}\u0000${state.instance_id}\u0000${state.config_id}`, result);
	}
	const m7Main = m7.observations.filter(
		(observation) =>
			observation.group_id === "main" &&
			(observation.config_id === "pi-general" || observation.config_id === "repofix-full"),
	);
	const m7ByKey = new Map(
		m7Main.map((observation) => [`${observation.instance_id}\u0000${observation.config_id}`, observation]),
	);
	const pairs: M9TaskPair[] = [];
	for (const instanceId of plan.task_selection.instance_ids) {
		const buildFirst = async (configId: M7ConfigId): Promise<OutcomeEvidence> => {
			const observation = m7ByKey.get(`${instanceId}\u0000${configId}`);
			if (observation !== undefined && observation.result_sha256 !== null && observation.resolved !== null) {
				const runId = observation.continuation_run_id ?? observation.source_run_id;
				const resultRoot = observation.max_model_turns === 64 ? "m7-v1.7.2" : "m7-v1.7.3";
				const result = await readVerifiedResult(
					join(root, resultRoot, "results", `${runId}.json`),
					runId,
					observation.result_sha256,
				);
				if (result.resolved !== observation.resolved)
					throw new Error(`M7 reused outcome drifted: ${instanceId}/${configId}`);
				return {
					source: "m7_reused",
					run_id: runId,
					result_sha256: result.result_sha256,
					resolved: result.resolved,
					observed_max_model_turns: observation.max_model_turns,
				};
			}
			if (observation !== undefined)
				return {
					source: "m7_no_final_snapshot",
					run_id: observation.continuation_run_id,
					result_sha256: null,
					resolved: false,
					observed_max_model_turns: observation.max_model_turns,
				};
			const result = m9ByKey.get(`m9-new-main-pairs\u0000${instanceId}\u0000${configId}`);
			if (result === undefined) throw new Error(`M9 new first attempt is missing: ${instanceId}/${configId}`);
			return {
				source: "m9_new_first_attempt",
				run_id: result.run_id,
				result_sha256: result.result_sha256,
				resolved: result.resolved,
				observed_max_model_turns: 128,
			};
		};
		const pi = await buildFirst("pi-general");
		const repofixFirst = await buildFirst("repofix-full");
		const recovery = m9ByKey.get(`m9-repofix-controlled-recovery\u0000${instanceId}\u0000repofix-full`);
		const repofixOperational: OutcomeEvidence =
			recovery === undefined
				? repofixFirst
				: {
						source: "m9_controlled_recovery",
						run_id: recovery.run_id,
						result_sha256: recovery.result_sha256,
						resolved: recovery.resolved,
						observed_max_model_turns: 128,
					};
		pairs.push({
			instance_id: instanceId,
			pi,
			repofix_first_attempt: repofixFirst,
			repofix_operational_final: repofixOperational,
		});
	}
	if (pairs.length !== 26 || new Set(pairs.map((pair) => pair.instance_id)).size !== 26)
		throw new Error("M9 task-pair coverage is incomplete");
	const firstAttempt = summarize(pairs, "repofix_first_attempt");
	const operationalFinal = summarize(pairs, "repofix_operational_final");
	const recoveryOutcomes = pairs.filter((pair) => pair.repofix_operational_final.source === "m9_controlled_recovery");
	const m9Results = [...m9ByKey.values()];
	const unsigned = {
		schema_version: "v1" as const,
		report_type: "m9_26_task_analysis" as const,
		status: "pass" as const,
		method_revision: M9_ANALYSIS_REVISION,
		source: {
			m7_continuation_report_sha256: m7.report_sha256,
			m9_batch_state_sha256: shaField(
				JSON.parse(await readFile(join(root, M9_ARTIFACT_DIRECTORY, "batch-state.json"), "utf8")).state_sha256,
				"M9 batch state",
			),
			m9_new_run_count: 21 as const,
		},
		task_pairs: pairs,
		first_attempt: firstAttempt,
		operational_final: operationalFinal,
		controlled_recovery: {
			eligible_count: 3 as const,
			resolved_count: recoveryOutcomes.filter((pair) => pair.repofix_operational_final.resolved).length,
			unresolved_count: recoveryOutcomes.filter((pair) => !pair.repofix_operational_final.resolved).length,
		},
		resources: {
			m9_new_accounted_tokens: m9Results.reduce((total, result) => total + result.usage.accounted_tokens, 0),
			m9_new_provider_actual_tokens: m9Results.reduce(
				(total, result) => total + (result.usage.provider_actual_tokens ?? 0),
				0,
			),
			m9_new_model_turns: m9Results.reduce((total, result) => total + result.usage.model_turns, 0),
			m9_new_cost_complete: false as const,
			m9_new_estimated_cost_cny_nano: null,
		},
		conclusion_boundaries: [
			"This is a 26-task task-level comparison under observed ceilings of at most 128 turns; reused 64-turn outcomes remain labelled as 64-turn evidence.",
			"The operational metric includes at most one separately recorded controlled recovery only for a no-final-snapshot first attempt; it is not a first-attempt ability metric.",
			"M9 does not support a fixed-128 claim for reused 64-turn observations and does not overwrite any M7 terminal evidence.",
		],
	};
	const report: M9AnalysisReport = { ...unsigned, report_sha256: sha256(unsigned) };
	const reportRoot = join(root, M9_ARTIFACT_DIRECTORY, "report");
	const jsonPath = join(reportRoot, `analysis-${report.report_sha256}.json`);
	const markdownPath = join(reportRoot, `analysis-${report.report_sha256}.md`);
	const htmlPath = join(reportRoot, `analysis-${report.report_sha256}.html`);
	await Promise.all([
		writeImmutable(jsonPath, stableStringify(report)),
		writeImmutable(markdownPath, markdown(report)),
		writeImmutable(htmlPath, html(report)),
	]);
	return { report, json_path: jsonPath, markdown_path: markdownPath, html_path: htmlPath };
}
