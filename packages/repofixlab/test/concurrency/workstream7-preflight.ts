/**
 * 脚本职责：在模型调用前验收二十六项冻结任务和真实 Controller 绑定。
 * 输入边界：读取资格清单、公共数据卷、任务环境锁和 Controller HTTP 接口。
 * 输出边界：输出任务数量、批次数、基线绑定及候选镜像预检结果。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpRuntimeController } from "../../src/runner/controller-runtime.ts";
import { DirectoryTaskEnvironmentLockSource, FilePublicTaskSource } from "../../src/runner/task-source.ts";
import { loadLocalConcurrencyProfile } from "./local-profile.ts";

const artifactsRoot = process.env.REPOFIX_ARTIFACTS_PATH ?? "/artifacts";
const eligibilityManifestPath =
	process.env.REPOFIX_WORKSTREAM7_ELIGIBILITY_MANIFEST ??
	join(artifactsRoot, "m3-eligibility", "20260720T193400Z-26-task-v1", "eligibility-manifest.json");
const taskEnvironmentRoot = fileURLToPath(new URL("../../configs/runtime/m6-26-task-v1", import.meta.url));
const runtimeConfigRoot = fileURLToPath(new URL("../../configs/runtime", import.meta.url));

/**
 * 函数职责：执行 WORKSTREAM7 全任务模型调用前预检。
 * 输入约束：Controller 容量固定为四，公共数据卷及二十六项冻结锁必须可用。
 * 返回结果：全部任务绑定一致时输出 accepted 摘要。
 * 失败语义：任一资格、数据、提交及镜像绑定失配时拒绝 Promise。
 */
async function main(): Promise<void> {
	const profile = loadLocalConcurrencyProfile();
	const parsed: unknown = JSON.parse(await readFile(eligibilityManifestPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("workstream7_preflight_eligibility_invalid");
	}
	const manifest = parsed as Record<string, unknown>;
	if (
		manifest.eligible_task_count !== profile.localize_task_count ||
		!Array.isArray(manifest.eligible_instance_ids) ||
		manifest.eligible_instance_ids.length !== profile.localize_task_count ||
		!manifest.eligible_instance_ids.every((value) => typeof value === "string")
	) {
		throw new Error("workstream7_preflight_eligibility_invalid");
	}
	const instanceIds = manifest.eligible_instance_ids as readonly string[];
	const environmentSource = new DirectoryTaskEnvironmentLockSource(taskEnvironmentRoot, {
		root_path: runtimeConfigRoot,
		relative_path: "axios-5892/dataset-lock.json",
	});
	const publicTaskSource = new FilePublicTaskSource(undefined, "test");
	const controller = new HttpRuntimeController({
		controllerUrl: process.env.REPOFIX_CONTROLLER_URL ?? "http://controller:8000",
	});
	let passed = 0;
	let preparedControllers = 0;
	for (let offset = 0; offset < instanceIds.length; offset += profile.localize_worker_capacity) {
		const batch = instanceIds.slice(offset, offset + profile.localize_worker_capacity);
		await Promise.all(
			batch.map(async (instanceId, index) => {
				const environment = await environmentSource.load(instanceId);
				const publicTask = await publicTaskSource.load(instanceId, environment);
				const attemptId = `ws7-preflight-${String(offset + index).padStart(2, "0")}`;
				const result = await controller.preflight(
					attemptId,
					`${attemptId}:preflight`,
					environment.candidateId,
					instanceId,
				);
				if (
					result.task_environment_lock_id !== environment.lockId ||
					result.task_environment_lock_sha256 !== environment.lockSha256 ||
					result.candidate_sha256 !== environment.candidateSha256 ||
					result.base_commit !== publicTask.task.base_commit
				) {
					throw new Error("workstream7_preflight_binding_mismatch");
				}
				if (offset === 0) {
					let prepared = false;
					let preparationError: unknown = null;
					try {
						const worker = await controller.prepare(
							attemptId,
							`${attemptId}:prepare`,
							environment.candidateId,
							instanceId,
						);
						prepared = true;
						const probe = await controller.toolTransport(attemptId).execute({
							leaseId: worker.leaseId,
							operationId: `${attemptId}:probe`,
							tool: "repo_list",
							input: {},
						});
						if (probe.tool !== "repo_list") throw new Error("workstream7_preflight_worker_probe_invalid");
					} catch (error) {
						preparationError = error;
					}
					if (prepared) {
						try {
							const cleanup = await controller.abort(attemptId, `${attemptId}:abort`);
							if (!cleanup.clean)
								preparationError = new Error("workstream7_preflight_worker_cleanup_incomplete");
							preparedControllers += 1;
						} catch (error) {
							preparationError =
								preparationError === null
									? error
									: new AggregateError([preparationError, error], "workstream7_preflight_and_cleanup_failed");
						}
					}
					if (preparationError !== null) throw preparationError;
				}
				passed += 1;
			}),
		);
	}
	process.stdout.write(
		`${JSON.stringify({
			workstream: 7,
			preflight_tasks: passed,
			worker_capacity: profile.localize_worker_capacity,
			batch_count: profile.localize_batch_count,
			prepared_controllers: preparedControllers,
			provider_called: false,
			status: "accepted",
		})}\n`,
	);
}

await main();
