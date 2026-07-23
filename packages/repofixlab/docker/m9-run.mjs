import { readFile } from "node:fs/promises";
import { parseExperimentPlan } from "../dist/contracts/experiment-plan.js";
import { runM9Batch } from "../dist/m9/batch-runner.js";

const plan = parseExperimentPlan(
	await readFile("/workspace/packages/repofixlab/configs/experiments/m9-v1.yaml", "utf8"),
);
const summary = await runM9Batch(plan, "/artifacts", "http://controller:8000");
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = summary.failed_run_ids.length === 0 ? 0 : 1;
