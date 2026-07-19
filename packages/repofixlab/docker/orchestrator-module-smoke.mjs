import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runCli } from "../dist/cli/main.js";

if (
	typeof createAssistantMessageEventStream !== "function" ||
	typeof AuthStorage?.inMemory !== "function" ||
	typeof ModelRegistry?.inMemory !== "function" ||
	typeof runCli !== "function"
) {
	throw new Error("RepoFixLab orchestrator runtime modules did not expose the required API");
}
