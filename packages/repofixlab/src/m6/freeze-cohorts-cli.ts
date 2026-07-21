import { parseArgs } from "node:util";
import { freezeM6EvaluationCohortsToFile } from "./freeze-cohorts.ts";

const parsed = parseArgs({
	args: process.argv.slice(2),
	options: {
		"split-path": { type: "string" },
		"sampling-metadata-path": { type: "string" },
		"dataset-lock-path": { type: "string" },
		"output-path": { type: "string" },
	},
	strict: true,
	allowPositionals: false,
});

const splitPath = parsed.values["split-path"];
const samplingMetadataPath = parsed.values["sampling-metadata-path"];
const datasetLockPath = parsed.values["dataset-lock-path"];
const outputPath = parsed.values["output-path"];
if (
	typeof splitPath !== "string" ||
	typeof samplingMetadataPath !== "string" ||
	typeof datasetLockPath !== "string" ||
	typeof outputPath !== "string"
) {
	throw new Error("Required: --split-path --sampling-metadata-path --dataset-lock-path --output-path");
}

const cohorts = await freezeM6EvaluationCohortsToFile({
	split_path: splitPath,
	sampling_metadata_path: samplingMetadataPath,
	dataset_lock_path: datasetLockPath,
	output_path: outputPath,
});
process.stdout.write(`${JSON.stringify(cohorts)}\n`);
