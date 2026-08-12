/**
 * 脚本职责：维护任务心跳并恢复租约失效任务。
 * 输入边界：接收任务租约端口、checkpoint 来源和受控时钟。
 * 输出边界：提交恢复状态并返回确定性恢复结果。
 */

import type { AttemptRecoveryCheckpoint } from "../runner/batch-state.ts";
import { evaluateAttemptRecovery } from "../runner/batch-state.ts";
import type { ConcurrencyTask } from "./contracts.ts";
import type { TaskLeaseStore } from "./task-store.ts";

export const TASK_LEASE_DURATION_MS = 60_000;
export const TASK_HEARTBEAT_INTERVAL_MS = 20_000;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export interface RecoveryCheckpointSource {
	/**
	 * 函数职责：读取任务当前 attempt 的持久化 checkpoint。
	 * 输入约束：任务必须已经被当前恢复所有者领取。
	 * 返回结果：完整记录存在时返回记录，缺失时返回 null。
	 * 失败语义：存储读取失败时拒绝 Promise。
	 */
	load(task: ConcurrencyTask): Promise<AttemptRecoveryCheckpoint | null>;
}

export interface LeaseManagerOptions {
	readonly store: Pick<TaskLeaseStore, "heartbeat" | "findExpiredLeases" | "claimExpiredLease" | "transition">;
	readonly checkpoint_source: RecoveryCheckpointSource;
	readonly owner_id: string;
	readonly now?: () => Date;
}

export interface TaskRecoveryResult {
	readonly task_id: string;
	readonly disposition: "resumed" | "failed";
	readonly attempt_id: string;
	readonly recovery_owner: string;
	readonly decision_reason: string;
	readonly token_ledger_offset: number | null;
}

export interface RecoveryBatchResult {
	readonly inspected_count: number;
	readonly claimed_count: number;
	readonly results: readonly TaskRecoveryResult[];
}

export interface LeaseManagerSnapshot {
	readonly active_heartbeats: number;
	readonly heartbeat_succeeded: number;
	readonly heartbeat_rejected: number;
	readonly heartbeat_failed: number;
	readonly recovery_inspected: number;
	readonly recovery_claimed: number;
	readonly recovery_resumed: number;
	readonly recovery_failed: number;
}

interface HeartbeatState {
	timer: ReturnType<typeof setInterval> | null;
	running: boolean;
}

/**
 * 类职责：维护固定心跳并协调失效任务单所有者恢复。
 * 持有状态：保存恢复所有者、时钟、定时器和运行统计。
 * 协作边界：只经任务存储端口改变状态，不执行任务主体。
 */
export class LeaseManager {
	private readonly store: LeaseManagerOptions["store"];
	private readonly checkpointSource: RecoveryCheckpointSource;
	private readonly ownerId: string;
	private readonly now: () => Date;
	private readonly heartbeatStates = new Map<string, HeartbeatState>();
	private heartbeatSucceeded = 0;
	private heartbeatRejected = 0;
	private heartbeatFailed = 0;
	private recoveryInspected = 0;
	private recoveryClaimed = 0;
	private recoveryResumed = 0;
	private recoveryFailed = 0;

	/**
	 * 函数职责：绑定租约存储、checkpoint 来源和恢复身份。
	 * 输入约束：所有者必须符合任务租约标识格式。
	 * 返回结果：创建无活动心跳的租约管理器。
	 * 失败语义：所有者无效时抛出稳定配置错误。
	 */
	constructor(options: LeaseManagerOptions) {
		if (!IDENTIFIER_PATTERN.test(options.owner_id)) throw new Error("invalid_lease_manager_owner_id");
		this.store = options.store;
		this.checkpointSource = options.checkpoint_source;
		this.ownerId = options.owner_id;
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * 函数职责：立即续租并启动固定二十秒心跳。
	 * 输入约束：任务当前租约所有者必须等于管理器身份。
	 * 返回结果：首次续租成功后建立单任务定时器。
	 * 失败语义：租约失配及持久化失败时不保留定时器。
	 */
	async startHeartbeat(task: Pick<ConcurrencyTask, "task_id" | "lease_owner">): Promise<void> {
		if (task.lease_owner !== this.ownerId) throw new Error("task_lease_owner_mismatch");
		if (this.heartbeatStates.has(task.task_id)) throw new Error("task_heartbeat_already_started");
		const state: HeartbeatState = { timer: null, running: false };
		this.heartbeatStates.set(task.task_id, state);
		try {
			const accepted = await this.sendHeartbeat(task.task_id);
			if (!accepted) {
				this.heartbeatRejected += 1;
				throw new Error("task_heartbeat_rejected");
			}
			this.heartbeatSucceeded += 1;
			state.timer = setInterval(() => {
				void this.runScheduledHeartbeat(task.task_id, state);
			}, TASK_HEARTBEAT_INTERVAL_MS);
		} catch (error) {
			this.heartbeatStates.delete(task.task_id);
			throw error;
		}
	}

	/**
	 * 函数职责：停止指定任务的租约心跳。
	 * 输入约束：任务 ID 必须来自已启动心跳任务。
	 * 返回结果：存在心跳时停止并返回 true。
	 * 失败语义：任务没有活动心跳时返回 false。
	 */
	stopHeartbeat(taskId: string): boolean {
		const state = this.heartbeatStates.get(taskId);
		if (state === undefined) return false;
		if (state.timer !== null) clearInterval(state.timer);
		this.heartbeatStates.delete(taskId);
		return true;
	}

	/**
	 * 函数职责：领取到期任务并按 checkpoint 判定恢复结果。
	 * 输入约束：查询上限必须是正安全整数。
	 * 返回结果：返回当前管理器成功领取的确定性结果。
	 * 失败语义：存储事务失败时拒绝 Promise 并保留已提交状态。
	 */
	async recoverExpired(limit: number): Promise<RecoveryBatchResult> {
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("invalid_recovery_limit");
		const now = this.currentTime();
		const leaseExpiresAt = new Date(now.getTime() + TASK_LEASE_DURATION_MS).toISOString();
		const candidates = await this.store.findExpiredLeases({ now: now.toISOString(), limit });
		this.recoveryInspected += candidates.length;
		const attempted = await Promise.all(
			candidates.map(async (candidate): Promise<TaskRecoveryResult | null> => {
				if (candidate.lease_owner === null || candidate.attempt_id === null) {
					throw new Error("expired_task_missing_lease_binding");
				}
				const claimed = await this.store.claimExpiredLease({
					task_id: candidate.task_id,
					expected_version: candidate.status_version,
					expected_lease_owner: candidate.lease_owner,
					recovery_owner: this.ownerId,
					now: now.toISOString(),
					lease_expires_at: leaseExpiresAt,
				});
				if (claimed === null) return null;
				this.recoveryClaimed += 1;
				return this.resolveRecovery(claimed, candidate.lease_owner);
			}),
		);
		const results: TaskRecoveryResult[] = [];
		for (const result of attempted) {
			if (result !== null) results.push(result);
		}
		return Object.freeze({
			inspected_count: candidates.length,
			claimed_count: results.length,
			results: Object.freeze(results),
		});
	}

	/**
	 * 函数职责：读取租约管理器当前运行统计。
	 * 输入约束：函数不接收外部输入。
	 * 返回结果：返回不可变数值快照。
	 * 失败语义：函数不产生失败和副作用。
	 */
	snapshot(): LeaseManagerSnapshot {
		return Object.freeze({
			active_heartbeats: this.heartbeatStates.size,
			heartbeat_succeeded: this.heartbeatSucceeded,
			heartbeat_rejected: this.heartbeatRejected,
			heartbeat_failed: this.heartbeatFailed,
			recovery_inspected: this.recoveryInspected,
			recovery_claimed: this.recoveryClaimed,
			recovery_resumed: this.recoveryResumed,
			recovery_failed: this.recoveryFailed,
		});
	}

	/**
	 * 函数职责：发送单次固定六十秒任务续租。
	 * 输入约束：任务必须由当前管理器持有。
	 * 返回结果：返回持久化层所有权判定结果。
	 * 失败语义：时间及数据库失败时拒绝 Promise。
	 */
	private async sendHeartbeat(taskId: string): Promise<boolean> {
		const now = this.currentTime();
		return this.store.heartbeat({
			task_id: taskId,
			lease_owner: this.ownerId,
			heartbeat_at: now.toISOString(),
			lease_expires_at: new Date(now.getTime() + TASK_LEASE_DURATION_MS).toISOString(),
		});
	}

	/**
	 * 函数职责：执行不重叠的后台心跳并记录结果。
	 * 输入约束：状态必须属于当前活动任务。
	 * 返回结果：心跳完成后释放任务内运行标记。
	 * 失败语义：数据库失败只记录统计并等待下一周期。
	 */
	private async runScheduledHeartbeat(taskId: string, state: HeartbeatState): Promise<void> {
		if (state.running || this.heartbeatStates.get(taskId) !== state) return;
		state.running = true;
		try {
			if (await this.sendHeartbeat(taskId)) {
				this.heartbeatSucceeded += 1;
			} else {
				this.heartbeatRejected += 1;
				this.stopHeartbeat(taskId);
			}
		} catch {
			this.heartbeatFailed += 1;
		} finally {
			state.running = false;
		}
	}

	/**
	 * 函数职责：按 checkpoint 完整性推进恢复任务。
	 * 输入约束：任务归属当前所有者且 checkpoint 绑定原租约。
	 * 返回结果：返回继续原 attempt 及稳定失败结果。
	 * 失败语义：状态持久化失败时拒绝 Promise。
	 */
	private async resolveRecovery(task: ConcurrencyTask, previousLeaseOwner: string): Promise<TaskRecoveryResult> {
		if (task.status !== "recovering" || task.lease_owner !== this.ownerId || task.attempt_id === null) {
			throw new Error("recovery_task_binding_invalid");
		}
		let checkpoint: AttemptRecoveryCheckpoint | null = null;
		let decisionReason = "checkpoint_missing";
		try {
			checkpoint = await this.checkpointSource.load(task);
		} catch {
			decisionReason = "checkpoint_load_failed";
		}
		if (checkpoint !== null && checkpoint.attempt_id !== task.attempt_id) {
			decisionReason = "checkpoint_attempt_binding_mismatch";
			checkpoint = null;
		}
		if (checkpoint !== null && checkpoint.worker_lease_id !== previousLeaseOwner) {
			decisionReason = "checkpoint_lease_binding_mismatch";
			checkpoint = null;
		}
		if (checkpoint !== null) {
			const decision = evaluateAttemptRecovery(checkpoint);
			decisionReason = decision.reason;
			if (decision.action === "resume_same_attempt") {
				await this.store.transition({
					task_id: task.task_id,
					expected_version: task.status_version,
					to_status: "running",
					attempt_id: task.attempt_id,
					failure_code: null,
					result_manifest_path: null,
					result_manifest_sha256: null,
				});
				this.recoveryResumed += 1;
				return Object.freeze({
					task_id: task.task_id,
					disposition: "resumed",
					attempt_id: task.attempt_id,
					recovery_owner: this.ownerId,
					decision_reason: decisionReason,
					token_ledger_offset: checkpoint.token_ledger_offset,
				});
			}
		}

		await this.store.transition({
			task_id: task.task_id,
			expected_version: task.status_version,
			to_status: "failed",
			attempt_id: task.attempt_id,
			failure_code: "checkpoint_incomplete",
			result_manifest_path: null,
			result_manifest_sha256: null,
		});
		this.recoveryFailed += 1;
		return Object.freeze({
			task_id: task.task_id,
			disposition: "failed",
			attempt_id: task.attempt_id,
			recovery_owner: this.ownerId,
			decision_reason: decisionReason,
			token_ledger_offset: null,
		});
	}

	/**
	 * 函数职责：读取并校验当前测试及系统时间。
	 * 输入约束：时钟函数必须返回有效 Date。
	 * 返回结果：返回克隆后的时间值。
	 * 失败语义：无效时间抛出稳定时钟错误。
	 */
	private currentTime(): Date {
		const now = new Date(this.now().getTime());
		if (Number.isNaN(now.getTime())) throw new Error("invalid_lease_clock");
		return now;
	}
}
