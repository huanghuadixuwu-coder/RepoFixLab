/**
 * Fixed RepoFix PLAN-skill loading and Provider-context projection.
 *
 * The skill is an instruction component, not memory: it is loaded from the
 * repository, hash-bound once, and inserted as one stable PLAN-only message.
 * It is never written into L0/L1/L2 or passed to the memory condenser.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Message } from "@earendil-works/pi-ai/compat";

export const PLAN_SKILL_POLICIES = ["disabled", "plan-robustness-v1"] as const;
export type PlanSkillPolicyId = (typeof PLAN_SKILL_POLICIES)[number];

const PLAN_SKILL_ID = "plan-robustness-v1";
const PLAN_SKILL_MAX_SOURCE_BYTES = 16 * 1_024;
const PLAN_SKILL_SHA256 = "5aa32fdc161c657084f75313e32eea3024a77879503144d0e2264f0139ec2f85";
const PLAN_SKILL_MARKER = '<repofix_plan_skill id="';
const PLAN_SKILL_FILES = [
	"SKILL.md",
	"references/evidence-and-scope.md",
	"references/state-and-probe.md",
	"references/bad-case-patterns.md",
] as const;

/** Immutable identity and text for the one supported PLAN skill. */
export interface PlanSkillBundle {
	readonly skill_id: typeof PLAN_SKILL_ID;
	readonly sha256: string;
	readonly source_bytes: number;
	readonly content: string;
}

/** Hash exact ordered source paths and contents, not a platform-dependent directory representation. */
function skillSha256(files: readonly { readonly path: string; readonly content: string }[]): string {
	return createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex");
}

/** Require a resolved fixed skill file to remain inside its regular, non-symlink root. */
function assertPathWithin(root: string, path: string): void {
	const pathFromRoot = relative(root, path);
	if (
		pathFromRoot === "" ||
		pathFromRoot === ".." ||
		pathFromRoot.startsWith(`..${sep}`) ||
		isAbsolute(pathFromRoot)
	) {
		throw new Error(`RepoFix PLAN skill file escaped its fixed root: ${path}`);
	}
}

/** Load the reviewed fixed bundle, or return null for the explicit disabled policy. */
export async function loadPlanSkill(policy: PlanSkillPolicyId): Promise<PlanSkillBundle | null> {
	if (policy === "disabled") return null;
	if (policy !== PLAN_SKILL_ID) throw new Error(`Unsupported RepoFix PLAN skill policy: ${String(policy)}`);

	const root = fileURLToPath(new URL("../../skills/plan-robustness-v1/", import.meta.url));
	const rootStats = await lstat(root);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
		throw new Error("RepoFix PLAN skill root must be a regular non-symlink directory");
	}
	const realRoot = await realpath(root);
	const files: { path: string; content: string }[] = [];
	let sourceBytes = 0;
	for (const relativePath of PLAN_SKILL_FILES) {
		const candidate = join(root, ...relativePath.split("/"));
		const stats = await lstat(candidate);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			throw new Error(`RepoFix PLAN skill source must be a regular non-symlink file: ${relativePath}`);
		}
		const resolved = await realpath(candidate);
		assertPathWithin(realRoot, resolved);
		const content = await readFile(resolved, "utf8");
		sourceBytes += Buffer.byteLength(content, "utf8");
		files.push({ path: relativePath, content });
	}
	if (sourceBytes > PLAN_SKILL_MAX_SOURCE_BYTES) {
		throw new Error(`RepoFix PLAN skill exceeds ${String(PLAN_SKILL_MAX_SOURCE_BYTES)} UTF-8 source bytes`);
	}
	const sha256 = skillSha256(files);
	if (sha256 !== PLAN_SKILL_SHA256) throw new Error("RepoFix PLAN skill content differs from its reviewed SHA-256");

	return {
		skill_id: PLAN_SKILL_ID,
		sha256,
		source_bytes: sourceBytes,
		content: files.map((file) => `--- ${file.path} ---\n${file.content.trimEnd()}`).join("\n\n"),
	};
}

/** Insert the skill once after the stable PLAN request and before dynamic memory or protocol messages. */
export function injectPlanSkill(context: Context, bundle: PlanSkillBundle, insertionIndex: number): Context {
	const existing = context.messages.filter(
		(message) =>
			message.role === "user" &&
			typeof message.content === "string" &&
			message.content.startsWith(PLAN_SKILL_MARKER),
	);
	if (existing.length > 1) throw new Error("RepoFix PLAN skill appears more than once in Provider context");
	if (existing.length === 1) return context;
	const anchor = context.messages[insertionIndex - 1];
	if (anchor?.role !== "user") {
		throw new Error("RepoFix PLAN skill requires the stable PLAN request as its user-message anchor");
	}
	const message: Message = {
		role: "user",
		content: `<repofix_plan_skill id="${bundle.skill_id}" sha256="${bundle.sha256}">\n${bundle.content}\n</repofix_plan_skill>`,
		timestamp: anchor.timestamp,
	};
	return {
		...context,
		messages: [...context.messages.slice(0, insertionIndex), message, ...context.messages.slice(insertionIndex)],
	};
}
