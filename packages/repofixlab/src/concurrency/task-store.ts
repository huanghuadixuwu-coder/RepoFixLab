/**
 * 脚本职责：定义并发任务持久化端口及原子操作输入。
 * 输入边界：接收通过契约校验的任务命令和时间值。
 * 输出边界：只暴露持久化结果，不暴露数据库驱动。
 */

import type { ConcurrencyTask, ConcurrencyTaskRequest, FailureCode, TaskStatus } from "./contracts.ts";

export interface SubmitTaskCommand {
	readonly task_id: string;
	readonly idempotency_key: string;
	readonly request_sha256: string;
	readonly request: ConcurrencyTaskRequest;
}

export interface SubmitTaskResult {
	readonly disposition: "created" | "existing";
	readonly task: ConcurrencyTask;
}

export interface ClaimQueuedCommand {
	readonly lease_name: string;
	readonly owner_id: string;
	readonly limit: number;
	readonly now: string;
	readonly lease_expires_at: string;
}

export interface TransitionTaskCommand {
	readonly task_id: string;
	readonly expected_version: number;
	readonly to_status: TaskStatus;
	readonly attempt_id: string | null;
	readonly failure_code: FailureCode | null;
	readonly result_manifest_path: string | null;
	readonly result_manifest_sha256: string | null;
}

export interface HeartbeatTaskCommand {
	readonly task_id: string;
	readonly lease_owner: string;
	readonly heartbeat_at: string;
	readonly lease_expires_at: string;
}

export interface FindExpiredLeasesCommand {
	readonly now: string;
	readonly limit: number;
}

export interface ClaimExpiredLeaseCommand {
	readonly task_id: string;
	readonly expected_version: number;
	readonly expected_lease_owner: string;
	readonly recovery_owner: string;
	readonly now: string;
	readonly lease_expires_at: string;
}

export interface RecordTaskResultCommand {
	readonly task_id: string;
	readonly expected_version: number;
	readonly result_manifest_path: string;
	readonly result_manifest_sha256: string;
}

export interface AcquireSchedulerLeaseCommand {
	readonly lease_name: string;
	readonly owner_id: string;
	readonly now: string;
	readonly expires_at: string;
}

export interface TaskSubmissionStore {
	/**
	 * 函数职责：以幂等语义持久化一项任务。
	 * 输入约束：幂等键和请求哈希必须通过契约校验。
	 * 返回结果：新请求返回新任务，重复请求返回已有任务。
	 * 失败语义：冲突请求及数据库失败时拒绝 Promise。
	 */
	submit(command: SubmitTaskCommand): Promise<SubmitTaskResult>;
}

export interface TaskSchedulingStore extends TaskSubmissionStore {
	/**
	 * 函数职责：按队列顺序原子领取可用任务。
	 * 输入约束：调用方必须持有有效调度领导租约。
	 * 返回结果：返回数量不超过 limit 的已领取任务。
	 * 失败语义：领取事务失败时不改变任务状态。
	 */
	claimQueued(command: ClaimQueuedCommand): Promise<readonly ConcurrencyTask[]>;

	/**
	 * 函数职责：按预期版本推进一项任务状态。
	 * 输入约束：任务版本和状态转换必须匹配冻结契约。
	 * 返回结果：返回已追加审计事件的新任务状态。
	 * 失败语义：版本冲突及非法转换时拒绝 Promise。
	 */
	transition(command: TransitionTaskCommand): Promise<ConcurrencyTask>;

	/**
	 * 函数职责：取得并续期单调度器领导租约。
	 * 输入约束：所有者、当前时间和到期时间必须有效。
	 * 返回结果：取得租约返回 true，竞争失败返回 false。
	 * 失败语义：数据库失败时拒绝 Promise。
	 */
	acquireSchedulerLease(command: AcquireSchedulerLeaseCommand): Promise<boolean>;
}

export interface TaskLeaseStore extends TaskSchedulingStore {
	/**
	 * 函数职责：续期当前执行器持有的任务租约。
	 * 输入约束：租约所有者必须与持久记录一致。
	 * 返回结果：续期成功返回 true，所有者失配返回 false。
	 * 失败语义：数据库失败时拒绝 Promise。
	 */
	heartbeat(command: HeartbeatTaskCommand): Promise<boolean>;

	/**
	 * 函数职责：查找达到恢复条件的失效任务。
	 * 输入约束：时间值和查询上限必须通过校验。
	 * 返回结果：返回数量不超过 limit 的失效任务。
	 * 失败语义：查询失败时拒绝 Promise。
	 */
	findExpiredLeases(command: FindExpiredLeasesCommand): Promise<readonly ConcurrencyTask[]>;

	/**
	 * 函数职责：原子领取一项已经失效的任务租约。
	 * 输入约束：任务版本和原租约所有者必须同时匹配。
	 * 返回结果：竞争成功返回 recovering 任务，失败返回 null。
	 * 失败语义：事务失败时不改变任务状态。
	 */
	claimExpiredLease(command: ClaimExpiredLeaseCommand): Promise<ConcurrencyTask | null>;
}

export interface TaskStore extends TaskLeaseStore {
	/**
	 * 函数职责：按任务版本登记不可变结果清单。
	 * 输入约束：结果路径和 SHA-256 必须通过校验。
	 * 返回结果：返回已绑定结果清单的任务状态。
	 * 失败语义：版本冲突及结果冲突时拒绝 Promise。
	 */
	recordResult(command: RecordTaskResultCommand): Promise<ConcurrencyTask>;
}
