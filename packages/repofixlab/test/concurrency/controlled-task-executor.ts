/**
 * 脚本职责：提供可释放、可失败、可统计的受控任务执行器。
 * 输入边界：接收已领取任务、attempt 和真实 CapacityGate。
 * 输出边界：产生确定性执行结果与模型闸门证据。
 */

import { performance } from "node:perf_hooks";
import type { CapacityGate } from "../../src/concurrency/capacity-gate.ts";
import type {
	ConcurrencyTask,
	TaskExecutionResult,
	TaskExecutor,
	TaskExecutorFactory,
} from "../../src/concurrency/contracts.ts";

type ControlledOutcome = "success" | "failure";

interface TaskControl {
	readonly resolve: (outcome: ControlledOutcome) => void;
}

export interface ControlledTaskExecutorSnapshot {
	readonly active_executions: number;
	readonly peak_active_executions: number;
	readonly started_tasks: number;
	readonly completed_tasks: number;
	readonly failed_tasks: number;
	readonly model_wait_ms_total: number;
	readonly model_wait_ms_max: number;
	readonly model_active_task_ids: readonly string[];
	readonly model_peak: number;
	readonly model_waiting: number;
}

/**
 * 类职责：执行一项绑定任务并把控制交给共享测试工厂。
 * 持有状态：保存任务、attempt 和所属工厂。
 * 协作边界：不访问数据库且不创建额外任务。
 */
export class ControlledTaskExecutor implements TaskExecutor {
	private readonly task: ConcurrencyTask;
	private readonly attemptId: string;
	private readonly factory: ControlledTaskExecutorFactory;

	/**
	 * 函数职责：绑定单项受控任务执行上下文。
	 * 输入约束：attempt 必须与任务持久化字段一致。
	 * 返回结果：创建尚未执行的测试执行器。
	 * 失败语义：构造过程不占用模型闸门。
	 */
	constructor(task: ConcurrencyTask, attemptId: string, factory: ControlledTaskExecutorFactory) {
		if (task.attempt_id !== attemptId) throw new Error("controlled_attempt_binding_mismatch");
		this.task = task;
		this.attemptId = attemptId;
		this.factory = factory;
	}

	/**
	 * 函数职责：执行受控任务并等待测试信号。
	 * 输入约束：同一执行器只执行一次。
	 * 返回结果：成功时返回绑定任务和 attempt 的固定结果。
	 * 失败语义：失败信号触发稳定受控异常。
	 */
	execute(): Promise<TaskExecutionResult> {
		return this.factory.executeControlled(this.task, this.attemptId);
	}
}

/**
 * 类职责：创建受控执行器并集中记录并发证据。
 * 持有状态：保存模型闸门、任务信号、活动集合和计数器。
 * 协作边界：只替换外部执行耗时，不替换调度及持久化模块。
 */
export class ControlledTaskExecutorFactory implements TaskExecutorFactory {
	private readonly modelGate: CapacityGate;
	private readonly controls = new Map<string, TaskControl>();
	private readonly failureTaskIds = new Set<string>();
	private readonly modelActiveTaskIds = new Set<string>();
	private releaseAllTasks = false;
	private activeExecutions = 0;
	private peakActiveExecutions = 0;
	private startedTasks = 0;
	private completedTasks = 0;
	private failedTasks = 0;
	private modelWaitMsTotal = 0;
	private modelWaitMsMax = 0;

	/**
	 * 函数职责：绑定真实模型容量闸门。
	 * 输入约束：闸门容量必须由本机配置创建。
	 * 返回结果：创建计数全部为零的测试工厂。
	 * 失败语义：构造过程不取得闸门名额。
	 */
	constructor(modelGate: CapacityGate) {
		this.modelGate = modelGate;
	}

	/**
	 * 函数职责：为已领取任务创建独立受控执行器。
	 * 输入约束：任务必须绑定传入 attempt。
	 * 返回结果：返回不共享任务局部状态的执行器。
	 * 失败语义：绑定不匹配时拒绝 Promise。
	 */
	async create(task: ConcurrencyTask, attemptId: string): Promise<TaskExecutor> {
		return new ControlledTaskExecutor(task, attemptId, this);
	}

	/**
	 * 函数职责：在模型闸门内执行受控任务流程。
	 * 输入约束：任务和 attempt 必须已经通过执行器绑定。
	 * 返回结果：成功信号返回固定任务执行结果。
	 * 失败语义：失败信号抛出异常并释放模型名额。
	 */
	async executeControlled(task: ConcurrencyTask, attemptId: string): Promise<TaskExecutionResult> {
		this.activeExecutions += 1;
		this.startedTasks += 1;
		this.peakActiveExecutions = Math.max(this.peakActiveExecutions, this.activeExecutions);
		const waitStartedAt = performance.now();
		await this.modelGate.acquire();
		const waitMs = performance.now() - waitStartedAt;
		this.modelWaitMsTotal += waitMs;
		this.modelWaitMsMax = Math.max(this.modelWaitMsMax, waitMs);
		this.modelActiveTaskIds.add(task.task_id);

		try {
			const outcome = await this.waitForOutcome(task.task_id);
			if (outcome === "failure") throw new Error("controlled_task_failure");
			this.completedTasks += 1;
			return {
				task_id: task.task_id,
				attempt_id: attemptId,
				baseline_commit: task.request.baseline_commit,
				artifact_staging_root: `controlled://results/${task.task_id}`,
			};
		} catch (error) {
			this.failedTasks += 1;
			throw error;
		} finally {
			this.modelActiveTaskIds.delete(task.task_id);
			this.modelGate.release();
			this.activeExecutions -= 1;
		}
	}

	/**
	 * 函数职责：向指定任务发送单次失败信号。
	 * 输入约束：任务 ID 必须属于当前验收运行。
	 * 返回结果：当前及后续等待读取到失败结果。
	 * 失败语义：重复信号保持首次失败语义。
	 */
	failTask(taskId: string): void {
		this.failureTaskIds.add(taskId);
		const control = this.controls.get(taskId);
		if (control !== undefined) {
			this.controls.delete(taskId);
			control.resolve("failure");
		}
	}

	/**
	 * 函数职责：释放当前和后续全部受控任务。
	 * 输入约束：仅在阻塞态证据采集完成后调用。
	 * 返回结果：全部等待者收到成功信号。
	 * 失败语义：已标记失败的任务继续保持失败。
	 */
	releaseAll(): void {
		this.releaseAllTasks = true;
		for (const [taskId, control] of this.controls) {
			this.controls.delete(taskId);
			control.resolve(this.failureTaskIds.has(taskId) ? "failure" : "success");
		}
	}

	/**
	 * 函数职责：读取受控执行与模型闸门统计。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回不可变数值和活动任务集合。
	 * 失败语义：函数不产生失败和副作用。
	 */
	snapshot(): ControlledTaskExecutorSnapshot {
		const gate = this.modelGate.snapshot();
		return {
			active_executions: this.activeExecutions,
			peak_active_executions: this.peakActiveExecutions,
			started_tasks: this.startedTasks,
			completed_tasks: this.completedTasks,
			failed_tasks: this.failedTasks,
			model_wait_ms_total: this.modelWaitMsTotal,
			model_wait_ms_max: this.modelWaitMsMax,
			model_active_task_ids: [...this.modelActiveTaskIds].sort(),
			model_peak: gate.peak_in_use,
			model_waiting: gate.waiting,
		};
	}

	/**
	 * 函数职责：等待指定任务的成功及失败控制信号。
	 * 输入约束：任务 ID 在同一时刻只允许一个等待者。
	 * 返回结果：返回该任务固定执行结果类别。
	 * 失败语义：重复等待抛出测试夹具状态错误。
	 */
	private waitForOutcome(taskId: string): Promise<ControlledOutcome> {
		if (this.failureTaskIds.has(taskId)) return Promise.resolve("failure");
		if (this.releaseAllTasks) return Promise.resolve("success");
		if (this.controls.has(taskId)) throw new Error("duplicate_controlled_task_waiter");
		return new Promise<ControlledOutcome>((resolve) => {
			this.controls.set(taskId, { resolve });
		});
	}
}
