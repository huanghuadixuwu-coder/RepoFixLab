# RepoFixLab 5–7 分钟演示脚本

## 0:00–0:45 问题与应用场景

“团队希望把代码修复 Agent 接入真实仓库 Issue，但不能只展示成功案例。我们需要知道：在固定模型、固定任务环境和预算下，补丁是否被独立官方 Evaluator 接受，成本是多少，失败能否复现，Agent 是否越过沙箱边界。”

展示 `docs/designs/repofixlab.md` 中 Pi、RepoFix workflow、Controller、Worker、Evaluator 和不可变制品的关系。

## 0:45–1:40 一条运行如何可信

解释 RepoFixLab 没有修改 Pi 的 agent loop：Pi 提供 session/agent loop，RepoFix 在工作流、工具协议、上下文控制和 Docker 编排边界增加约束。

展示一条 `RunResult` 与对应 `evaluation-normalized.json`：Worker 生成补丁后已销毁，fresh Evaluator 在独立环境中验证补丁。强调“Agent 自测通过”不等于“官方评测 resolved”。

## 1:40–2:30 安全与可复现

展示 M7 security audit：74 条轨迹均有安全证据，148 次被阻断操作，0 policy violation，42 次 sandbox-escape 格式尝试且 0 次未阻断。说明 Controller 是唯一 Docker socket owner，Worker/Evaluator 没有 socket、网络或 Provider key。

## 2:30–3:30 M7 的真实结果

打开 M8 HTML：

- 74 条冻结逻辑运行；
- 71 条完成独立官方评测；
- 48 条 official resolved，intention-to-treat 成功率 64.86%，Wilson 95% 区间 53.50%–74.76%；
- 23 条官方 unresolved，3 条 Agent 未生成最终快照并保留在分母。

明确说：这不是“全部成功”，也不是把 48/71 当成主成功率。

## 3:30–4:40 公平比较与负结果

展示配对比较表。64-turn 只有 1 个完整主配对；128-turn 有 11 个完整主配对，`repofix-full - pi-general = -18.18%`，McNemar exact p=0.5。

结论：**当前冻结实验不支持 RepoFix-full 优于 Pi-general 的性能宣称。** 项目的价值在于能得到这个可信、可复核的负结果，而不是选择性重跑或删掉失败。

## 4:40–5:40 工程指标与根因

展示：

- 全部 74 条运行的 Token 账本，包含 3 条 Agent 终态失败的已结算 token ledger；
- CNY 价格证据不完整时报告 unavailable，不反推成本；
- 三类失败根因：19 条 fail-to-pass failure、4 条 pass-to-pass regression、3 条无 final snapshot。

## 5:40–6:30 一键复现与后续迭代

执行或展示命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repofixlab-m8.ps1
```

说明此命令不调用模型，仅根据 hash 绑定的制品离线重建 JSON、Markdown、HTML。后续优化会作为新的冻结批次运行，不能覆盖 M7。
