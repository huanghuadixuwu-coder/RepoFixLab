/**
 * 脚本职责：真实执行 RepoFix 至 LOCALIZE 并在结构化定位产物完成后停止。
 * 输入边界：接收已创建的 RepoFix 会话、问题描述和定位阶段证据回调。
 * 输出边界：仅返回 UNDERSTAND 与 LOCALIZE 产物，不进入代码修改阶段。
 */

import { createHash } from "node:crypto";
import {
	type RepoFixSessionResult,
	type RepoFixTrajectoryEvent,
	runRepoFixWorkflow,
	type StageRecovery,
} from "../agent/repofix.ts";
import type { StageCompletion } from "../agent/repofix-fsm.ts";
import { stableStringify } from "../contracts/canonical-json.ts";

type UnderstandCompletion = Extract<StageCompletion, { readonly stage: "UNDERSTAND" }>;
type LocalizeCompletion = Extract<StageCompletion, { readonly stage: "LOCALIZE" }>;

export interface RepoFixLocalizationCallbacks {
	readonly onStageComplete?: (completion: UnderstandCompletion | LocalizeCompletion) => Promise<void>;
	readonly onStageRecovery?: (recovery: StageRecovery) => Promise<void>;
	readonly onTrajectoryEvent?: (event: RepoFixTrajectoryEvent) => Promise<void>;
}

export interface RepoFixLocalizationResult {
	readonly schema_version: "v1";
	readonly result_type: "repofix_localization";
	readonly stages: readonly ["UNDERSTAND", "LOCALIZE"];
	readonly understand: UnderstandCompletion;
	readonly localize: LocalizeCompletion;
	readonly understand_sha256: string;
	readonly localize_sha256: string;
}

/**
 * 类职责：以内部控制信号表示 LOCALIZE 产物已经完整持久化。
 * 持有状态：不保存业务数据，只提供稳定错误名称。
 * 协作边界：仅由本脚本抛出并捕获，不暴露为任务失败。
 */
class LocalizationBoundaryReached extends Error {
	/**
	 * 函数职责：创建定位完成控制信号。
	 * 输入约束：仅在 LOCALIZE 回调成功完成后调用。
	 * 返回结果：返回固定名称的内部错误实例。
	 * 失败语义：构造过程不修改会话及文件系统。
	 */
	constructor() {
		super("repofix_localization_boundary_reached");
		this.name = "LocalizationBoundaryReached";
	}
}

/**
 * 函数职责：计算结构化阶段产物的确定性 SHA-256。
 * 输入约束：输入必须通过 RepoFix 阶段契约校验。
 * 返回结果：返回六十四位小写十六进制哈希。
 * 失败语义：序列化及哈希失败时同步抛出异常。
 */
function completionSha256(completion: StageCompletion): string {
	return createHash("sha256").update(stableStringify(completion), "utf8").digest("hex");
}

/**
 * 函数职责：执行真实 RepoFix 并在 LOCALIZE 完成边界停止。
 * 输入约束：会话配置必须以 UNDERSTAND、LOCALIZE 开始且包含定位阶段。
 * 返回结果：返回两个阶段的结构化产物及确定性哈希。
 * 失败语义：模型失败、产物非法及后续阶段越界时拒绝 Promise。
 */
export async function runRepoFixLocalization(
	session: RepoFixSessionResult,
	problemStatement: string,
	callbacks: RepoFixLocalizationCallbacks = {},
): Promise<RepoFixLocalizationResult> {
	const stages = session.stageMachine.workflowConfig.stages;
	if (stages[0] !== "UNDERSTAND" || stages[1] !== "LOCALIZE") {
		throw new Error("repofix_localization_stage_contract_mismatch");
	}

	try {
		await runRepoFixWorkflow(session, problemStatement, {
			verificationCatalog: { catalog_id: "localize-only", candidates: [] },
			onStageComplete: async (completion) => {
				if (completion.stage !== "UNDERSTAND" && completion.stage !== "LOCALIZE") {
					throw new Error("repofix_localization_stage_boundary_violated");
				}
				await callbacks.onStageComplete?.(completion);
				if (completion.stage === "LOCALIZE") throw new LocalizationBoundaryReached();
			},
			onStageRecovery: callbacks.onStageRecovery,
			onTrajectoryEvent: callbacks.onTrajectoryEvent,
			capturePatch: async () => {
				throw new Error("repofix_localization_patch_capture_forbidden");
			},
			controlledVerify: async () => {
				throw new Error("repofix_localization_verification_forbidden");
			},
		});
		throw new Error("repofix_localization_boundary_missing");
	} catch (error) {
		if (!(error instanceof LocalizationBoundaryReached)) throw error;
	}

	const completedStages = session.stageMachine.completedStages;
	if (
		completedStages.length !== 2 ||
		completedStages[0] !== "UNDERSTAND" ||
		completedStages[1] !== "LOCALIZE" ||
		session.stageMachine.activeStage !== null
	) {
		throw new Error("repofix_localization_completion_invalid");
	}
	const understand = session.stageMachine.assertComplete("UNDERSTAND");
	const localize = session.stageMachine.assertComplete("LOCALIZE");
	if (understand.stage !== "UNDERSTAND" || localize.stage !== "LOCALIZE") {
		throw new Error("repofix_localization_artifact_binding_invalid");
	}
	return {
		schema_version: "v1",
		result_type: "repofix_localization",
		stages: ["UNDERSTAND", "LOCALIZE"],
		understand,
		localize,
		understand_sha256: completionSha256(understand),
		localize_sha256: completionSha256(localize),
	};
}
