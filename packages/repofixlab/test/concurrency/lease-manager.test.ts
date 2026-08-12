/**
 * 脚本职责：验证固定任务心跳和 checkpoint 恢复判定。
 * 输入边界：使用内存租约端口、固定时钟和两项任务夹具。
 * 输出边界：产生确定性的 Vitest 租约断言。
 */

import { describe, expect, it } from "vitest";
import type { ConcurrencyTask } from "../../src/concurrency/contracts.ts";
import {
	LeaseManager,
	type LeaseManagerOptions,
	type RecoveryCheckpointSource,
	TASK_HEARTBEAT_INTERVAL_MS,
	TASK_LEASE_DURATION_MS,
} from "../../src/concurrency/lease-manager.ts";

interface MemoryLeaseState {
	readonly tasks: Map<string, ConcurrencyTask>;
	readonly recovery_claims: string[];
	readonly store: LeaseManagerOptions["store"];
}

/**
 * 函数职责：构造一项带有效执行租约的运行任务。
 * 输入约束：任务 ID 和租约到期时间必须来自当前测试。
 * 返回结果：返回状态版本为二的固定任务快照。
 * 失败语义：函数不访问外部状态。
 */
function runningTask(taskId: string, leaseExpiresAt: string): ConcurrencyTask {
	return {
		schema_version: "v1",
		task_id: taskId,
		idempotency_key: `key-${taskId}`,
		request_sha256: "b".repeat(64),
		request: {
			repository: "fixture/repo",
			baseline_commit: "a".repeat(40),
			task_content: "lease recovery",
			caller_id: "local-user",
		},
		enqueue_sequence: 1,
		status: "running",
		status_version: 2,
		attempt_id: `${taskId}:attempt:1`,
		lease_owner: "worker-primary",
		lease_expires_at: leaseExpiresAt,
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
 * 函数职责：创建具备原子租约语义的内存测试端口。
 * 输入约束：初始任务 ID 必须互不相同。
 * 返回结果：返回任务状态、恢复记录和租约端口。
 * 失败语义：版本冲突及非法状态抛出测试错误。
 */
function createMemoryLeaseState(initialTasks: readonly ConcurrencyTask[]): MemoryLeaseState {
	const tasks = new Map(initialTasks.map((task) => [task.task_id, task]));
	const recoveryClaims: string[] = [];
	const store: LeaseManagerOptions["store"] = {
		async heartbeat(command) {
			const task = tasks.get(command.task_id);
			if (
				task === undefined ||
				task.lease_owner !== command.lease_owner ||
				task.lease_expires_at === null ||
				new Date(task.lease_expires_at).getTime() <= new Date(command.heartbeat_at).getTime()
			) {
				return false;
			}
			tasks.set(command.task_id, {
				...task,
				heartbeat_at: command.heartbeat_at,
				lease_expires_at: command.lease_expires_at,
			});
			return true;
		},
		async findExpiredLeases(command) {
			return [...tasks.values()].filter(
				(task) =>
					task.status === "running" &&
					task.lease_expires_at !== null &&
					new Date(task.lease_expires_at).getTime() <= new Date(command.now).getTime(),
			);
		},
		async claimExpiredLease(command) {
			const task = tasks.get(command.task_id);
			if (
				task === undefined ||
				task.status !== "running" ||
				task.status_version !== command.expected_version ||
				task.lease_owner !== command.expected_lease_owner ||
				task.lease_expires_at === null ||
				new Date(task.lease_expires_at).getTime() > new Date(command.now).getTime()
			) {
				return null;
			}
			const claimed: ConcurrencyTask = {
				...task,
				status: "recovering",
				status_version: task.status_version + 1,
				lease_owner: command.recovery_owner,
				heartbeat_at: command.now,
				lease_expires_at: command.lease_expires_at,
			};
			tasks.set(task.task_id, claimed);
			recoveryClaims.push(task.task_id);
			return claimed;
		},
		async transition(command) {
			const task = tasks.get(command.task_id);
			if (task === undefined || task.status_version !== command.expected_version) {
				throw new Error("memory_task_version_conflict");
			}
			const terminal = command.to_status === "failed";
			const changed: ConcurrencyTask = {
				...task,
				status: command.to_status,
				status_version: task.status_version + 1,
				failure_code: command.failure_code,
				lease_owner: terminal ? null : task.lease_owner,
				lease_expires_at: terminal ? null : task.lease_expires_at,
				heartbeat_at: terminal ? null : task.heartbeat_at,
			};
			tasks.set(task.task_id, changed);
			return changed;
		},
	};
	return { tasks, recovery_claims: recoveryClaims, store };
}

/**
 * 函数职责：创建与指定 attempt 绑定的完整 checkpoint。
 * 输入约束：任务必须处于运行状态且带 attempt。
 * 返回结果：返回通过静止边界检查的固定记录。
 * 失败语义：缺少 attempt 时抛出测试夹具错误。
 */
function completeCheckpoint(task: ConcurrencyTask) {
	if (task.attempt_id === null) throw new Error("missing_test_attempt_id");
	return {
		attempt_id: task.attempt_id,
		status: "running" as const,
		worker_lease_id: "worker-primary",
		session_sha256: "1".repeat(64),
		stage_sha256: "2".repeat(64),
		trace_offset: 11,
		token_ledger_offset: 7,
		checkpoint_sha256: "3".repeat(64),
		quiescent: true,
		in_flight_operations: 0,
		open_reservations: 0,
	};
}

describe("concurrency lease manager", () => {
	/**
	 * 函数职责：验证首次心跳按固定六十秒续租并可停止。
	 * 输入约束：任务租约在固定测试时间仍然有效。
	 * 返回结果：心跳成功一次且活动定时器归零。
	 * 失败语义：所有者失配及定时器泄漏使断言失败。
	 */
	it("starts and stops a fixed heartbeat", async () => {
		const task = runningTask("task-heartbeat", "2026-08-09T00:01:00.000Z");
		const state = createMemoryLeaseState([task]);
		const manager = new LeaseManager({
			store: state.store,
			checkpoint_source: {
				async load() {
					return null;
				},
			},
			owner_id: "worker-primary",
			now: () => new Date("2026-08-09T00:00:40.000Z"),
		});
		await manager.startHeartbeat(task);
		expect(state.tasks.get(task.task_id)?.lease_expires_at).toBe("2026-08-09T00:01:40.000Z");
		expect(manager.stopHeartbeat(task.task_id)).toBe(true);
		expect(manager.snapshot()).toMatchObject({ active_heartbeats: 0, heartbeat_succeeded: 1 });
		expect(TASK_HEARTBEAT_INTERVAL_MS).toBe(20_000);
		expect(TASK_LEASE_DURATION_MS).toBe(60_000);
	});

	/**
	 * 函数职责：验证完整 checkpoint 续跑且缺失记录稳定失败。
	 * 输入约束：两项任务租约均已超过固定有效期。
	 * 返回结果：保留同 attempt 一项并失败一项。
	 * 失败语义：重复领取及错误终态使断言失败。
	 */
	it("resumes only a complete checkpoint", async () => {
		const resumable = runningTask("task-resume", "2026-08-09T00:01:00.000Z");
		const incomplete = runningTask("task-incomplete", "2026-08-09T00:01:00.000Z");
		const state = createMemoryLeaseState([resumable, incomplete]);
		const checkpointSource: RecoveryCheckpointSource = {
			async load(task) {
				return task.task_id === resumable.task_id ? completeCheckpoint(resumable) : null;
			},
		};
		const manager = new LeaseManager({
			store: state.store,
			checkpoint_source: checkpointSource,
			owner_id: "recovery-primary",
			now: () => new Date("2026-08-09T00:01:01.000Z"),
		});
		const recovered = await manager.recoverExpired(2);
		expect(recovered.claimed_count).toBe(2);
		expect(state.recovery_claims).toHaveLength(2);
		expect(recovered.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					task_id: resumable.task_id,
					disposition: "resumed",
					attempt_id: resumable.attempt_id,
					token_ledger_offset: 7,
				}),
				expect.objectContaining({
					task_id: incomplete.task_id,
					disposition: "failed",
					decision_reason: "checkpoint_missing",
				}),
			]),
		);
		expect(state.tasks.get(resumable.task_id)?.status).toBe("running");
		expect(state.tasks.get(resumable.task_id)?.attempt_id).toBe(resumable.attempt_id);
		expect(state.tasks.get(incomplete.task_id)).toMatchObject({
			status: "failed",
			failure_code: "checkpoint_incomplete",
			lease_owner: null,
		});
	});
});
