---
name: repofixlab-resume-writer
description: 为大模型应用开发、LLM Agent 开发或智能体工程师岗位撰写 RepoFixLab 项目经历。适用于简历项目、项目亮点、面试自述和技术复盘；聚焦真实 GitHub Issue、代码修复 Agent、容器隔离、工具安全、官方评测与可复核指标。
---

# RepoFixLab Resume Writer

为“大模型应用开发 / Agent 开发工程师”岗位撰写高信号项目经历。将 RepoFixLab 描述为“基于真实 GitHub Issue 的容器化代码修复智能体与可信评测平台”；突出 Agent 工作流、受控工具执行、验证闭环和评测可信度，而不是把 Docker 或测试日志写成主角。

## 事实边界

- RepoFixLab 基于 Pi 的公开 session API；不声称重写了 Pi 核心 agent loop。
- Controller 是唯一 Docker socket 持有者；Worker 与 fresh Evaluator 分离，模型不能指定镜像、命令、挂载、网络或 capability。
- RepoFix workflow 包含理解、定位、计划、补丁、Controller-owned verification、修订、自审和官方评测。
- 私有 F2P/P2P、官方 Harness 与完整日志不暴露给 Agent。通用测试通过不等于官方验收。
- M9 Pi-general 26 任务首次结果：21/26 resolved、F2P 29/32、P2P 587/592。
- R2 RepoFix 当前替换视图：24/26 resolved、F2P 30/32、P2P 592/592；它是多个定向恢复批次的 provenance-labelled composite，不是与 Pi 同批次的直接显著性对照。
- 不得声称真实商业用户、线上收入、付费客户或任意 GitHub Issue 的公网一键修复能力。

## 写作规则

1. 先写问题：通用编码 Agent 缺少可靠的任务边界、工具权限和修复验收，容易把“生成补丁”误认为“解决 Issue”。
2. 每条过程描述都连接“构建内容 → 实现方式 → 工程价值”。
3. 优先选择 3–5 个亮点：RepoFix FSM、Controller-owned verification、Worker/Evaluator 隔离、不可变证据链、F2P/P2P 与失败保留。
4. 指标必须保留适用范围。可以写“26 个冻结 JS/TS 真实 Issue”；不能把 R2 24/26 写成对 Pi 21/26 的同批次胜率。
5. 避免仅列技术名词、内部版本号、测试用例数量、lint/build 通过数或 Docker health 日志。

## 推荐输出

```markdown
**基于真实 GitHub Issue 的容器化代码修复智能体（RepoFixLab）** | [时间] | 大模型 / Agent 开发

**背景**：[代码修复 Agent 的可信验收与回归控制问题]

- [动作] RepoFix 阶段化工作流，使模型从定位、计划、补丁到自审均有可追踪产物。
- [动作] 受信 Controller 与隔离 Worker/Evaluator，限制 Agent 工具权限并将官方评测置于独立环境。
- [动作] Controller-owned 验证目录和基线/候选对照反馈，避免任意命令执行与“通用测试通过即修复成功”。
- [动作] 不可变账本与报告，保留补丁快照、F2P/P2P、Token、耗时和失败证据。

**结果**：[只使用符合当前口径的指标，并写明复合结果或比较边界]

**技术栈**：TypeScript、Node.js、Python、Pi Session API、Docker、JSON Schema、SWE-bench、官方 Harness、Git、PowerShell
```

## 面试自检

- 为什么 Worker 和 Evaluator 必须分离？
- 模型为何不能直接执行任意测试命令？
- F2P、P2P 与任务级 resolved 分别防止什么误判？
- 如何证明一次补丁结果可复核、不可被重跑覆盖？
- 为什么 R2 的 24/26 不能作为对 Pi 21/26 的严格同批次胜率？
