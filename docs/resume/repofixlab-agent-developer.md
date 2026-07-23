# 项目经历：RepoFixLab

**基于真实 GitHub Issue 的容器化代码修复智能体（RepoFixLab）** | 大模型 / Agent 开发

**背景**：通用编码 Agent 即使生成了可应用补丁，也难以证明真正解决了真实 Issue，且容易因任意命令执行、环境漂移、私有评测泄露或回归测试缺失造成“表面成功”。项目以冻结的 SWE-bench Multilingual JS/TS 真实 Issue 为载体，构建代码修复 Agent 与可信评测闭环。

- 基于 Pi 公开 session API 设计 RepoFix 阶段化工作流，将问题理解、仓库定位、修复计划、P0/P1 补丁、受控验证、修订和自审串联为可追踪状态机；不改写底层 Agent loop，而在其上约束代码修复任务的输入、阶段产物和退出条件。
- 构建 Node Orchestrator + Python Controller 的双层执行架构：Controller 作为唯一 Docker socket 持有者，按固定策略创建无特权 Worker 和 fresh Evaluator；Agent 无法自行指定镜像、shell 命令、挂载、网络或 capability，降低工具调用突破任务边界的风险。
- 实现 Controller-owned 验证目录与基线/候选双克隆比对：模型只选择预检测试候选 ID，验证结果以结构化反馈驱动 REFINE；将“通用回归通过”与“目标行为已证明”分离，避免把非终止、环境失败或无关绿测误判为修复成功。
- 建立不可变证据链，关联任务/环境/模型锁、补丁快照、P0/V1/V2/P1 验证、官方 Evaluator、Token 账本和失败原因；Worker 销毁后再创建独立 Evaluator，以 F2P、P2P 和任务级 `resolved` 共同裁决结果。
- 在 26 个冻结真实 JS/TS Issue 上完成 Pi 基线与 RepoFix 后续修复实验：Pi-general 首次结果为 21/26 resolved、F2P 29/32、P2P 587/592；RepoFix 当前来源标注的替换视图为 24/26 resolved、F2P 30/32、P2P 592/592。明确保留 R2 为定向恢复合成视图的边界，不将其包装为与 Pi 的同批次固定预算胜率。

**技术栈**：TypeScript、Node.js、Python、Pi Session API、Docker Compose、JSON Schema、SWE-bench、官方 Harness、Git、PowerShell。

**面试可展开点**：

1. 为什么要让 Controller 独占 Docker socket，且将 Worker 与 Evaluator 分离？
2. 如何把模型的验证需求限制为候选 ID，而不是开放任意 shell？
3. F2P、P2P、任务成功率为何不能互相替代？
4. 如何处理无最终快照、环境失败与语义未解决，避免重跑覆盖失败证据？
