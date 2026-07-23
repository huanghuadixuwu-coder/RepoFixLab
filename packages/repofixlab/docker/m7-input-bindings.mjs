import { readFileSync } from "node:fs";
import { parseExperimentPlan } from "../dist/contracts/experiment-plan.js";
import { DirectoryTaskEnvironmentLockSource, FilePublicTaskSource } from "../dist/runner/task-source.js";

const plan = parseExperimentPlan(
	readFileSync("/workspace/packages/repofixlab/configs/experiments/m7-v1.7.3.yaml", "utf8"),
);
if (plan.experiment_id !== "repofixlab-m7-v1.7.3" || plan.task_selection.status !== "frozen") {
	throw new Error("M7 input binding check received an unexpected frozen experiment plan");
}
const environmentSource = new DirectoryTaskEnvironmentLockSource(
	"/workspace/packages/repofixlab/configs/runtime/m6-26-task-v1",
	{ root_path: "/workspace/packages/repofixlab/configs/runtime", relative_path: "axios-5892/dataset-lock.json" },
);
const publicTaskSource = new FilePublicTaskSource("/data/public", "test");
await Promise.all(
	plan.task_selection.instance_ids.map(async (instanceId) => {
		const environment = await environmentSource.load(instanceId);
		await publicTaskSource.load(instanceId, environment);
	}),
);
process.stdout.write(`${JSON.stringify({ schema_version: "v1", status: "pass", checked_task_count: plan.task_selection.instance_ids.length })}\n`);
