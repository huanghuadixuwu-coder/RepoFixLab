/**
 * 脚本职责：验证固定容量闸门的等待、转交和错误语义。
 * 输入边界：只使用容量为二的本地闸门。
 * 输出边界：产生确定性的 Vitest 断言结果。
 */

import { describe, expect, it } from "vitest";
import { CapacityGate } from "../../src/concurrency/capacity-gate.ts";

describe("concurrency capacity gate", () => {
	/**
	 * 函数职责：验证满载请求等待并接收释放名额。
	 * 输入约束：连续取得三个容量为二的名额。
	 * 返回结果：占用峰值固定为二且最终归零。
	 * 失败语义：等待绕过容量限制时测试失败。
	 */
	it("holds the fixed upstream limit", async () => {
		const gate = new CapacityGate("model", 2);
		await gate.acquire();
		await gate.acquire();
		const third = gate.acquire();
		await Promise.resolve();

		expect(gate.snapshot()).toMatchObject({ capacity: 2, in_use: 2, waiting: 1, peak_in_use: 2 });
		gate.release();
		await third;
		expect(gate.snapshot()).toMatchObject({ in_use: 2, waiting: 0, peak_in_use: 2 });
		gate.release();
		gate.release();
		expect(gate.snapshot()).toMatchObject({ in_use: 0, waiting: 0, peak_in_use: 2 });
	});

	/**
	 * 函数职责：验证无占用释放被稳定拒绝。
	 * 输入约束：新建闸门后直接调用 release。
	 * 返回结果：抛出固定状态错误消息。
	 * 失败语义：错误释放改变计数时测试失败。
	 */
	it("rejects release without an acquired slot", () => {
		const gate = new CapacityGate("model", 2);
		expect(() => gate.release()).toThrow("capacity_gate_release_without_acquire");
		expect(gate.snapshot().in_use).toBe(0);
	});
});
