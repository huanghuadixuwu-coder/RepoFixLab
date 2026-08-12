/**
 * 脚本职责：校验并发任务请求并生成稳定身份信息。
 * 输入边界：接收调用方幂等键和版本化任务请求。
 * 输出边界：仅向持久化端口提交已校验命令。
 */

import { createHash } from "node:crypto";
import { stableStringify } from "../contracts/canonical-json.ts";
import type { ConcurrencyTaskRequest } from "./contracts.ts";
import type { SubmitTaskResult, TaskSubmissionStore } from "./task-store.ts";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const BASELINE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export type AdmissionValidationCode =
	| "invalid_idempotency_key"
	| "invalid_repository"
	| "invalid_baseline_commit"
	| "invalid_task_content"
	| "invalid_caller_id";

export interface AdmissionSubmitCommand {
	readonly idempotency_key: string;
	readonly request: ConcurrencyTaskRequest;
}

/**
 * 类职责：表达任务准入字段不符合冻结契约。
 * 持有状态：保存稳定校验码。
 * 协作边界：不访问持久化层且不修改请求。
 */
export class AdmissionValidationError extends Error {
	readonly code: AdmissionValidationCode;

	/**
	 * 函数职责：创建带稳定校验码的准入错误。
	 * 输入约束：错误码必须来自冻结校验码集合。
	 * 返回结果：返回可供调用方识别的错误实例。
	 * 失败语义：构造过程不产生外部副作用。
	 */
	constructor(code: AdmissionValidationCode) {
		super(code);
		this.name = "AdmissionValidationError";
		this.code = code;
	}
}

/**
 * 函数职责：计算版本化任务请求的规范 SHA-256。
 * 输入约束：请求字段必须符合任务契约。
 * 返回结果：返回六十四位小写十六进制摘要。
 * 失败语义：请求含不可序列化数据时抛出异常。
 */
export function taskRequestSha256(request: ConcurrencyTaskRequest): string {
	return createHash("sha256").update(stableStringify(request), "utf8").digest("hex");
}

/**
 * 函数职责：根据幂等键生成稳定任务 ID。
 * 输入约束：幂等键必须已经通过准入校验。
 * 返回结果：返回满足数据库格式约束的任务 ID。
 * 失败语义：函数不访问外部状态。
 */
export function taskIdForIdempotencyKey(idempotencyKey: string): string {
	return `task-${createHash("sha256").update(idempotencyKey, "utf8").digest("hex")}`;
}

/**
 * 类职责：完成并发任务校验、身份生成和持久化准入。
 * 持有状态：仅持有任务提交端口。
 * 协作边界：不保存内存任务且不参与任务调度。
 */
export class AdmissionService {
	private readonly store: TaskSubmissionStore;

	/**
	 * 函数职责：绑定唯一任务提交端口。
	 * 输入约束：提交端口必须提供事务化 submit 实现。
	 * 返回结果：创建无内存任务副本的准入服务。
	 * 失败语义：构造过程不访问数据库。
	 */
	constructor(store: TaskSubmissionStore) {
		this.store = store;
	}

	/**
	 * 函数职责：校验请求并提交稳定任务身份。
	 * 输入约束：幂等键、仓库、基线、任务内容和调用身份必须有效。
	 * 返回结果：数据库提交后返回新建任务及已有任务。
	 * 失败语义：校验失败及持久化失败时拒绝 Promise。
	 */
	async submit(command: AdmissionSubmitCommand): Promise<SubmitTaskResult> {
		if (!IDEMPOTENCY_KEY_PATTERN.test(command.idempotency_key)) {
			throw new AdmissionValidationError("invalid_idempotency_key");
		}
		if (command.request.repository.trim().length === 0) {
			throw new AdmissionValidationError("invalid_repository");
		}
		if (!BASELINE_COMMIT_PATTERN.test(command.request.baseline_commit)) {
			throw new AdmissionValidationError("invalid_baseline_commit");
		}
		if (command.request.task_content.trim().length === 0) {
			throw new AdmissionValidationError("invalid_task_content");
		}
		if (command.request.caller_id.trim().length === 0) {
			throw new AdmissionValidationError("invalid_caller_id");
		}

		return this.store.submit({
			task_id: taskIdForIdempotencyKey(command.idempotency_key),
			idempotency_key: command.idempotency_key,
			request_sha256: taskRequestSha256(command.request),
			request: command.request,
		});
	}
}
