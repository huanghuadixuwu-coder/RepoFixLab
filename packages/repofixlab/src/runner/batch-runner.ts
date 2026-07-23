import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ExperimentPlan } from "../contracts/experiment-plan.ts";
import { canonicalContractSha256, verifyRunResult, type RunResult } from "../contracts/run-contracts.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { RunMetricEvidence } from "../metrics/experiment-metrics.ts";
import { publishExperimentReport } from "../report/experiment-report.ts";
import {
	BatchStateStore,
	ExperimentOwnerLease,
	type BatchRunSpec,
	type BatchRunState,
} from "./batch-state.ts";
import { GlobalBudgetLedger, GlobalBudgetWriterLease } from "./global-budget-ledger.ts";
import { KnownProviderUsageBatchFailure, PreProviderBatchFailure } from "./pre-provider-failure.ts";

export interface BatchRunExecutor {
	execute(
		spec: BatchRunSpec,
		attemptId: string,
		hooks: {
			readonly agentFinished: () => Promise<void>;
			readonly evaluating: () => Promise<void>;
		},
	): Promise<RunResult>;
}

export interface BatchBudgetAdmission {
	readonly ledger_path: string;
	readonly cap_tokens: number;
	readonly per_run_reservation_tokens: number;
}

export interface BatchExecutionOptions {
	readonly budget_admission?: BatchBudgetAdmission;
	/**
	 * Stable identity for one physical execution. It is persisted in the batch
	 * root and incorporated into every Controller attempt ID, so a repaired
	 * rerun cannot accidentally replay another execution's durable operations.
	 */
	readonly execution_namespace?: string;
	/** Stop before executing another logical run when setup failed before any Provider request. */
	readonly stop_on_pre_provider_failure?: boolean;
	readonly report_evidence_loader?: (
		root: string,
		specs: readonly BatchRunSpec[],
		results: Readonly<Record<string, RunResult>>,
	) => Promise<Readonly<Record<string, RunMetricEvidence>>>;
}

export interface BatchRunAssignment {
	readonly group_id: string;
	readonly instance_ids: readonly string[];
}

export interface BatchExecutionSummary {
	readonly schema_version: "v1";
	readonly summary_type: "m5_batch_execution";
	readonly root: string;
	readonly completed_run_ids: readonly string[];
	readonly failed_run_ids: readonly string[];
	readonly report: {
		readonly aggregate_sha256: string;
		readonly json_path: string;
		readonly html_path: string;
	};
}

const EXECUTION_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function executionNamespaceForRoot(root: string, requested?: string): string {
	if (requested !== undefined) {
		if (!EXECUTION_NAMESPACE.test(requested)) throw new Error("execution_namespace is invalid");
		return requested;
	}
	return `execution-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 24)}`;
}

export function attemptIdFor(
	spec: BatchRunSpec,
	sequence: number,
	executionNamespace: string,
): string {
	if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("attempt sequence must be positive");
	if (!EXECUTION_NAMESPACE.test(executionNamespace)) throw new Error("execution_namespace is invalid");
	const logicalRunToken = createHash("sha256").update(spec.run_id, "utf8").digest("hex").slice(0, 32);
	return `attempt-${executionNamespace}-run-${logicalRunToken}-${String(sequence).padStart(3, "0")}`;
}

function sameSpec(left: BatchRunSpec, right: BatchRunSpec): boolean {
	return stableStringify(left) === stableStringify(right);
}

function specFromState(state: BatchRunState): BatchRunSpec {
	return {
		run_id: state.run_id,
		group_id: state.group_id,
		instance_id: state.instance_id,
		config_id: state.config_id,
		replicate: state.replicate,
	};
}

function assertBatchSpecs(specs: readonly BatchRunSpec[]): void {
	const ids = specs.map((spec) => spec.run_id);
	if (new Set(ids).size !== ids.length) throw new Error("Batch specs contain duplicate run IDs");
}

async function writeImmutable(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporary, path);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		const existing = await readFile(path, "utf8");
		if (existing !== content) throw new Error(`Immutable artifact conflict: ${path}`);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

async function writeExecutionIdentity(root: string, executionNamespace: string): Promise<void> {
	const resolvedRoot = resolve(root);
	await writeImmutable(
		join(resolvedRoot, "execution-identity.json"),
		stableStringify({
			schema_version: "v1",
			record_type: "batch_execution_identity",
			execution_namespace: executionNamespace,
			execution_root_sha256: createHash("sha256").update(resolvedRoot, "utf8").digest("hex"),
		}),
	);
}

class BatchResultStore {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root, "results");
	}

	private pathFor(runId: string): string {
		return join(this.root, `${runId}.json`);
	}

	async write(result: RunResult): Promise<void> {
		const verified = verifyRunResult(result);
		await writeImmutable(this.pathFor(verified.run_id), stableStringify(verified));
	}

	async read(state: BatchRunState): Promise<RunResult> {
		let raw: string;
		try {
			raw = await readFile(this.pathFor(state.run_id), "utf8");
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				throw new Error(`completed_run_missing_immutable_result: ${state.run_id}`);
			}
			throw error;
		}
		const result = verifyRunResult(JSON.parse(raw) as unknown);
		if (
			result.run_id !== state.run_id ||
			result.attempt_id !== state.attempt_id ||
			result.terminal_status !== "completed" ||
			result.result_sha256 !== state.result_sha256
		) {
			throw new Error(`completed_run_result_binding_invalid: ${state.run_id}`);
		}
		return result;
	}
}

function deterministicRunId(
	plan: ExperimentPlan,
	groupId: string,
	instanceId: string,
	configId: BatchRunSpec["config_id"],
	replicate: number,
): string {
	return `run-${canonicalContractSha256({
		experiment_id: plan.experiment_id,
		plan_sha256: canonicalContractSha256(plan),
		group_id: groupId,
		instance_id: instanceId,
		config_id: configId,
		replicate,
	}).slice(0, 32)}`;
}

/**
 * M5 converts a frozen cohort assignment into an immutable logical-run set.
 * It never selects the first N dataset entries itself: M6 must supply the
 * frozen Dev/Validation/Test cohort assignment explicitly.
 */
export function createBatchRunSpecs(
	plan: ExperimentPlan,
	assignments: readonly BatchRunAssignment[],
): readonly BatchRunSpec[] {
	if (plan.task_selection.status !== "frozen") throw new Error("Batch run specs require frozen task selection");
	const assignmentByGroup = new Map(assignments.map((assignment) => [assignment.group_id, assignment]));
	if (assignmentByGroup.size !== assignments.length) throw new Error("Batch group assignments contain duplicate group IDs");
	if (assignmentByGroup.size !== plan.matrix.length) throw new Error("Batch group assignments do not match the frozen experiment matrix");
	const allowedInstances = new Set(plan.task_selection.instance_ids);
	const specs: BatchRunSpec[] = [];
	for (const group of plan.matrix) {
		const assignment = assignmentByGroup.get(group.group_id);
		if (assignment === undefined) throw new Error(`Batch assignment is missing group ${group.group_id}`);
		if (assignment.instance_ids.length !== group.task_count) {
			throw new Error(`Batch assignment ${group.group_id} does not satisfy its frozen task count`);
		}
		if (new Set(assignment.instance_ids).size !== assignment.instance_ids.length) {
			throw new Error(`Batch assignment ${group.group_id} contains duplicate task IDs`);
		}
		for (const instanceId of assignment.instance_ids) {
			if (!allowedInstances.has(instanceId)) throw new Error(`Batch assignment uses an unfrozen task: ${instanceId}`);
			// Formal main, ablation, and stability cohorts intentionally overlap.
			// group_id remains part of the immutable logical-run identity, so a task
			// may occur in more than one group without collapsing observations.
			for (const configId of group.config_ids) {
				for (let replicate = 1; replicate <= group.replicates; replicate += 1) {
					specs.push({
						run_id: deterministicRunId(plan, group.group_id, instanceId, configId, replicate),
						group_id: group.group_id,
						instance_id: instanceId,
						config_id: configId,
						replicate,
					});
				}
			}
		}
	}
	assertBatchSpecs(specs);
	return specs;
}

async function reconcileSpecs(store: BatchStateStore, specs: readonly BatchRunSpec[]): Promise<void> {
	const states = store.values;
	if (states.length === 0) {
		for (const spec of specs) await store.register(spec);
		return;
	}
	if (states.length !== specs.length) throw new Error("Persisted batch run set differs from the immutable invocation");
	const requested = new Map(specs.map((spec) => [spec.run_id, spec]));
	for (const state of states) {
		const spec = requested.get(state.run_id);
		if (spec === undefined || !sameSpec(specFromState(state), spec)) {
			throw new Error("Persisted batch run specification drifted from the immutable invocation");
		}
	}
}

/**
 * M5 deliberately serializes work under an owner lease. The executor is
 * injected so M6 can bind it to the frozen Controller lifecycle without
 * changing state-machine, durability, or aggregate-report semantics.
 */
export async function executeBatch(
	root: string,
	specs: readonly BatchRunSpec[],
	executor: BatchRunExecutor,
	options: BatchExecutionOptions = {},
): Promise<BatchExecutionSummary> {
	assertBatchSpecs(specs);
	const lease = await ExperimentOwnerLease.acquire(root);
	let budgetLease: GlobalBudgetWriterLease | null = null;
	try {
		const executionNamespace = executionNamespaceForRoot(root, options.execution_namespace);
		await writeExecutionIdentity(root, executionNamespace);
		const store = await BatchStateStore.open(root);
		await reconcileSpecs(store, specs);
		const results = new BatchResultStore(root);
		const budget = options.budget_admission;
		if (budget !== undefined) budgetLease = await GlobalBudgetWriterLease.acquire(budget.ledger_path);
		const ledger = budget === undefined ? null : await GlobalBudgetLedger.open(budget.ledger_path, budget.cap_tokens);
		const completed: string[] = [];
		const failed: string[] = [];
		const resultByRun: Record<string, RunResult> = {};
		for (const state of store.values) {
			await lease.heartbeat();
			if (state.status === "completed") {
				resultByRun[state.run_id] = await results.read(state);
				completed.push(state.run_id);
				continue;
			}
			if (state.status === "failed") {
				failed.push(state.run_id);
				continue;
			}
			if (state.status !== "queued") {
				await store.transition(state.run_id, "failed", state.attempt_id, "interrupted_attempt_requires_recovery");
				failed.push(state.run_id);
				continue;
			}
			let reservation = budget?.per_run_reservation_tokens ?? null;
			if (ledger !== null && reservation !== null && !(await ledger.reserve(reservation))) {
				await store.transition(state.run_id, "failed", null, "budget_exhausted");
				failed.push(state.run_id);
				continue;
			}
			const attemptId = attemptIdFor(state, 1, executionNamespace);
			try {
				await store.transition(state.run_id, "preparing", attemptId);
				await store.transition(state.run_id, "running", attemptId);
				const result = await executor.execute(state, attemptId, {
					agentFinished: () => store.transition(state.run_id, "agent_finished", attemptId),
					evaluating: () => store.transition(state.run_id, "evaluating", attemptId),
				});
				if (result.run_id !== state.run_id || result.attempt_id !== attemptId) {
					throw new Error("Executor result identity drifted from the registered logical run and attempt");
				}
				if (result.terminal_status !== "completed") throw new Error(`Executor returned non-completed ${result.termination_reason}`);
				await results.write(result);
				if (ledger !== null && reservation !== null) {
					await ledger.settle(reservation, result.usage.accounted_tokens);
					reservation = null;
				}
				await store.transition(state.run_id, "completed", attemptId, result.termination_reason, result.result_sha256);
				resultByRun[state.run_id] = result;
				completed.push(state.run_id);
			} catch (error) {
				if (ledger !== null && reservation !== null) {
					if (error instanceof PreProviderBatchFailure) await ledger.settle(reservation, 0);
					else if (error instanceof KnownProviderUsageBatchFailure) await ledger.settle(reservation, error.accountedTokens);
					else await ledger.chargeUnverified(reservation);
					reservation = null;
				}
				const live = store.values.find((value) => value.run_id === state.run_id);
				if (live !== undefined && live.status !== "completed" && live.status !== "failed") {
					await store.transition(
						state.run_id,
						"failed",
						attemptId,
						error instanceof Error ? error.message.slice(0, 200) : "batch_executor_failure",
					);
				}
				failed.push(state.run_id);
				if (options.stop_on_pre_provider_failure === true && error instanceof PreProviderBatchFailure) break;
			}
		}
		const reportEvidence: Readonly<Record<string, RunMetricEvidence>> = options.report_evidence_loader === undefined
			? {}
			: await options.report_evidence_loader(root, specs, resultByRun);
		const report = await publishExperimentReport(root, specs, resultByRun, reportEvidence);
		return {
			schema_version: "v1",
			summary_type: "m5_batch_execution",
			root,
			completed_run_ids: completed.sort(),
			failed_run_ids: failed.sort(),
			report: {
				aggregate_sha256: report.aggregate.aggregate_sha256,
				json_path: report.json_path,
				html_path: report.html_path,
			},
		};
	} finally {
		await budgetLease?.release();
		await lease.release();
	}
}

export function incompleteRuns(states: readonly BatchRunState[]): readonly BatchRunState[] {
	return states.filter((state) => state.status !== "completed" && state.status !== "failed");
}
