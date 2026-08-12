/**
 * 脚本职责：把工作区回收失败登记为任务稳定失败状态。
 * 输入边界：接收已领取任务、目录分配和状态存储端口。
 * 输出边界：提交失败状态及对应审计事件。
 */

import type { ConcurrencyTask } from "./contracts.ts";
import type { TaskSchedulingStore } from "./task-store.ts";
import type { WorkspaceAllocation, WorkspaceManager } from "./workspace-manager.ts";
import { WorkspaceCleanupError } from "./workspace-manager.ts";

/**
 * 类职责：回收任务目录并持久化固定失败原因。
 * 持有状态：保存工作区管理器和任务状态端口。
 * 协作边界：不创建目录且不直接访问数据库驱动。
 */
export class TaskStoreWorkspaceCleanupLifecycle {
	private readonly workspaceManager: WorkspaceManager;
	private readonly store: Pick<TaskSchedulingStore, "transition">;

	/**
	 * 函数职责：绑定目录管理器和原子状态存储端口。
	 * 输入约束：依赖必须保持目录和状态职责分离。
	 * 返回结果：创建无本地任务状态的生命周期适配器。
	 * 失败语义：构造过程不访问外部资源。
	 */
	constructor(workspaceManager: WorkspaceManager, store: Pick<TaskSchedulingStore, "transition">) {
		this.workspaceManager = workspaceManager;
		this.store = store;
	}

	/**
	 * 函数职责：回收目录并登记 workspace_cleanup_failed。
	 * 输入约束：任务版本和目录所有权必须保持一致。
	 * 返回结果：回收成功时完成且不修改任务状态。
	 * 失败语义：回收失败后提交 failed 并抛出稳定错误。
	 */
	async cleanup(task: ConcurrencyTask, allocation: WorkspaceAllocation): Promise<void> {
		try {
			await this.workspaceManager.cleanup(allocation);
		} catch (error) {
			const cleanupError = error instanceof WorkspaceCleanupError ? error : new WorkspaceCleanupError(error);
			try {
				await this.store.transition({
					task_id: task.task_id,
					expected_version: task.status_version,
					to_status: "failed",
					attempt_id: task.attempt_id,
					failure_code: "workspace_cleanup_failed",
					result_manifest_path: null,
					result_manifest_sha256: null,
				});
			} catch (transitionError) {
				throw new AggregateError([cleanupError, transitionError], "workspace_cleanup_failure_not_persisted");
			}
			throw cleanupError;
		}
	}
}
