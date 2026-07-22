# RepoFixLab 简历与面试材料

## 简历项目描述

**RepoFixLab：基于真实 GitHub Issue 的容器化代码修复 Agent 与可信评测平台**

- 基于 Pi public session API 构建 RepoFix FSM 与受控工具边界，保持 Pi 原生 agent loop 不变；实现 Worker 修复、独立 Evaluator、不可变 patch/result/evidence 制品链。
- 面向 26 个冻结 SWE-bench Multilingual JS/TS 任务组织 74 条逻辑运行；71 条进入独立官方 Evaluator，48 条 official resolved。主指标按全部冻结运行计算为 **64.86%（48/74，Wilson 95%：53.50%–74.76%）**。
- 建立离线 M8 分析：按 64/128-turn 分层计算 Wilson 区间、配对差值、McNemar、仓库级 bootstrap、leave-one-repository-out、稳定性和失败根因；不将不同 turn limit 的结果混合为性能结论。
- 实现 Docker 安全审计与全量轨迹复核：74 条运行均有安全证据，记录 **148** 次受阻操作、**0** policy violation、**42** 次 sandbox-escape 尝试且 **0** 次未阻断；3 条 Agent 终态失败的已结算 Token 同样计入成本账本。

## 面试高频问答

### 为什么不直接用 Agent 自己跑测试？

Agent 的自测是工作流中的反馈，不是最终裁决。RepoFixLab 会销毁 Worker，再在 fresh Evaluator 中运行独立官方评测。最终 resolved 只来自官方 Evaluator 绑定的结果。

### 为什么 48/71 不是主成功率？

71 是已产出最终补丁并完成评测的数量。若用 48/71，会排除 3 条 Agent 未生成最终快照的失败运行。正式主指标必须是冻结时预先确定的 74 条逻辑运行，因此为 48/74。

### RepoFix 是否优于 Pi？

不能这样声称。当前主配对样本很小：64-turn 仅 1 对，128-turn 11 对；128-turn 的 RepoFix-full 相对 Pi-general 差值为 -18.18%，McNemar exact p=0.5。正确结论是当前证据不支持性能优越性。下一轮改进必须新建冻结批次，不能重写 M7。

### 为什么 CNY 显示 unavailable？

Token 总量已逐请求结算，但所有运行没有完整的冻结价格分项证据。为了不把估算当实测，M8 保留 unavailable。这比根据临时价格表反推一个看似精确的金额更可信。

### 这个项目解决什么真实问题？

适用于研发效能/Agent 平台团队上线代码修复能力前的验收：固定任务、模型、镜像和预算，独立裁决补丁，保留失败，审计越权工具调用，并能在不再次付费调用模型的情况下复算报告。
