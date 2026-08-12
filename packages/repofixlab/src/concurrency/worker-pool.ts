/**
 * 脚本职责：以固定任务槽位运行互相独立的任务执行器。
 * 输入边界：接收已领取任务和任务执行器工厂。
 * 输出边界：返回执行结果和任务槽位统计。
 */

import type { ConcurrencyTask, TaskExecutionResult, TaskExecutorFactory } from "./contracts.ts";
import type { TaskSchedulingStore } from "./task-store.ts";

export interface TaskExecutionLifecycle {
	/**
	 * 函数职责：把执行器失败登记为任务稳定失败状态。
	 * 输入约束：任务必须保持提交执行时的状态版本。
	 * 返回结果：失败状态及审计事件提交后完成。
	 * 失败语义：持久化失败时拒绝 Promise。
	 */
	recordFailure(task: ConcurrencyTask): Promise<void>;
}

export interface WorkerPoolSnapshot {
	readonly capacity: number;
	readonly active: number;
	readonly available: number;
	readonly peak_active: number;
	readonly submitted: number;
	readonly completed: number;
	readonly failed: number;
}

/**
 * 类职责：表达任务提交超过固定 Worker 容量。
 * 持有状态：不持有运行状态。
 * 协作边界：只提供稳定错误名称和消息。
 */
export class WorkerPoolCapacityError extends Error {
	/**
	 * 函数职责：创建固定容量耗尽错误。
	 * 输入约束：仅在可用槽位为零时调用。
	 * 返回结果：返回稳定 WorkerPool 错误实例。
	 * 失败语义：构造过程不修改槽位计数。
	 */
	constructor() {
		super("worker_pool_capacity_exhausted");
		this.name = "WorkerPoolCapacityError";
	}
}

/**
 * 类职责：通过任务存储端口登记执行器失败状态。
 * 持有状态：保存任务调度存储端口。
 * 协作边界：不读取队列且不处理成功结果发布。
 */
export class TaskStoreExecutionLifecycle implements TaskExecutionLifecycle {
	private readonly store: Pick<TaskSchedulingStore, "transition">;

	/**
	 * 函数职责：绑定支持状态转换的任务存储端口。
	 * 输入约束：存储端口必须实现原子 transition。
	 * 返回结果：创建无本地任务状态的生命周期适配器。
	 * 失败语义：构造过程不访问持久化层。
	 */
	constructor(store: Pick<TaskSchedulingStore, "transition">) {
		this.store = store;
	}

	/**
	 * 函数职责：把执行器失败原子推进为 failed。
	 * 输入约束：任务必须处于允许失败的已领取状态。
	 * 返回结果：失败原因和审计事件提交后完成。
	 * 失败语义：版本冲突及数据库失败时拒绝 Promise。
	 */
	async recordFailure(task: ConcurrencyTask): Promise<void> {
		await this.store.transition({
			task_id: task.task_id,
			expected_version: task.status_version,
			to_status: "failed",
			attempt_id: task.attempt_id,
			failure_code: "task_executor_failure",
			result_manifest_path: null,
			result_manifest_sha256: null,
		});
	}
}

/**
 * 类职责：限制同时执行的任务数量并保证槽位释放。
 * 持有状态：保存冻结容量、执行器工厂、生命周期和槽位统计。
 * 协作边界：只经生命周期端口登记失败，不读取队列。
 */
export class WorkerPool {
	private readonly capacityLimit: number;
	private readonly executorFactory: TaskExecutorFactory;
	private readonly lifecycle: TaskExecutionLifecycle;
	private readonly drainWaiters: Array<() => void> = [];
	private active = 0;
	private peakActive = 0;
	private submitted = 0;
	private completed = 0;
	private failed = 0;

	/**
	 * 函数职责：创建固定容量 WorkerPool。
	 * 输入约束：容量为正安全整数，工厂和生命周期必须保持任务隔离。
	 * 返回结果：创建活动数为零的任务池。
	 * 失败语义：容量无效时抛出稳定配置错误。
	 */
	constructor(capacity: number, executorFactory: TaskExecutorFactory, lifecycle: TaskExecutionLifecycle) {
		if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("invalid_worker_pool_capacity");
		this.capacityLimit = capacity;
		this.executorFactory = executorFactory;
		this.lifecycle = lifecycle;
	}

	/**
	 * 函数职责：提交一项已领取任务并占用单个槽位。
	 * 输入约束：任务必须绑定 attempt 且存在可用槽位。
	 * 返回结果：执行成功返回绑定当前任务的执行结果。
	 * 失败语义：创建及执行失败时拒绝 Promise 并释放槽位。
	 */
	async submit(task: ConcurrencyTask): Promise<TaskExecutionResult> {
		if (this.active >= this.capacityLimit) throw new WorkerPoolCapacityError();
		if (task.attempt_id === null) throw new Error("claimed_task_missing_attempt_id");

		this.active += 1;
		this.submitted += 1;
		this.peakActive = Math.max(this.peakActive, this.active);
		try {
			const executor = await this.executorFactory.create(task, task.attempt_id);
			const result = await executor.execute();
			if (result.task_id !== task.task_id || result.attempt_id !== task.attempt_id) {
				throw new Error("task_execution_result_binding_mismatch");
			}
			this.completed += 1;
			return result;
		} catch (error) {
			this.failed += 1;
			try {
				await this.lifecycle.recordFailure(task);
			} catch (lifecycleError) {
				throw new AggregateError([error, lifecycleError], "task_execution_failure_not_persisted");
			}
			throw error;
		} finally {
			this.active -= 1;
			if (this.active === 0) {
				for (const resolve of this.drainWaiters.splice(0)) resolve();
			}
		}
	}

	/**
	 * 函数职责：计算当前可领取的任务数量。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回固定容量减去活动数。
	 * 失败语义：函数不修改槽位状态。
	 */
	availableSlots(): number {
		return this.capacityLimit - this.active;
	}

	/**
	 * 函数职责：等待当前全部活动任务释放槽位。
	 * 输入约束：调用方必须先停止继续提交新任务。
	 * 返回结果：活动数归零后 Promise 完成。
	 * 失败语义：任务失败不阻止排空完成。
	 */
	async drain(): Promise<void> {
		if (this.active === 0) return;
		await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
	}

	/**
	 * 函数职责：读取 WorkerPool 当前运行统计。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回不可变数值快照。
	 * 失败语义：函数不产生失败和副作用。
	 */
	snapshot(): WorkerPoolSnapshot {
		return {
			capacity: this.capacityLimit,
			active: this.active,
			available: this.capacityLimit - this.active,
			peak_active: this.peakActive,
			submitted: this.submitted,
			completed: this.completed,
			failed: this.failed,
		};
	}
}
