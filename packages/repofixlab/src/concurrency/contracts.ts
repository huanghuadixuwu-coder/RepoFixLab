/**
 * 脚本职责：定义高并发任务的稳定契约与状态转换规则。
 * 输入边界：只接收版本化任务数据和已声明状态。
 * 输出边界：导出不可变类型、执行边界和转换校验。
 */

export const TASK_STATUSES = [
	"queued",
	"preparing",
	"running",
	"validating",
	"publishing",
	"recovering",
	"revalidation_required",
	"completed",
	"failed",
	"cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_FAILURE_CODES = [
	"checkpoint_incomplete",
	"workspace_cleanup_failed",
	"result_manifest_invalid",
	"task_executor_failure",
] as const;

export type FailureCode = (typeof TASK_FAILURE_CODES)[number];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	queued: ["preparing", "cancelled"],
	preparing: ["running", "recovering", "failed"],
	running: ["validating", "recovering", "failed"],
	validating: ["publishing", "recovering", "revalidation_required", "failed"],
	publishing: ["recovering", "revalidation_required", "completed", "failed"],
	recovering: ["running", "failed"],
	revalidation_required: [],
	completed: [],
	failed: [],
	cancelled: [],
};

export interface ConcurrencyTaskRequest {
	readonly repository: string;
	readonly baseline_commit: string;
	readonly task_content: string;
	readonly caller_id: string;
}

export interface ConcurrencyTask {
	readonly schema_version: "v1";
	readonly task_id: string;
	readonly idempotency_key: string;
	readonly request_sha256: string;
	readonly request: ConcurrencyTaskRequest;
	readonly enqueue_sequence: number;
	readonly status: TaskStatus;
	readonly status_version: number;
	readonly attempt_id: string | null;
	readonly lease_owner: string | null;
	readonly lease_expires_at: string | null;
	readonly heartbeat_at: string | null;
	readonly attempt_count: number;
	readonly failure_code: FailureCode | null;
	readonly result_manifest_path: string | null;
	readonly result_manifest_sha256: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

export interface TaskExecutionResult {
	readonly task_id: string;
	readonly attempt_id: string;
	readonly baseline_commit: string;
	readonly artifact_staging_root: string;
}

export interface TaskExecutor {
	/**
	 * 函数职责：执行已经绑定任务与 attempt 的单次流程。
	 * 输入约束：执行器必须由 TaskExecutorFactory 创建。
	 * 返回结果：返回工作区基线和制品暂存目录。
	 * 失败语义：执行失败时拒绝 Promise 且不伪造终态。
	 */
	execute(): Promise<TaskExecutionResult>;
}

export interface TaskExecutorFactory {
	/**
	 * 函数职责：创建任务与 attempt 独占的执行器。
	 * 输入约束：任务必须已取得有效租约。
	 * 返回结果：返回不与其他任务共享写状态的执行器。
	 * 失败语义：资源准备失败时拒绝 Promise。
	 */
	create(task: ConcurrencyTask, attemptId: string): Promise<TaskExecutor>;
}

/**
 * 类职责：表达一条被拒绝的任务状态转换。
 * 持有状态：保存转换前状态和目标状态。
 * 协作边界：只描述契约错误，不修改任务数据。
 */
export class TaskTransitionError extends Error {
	readonly fromStatus: TaskStatus;
	readonly toStatus: TaskStatus;

	/**
	 * 函数职责：创建包含稳定状态字段的转换错误。
	 * 输入约束：输入状态必须来自任务状态集合。
	 * 返回结果：返回可供调用方识别的错误实例。
	 * 失败语义：构造过程不产生外部副作用。
	 */
	constructor(fromStatus: TaskStatus, toStatus: TaskStatus) {
		super(`invalid_task_transition: ${fromStatus} -> ${toStatus}`);
		this.name = "TaskTransitionError";
		this.fromStatus = fromStatus;
		this.toStatus = toStatus;
	}
}

/**
 * 函数职责：校验任务状态转换是否属于冻结规则。
 * 输入约束：转换前状态和目标状态必须已经声明。
 * 返回结果：合法转换正常返回且不修改输入。
 * 失败语义：非法转换抛出 TaskTransitionError。
 */
export function assertTaskTransition(fromStatus: TaskStatus, toStatus: TaskStatus): void {
	if (!TASK_TRANSITIONS[fromStatus].includes(toStatus)) {
		throw new TaskTransitionError(fromStatus, toStatus);
	}
}
