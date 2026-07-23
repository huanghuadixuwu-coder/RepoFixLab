# RepoFixLab 实验结果摘要

## 目的与口径

RepoFixLab 在冻结的 SWE-bench Multilingual JS/TS 任务、Docker 任务环境、模型修订和官方 Evaluator 条件下评估代码修复工作流。任务级 `resolved` 只有在全部 fail-to-pass（F2P）通过且所有 pass-to-pass（P2P）保持通过时成立。

- **F2P**：原本失败、修复后应通过的目标测试；衡量目标修复是否成立。
- **P2P**：原本通过、修复后仍应通过的测试；衡量是否引入回归。
- **任务成功率**：官方评测判定 `resolved` 的任务占比；不能用测试级 F2P/P2P 比例代替。

## Pi-general：26 任务基线

M9 将 M7 已有有效官方结果与新增首次运行合并为每个冻结任务一条 Pi 结果。64-turn 的已完成结果被保留为 64-turn 证据，不与后续 128-turn 结果重复计数。

| 指标 | 结果 |
| --- | ---: |
| 任务成功率 | 21/26（80.77%） |
| F2P | 29/32（90.63%） |
| P2P | 587/592（99.16%） |

该集合是“实际轮次不超过 128”的任务级视图，不构成将全部任务标作固定 128-turn 的声明。

## RepoFix：R2 当前替换视图

R2 在历史 26 任务结果基础上执行了 Controller 身份恢复、语义工作流修复、R9 follow-up 和 R12 单任务恢复。对每个冻结任务选择最新有效官方评测制品后，当前替换视图为：

| 指标 | 结果 |
| --- | ---: |
| 任务成功率 | 24/26（92.31%） |
| F2P | 30/32（93.75%） |
| P2P | 592/592（100%） |

其中仍有两个有效的语义未解决任务：`preactjs__preact-3345` 和 `preactjs__preact-3567`。R12 确认前者为 F2P 0/1、P2P 16/16 的语义未解决；R9 确认后者为 F2P 0/1、P2P 20/20 的语义未解决。

这个 24/26 是带来源标签的复合视图，由 R3 Full、Controller-identity recovery、`semantic-workflow-4`、R9、R12 和携带的 immutable-js 制品组成；不是一个重新运行的同质 26 任务批次。历史 corrected R2 Full 仍为 22/26，必须保留。

## 可比较性的边界

Pi 的 21/26 是 M9 的首次任务结果；RepoFix 的 24/26 是后续定向修复后的当前复合视图。两者不应写作一次同批次、固定预算的直接胜负比较。

对于冻结 M7/M8 主实验，74 个逻辑运行保留 64-turn 和 128-turn 两个分层；正式的 Pi/RepoFix 横向比较只在相同任务、replicate 与 turn limit 的完整配对内进行。无最终快照、环境或工作流失败同样应留在预先定义的结果/失败证据中，不能被静默替换。

## 证据入口

- [M7 continuation 协议](../designs/repofixlab-m7-protocol-1.7.md)
- [M8 分析契约](../designs/repofixlab-m8-analysis.md)
- [M9 复用完成协议](../designs/repofixlab-m9-reuse-protocol.md)
- [R2 执行契约](../designs/repofixlab-r2-execution-contract.md)
- [R2 阶段化修复复盘](../designs/repofixlab-r2-remediation-postmortem.md)

本地原始 JSON、日志、快照和 Hash 绑定制品位于 `artifacts/`，按项目策略通常不提交 Git。
