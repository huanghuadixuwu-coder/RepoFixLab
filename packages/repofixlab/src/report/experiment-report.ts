import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepoFixConfigId } from "../agent/repofix-config.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { RunResult } from "../contracts/run-contracts.ts";
import {
	createExperimentMetrics,
	type ExperimentMetrics,
	type RunMetricEvidence,
} from "../metrics/experiment-metrics.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";

export interface ExperimentAggregate {
	readonly schema_version: "v1";
	readonly report_type: "experiment_aggregate";
	readonly expected_run_count: number;
	readonly observed_run_count: number;
	readonly missing_run_ids: readonly string[];
	readonly configurations: readonly {
		readonly config_id: RepoFixConfigId;
		readonly denominator: number;
		readonly resolved_count: number;
		readonly resolved_rate: number;
		readonly terminal_counts: Readonly<Record<string, number>>;
		readonly accounted_tokens: number;
		readonly provider_actual_tokens: number | null;
		readonly wall_time_ms: { readonly p50: number | null; readonly p90: number | null; readonly total: number };
		readonly cost_complete: boolean;
		readonly estimated_cost_cny_nano: number | null;
	}[];
	readonly metrics: ExperimentMetrics;
	readonly aggregate_sha256: string;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * p) - 1] ?? null;
}

export function createExperimentAggregate(
	specs: readonly BatchRunSpec[],
	results: Readonly<Record<string, RunResult>>,
	evidence: Readonly<Record<string, RunMetricEvidence>> = {},
): ExperimentAggregate {
	const ids = specs.map((spec) => spec.run_id);
	if (new Set(ids).size !== ids.length) throw new Error("Experiment aggregate specs contain duplicate run IDs");
	const missing = ids.filter((id) => results[id] === undefined).sort();
	for (const [runId, result] of Object.entries(results)) {
		if (!ids.includes(runId) || result.run_id !== runId)
			throw new Error("Experiment result is not bound to a registered run");
	}
	const configIds = [...new Set(specs.map((spec) => spec.config_id))].sort() as RepoFixConfigId[];
	const configurations = configIds.map((configId) => {
		const configSpecs = specs.filter((spec) => spec.config_id === configId);
		const configResults = configSpecs.flatMap((spec) => {
			const result = results[spec.run_id];
			return result === undefined ? [] : [result];
		});
		const terminalCounts: Record<string, number> = {};
		for (const result of configResults) {
			terminalCounts[result.termination_reason] = (terminalCounts[result.termination_reason] ?? 0) + 1;
		}
		const completeActual = configResults.every((result) => result.usage.provider_actual_tokens !== null);
		const completeCost = configResults.every((result) => result.usage.cost_complete);
		const actual = completeActual
			? configResults.reduce((total, result) => total + (result.usage.provider_actual_tokens ?? 0), 0)
			: null;
		const cost = completeCost
			? configResults.reduce((total, result) => total + (result.usage.estimated_cost_cny_nano ?? 0), 0)
			: null;
		return {
			config_id: configId,
			denominator: configSpecs.length,
			resolved_count: configResults.filter((result) => result.resolved).length,
			resolved_rate:
				configSpecs.length === 0
					? 0
					: configResults.filter((result) => result.resolved).length / configSpecs.length,
			terminal_counts: Object.fromEntries(
				Object.entries(terminalCounts).sort(([left], [right]) => left.localeCompare(right)),
			),
			accounted_tokens: configResults.reduce((total, result) => total + result.usage.accounted_tokens, 0),
			provider_actual_tokens: actual,
			wall_time_ms: {
				p50: percentile(
					configResults.map((result) => result.wall_time_ms),
					0.5,
				),
				p90: percentile(
					configResults.map((result) => result.wall_time_ms),
					0.9,
				),
				total: configResults.reduce((total, result) => total + result.wall_time_ms, 0),
			},
			cost_complete: completeCost,
			estimated_cost_cny_nano: cost,
		};
	});
	const unsigned = {
		schema_version: "v1" as const,
		report_type: "experiment_aggregate" as const,
		expected_run_count: specs.length,
		observed_run_count: Object.keys(results).length,
		missing_run_ids: missing,
		configurations,
		metrics: createExperimentMetrics(specs, results, evidence),
	};
	return { ...unsigned, aggregate_sha256: sha256(unsigned) };
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function createStaticExperimentReport(aggregate: ExperimentAggregate): string {
	const rows = aggregate.configurations
		.map(
			(config) =>
				`<tr><td>${escapeHtml(config.config_id)}</td><td>${config.resolved_count}/${config.denominator}</td><td>${(config.resolved_rate * 100).toFixed(1)}%</td><td>${config.accounted_tokens}</td><td>${config.wall_time_ms.p50 ?? "n/a"}</td><td>${config.wall_time_ms.p90 ?? "n/a"}</td><td>${escapeHtml(JSON.stringify(config.terminal_counts))}</td></tr>`,
		)
		.join("");
	const f2p = aggregate.metrics.tests.fail_to_pass;
	const p2p = aggregate.metrics.tests.pass_to_pass;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RepoFixLab experiment report</title></head><body><main><h1>RepoFixLab experiment aggregate</h1><p>Expected runs: ${aggregate.expected_run_count}; observed: ${aggregate.observed_run_count}; missing: ${aggregate.missing_run_ids.length}</p><table><thead><tr><th>Configuration</th><th>Resolved</th><th>Rate</th><th>Accounted tokens</th><th>P50 ms</th><th>P90 ms</th><th>Terminal counts</th></tr></thead><tbody>${rows}</tbody></table><h2>Evaluation evidence</h2><p>F2P: ${f2p.passed}/${f2p.total}${f2p.rate === null ? " (evidence unavailable)" : ` (${(f2p.rate * 100).toFixed(1)}%)`}; P2P: ${p2p.passed}/${p2p.total}${p2p.rate === null ? " (evidence unavailable)" : ` (${(p2p.rate * 100).toFixed(1)}%)`}; evaluation evidence: ${aggregate.metrics.tests.evaluation_evidence_run_count}/${aggregate.expected_run_count}.</p><h2>Reliability and safety evidence</h2><p>Failure categories: ${escapeHtml(JSON.stringify(aggregate.metrics.failure_categories))}; complete replicate groups: ${aggregate.metrics.stability.reduce((total, value) => total + value.complete_replicate_group_count, 0)}; unstable replicate groups: ${aggregate.metrics.stability.reduce((total, value) => total + value.unstable_replicate_group_count, 0)}; blocked operations: ${aggregate.metrics.security.blocked_operation_count}; policy violations: ${aggregate.metrics.security.policy_violation_count}; sandbox escape attempts: ${aggregate.metrics.security.sandbox_escape_attempt_count}; security evidence: ${aggregate.metrics.security.evidence_run_count}/${aggregate.expected_run_count}.</p><p>Aggregate SHA-256: <code>${aggregate.aggregate_sha256}</code></p></main></body></html>`;
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
		const existing = await readFile(path, "utf8");
		if (existing !== content) throw new Error(`Immutable report conflict: ${path}`);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function publishExperimentReport(
	root: string,
	specs: readonly BatchRunSpec[],
	results: Readonly<Record<string, RunResult>>,
	evidence: Readonly<Record<string, RunMetricEvidence>> = {},
): Promise<{ readonly aggregate: ExperimentAggregate; readonly json_path: string; readonly html_path: string }> {
	const aggregate = createExperimentAggregate(specs, results, evidence);
	const reportRoot = resolve(root, "report");
	const jsonPath = join(reportRoot, `aggregate-${aggregate.aggregate_sha256}.json`);
	const htmlPath = join(reportRoot, `report-${aggregate.aggregate_sha256}.html`);
	await writeImmutable(jsonPath, stableStringify(aggregate));
	await writeImmutable(htmlPath, createStaticExperimentReport(aggregate));
	return { aggregate, json_path: jsonPath, html_path: htmlPath };
}
