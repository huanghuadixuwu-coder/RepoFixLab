import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runCli } from "../dist/cli/main.js";
import { publishM7ContinuationReport } from "../dist/m7/continuation-report.js";
import { publishM7SecurityAuditReport } from "../dist/m7/security-audit.js";
import { publishM8Analysis } from "../dist/m8/analysis.js";
import { finalizeM7ContinuationSource } from "../dist/m7/batch-runner.js";
import { createM9RunSpecs } from "../dist/m9/batch-runner.js";
import { publishM9Analysis } from "../dist/m9/analysis.js";

if (
	typeof createAssistantMessageEventStream !== "function" ||
	typeof AuthStorage?.inMemory !== "function" ||
	typeof ModelRegistry?.inMemory !== "function" ||
	typeof runCli !== "function" ||
	typeof finalizeM7ContinuationSource !== "function" ||
	typeof publishM7ContinuationReport !== "function" ||
	typeof publishM7SecurityAuditReport !== "function"
	|| typeof publishM8Analysis !== "function" ||
	typeof createM9RunSpecs !== "function" ||
	typeof publishM9Analysis !== "function"
) {
	throw new Error("RepoFixLab orchestrator runtime modules did not expose the required API");
}
