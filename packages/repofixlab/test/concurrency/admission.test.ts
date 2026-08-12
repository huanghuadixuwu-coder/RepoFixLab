/**
 * 脚本职责：验证任务准入的哈希、稳定 ID 和字段校验。
 * 输入边界：使用固定任务请求和无外部状态的提交端口。
 * 输出边界：产生确定性的 Vitest 断言结果。
 */

import { describe, expect, it } from "vitest";
import {
	AdmissionService,
	AdmissionValidationError,
	taskIdForIdempotencyKey,
	taskRequestSha256,
} from "../../src/concurrency/admission-service.ts";
import type { ConcurrencyTaskRequest } from "../../src/concurrency/contracts.ts";
import type { SubmitTaskCommand, SubmitTaskResult, TaskSubmissionStore } from "../../src/concurrency/task-store.ts";

const request: ConcurrencyTaskRequest = {
	repository: "fixture/repo",
	baseline_commit: "a".repeat(40),
	task_content: "fix race",
	caller_id: "local-user",
};

/**
 * 类职责：记录准入服务提交的单条持久化命令。
 * 持有状态：保存最近命令和固定返回结果。
 * 协作边界：仅用于单元测试且不模拟数据库事务。
 */
class RecordingSubmissionStore implements TaskSubmissionStore {
	lastCommand: SubmitTaskCommand | null = null;

	/**
	 * 函数职责：记录一条已校验任务提交命令。
	 * 输入约束：命令由 AdmissionService 生成。
	 * 返回结果：返回与命令字段一致的固定任务快照。
	 * 失败语义：测试适配器不注入失败。
	 */
	async submit(command: SubmitTaskCommand): Promise<SubmitTaskResult> {
		this.lastCommand = command;
		return {
			disposition: "created",
			task: {
				schema_version: "v1",
				task_id: command.task_id,
				idempotency_key: command.idempotency_key,
				request_sha256: command.request_sha256,
				request: command.request,
				enqueue_sequence: 1,
				status: "queued",
				status_version: 0,
				attempt_id: null,
				lease_owner: null,
				lease_expires_at: null,
				heartbeat_at: null,
				attempt_count: 0,
				failure_code: null,
				result_manifest_path: null,
				result_manifest_sha256: null,
				created_at: "2026-08-09T00:00:00.000Z",
				updated_at: "2026-08-09T00:00:00.000Z",
			},
		};
	}
}

describe("concurrency task admission", () => {
	/**
	 * 函数职责：验证规范请求哈希和稳定任务 ID。
	 * 输入约束：使用固定请求和固定幂等键。
	 * 返回结果：摘要与任务 ID 完全匹配冻结值。
	 * 失败语义：规范序列化及身份算法漂移时测试失败。
	 */
	it("keeps request identity deterministic", () => {
		expect(taskRequestSha256(request)).toBe("a33f5edc7ceb3d13bee363eafb8c4380c19563e01f5858c4fc809045ff6d3036");
		expect(taskIdForIdempotencyKey("ws2-same-request")).toBe(
			"task-cc00728e2d05a1052abeda67a2507df84ace2692d1698a34fd5a7ae4866f9884",
		);
	});

	/**
	 * 函数职责：验证准入服务只提交已生成的稳定身份。
	 * 输入约束：提交端口仅记录接收命令。
	 * 返回结果：服务结果与持久化结果保持同一引用。
	 * 失败语义：服务产生内存副本及字段漂移时测试失败。
	 */
	it("delegates accepted requests without local staging", async () => {
		const store = new RecordingSubmissionStore();
		const service = new AdmissionService(store);
		const result = await service.submit({ idempotency_key: "ws2-same-request", request });

		expect(result.task.task_id).toBe(taskIdForIdempotencyKey("ws2-same-request"));
		expect(store.lastCommand).toEqual({
			task_id: taskIdForIdempotencyKey("ws2-same-request"),
			idempotency_key: "ws2-same-request",
			request_sha256: taskRequestSha256(request),
			request,
		});
	});

	/**
	 * 函数职责：验证无效准入字段在持久化前被拒绝。
	 * 输入约束：依次注入非法幂等键和非法基线。
	 * 返回结果：返回稳定校验错误码。
	 * 失败语义：无效请求进入提交端口时测试失败。
	 */
	it("rejects invalid identity fields before persistence", async () => {
		const store = new RecordingSubmissionStore();
		const service = new AdmissionService(store);

		await expect(service.submit({ idempotency_key: "bad key", request })).rejects.toMatchObject({
			name: "AdmissionValidationError",
			code: "invalid_idempotency_key",
		});
		await expect(
			service.submit({
				idempotency_key: "valid-key",
				request: { ...request, baseline_commit: "HEAD" },
			}),
		).rejects.toBeInstanceOf(AdmissionValidationError);
		expect(store.lastCommand).toBeNull();
	});
});
