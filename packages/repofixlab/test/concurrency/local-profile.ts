/**
 * 脚本职责：加载并冻结 16 GiB 本机并发验收参数。
 * 输入边界：只读取版本化 local-16gb.json。
 * 输出边界：返回不可改写的固定配置对象。
 */

import { readFileSync } from "node:fs";

export interface LocalConcurrencyProfile {
	readonly schema_version: "v1";
	readonly task_count: 100;
	readonly submission_batch_count: 20;
	readonly submission_batch_size: 5;
	readonly submission_interval_ms: 3000;
	readonly submission_window_ms: 60000;
	readonly worker_capacity: 20;
	readonly model_capacity: 2;
	readonly localize_task_count: 26;
	readonly localize_worker_capacity: 4;
	readonly localize_batch_count: 7;
	readonly localize_model_capacity: 2;
	readonly localize_stop_stage: "LOCALIZE";
	readonly postgres_interrupt_ms: 5000;
	readonly test_memory_peak_bytes: 12884901888;
	readonly system_available_memory_floor_bytes: 2147483648;
	readonly scheduler_tick_ms: 1000;
	readonly scheduler_lease_ms: 5000;
	readonly task_lease_ms: 60000;
}

/**
 * 函数职责：读取并校验冻结本机并发配置。
 * 输入约束：配置文件必须包含全部固定字段和值。
 * 返回结果：返回浅层冻结的本机配置。
 * 失败语义：字段缺失及数值漂移时抛出配置错误。
 */
export function loadLocalConcurrencyProfile(): Readonly<LocalConcurrencyProfile> {
	const parsed: unknown = JSON.parse(
		readFileSync(new URL("../../configs/concurrency/local-16gb.json", import.meta.url), "utf8"),
	);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("invalid_local_concurrency_profile");
	}
	const profile = parsed as Record<string, unknown>;
	if (
		profile.schema_version !== "v1" ||
		profile.task_count !== 100 ||
		profile.submission_batch_count !== 20 ||
		profile.submission_batch_size !== 5 ||
		profile.submission_interval_ms !== 3000 ||
		profile.submission_window_ms !== 60000 ||
		profile.worker_capacity !== 20 ||
		profile.model_capacity !== 2 ||
		profile.localize_task_count !== 26 ||
		profile.localize_worker_capacity !== 4 ||
		profile.localize_batch_count !== 7 ||
		profile.localize_model_capacity !== 2 ||
		profile.localize_stop_stage !== "LOCALIZE" ||
		profile.postgres_interrupt_ms !== 5000 ||
		profile.test_memory_peak_bytes !== 12884901888 ||
		profile.system_available_memory_floor_bytes !== 2147483648 ||
		profile.scheduler_tick_ms !== 1000 ||
		profile.scheduler_lease_ms !== 5000 ||
		profile.task_lease_ms !== 60000
	) {
		throw new Error("local_concurrency_profile_contract_mismatch");
	}
	return Object.freeze(profile) as unknown as Readonly<LocalConcurrencyProfile>;
}
