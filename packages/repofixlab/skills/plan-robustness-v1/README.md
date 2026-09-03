# RepoFix PLAN Skill

RepoFix 的 DPO 实验展示了 PLAN 阶段的四类关键痛点：长上下文中的证据绑定不稳定、候选范围容易扩张、状态转换方向容易判断错误，以及验证方案与缺陷触发路径容易错位。

本实验以 Skill 是更具性价比的增强方式为假设，将失败案例中的稳定规律蒸馏为仅在 PLAN 阶段生效的确定性流程，在不改变原有 PLAN Schema 和阶段协议的前提下，提高修复计划的完整性、证据质量与可执行性。

## 核心设计

- **证据绑定**：每个结论同时绑定路径、代码区域和真实行为。
- **因果收敛**：将 LOCALIZE 候选划分为必须修改、只读依赖和排除项，只保留必要改动。
- **状态校验**：以 `ALLOW` / `FORBID` 明确正常、异常和重入路径的状态转换方向。
- **验证对齐**：按触发条件、前置状态和可观察结果选择最贴近问题的验证候选。
- **协议兼容**：沿用 RepoFix 原有 PLAN Schema，并通过原生 `stage_complete` 完成阶段交接。

## 工作流程

```text
问题契约
  ↓
直接证据绑定
  ↓
候选因果分类
  ↓
最小完整修改计划
  ↓
状态转换与保持条件校验
  ↓
验证候选对齐
  ↓
PLAN 制品交接给 IMPLEMENT
```

## 实验效果

RepoFix 此前 26 个任务中已完成 24 个，剩余任务为 `preactjs__preact-3345` 和 `preactjs__preact-3567`。本实验选择 `preactjs__preact-3345`，通过 PLAN Skill 形成完整修复计划，并通过正式 SWE-bench 评测。

以 `preactjs__preact-3345` 为例，PLAN Skill 将修复目标明确为四项核心义务：

1. cleanup 抛错后继续执行剩余 cleanup。
2. child、sibling 和 DOM teardown 必须完成。
3. 同一 cleanup 错误只投递一次。
4. `currentComponent` 在异常路径中始终恢复。

最终补丁修改三个运行时文件：

- `hooks/src/index.js`
- `src/diff/children.js`
- `src/diff/index.js`

| 指标 | 结果 |
|---|---:|
| RepoFix 阶段 | 7/7 完成 |
| 最终验证 V2 | passed |
| 最终补丁文件 | 3 |
| 测试文件改动 | 0 |
| 正式 SWE-bench 评测 | resolved |

## 项目结构

```text
plan-robustness-v1/
├── README.md
├── SKILL.md
└── references/
    ├── evidence-and-scope.md
    ├── state-and-probe.md
    └── bad-case-patterns.md
```

`SKILL.md` 定义 PLAN 阶段必须执行的主流程；`references/` 承载证据、范围、状态转换、验证对齐与失败模式的细化规则，并与主文件共同组成固定、可校验的 Skill 指令包。
