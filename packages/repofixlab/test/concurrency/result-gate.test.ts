/**
 * 脚本职责：验证结果门禁的基线分流、原子发布和失效闭环。
 * 输入边界：使用临时目录、真实 ArtifactStore 和内存任务端口。
 * 输出边界：断言任务状态、结果引用及失败码满足冻结契约。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConcurrencyTask } from "../../src/concurrency/contracts.ts";
import { ResultGate } from "../../src/concurrency/result-gate.ts";
import type { RecordTaskResultCommand, TaskStore, TransitionTaskCommand } from "../../src/concurrency/task-store.ts";
import { ArtifactStore } from "../../src/storage/artifact-store.ts";

const baselineCommit = "a".repeat(40);
const movedCommit = "b".repeat(40);
const tempRoots: string[] = [];

/**
 * 函数职责：创建指定状态的确定性任务快照。
 * 输入约束：任务状态来自冻结状态集合。
 * 返回结果：返回字段完整且可被结果门禁消费的任务。
 * 失败语义：该夹具不访问外部资源且不抛出异常。
 */
function makeTask(status: ConcurrencyTask["status"] = "validating"): ConcurrencyTask {
	return {
		schema_version: "v1",
		task_id: "result-task-1",
		idempotency_key: "result-key-1",
		request_sha256: "c".repeat(64),
		request: {
			repository: "fixture/repository",
			baseline_commit: baselineCommit,
			task_content: "validate result gate",
			caller_id: "local-test",
		},
		enqueue_sequence: 1,
		status,
		status_version: 3,
		attempt_id: "result-task-1:attempt:1",
		lease_owner: "worker-1",
		lease_expires_at: "2026-08-09T10:05:00.000Z",
		heartbeat_at: "2026-08-09T10:00:00.000Z",
		attempt_count: 1,
		failure_code: null,
		result_manifest_path: null,
		result_manifest_sha256: null,
		created_at: "2026-08-09T09:59:00.000Z",
		updated_at: "2026-08-09T10:00:00.000Z",
	};
}

/**
 * 类职责：模拟结果门禁依赖的版本化任务持久化端口。
 * 持有状态：仅保存当前测试任务快照。
 * 协作边界：不实现准入、调度及租约查询行为。
 */
class MemoryResultStore implements Pick<TaskStore, "transition" | "recordResult"> {
	private current: ConcurrencyTask;

	/**
	 * 函数职责：绑定当前测试任务快照。
	 * 输入约束：输入任务版本是测试中的唯一事实源。
	 * 返回结果：创建无后台行为的内存端口。
	 * 失败语义：构造阶段不执行状态转换。
	 */
	constructor(task: ConcurrencyTask) {
		this.current = task;
	}

	/**
	 * 函数职责：按版本推进测试任务状态。
	 * 输入约束：任务标识及预期版本必须匹配当前快照。
	 * 返回结果：返回版本递增且字段绑定完成的新快照。
	 * 失败语义：标识及版本失配时抛出稳定异常。
	 */
	async transition(command: TransitionTaskCommand): Promise<ConcurrencyTask> {
		if (command.task_id !== this.current.task_id || command.expected_version !== this.current.status_version) {
			throw new Error("task_version_conflict");
		}
		const terminal = ["revalidation_required", "completed", "failed", "cancelled"].includes(command.to_status);
		this.current = {
			...this.current,
			status: command.to_status,
			status_version: this.current.status_version + 1,
			failure_code: command.failure_code,
			result_manifest_path: command.result_manifest_path,
			result_manifest_sha256: command.result_manifest_sha256,
			lease_owner: terminal ? null : this.current.lease_owner,
			lease_expires_at: terminal ? null : this.current.lease_expires_at,
			heartbeat_at: terminal ? null : this.current.heartbeat_at,
		};
		return this.current;
	}

	/**
	 * 函数职责：绑定最终清单并完成测试任务。
	 * 输入约束：当前任务处于 publishing 且版本匹配。
	 * 返回结果：返回携带清单引用的 completed 快照。
	 * 失败语义：状态及版本失配时抛出稳定异常。
	 */
	async recordResult(command: RecordTaskResultCommand): Promise<ConcurrencyTask> {
		if (this.current.status !== "publishing" || command.expected_version !== this.current.status_version) {
			throw new Error("result_manifest_record_conflict");
		}
		this.current = {
			...this.current,
			status: "completed",
			status_version: this.current.status_version + 1,
			lease_owner: null,
			lease_expires_at: null,
			heartbeat_at: null,
			result_manifest_path: command.result_manifest_path,
			result_manifest_sha256: command.result_manifest_sha256,
		};
		return this.current;
	}
}

/**
 * 函数职责：创建隔离的结果门禁临时根目录。
 * 输入约束：系统临时目录可创建当前进程独占子目录。
 * 返回结果：返回已登记清理责任的绝对目录路径。
 * 失败语义：目录创建失败时拒绝 Promise。
 */
async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "repofixlab-result-gate-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ResultGate", () => {
	(process.platform === "win32" ? it.skip : it)(
		"publishes immutable artifacts and completes only after manifest verification",
		async () => {
			const root = await createRoot();
			const task = makeTask();
			const store = new MemoryResultStore(task);
			const gate = new ResultGate({
				root,
				store,
				baselineSource: { currentCommit: async () => baselineCommit },
			});
			const publishing = await gate.verifyBaseline(task);
			const artifacts = await ArtifactStore.createNew(join(root, "results", `.staging-${task.task_id}`));
			await artifacts.writeNew("candidate.patch", "fixed content\n", {
				mediaType: "text/x-diff",
				sensitivity: "internal",
				generatedBy: "agent",
			});

			const published = await gate.publish(publishing, artifacts);
			const completed = await gate.recordManifest(publishing, published);

			expect(completed.status).toBe("completed");
			expect(completed.result_manifest_path).toBe(`results/${task.task_id}/result-manifest.json`);
			expect(completed.result_manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
		},
	);

	it("moves a changed target baseline to revalidation_required without publishing", async () => {
		const task = makeTask();
		const store = new MemoryResultStore(task);
		const gate = new ResultGate({
			root: await createRoot(),
			store,
			baselineSource: { currentCommit: async () => movedCommit },
		});

		const changed = await gate.verifyBaseline(task);

		expect(changed.status).toBe("revalidation_required");
		expect(changed.result_manifest_path).toBeNull();
	});

	(process.platform === "win32" ? it.skip : it)(
		"fails a task when the published manifest bytes no longer match",
		async () => {
			const root = await createRoot();
			const task = makeTask();
			const store = new MemoryResultStore(task);
			const gate = new ResultGate({
				root,
				store,
				baselineSource: { currentCommit: async () => baselineCommit },
			});
			const publishing = await gate.verifyBaseline(task);
			const artifacts = await ArtifactStore.createNew(join(root, "results", `.staging-${task.task_id}`));
			await artifacts.writeNew("candidate.patch", "fixed content\n", {
				mediaType: "text/x-diff",
				sensitivity: "internal",
				generatedBy: "agent",
			});
			const published = await gate.publish(publishing, artifacts);
			await writeFile(join(root, published.manifest_path), "{}\n", "utf8");

			const failed = await gate.recordManifest(publishing, published);

			expect(failed.status).toBe("failed");
			expect(failed.failure_code).toBe("result_manifest_invalid");
			expect(failed.result_manifest_path).toBeNull();
		},
	);
});
