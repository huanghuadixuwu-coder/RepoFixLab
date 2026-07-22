import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyEvaluationResult, type RunResult } from "../contracts/run-contracts.ts";
import type { RunMetricEvidence } from "../metrics/experiment-metrics.ts";
import type { BatchRunSpec } from "../runner/batch-state.ts";

export async function loadM7FormalMetricEvidence(
	batchRoot: string,
	specs: readonly BatchRunSpec[],
	results: Readonly<Record<string, RunResult>>,
): Promise<Readonly<Record<string, RunMetricEvidence>>> {
	const evidence: Record<string, RunMetricEvidence> = {};
	for (const spec of specs) {
		const result = results[spec.run_id];
		if (result === undefined) continue;
		const path = join(resolve(batchRoot), "runs", spec.run_id, "evaluation-normalized.json");
		const evaluation = verifyEvaluationResult(JSON.parse(await readFile(path, "utf8")) as unknown);
		if (
			evaluation.run_id !== result.run_id ||
			evaluation.attempt_id !== result.attempt_id ||
			evaluation.evaluation_sha256 !== result.evaluation_result_sha256
		) {
			throw new Error(`M7 metric evaluation binding drifted for ${spec.run_id}`);
		}
		evidence[spec.run_id] = { run_id: spec.run_id, evaluation, security: null };
	}
	return evidence;
}
