/**
 * 脚本职责：验证 WorkerPool 固定容量和失败槽位释放。
 * 输入边界：使用三项固定任务和受控执行器。
 * 输出边界：产生确定性的 Vitest 断言结果。
 */

import { describe, expect, it } from "vitest";
import { CapacityGate } from "../../src/concurrency/capacity-gate.ts";
import type { ConcurrencyTask } from "../../src/concurrency/contracts.ts";
import type { TaskExecutionLifecycle } from "../../src/concurrency/worker-pool.ts";
import { WorkerPool, WorkerPoolCapacityError } from "../../src/concurrency/worker-pool.ts";
import { ControlledTaskExecutorFactory } from "./controlled-task-executor.ts";

/**
 * 函数职责：构造一项已经绑定 attempt 的固定任务。
 * 输入约束：任务 ID 必须满足数据库格式约束。
 * 返回结果：返回 preparing 状态的任务快照。
 * 失败语义：函数不访问外部状态。
 */
function claimedTask(taskId: string): ConcurrencyTask {
	return {
		schema_version: "v1",
		task_id: taskId,
		idempotency_key: `key-${taskId}`,
		request_sha256: "b".repeat(64),
		request: {
			repository: "fixture/repo",
			baseline_commit: "a".repeat(40),
			task_content: "controlled",
			caller_id: "local-user",
		},
		enqueue_sequence: 1,
		status: "preparing",
		status_version: 1,
		attempt_id: `${taskId}:attempt:1`,
		lease_owner: "scheduler-primary",
		lease_expires_at: "2026-08-09T00:01:00.000Z",
		heartbeat_at: "2026-08-09T00:00:00.000Z",
		attempt_count: 1,
		failure_code: null,
		result_manifest_path: null,
		result_manifest_sha256: null,
		created_at: "2026-08-09T00:00:00.000Z",
		updated_at: "2026-08-09T00:00:00.000Z",
	};
}

/**
 * 函数职责：等待固定断言在超时前成立。
 * 输入约束：断言必须只读取测试内存状态。
 * 返回结果：条件成立时 Promise 完成。
 * 失败语义：一秒内未成立时抛出测试超时。
 */
async function waitUntil(assertion: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!assertion()) {
		if (Date.now() >= deadline) throw new Error("worker_pool_test_timeout");
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
}

/**
 * 类职责：记录单元测试中的失败生命周期调用。
 * 持有状态：保存收到的失败任务 ID。
 * 协作边界：不访问数据库且不修改任务对象。
 */
class RecordingExecutionLifecycle implements TaskExecutionLifecycle {
	readonly failedTaskIds: string[] = [];

	/**
	 * 函数职责：记录一项执行失败任务。
	 * 输入约束：任务必须来自当前 WorkerPool。
	 * 返回结果：追加任务 ID 后完成。
	 * 失败语义：测试适配器不注入持久化失败。
	 */
	async recordFailure(task: ConcurrencyTask): Promise<void> {
		this.failedTaskIds.push(task.task_id);
	}
}

describe("concurrency worker pool", () => {
	/**
	 * 函数职责：验证失败任务释放槽位并允许下一任务执行。
	 * 输入约束：Worker 容量和模型容量均固定为二。
	 * 返回结果：活动峰值为二且第三项任务正常完成。
	 * 失败语义：槽位泄漏及超量提交时测试失败。
	 */
	it("releases a failed task slot", async () => {
		const factory = new ControlledTaskExecutorFactory(new CapacityGate("model", 2));
		const lifecycle = new RecordingExecutionLifecycle();
		const pool = new WorkerPool(2, factory, lifecycle);
		const first = pool.submit(claimedTask("task-a"));
		const second = pool.submit(claimedTask("task-b"));
		await waitUntil(() => factory.snapshot().model_active_task_ids.length === 2);

		await expect(pool.submit(claimedTask("task-over-capacity"))).rejects.toBeInstanceOf(WorkerPoolCapacityError);
		factory.failTask("task-a");
		await expect(first).rejects.toThrow("controlled_task_failure");
		expect(pool.availableSlots()).toBe(1);

		const third = pool.submit(claimedTask("task-c"));
		factory.releaseAll();
		await Promise.all([second, third]);
		await pool.drain();

		expect(pool.snapshot()).toEqual({
			capacity: 2,
			active: 0,
			available: 2,
			peak_active: 2,
			submitted: 3,
			completed: 2,
			failed: 1,
		});
		expect(lifecycle.failedTaskIds).toEqual(["task-a"]);
	});
});
