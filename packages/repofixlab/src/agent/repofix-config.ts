import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/canonical-json.ts";

export const REPOFIX_CONFIG_IDS = [
	"pi-general",
	"repofix-full",
	"repofix-no-localize",
	"repofix-no-verify-feedback",
] as const;

export type RepoFixConfigId = (typeof REPOFIX_CONFIG_IDS)[number];

export const REPOFIX_STAGES = [
	"UNDERSTAND",
	"LOCALIZE",
	"PLAN",
	"IMPLEMENT",
	"REFINE",
	"SELF_REVIEW",
] as const;

export type RepoFixStage = (typeof REPOFIX_STAGES)[number];

export interface RepoFixWorkflowConfig {
	readonly config_id: RepoFixConfigId;
	readonly workflow_kind: "pi_general" | "repofix";
	readonly include_localize_stage: boolean;
	readonly deliver_verification_feedback: boolean;
	readonly allow_refine_repo_exec: boolean;
	readonly stages: readonly RepoFixStage[];
}

const FULL_STAGES = [...REPOFIX_STAGES] as const;

export const REPOFIX_WORKFLOW_CONFIGS: Readonly<Record<RepoFixConfigId, RepoFixWorkflowConfig>> = {
	"pi-general": {
		config_id: "pi-general",
		workflow_kind: "pi_general",
		include_localize_stage: false,
		deliver_verification_feedback: false,
		allow_refine_repo_exec: false,
		stages: [],
	},
	"repofix-full": {
		config_id: "repofix-full",
		workflow_kind: "repofix",
		include_localize_stage: true,
		deliver_verification_feedback: true,
		allow_refine_repo_exec: true,
		stages: FULL_STAGES,
	},
	"repofix-no-localize": {
		config_id: "repofix-no-localize",
		workflow_kind: "repofix",
		include_localize_stage: false,
		deliver_verification_feedback: true,
		allow_refine_repo_exec: true,
		stages: FULL_STAGES.filter((stage) => stage !== "LOCALIZE"),
	},
	"repofix-no-verify-feedback": {
		config_id: "repofix-no-verify-feedback",
		workflow_kind: "repofix",
		include_localize_stage: true,
		deliver_verification_feedback: false,
		allow_refine_repo_exec: false,
		stages: FULL_STAGES,
	},
};

export interface RepoFixConfigurationDiffReport {
	readonly schema_version: "v1";
	readonly report_type: "repofix_configuration_diff";
	readonly configurations: readonly {
		readonly config_id: RepoFixConfigId;
		readonly configuration_sha256: string;
		readonly workflow_kind: RepoFixWorkflowConfig["workflow_kind"];
		readonly variable_values: {
			readonly include_localize_stage: boolean;
			readonly deliver_verification_feedback: boolean;
			readonly allow_refine_repo_exec: boolean;
			readonly stages: readonly RepoFixStage[];
		};
	}[];
	readonly shared_invariants: Readonly<Record<string, string>>;
	readonly report_sha256: string;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function getRepoFixWorkflowConfig(configId: RepoFixConfigId): RepoFixWorkflowConfig {
	const config = REPOFIX_WORKFLOW_CONFIGS[configId];
	if (config === undefined) throw new Error(`Unsupported RepoFix configuration: ${configId}`);
	return config;
}

export function assertRepoFixWorkflowConfig(config: RepoFixWorkflowConfig): void {
	if (!REPOFIX_CONFIG_IDS.includes(config.config_id)) {
		throw new Error(`Unsupported RepoFix configuration: ${config.config_id}`);
	}
	if (config.workflow_kind === "pi_general") {
		if (
			config.stages.length !== 0 ||
			config.include_localize_stage ||
			config.deliver_verification_feedback ||
			config.allow_refine_repo_exec
		) {
			throw new Error("pi-general must not receive RepoFix workflow controls");
		}
		return;
	}
	if (
		config.stages.length === 0 ||
		config.stages[0] !== "UNDERSTAND" ||
		config.stages.at(-1) !== "SELF_REVIEW" ||
		new Set(config.stages).size !== config.stages.length ||
		config.stages.some((stage) => !REPOFIX_STAGES.includes(stage)) ||
		config.stages.includes("LOCALIZE") !== config.include_localize_stage ||
		(config.deliver_verification_feedback === false && config.allow_refine_repo_exec)
	) {
		throw new Error(`RepoFix workflow configuration ${config.config_id} violates the v1 ablation contract`);
	}
}

export function createRepoFixConfigurationDiffReport(
	sharedInvariants: Readonly<Record<string, string>>,
): RepoFixConfigurationDiffReport {
	const configurations = REPOFIX_CONFIG_IDS.map((configId) => {
		const config = getRepoFixWorkflowConfig(configId);
		assertRepoFixWorkflowConfig(config);
		const variableValues = {
			include_localize_stage: config.include_localize_stage,
			deliver_verification_feedback: config.deliver_verification_feedback,
			allow_refine_repo_exec: config.allow_refine_repo_exec,
			stages: [...config.stages],
		};
		return {
			config_id: config.config_id,
			configuration_sha256: sha256({ workflow_kind: config.workflow_kind, variable_values: variableValues }),
			workflow_kind: config.workflow_kind,
			variable_values: variableValues,
		};
	});
	const draft = {
		schema_version: "v1" as const,
		report_type: "repofix_configuration_diff" as const,
		configurations,
		shared_invariants: Object.fromEntries(Object.entries(sharedInvariants).sort(([left], [right]) => left.localeCompare(right))),
	};
	return { ...draft, report_sha256: sha256(draft) };
}
