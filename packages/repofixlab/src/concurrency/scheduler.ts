/**
 * 脚本职责：在领导租约保护下按 Worker 可用槽位领取任务。
 * 输入边界：接收调度持久化端口、WorkerPool 和固定时间参数。
 * 输出边界：只提交已领取任务并暴露调度统计。
 */

import type { TaskSchedulingStore } from "./task-store.ts";
import type { WorkerPool } from "./worker-pool.ts";

export interface TaskSchedulerOptions {
	readonly store: TaskSchedulingStore;
	readonly worker_pool: WorkerPool;
	readonly lease_name: string;
	readonly owner_id: string;
	readonly scheduler_lease_ms: number;
	readonly task_lease_ms: number;
	readonly tick_interval_ms: number;
	readonly clock?: () => Date;
}

export interface SchedulerTickResult {
	readonly leadership_acquired: boolean;
	readonly claimed_count: number;
}

export interface TaskSchedulerSnapshot {
	readonly running: boolean;
	readonly leadership_acquired_count: number;
	readonly leadership_rejected_count: number;
	readonly claimed_count: number;
	readonly execution_failures: number;
	readonly tick_failures: number;
	readonly last_tick_error: string | null;
}

/**
 * 类职责：以单领导身份把数据库排队任务提交给 WorkerPool。
 * 持有状态：保存调度配置、串行 tick 队列和运行统计。
 * 协作边界：不创建执行器且不读取 Worker 内部任务状态。
 */
export class TaskScheduler {
	private readonly store: TaskSchedulingStore;
	private readonly workerPool: WorkerPool;
	private readonly leaseName: string;
	private readonly ownerId: string;
	private readonly schedulerLeaseMs: number;
	private readonly taskLeaseMs: number;
	private readonly tickIntervalMs: number;
	private readonly clock: () => Date;
	private tickQueue: Promise<void> = Promise.resolve();
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private leadershipAcquiredCount = 0;
	private leadershipRejectedCount = 0;
	private claimedCount = 0;
	private executionFailures = 0;
	private tickFailures = 0;
	private lastTickError: string | null = null;

	/**
	 * 函数职责：绑定调度依赖并冻结容量时间参数。
	 * 输入约束：标识非空，三个毫秒参数必须是正安全整数。
	 * 返回结果：创建尚未启动的调度器。
	 * 失败语义：配置无效时抛出稳定配置错误。
	 */
	constructor(options: TaskSchedulerOptions) {
		if (options.lease_name.trim().length === 0 || options.owner_id.trim().length === 0) {
			throw new Error("invalid_task_scheduler_identity");
		}
		for (const value of [options.scheduler_lease_ms, options.task_lease_ms, options.tick_interval_ms]) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid_task_scheduler_timing");
		}
		this.store = options.store;
		this.workerPool = options.worker_pool;
		this.leaseName = options.lease_name;
		this.ownerId = options.owner_id;
		this.schedulerLeaseMs = options.scheduler_lease_ms;
		this.taskLeaseMs = options.task_lease_ms;
		this.tickIntervalMs = options.tick_interval_ms;
		this.clock = options.clock ?? (() => new Date());
	}

	/**
	 * 函数职责：启动周期 tick 并立即尝试一次调度。
	 * 输入约束：当前调度器必须处于停止状态。
	 * 返回结果：返回首次 tick 的领导租约和领取结果。
	 * 失败语义：首次 tick 失败时恢复停止状态并拒绝 Promise。
	 */
	async start(): Promise<SchedulerTickResult> {
		if (this.running) throw new Error("task_scheduler_already_started");
		this.running = true;
		try {
			const firstTick = await this.tick();
			this.timer = setInterval(() => {
				void this.tick().catch(() => undefined);
			}, this.tickIntervalMs);
			return firstTick;
		} catch (error) {
			this.running = false;
			throw error;
		}
	}

	/**
	 * 函数职责：串行执行一次领导续期和按槽位领取。
	 * 输入约束：存储端口与 WorkerPool 必须保持可用。
	 * 返回结果：返回本次领导状态和领取数量。
	 * 失败语义：数据库失败被计数并拒绝当前 Promise。
	 */
	tick(): Promise<SchedulerTickResult> {
		const tickResult = this.tickQueue.then(async () => {
			try {
				const now = this.clock();
				const nowIso = now.toISOString();
				const leadershipAcquired = await this.store.acquireSchedulerLease({
					lease_name: this.leaseName,
					owner_id: this.ownerId,
					now: nowIso,
					expires_at: new Date(now.getTime() + this.schedulerLeaseMs).toISOString(),
				});
				if (!leadershipAcquired) {
					this.leadershipRejectedCount += 1;
					return { leadership_acquired: false, claimed_count: 0 };
				}

				this.leadershipAcquiredCount += 1;
				const availableSlots = this.workerPool.availableSlots();
				if (availableSlots === 0) return { leadership_acquired: true, claimed_count: 0 };

				const claimedTasks = await this.store.claimQueued({
					lease_name: this.leaseName,
					owner_id: this.ownerId,
					limit: availableSlots,
					now: nowIso,
					lease_expires_at: new Date(now.getTime() + this.taskLeaseMs).toISOString(),
				});
				this.claimedCount += claimedTasks.length;
				for (const task of claimedTasks) {
					void this.workerPool
						.submit(task)
						.catch(() => {
							this.executionFailures += 1;
						})
						.then(() => {
							if (this.running) void this.tick().catch(() => undefined);
						});
				}
				return { leadership_acquired: true, claimed_count: claimedTasks.length };
			} catch (error) {
				this.tickFailures += 1;
				this.lastTickError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		});
		this.tickQueue = tickResult.then(
			() => undefined,
			() => undefined,
		);
		return tickResult;
	}

	/**
	 * 函数职责：停止周期 tick 并等待已排队 tick 完成。
	 * 输入约束：函数允许对停止状态重复调用。
	 * 返回结果：定时器清除且 tick 队列排空后完成。
	 * 失败语义：已记录的 tick 失败不阻止停止。
	 */
	async stop(): Promise<void> {
		this.running = false;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.tickQueue;
	}

	/**
	 * 函数职责：读取调度器当前运行统计。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回不可变数值和最后错误快照。
	 * 失败语义：函数不产生失败和副作用。
	 */
	snapshot(): TaskSchedulerSnapshot {
		return {
			running: this.running,
			leadership_acquired_count: this.leadershipAcquiredCount,
			leadership_rejected_count: this.leadershipRejectedCount,
			claimed_count: this.claimedCount,
			execution_failures: this.executionFailures,
			tick_failures: this.tickFailures,
			last_tick_error: this.lastTickError,
		};
	}
}
