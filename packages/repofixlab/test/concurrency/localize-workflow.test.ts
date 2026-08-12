/**
 * 脚本职责：验证真实 RepoFix 会话在 LOCALIZE 完成后严格停止。
 * 输入边界：使用项目 faux provider、完整阶段机和仓库工具传输夹具。
 * 输出边界：断言只产生 UNDERSTAND 与 LOCALIZE 两项结构化产物。
 */

import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { createRepoFixSession, type RepoFixSessionResult } from "../../src/agent/repofix.ts";
import { getRepoFixWorkflowConfig } from "../../src/agent/repofix-config.ts";
import { runRepoFixLocalization } from "../../src/concurrency/localize-workflow.ts";
import type { RepoToolTransport } from "../../src/controller/client.ts";
import type { RepoToolRequest, RepoToolResponse } from "../../src/sandbox/protocol.ts";

const harnesses: Harness[] = [];
const sessions: RepoFixSessionResult[] = [];

/**
 * 类职责：提供不会访问真实 Controller 的仓库工具传输夹具。
 * 持有状态：不保存请求及仓库内容。
 * 协作边界：仅返回协议有效的空成功结果。
 */
class LocalizeTransport implements RepoToolTransport {
	/**
	 * 函数职责：响应 RepoFix 仓库工具调用。
	 * 输入约束：请求必须通过 RepoFix 工具协议构造。
	 * 返回结果：返回与工具名称绑定的确定性成功结果。
	 * 失败语义：夹具不产生外部失败。
	 */
	async execute(request: RepoToolRequest): Promise<RepoToolResponse> {
		return {
			tool: request.tool,
			result: {
				tool: request.tool,
				exit_code: 0,
				stdout: "fixture",
				stderr: "",
				truncated: false,
				timed_out: false,
				duration_ms: 1,
			},
		};
	}
}

/**
 * 函数职责：为 faux provider 创建隔离模型注册表。
 * 输入约束：夹具必须已经完成临时目录初始化。
 * 返回结果：返回仅注册当前 faux 模型的内存表。
 * 失败语义：模型定义缺失时由注册表抛出异常。
 */
function createRegistry(harness: Harness): ModelRegistry {
	const model = harness.getModel();
	const registry = ModelRegistry.inMemory(harness.authStorage);
	registry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: harness.faux.api,
		models: harness.faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	return registry;
}

afterEach(() => {
	while (sessions.length > 0) sessions.pop()?.session.dispose();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("runRepoFixLocalization", () => {
	it("completes UNDERSTAND and LOCALIZE without entering PLAN", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("stage_complete", {
					stage: "UNDERSTAND",
					problem_summary: "summary",
					expected_behavior: ["behavior"],
					constraints: ["constraint"],
					acceptance_evidence: ["evidence"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("stage_complete", {
					stage: "LOCALIZE",
					candidates: [{ path: "src/example.ts", symbol: "target", evidence: "relevant branch" }],
					exclusions: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const session = await createRepoFixSession({
			leaseId: "lease-localize-test",
			attemptDirectory: join(harness.tempDir, "attempt"),
			cwd: harness.tempDir,
			model: harness.getModel(),
			authStorage: harness.authStorage,
			modelRegistry: createRegistry(harness),
			transport: new LocalizeTransport(),
			config: getRepoFixWorkflowConfig("repofix-full"),
			thinkingLevel: "off",
		});
		sessions.push(session);

		const result = await runRepoFixLocalization(session, "Locate the defect.");

		expect(result.stages).toEqual(["UNDERSTAND", "LOCALIZE"]);
		expect(result.localize.candidates).toHaveLength(1);
		expect(session.stageMachine.completedStages).toEqual(["UNDERSTAND", "LOCALIZE"]);
		expect(session.stageMachine.activeStage).toBeNull();
	});
});
