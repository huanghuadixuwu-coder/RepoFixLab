/**
 * 脚本职责：把并发任务执行为真实 RepoFix 定位流程并交给结果门禁发布。
 * 输入边界：接收冻结任务映射、真实 Controller、模型闸门和 PostgreSQL 任务端口。
 * 输出边界：产生 UNDERSTAND、LOCALIZE 证据及不可变最终结果。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { RepoFixSessionResult, RepoFixTrajectoryEvent, StageRecovery } from "../agent/repofix.ts";
import { createRepoFixConfigurationDiffReport, getRepoFixWorkflowConfig } from "../agent/repofix-config.ts";
import type { StageCompletion } from "../agent/repofix-fsm.ts";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { RepoToolTransport } from "../controller/client.ts";
import { HttpRuntimeController, type RuntimeController } from "../runner/controller-runtime.ts";
import {
	createDeepSeekV4FlashRuntime,
	createFrozenRepoFixSession,
	type FrozenModelRuntime,
	installRunAdmissionGate,
	runtimeIdentityFromSession,
} from "../runner/runtime-factory.ts";
import {
	DirectoryTaskEnvironmentLockSource,
	FilePublicTaskSource,
	type PublicTaskSource,
	type TaskEnvironmentLockSource,
} from "../runner/task-source.ts";
import { ArtifactStore } from "../storage/artifact-store.ts";
import type { CapacityGate } from "./capacity-gate.ts";
import type { ConcurrencyTask, TaskExecutionResult, TaskExecutor, TaskExecutorFactory } from "./contracts.ts";
import type { LeaseManager } from "./lease-manager.ts";
import { type RepoFixLocalizationResult, runRepoFixLocalization } from "./localize-workflow.ts";
import { ResultGate } from "./result-gate.ts";
import type { TaskStore } from "./task-store.ts";

const LOGICAL_AGENT_CWD = "/testbed";
const LOCALIZE_MODEL_TURN_LIMIT = 32;
const TASK_ENVIRONMENT_LOCK_ROOT = fileURLToPath(new URL("../../configs/runtime/m6-26-task-v1", import.meta.url));
const RUNTIME_CONFIG_ROOT = fileURLToPath(new URL("../../configs/runtime", import.meta.url));

export interface LocalizeSessionFactoryOptions {
	readonly leaseId: string;
	readonly attemptDirectory: string;
	readonly cwd: string;
	readonly transport: RepoToolTransport;
}

export interface LocalizeExecutionDependencies {
	readonly controller: RuntimeController;
	readonly publicTaskSource: PublicTaskSource;
	readonly environmentLockSource: TaskEnvironmentLockSource;
	readonly createRepoFixSession: (options: LocalizeSessionFactoryOptions) => Promise<RepoFixSessionResult>;
	readonly modelSpecSha256: string;
	readonly now: () => Date;
}

export interface LocalizeTaskExecutorFactoryOptions {
	readonly root: string;
	readonly store: TaskStore;
	readonly model_gate: CapacityGate;
	readonly lease_manager: LeaseManager;
	readonly dependencies: LocalizeExecutionDependencies;
	readonly instance_by_idempotency_key: ReadonlyMap<string, string>;
}

export interface LocalizeTaskExecutorSnapshot {
	readonly active_executions: number;
	readonly peak_active_executions: number;
	readonly completed_tasks: number;
	readonly failed_tasks: number;
	readonly localization_candidates: number;
	readonly model_wait_ms_total: number;
	readonly model_wait_ms_max: number;
}

interface LocalizationAttemptSummary {
	readonly schema_version: "v1";
	readonly summary_type: "workstream7_localization_attempt";
	readonly task_id: string;
	readonly attempt_id: string;
	readonly instance_id: string;
	readonly repository: string;
	readonly baseline_commit: string;
	readonly stages: readonly ["UNDERSTAND", "LOCALIZE"];
	readonly localize_sha256: string;
	readonly candidate_count: number;
	readonly exclusion_count: number;
	readonly model_turns: number;
	readonly provider_tokens: number;
	readonly model_wait_ms: number;
	readonly agent_wall_ms: number;
	readonly worker_released: true;
	readonly completed_at: string;
}

interface LocalizationAttemptResult {
	readonly baseline_commit: string;
	readonly candidate_count: number;
	readonly model_wait_ms: number;
}

/**
 * 函数职责：把未知错误转换为有限长度持久化消息。
 * 输入约束：允许接收模型、Controller、文件系统及数据库错误。
 * 返回结果：返回长度不超过两千字符的稳定文本。
 * 失败语义：该函数不抛出异常且不泄露错误对象结构。
 */
function safeMessage(error: unknown): string {
	return (error instanceof Error ? error.message : "workstream7_localization_failed").slice(0, 2_000);
}

/**
 * 函数职责：移除会话消息中的非 JSON 运行时值。
 * 输入约束：输入来自当前 RepoFix 会话消息集合。
 * 返回结果：返回可被稳定序列化的深拷贝值。
 * 失败语义：循环结构及不可序列化值会同步抛出异常。
 */
function jsonSerializable(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/**
 * 函数职责：统计会话中的模型轮次和 Provider token 数量。
 * 输入约束：消息集合来自已经完成 LOCALIZE 的 RepoFix 会话。
 * 返回结果：返回助手消息数量及其 usage.totalTokens 总和。
 * 失败语义：函数不修改会话消息且不访问 Provider。
 */
function sessionUsage(session: RepoFixSessionResult): {
	readonly model_turns: number;
	readonly provider_tokens: number;
} {
	let modelTurns = 0;
	let providerTokens = 0;
	for (const message of session.session.messages) {
		if (message.role !== "assistant") continue;
		modelTurns += 1;
		providerTokens += message.usage.totalTokens;
	}
	return { model_turns: modelTurns, provider_tokens: providerTokens };
}

/**
 * 函数职责：持久化一个已通过契约校验的定位阶段产物。
 * 输入约束：ArtifactStore 属于当前任务且阶段仅为 UNDERSTAND、LOCALIZE。
 * 返回结果：阶段 JSON 和上下文预算均完成不可变写入后返回。
 * 失败语义：重复路径及写入失败时拒绝 Promise。
 */
async function writeStageEvidence(
	store: ArtifactStore,
	completion: StageCompletion,
	session: RepoFixSessionResult,
): Promise<void> {
	if (completion.stage !== "UNDERSTAND" && completion.stage !== "LOCALIZE") {
		throw new Error("workstream7_stage_boundary_violated");
	}
	await store.writeNew(`stages/${completion.stage.toLowerCase()}.json`, stableStringify(completion), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "agent",
	});
	await store.writeNew(
		`stages/${completion.stage.toLowerCase()}.context-budget.json`,
		stableStringify(session.repoToolOutputBudget.snapshot),
		{
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "orchestrator",
		},
	);
}

/**
 * 函数职责：持久化阶段完成恢复事件。
 * 输入约束：恢复事件必须来自当前 RepoFix 会话。
 * 返回结果：恢复证据完成不可变写入后返回。
 * 失败语义：同阶段重复恢复及文件写入失败时拒绝 Promise。
 */
async function writeRecoveryEvidence(store: ArtifactStore, recovery: StageRecovery): Promise<void> {
	await store.writeNew(`stages/${recovery.stage.toLowerCase()}.recovery.json`, stableStringify(recovery), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
}

/**
 * 函数职责：执行单项 Controller 隔离的真实 RepoFix 定位流程。
 * 输入约束：任务、实例、attempt、暂存区及冻结依赖必须一一绑定。
 * 返回结果：返回 Controller 基线、定位候选数和模型等待时间。
 * 失败语义：输入漂移、模型失败及资源回收失败时拒绝 Promise。
 */
async function runLocalizationAttempt(
	task: ConcurrencyTask,
	instanceId: string,
	attemptId: string,
	store: ArtifactStore,
	modelGate: CapacityGate,
	dependencies: LocalizeExecutionDependencies,
): Promise<LocalizationAttemptResult> {
	const environment = await dependencies.environmentLockSource.load(instanceId);
	const publicTask = await dependencies.publicTaskSource.load(instanceId, environment);
	if (
		publicTask.task.repo !== task.request.repository ||
		publicTask.task.base_commit !== task.request.baseline_commit ||
		publicTask.task.problem_statement !== task.request.task_content
	) {
		throw new Error("workstream7_task_binding_mismatch");
	}
	await store.writeNew("public-task.json", stableStringify(publicTask.manifest), {
		mediaType: "application/json",
		sensitivity: "public",
		generatedBy: "orchestrator",
	});
	await store.writeNew("public-task-record.json", publicTask.recordBytes, {
		mediaType: "application/json",
		sensitivity: "public",
		generatedBy: "orchestrator",
	});
	await store.writeNew("task-environment-lock.json", environment.lockBytes, {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});

	const controller = dependencies.controller;
	let controllerAttemptStarted = false;
	let modelAcquired = false;
	let sessionDirectory: string | null = null;
	let session: RepoFixSessionResult | null = null;
	let localization: RepoFixLocalizationResult | null = null;
	let usage: ReturnType<typeof sessionUsage> | null = null;
	let modelWaitMs = 0;
	let agentWallMs = 0;
	const trajectory: RepoFixTrajectoryEvent[] = [];
	let executionError: unknown = null;
	try {
		const preflight = await controller.preflight(
			attemptId,
			`${attemptId}:preflight`,
			environment.candidateId,
			instanceId,
		);
		controllerAttemptStarted = true;
		if (
			preflight.task_environment_lock_id !== environment.lockId ||
			preflight.task_environment_lock_sha256 !== environment.lockSha256 ||
			preflight.candidate_sha256 !== environment.candidateSha256 ||
			preflight.base_commit !== publicTask.task.base_commit
		) {
			throw new Error("workstream7_controller_preflight_binding_mismatch");
		}
		await store.writeNew("controller-preflight.json", stableStringify(preflight), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "controller",
		});
		const leaseId = (await controller.prepare(attemptId, `${attemptId}:prepare`, environment.candidateId, instanceId))
			.leaseId;
		const transport = controller.toolTransport(attemptId);
		const probe = await transport.execute({
			leaseId,
			operationId: `${attemptId}:worker-probe`,
			tool: "repo_list",
			input: {},
		});
		if (probe.tool !== "repo_list") throw new Error("workstream7_worker_probe_invalid");
		await store.writeNew("controller-worker-probe.json", stableStringify(probe), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "controller",
		});

		const waitStarted = performance.now();
		await modelGate.acquire();
		modelAcquired = true;
		modelWaitMs = Math.max(0, Math.ceil(performance.now() - waitStarted));
		sessionDirectory = await mkdtemp(join(tmpdir(), "repofixlab-localize-"));
		session = await dependencies.createRepoFixSession({
			leaseId,
			attemptDirectory: join(sessionDirectory, "session"),
			cwd: LOGICAL_AGENT_CWD,
			transport,
		});
		const identity = runtimeIdentityFromSession(session.session, dependencies.modelSpecSha256);
		await store.writeNew(
			"configuration-diff.json",
			stableStringify(
				createRepoFixConfigurationDiffReport({
					model_spec_sha256: identity.modelSpecSha256,
					system_prompt_sha256: identity.systemPromptSha256,
					tool_schema_sha256: identity.toolSchemaSha256,
				}),
			),
			{
				mediaType: "application/json",
				sensitivity: "internal",
				generatedBy: "orchestrator",
			},
		);
		installRunAdmissionGate(session.session, {
			accountedTokens: null,
			modelTurns: LOCALIZE_MODEL_TURN_LIMIT,
			toolCalls: null,
		});
		const agentStarted = performance.now();
		localization = await runRepoFixLocalization(session, publicTask.task.problem_statement, {
			onStageComplete: (completion) => {
				if (session === null) throw new Error("workstream7_session_missing_during_stage_write");
				return writeStageEvidence(store, completion, session);
			},
			onStageRecovery: (recovery) => writeRecoveryEvidence(store, recovery),
			onTrajectoryEvent: async (event) => {
				trajectory.push(event);
			},
		});
		agentWallMs = Math.max(0, Math.ceil(performance.now() - agentStarted));
		await store.writeNew(
			"repofix-control-trajectory.json",
			stableStringify({
				schema_version: "v1",
				trajectory_type: "repofix_localization_control",
				task_id: task.task_id,
				attempt_id: attemptId,
				events: trajectory.map((event, index) => ({ sequence: index + 1, ...event })),
			}),
			{
				mediaType: "application/json",
				sensitivity: "internal",
				generatedBy: "orchestrator",
			},
		);
		await store.writeNew("trajectory.json", stableStringify(jsonSerializable(session.session.messages)), {
			mediaType: "application/json",
			sensitivity: "internal",
			generatedBy: "agent",
		});
		usage = sessionUsage(session);
	} catch (error) {
		executionError = error;
	} finally {
		session?.session.dispose();
		if (sessionDirectory !== null) {
			await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
		if (modelAcquired) modelGate.release();
		if (controllerAttemptStarted) {
			let cleanupError: unknown = null;
			try {
				const released = await controller.abort(attemptId, `${attemptId}:abort`);
				if (!released.clean) cleanupError = new Error("workstream7_worker_cleanup_incomplete");
			} catch (error) {
				cleanupError = error;
			}
			if (cleanupError !== null) {
				executionError =
					executionError === null
						? cleanupError
						: new AggregateError([executionError, cleanupError], "workstream7_execution_and_cleanup_failed");
			}
		}
	}
	if (executionError !== null) throw executionError;
	if (session === null || localization === null || usage === null) {
		throw new Error("workstream7_localization_result_missing");
	}
	const summary: LocalizationAttemptSummary = {
		schema_version: "v1",
		summary_type: "workstream7_localization_attempt",
		task_id: task.task_id,
		attempt_id: attemptId,
		instance_id: instanceId,
		repository: publicTask.task.repo,
		baseline_commit: publicTask.task.base_commit,
		stages: ["UNDERSTAND", "LOCALIZE"],
		localize_sha256: localization.localize_sha256,
		candidate_count: localization.localize.candidates.length,
		exclusion_count: localization.localize.exclusions.length,
		model_turns: usage.model_turns,
		provider_tokens: usage.provider_tokens,
		model_wait_ms: modelWaitMs,
		agent_wall_ms: agentWallMs,
		worker_released: true,
		completed_at: dependencies.now().toISOString(),
	};
	await store.writeNew("localize-summary.json", stableStringify(summary), {
		mediaType: "application/json",
		sensitivity: "internal",
		generatedBy: "orchestrator",
	});
	return {
		baseline_commit: publicTask.task.base_commit,
		candidate_count: localization.localize.candidates.length,
		model_wait_ms: modelWaitMs,
	};
}

/**
 * 类职责：执行一项已领取的真实 RepoFix 定位任务。
 * 持有状态：保存任务、attempt 和所属执行器工厂。
 * 协作边界：不创建额外任务且不共享任务局部文件。
 */
export class LocalizeTaskExecutor implements TaskExecutor {
	private readonly task: ConcurrencyTask;
	private readonly attemptId: string;
	private readonly factory: LocalizeTaskExecutorFactory;

	/**
	 * 函数职责：绑定单项任务执行上下文。
	 * 输入约束：任务 attempt 必须与工厂传入值一致。
	 * 返回结果：创建尚未占用模型闸门的执行器。
	 * 失败语义：绑定失配时同步抛出异常。
	 */
	constructor(task: ConcurrencyTask, attemptId: string, factory: LocalizeTaskExecutorFactory) {
		if (task.attempt_id !== attemptId) throw new Error("workstream7_attempt_binding_mismatch");
		this.task = task;
		this.attemptId = attemptId;
		this.factory = factory;
	}

	/**
	 * 函数职责：执行当前任务的状态、定位和发布闭环。
	 * 输入约束：执行器只能由绑定工厂创建并调用一次。
	 * 返回结果：返回任务、attempt、基线和暂存路径绑定。
	 * 失败语义：任一阶段失败时由工厂记录稳定失败状态。
	 */
	execute(): Promise<TaskExecutionResult> {
		return this.factory.executeTask(this.task, this.attemptId);
	}
}

/**
 * 类职责：创建独立定位执行器并集中维护并发执行统计。
 * 持有状态：保存任务端口、模型闸门、租约管理器、实例映射和计数器。
 * 协作边界：经 ResultGate 发布结果，不负责调度任务领取。
 */
export class LocalizeTaskExecutorFactory implements TaskExecutorFactory {
	private readonly root: string;
	private readonly store: TaskStore;
	private readonly modelGate: CapacityGate;
	private readonly leaseManager: LeaseManager;
	private readonly dependencies: LocalizeExecutionDependencies;
	private readonly instanceByIdempotencyKey: ReadonlyMap<string, string>;
	private readonly observedBaselineByTaskId = new Map<string, string>();
	private readonly resultGate: ResultGate;
	private activeExecutions = 0;
	private peakActiveExecutions = 0;
	private completedTasks = 0;
	private failedTasks = 0;
	private localizationCandidates = 0;
	private modelWaitMsTotal = 0;
	private modelWaitMsMax = 0;

	/**
	 * 函数职责：绑定真实定位执行依赖并创建结果门禁。
	 * 输入约束：实例映射覆盖全部准入幂等键且根目录属于本次运行。
	 * 返回结果：创建计数为零的任务执行器工厂。
	 * 失败语义：构造过程不连接 Provider 且不创建工作区。
	 */
	constructor(options: LocalizeTaskExecutorFactoryOptions) {
		this.root = resolve(options.root);
		this.store = options.store;
		this.modelGate = options.model_gate;
		this.leaseManager = options.lease_manager;
		this.dependencies = options.dependencies;
		this.instanceByIdempotencyKey = options.instance_by_idempotency_key;
		this.resultGate = new ResultGate({
			root: this.root,
			store: this.store,
			baselineSource: {
				currentCommit: async (task) => {
					const baseline = this.observedBaselineByTaskId.get(task.task_id);
					if (baseline === undefined) throw new Error("workstream7_observed_baseline_missing");
					return baseline;
				},
			},
		});
	}

	/**
	 * 函数职责：为已领取任务创建独立真实定位执行器。
	 * 输入约束：任务必须存在实例映射并绑定传入 attempt。
	 * 返回结果：返回不共享任务局部状态的执行器。
	 * 失败语义：映射及 attempt 失配时拒绝 Promise。
	 */
	async create(task: ConcurrencyTask, attemptId: string): Promise<TaskExecutor> {
		if (!this.instanceByIdempotencyKey.has(task.idempotency_key)) {
			throw new Error("workstream7_instance_mapping_missing");
		}
		return new LocalizeTaskExecutor(task, attemptId, this);
	}

	/**
	 * 函数职责：完成单任务状态推进、真实定位、基线复验和原子发布。
	 * 输入约束：任务处于 preparing 且由当前租约管理器所有者持有。
	 * 返回结果：任务进入 completed 后返回确定性执行结果。
	 * 失败语义：错误证据持久化后任务进入 failed 并拒绝 Promise。
	 */
	async executeTask(task: ConcurrencyTask, attemptId: string): Promise<TaskExecutionResult> {
		const instanceId = this.instanceByIdempotencyKey.get(task.idempotency_key);
		if (instanceId === undefined) throw new Error("workstream7_instance_mapping_missing");
		this.activeExecutions += 1;
		this.peakActiveExecutions = Math.max(this.peakActiveExecutions, this.activeExecutions);
		let current = task;
		let artifacts: ArtifactStore | null = null;
		try {
			current = await this.store.transition({
				task_id: task.task_id,
				expected_version: task.status_version,
				to_status: "running",
				attempt_id: attemptId,
				failure_code: null,
				result_manifest_path: null,
				result_manifest_sha256: null,
			});
			await this.leaseManager.startHeartbeat(current);
			artifacts = await ArtifactStore.createNew(join(this.root, "results", `.staging-${task.task_id}`));
			const localization = await runLocalizationAttempt(
				current,
				instanceId,
				attemptId,
				artifacts,
				this.modelGate,
				this.dependencies,
			);
			this.observedBaselineByTaskId.set(task.task_id, localization.baseline_commit);
			this.localizationCandidates += localization.candidate_count;
			this.modelWaitMsTotal += localization.model_wait_ms;
			this.modelWaitMsMax = Math.max(this.modelWaitMsMax, localization.model_wait_ms);
			current = await this.store.transition({
				task_id: task.task_id,
				expected_version: current.status_version,
				to_status: "validating",
				attempt_id: attemptId,
				failure_code: null,
				result_manifest_path: null,
				result_manifest_sha256: null,
			});
			current = await this.resultGate.verifyBaseline(current);
			if (current.status !== "publishing") throw new Error("workstream7_baseline_revalidation_required");
			const published = await this.resultGate.publish(current, artifacts);
			current = await this.resultGate.recordManifest(current, published);
			if (current.status !== "completed") throw new Error("workstream7_result_manifest_rejected");
			this.completedTasks += 1;
			return {
				task_id: task.task_id,
				attempt_id: attemptId,
				baseline_commit: task.request.baseline_commit,
				artifact_staging_root: join(this.root, "results", `.staging-${task.task_id}`),
			};
		} catch (error) {
			this.failedTasks += 1;
			const expectedStagingRoot = join(this.root, "results", `.staging-${task.task_id}`);
			if (artifacts !== null && resolve(artifacts.rootPath) === resolve(expectedStagingRoot)) {
				await artifacts
					.writeNew(
						"execution-error.json",
						stableStringify({
							schema_version: "v1",
							error_type: "workstream7_localization_failure",
							message: safeMessage(error),
							at: this.dependencies.now().toISOString(),
						}),
						{
							mediaType: "application/json",
							sensitivity: "internal",
							generatedBy: "orchestrator",
						},
					)
					.catch(() => undefined);
			}
			if (
				current.status === "preparing" ||
				current.status === "running" ||
				current.status === "validating" ||
				current.status === "publishing"
			) {
				await this.store.transition({
					task_id: current.task_id,
					expected_version: current.status_version,
					to_status: "failed",
					attempt_id: current.attempt_id,
					failure_code: "task_executor_failure",
					result_manifest_path: null,
					result_manifest_sha256: null,
				});
			}
			throw error;
		} finally {
			this.leaseManager.stopHeartbeat(task.task_id);
			this.activeExecutions -= 1;
		}
	}

	/**
	 * 函数职责：读取真实定位执行器当前统计。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回活动数、峰值、完成数、失败数和模型等待指标。
	 * 失败语义：函数不产生外部副作用。
	 */
	snapshot(): LocalizeTaskExecutorSnapshot {
		return Object.freeze({
			active_executions: this.activeExecutions,
			peak_active_executions: this.peakActiveExecutions,
			completed_tasks: this.completedTasks,
			failed_tasks: this.failedTasks,
			localization_candidates: this.localizationCandidates,
			model_wait_ms_total: this.modelWaitMsTotal,
			model_wait_ms_max: this.modelWaitMsMax,
		});
	}
}

/**
 * 函数职责：创建 WORKSTREAM7 使用的真实 Controller、任务源和 DeepSeek 会话依赖。
 * 输入约束：Controller 地址可达，冻结任务目录和数据卷与当前代码版本一致。
 * 返回结果：返回模型凭据仅驻留 Orchestrator 内存的执行依赖。
 * 失败语义：模型凭据缺失及冻结运行时无效时同步抛出异常。
 */
export function createDefaultLocalizeExecutionDependencies(
	controllerUrl: string,
	runtime: FrozenModelRuntime = createDeepSeekV4FlashRuntime(),
): LocalizeExecutionDependencies {
	return {
		controller: new HttpRuntimeController({ controllerUrl }),
		publicTaskSource: new FilePublicTaskSource(undefined, "test"),
		environmentLockSource: new DirectoryTaskEnvironmentLockSource(
			process.env.REPOFIX_WORKSTREAM7_TASK_ENVIRONMENT_LOCK_ROOT ?? TASK_ENVIRONMENT_LOCK_ROOT,
			{ root_path: RUNTIME_CONFIG_ROOT, relative_path: "axios-5892/dataset-lock.json" },
		),
		createRepoFixSession: (options) =>
			createFrozenRepoFixSession(runtime, {
				leaseId: options.leaseId,
				attemptDirectory: options.attemptDirectory,
				cwd: options.cwd,
				transport: options.transport,
				config: getRepoFixWorkflowConfig("repofix-full"),
			}),
		modelSpecSha256: runtime.modelSpecSha256,
		now: () => new Date(),
	};
}
