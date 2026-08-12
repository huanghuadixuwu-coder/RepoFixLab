/**
 * 脚本职责：验证并发任务状态契约和错误字段。
 * 输入边界：只使用冻结状态集合与转换矩阵。
 * 输出边界：产生确定性的 Vitest 断言结果。
 */

import { describe, expect, it } from "vitest";
import {
	assertTaskTransition,
	TASK_STATUSES,
	TASK_TRANSITIONS,
	TaskTransitionError,
} from "../../src/concurrency/contracts.ts";

describe("concurrency task transitions", () => {
	/**
	 * 函数职责：验证导出的状态矩阵等于冻结设计。
	 * 输入约束：预期值逐项写明全部合法转换。
	 * 返回结果：矩阵内容和顺序完全一致。
	 * 失败语义：状态增删及转换漂移时测试失败。
	 */
	it("matches the frozen transition matrix", () => {
		expect(TASK_TRANSITIONS).toEqual({
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
		});
	});

	/**
	 * 函数职责：验证冻结矩阵中的全部合法状态转换。
	 * 输入约束：遍历契约直接导出的转换目标。
	 * 返回结果：每条合法转换均正常返回。
	 * 失败语义：任一合法转换被拒绝时测试失败。
	 */
	it("accepts every declared transition", () => {
		for (const fromStatus of TASK_STATUSES) {
			for (const toStatus of TASK_TRANSITIONS[fromStatus]) {
				expect(() => assertTaskTransition(fromStatus, toStatus)).not.toThrow();
			}
		}
	});

	/**
	 * 函数职责：验证未声明状态转换全部被拒绝。
	 * 输入约束：遍历冻结状态集合的笛卡尔积。
	 * 返回结果：每条非法转换均抛出契约错误。
	 * 失败语义：任一非法转换被接受时测试失败。
	 */
	it("rejects every undeclared transition", () => {
		for (const fromStatus of TASK_STATUSES) {
			for (const toStatus of TASK_STATUSES) {
				if (TASK_TRANSITIONS[fromStatus].includes(toStatus)) continue;
				expect(() => assertTaskTransition(fromStatus, toStatus)).toThrow(TaskTransitionError);
			}
		}
	});

	/**
	 * 函数职责：验证转换错误保留稳定状态字段。
	 * 输入约束：使用 completed 到 running 的非法转换。
	 * 返回结果：错误名称、消息和状态字段保持确定。
	 * 失败语义：错误字段漂移时测试失败。
	 */
	it("preserves stable rejected-transition fields", () => {
		try {
			assertTaskTransition("completed", "running");
			expect.unreachable("completed must remain terminal");
		} catch (error) {
			expect(error).toBeInstanceOf(TaskTransitionError);
			const transitionError = error as TaskTransitionError;
			expect(transitionError.name).toBe("TaskTransitionError");
			expect(transitionError.message).toBe("invalid_task_transition: completed -> running");
			expect(transitionError.fromStatus).toBe("completed");
			expect(transitionError.toStatus).toBe("running");
		}
	});
});
