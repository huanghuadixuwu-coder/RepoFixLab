import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseDocument } from "yaml";
import { canonicalContractSha256 } from "./run-contracts.ts";

const IdentifierSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$" });
const InstanceIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const RunConfigIdSchema = Type.Union([
	Type.Literal("pi-general"),
	Type.Literal("repofix-full"),
	Type.Literal("repofix-no-localize"),
	Type.Literal("repofix-no-verify-feedback"),
]);

const FrozenTaskSelectionSchema = Type.Object(
	{
		status: Type.Literal("frozen"),
		declared_task_count: Type.Integer({ minimum: 1, maximum: 300 }),
		instance_ids: Type.Array(InstanceIdSchema, { minItems: 1, maxItems: 300 }),
	},
	{ additionalProperties: false },
);

const PendingTaskSelectionSchema = Type.Object(
	{
		status: Type.Literal("pending_m3"),
		declared_task_count: Type.Integer({ minimum: 1, maximum: 300 }),
	},
	{ additionalProperties: false },
);

const ExperimentGroupSchema = Type.Object(
	{
		group_id: IdentifierSchema,
		task_count: Type.Integer({ minimum: 1, maximum: 300 }),
		config_ids: Type.Array(RunConfigIdSchema, { minItems: 1, maxItems: 4 }),
		replicates: Type.Integer({ minimum: 1, maximum: 10 }),
	},
	{ additionalProperties: false },
);

const NullableAdmissionCapSchema = Type.Union([
	Type.Integer({ minimum: 1, maximum: 10_000_000 }),
	Type.Null(),
]);

export const ExperimentPlanSchema = Type.Object(
	{
		schema_version: Type.Literal("v1"),
		plan_type: Type.Literal("experiment_capacity"),
		experiment_id: IdentifierSchema,
		task_selection: Type.Union([FrozenTaskSelectionSchema, PendingTaskSelectionSchema]),
		matrix: Type.Array(ExperimentGroupSchema, { minItems: 1, maxItems: 20 }),
		budget: Type.Object(
			{
				per_run_accounted_admission_cap_tokens: NullableAdmissionCapSchema,
				total_accounted_admission_cap_tokens: Type.Union([
					Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
					Type.Null(),
				]),
			},
			{ additionalProperties: false },
		),
		runtime_status: Type.Union([Type.Literal("m1_single_run_available"), Type.Literal("lifecycle_unavailable")]),
	},
	{
		$id: "urn:repofixlab:schema:v1:experiment-plan",
		additionalProperties: false,
	},
);

export type ExperimentPlan = Static<typeof ExperimentPlanSchema>;

export interface ExperimentGroupDryRunSummary {
	readonly group_id: string;
	readonly task_count: number;
	readonly config_ids: readonly string[];
	readonly replicates: number;
	readonly logical_run_count: number;
}

export interface ExperimentDryRunSummary {
	readonly schema_version: "v1";
	readonly summary_type: "experiment_dry_run";
	readonly experiment_id: string;
	readonly plan_sha256: string;
	readonly task_selection_status: "frozen" | "pending_m3";
	readonly declared_task_count: number;
	readonly logical_run_count: number;
	readonly per_run_accounted_admission_cap_tokens: number | null;
	readonly total_accounted_admission_cap_tokens: number | null;
	readonly groups: readonly ExperimentGroupDryRunSummary[];
	readonly runtime_status: "m1_single_run_available" | "lifecycle_unavailable";
	readonly lifecycle_available: boolean;
}

const experimentPlanValidator = Compile(ExperimentPlanSchema);

function yamlDiagnosticMessage(value: unknown): string {
	if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
		return value.message;
	}
	return String(value);
}

export function parseExperimentPlan(content: string): ExperimentPlan {
	const document = parseDocument(content, { uniqueKeys: true });
	const diagnostics = [...document.errors, ...document.warnings];
	if (diagnostics.length > 0) {
		throw new Error(`Experiment plan YAML is invalid: ${diagnostics.map(yamlDiagnosticMessage).join("; ")}`);
	}

	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 0 });
	} catch (error) {
		throw new Error(`Experiment plan YAML aliases are forbidden: ${yamlDiagnosticMessage(error)}`);
	}
	if (!experimentPlanValidator.Check(value)) {
		throw new Error("Experiment plan does not satisfy the strict v1 schema");
	}

	const groupIds = value.matrix.map((group) => group.group_id);
	if (new Set(groupIds).size !== groupIds.length) {
		throw new Error("Experiment plan group IDs must be unique");
	}
	for (const group of value.matrix) {
		if (group.task_count > value.task_selection.declared_task_count) {
			throw new Error(`Experiment group ${group.group_id} exceeds the declared task count`);
		}
		if (new Set(group.config_ids).size !== group.config_ids.length) {
			throw new Error(`Experiment group ${group.group_id} config IDs must be unique`);
		}
	}
	if (value.task_selection.status === "frozen") {
		if (
			value.task_selection.instance_ids.length !== value.task_selection.declared_task_count ||
			new Set(value.task_selection.instance_ids).size !== value.task_selection.instance_ids.length
		) {
			throw new Error("Frozen task selection must contain the declared number of unique instance IDs");
		}
	}

	const logicalRunCount = value.matrix.reduce(
		(total, group) => total + group.task_count * group.config_ids.length * group.replicates,
		0,
	);
	const perRunAdmissionCap = value.budget.per_run_accounted_admission_cap_tokens;
	const totalAdmissionCap = value.budget.total_accounted_admission_cap_tokens;
	if ((perRunAdmissionCap === null) !== (totalAdmissionCap === null))
		throw new Error("Experiment plan admission budget must be either fully bounded or fully unbounded");
	if (perRunAdmissionCap !== null && totalAdmissionCap !== null) {
		const calculatedAdmissionCap = logicalRunCount * perRunAdmissionCap;
		if (!Number.isSafeInteger(calculatedAdmissionCap)) {
			throw new Error("Experiment plan admission cap exceeds safe integer precision");
		}
		if (calculatedAdmissionCap !== totalAdmissionCap) {
			throw new Error(
				`Experiment plan total admission cap must equal ${logicalRunCount} logical runs multiplied by the per-run cap`,
			);
		}
	}
	return value;
}

export function createExperimentDryRunSummary(plan: ExperimentPlan): ExperimentDryRunSummary {
	const groups = plan.matrix.map((group) => ({
		group_id: group.group_id,
		task_count: group.task_count,
		config_ids: group.config_ids,
		replicates: group.replicates,
		logical_run_count: group.task_count * group.config_ids.length * group.replicates,
	}));
	return {
		schema_version: "v1",
		summary_type: "experiment_dry_run",
		experiment_id: plan.experiment_id,
		plan_sha256: canonicalContractSha256(plan),
		task_selection_status: plan.task_selection.status,
		declared_task_count: plan.task_selection.declared_task_count,
		logical_run_count: groups.reduce((total, group) => total + group.logical_run_count, 0),
		per_run_accounted_admission_cap_tokens: plan.budget.per_run_accounted_admission_cap_tokens,
		total_accounted_admission_cap_tokens: plan.budget.total_accounted_admission_cap_tokens,
		groups,
		runtime_status: plan.runtime_status,
		lifecycle_available: plan.runtime_status === "m1_single_run_available",
	};
}
