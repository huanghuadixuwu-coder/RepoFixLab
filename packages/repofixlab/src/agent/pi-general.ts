import { join, resolve } from "node:path";
import {
	type AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RepoToolTransport } from "../controller/client.ts";
import { REPO_TOOL_NAMES } from "../sandbox/protocol.ts";
import { createRepoTools } from "../sandbox/repo-tools.ts";

export interface PiGeneralSessionOptions {
	leaseId: string;
	attemptDirectory: string;
	cwd: string;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	transport: RepoToolTransport;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}

export interface PiGeneralSessionResult {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}

const REPOFIX_AGENT_SYSTEM_PROMPT = [
	"You are RepoFix Agent. Produce a minimal, reviewable repair for the user-reported defect.",
	"Workflow: localize with targeted repo_search, read only the relevant source and existing tests, make the smallest safe change, run the closest existing test, then inspect repo_diff before concluding.",
	"Treat runtime types and available APIs as evidence: before replacing direct access with a method call, trace the value's construction or established use in the relevant source. Do not infer a method from a similarly named class or abstraction elsewhere in the repository.",
	"Before choosing a verification command, inspect the repository's package scripts or existing test commands. Do not guess unsupported npm flags. Prefer the narrowest existing runner command; if it fails or times out, use that result to diagnose the repair and never describe it as passing.",
	"Do not browse directories one level at a time, read a directory with repo_read, create ad-hoc reproduction scripts, or add generated files outside the repository's established test locations.",
	"For this controlled SWE-bench evaluation, never modify files under test/ or tests/, and never create standalone test files. The evaluator applies its private test patch after your candidate; test-file overlap invalidates the candidate before tests run.",
	"repo_read accepts exactly one field: path. Do not add line ranges, content, or other fields. repo_search accepts query and optional path.",
	"repo_edit creates only new files when given content. To modify an existing file, send path, old_text, and new_text; old_text must be an exact unique fragment and new_text replaces it.",
	"repo_exec is non-shell: argv must always be a JSON string array, for example [\"node\", \"test/unit/adapters/http.js\"]. If a tool request is rejected, correct its input instead of working around the tool boundary.",
	"Do not claim a repair is verified until the relevant existing test command has run and repo_diff contains only intended changes.",
].join("\n");

function hasExactRepoToolSet(actualNames: string[]): boolean {
	return (
		actualNames.length === REPO_TOOL_NAMES.length &&
		REPO_TOOL_NAMES.every((expectedName) => actualNames.filter((name) => name === expectedName).length === 1)
	);
}

export async function createPiGeneralSession(options: PiGeneralSessionOptions): Promise<PiGeneralSessionResult> {
	const attemptDirectory = resolve(options.attemptDirectory);
	const cwd = resolve(options.cwd);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: {
			enabled: false,
			provider: { maxRetries: 0 },
		},
	});
	const sessionManager = SessionManager.create(cwd, attemptDirectory);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(attemptDirectory, "pi-agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: REPOFIX_AGENT_SYSTEM_PROMPT,
		appendSystemPrompt: [],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir: join(attemptDirectory, "pi-agent"),
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		resourceLoader,
		settingsManager,
		sessionManager,
		noTools: "builtin",
		tools: [...REPO_TOOL_NAMES],
		customTools: createRepoTools(options.leaseId, options.transport),
	});

	const actualToolNames = session.getAllTools().map((tool) => tool.name);
	if (!hasExactRepoToolSet(actualToolNames)) {
		session.dispose();
		throw new Error(
			`pi-general tool registry mismatch: expected ${REPO_TOOL_NAMES.join(",")}; received ${actualToolNames.join(",")}`,
		);
	}
	// Keep this explicit after registry verification. Pi intentionally ignores unknown names.
	session.setActiveToolsByName([...REPO_TOOL_NAMES]);

	return { session, sessionManager, settingsManager };
}
