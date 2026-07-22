# RepoFixLab M8 分析与交付契约

## 目标

M8 只分析已经封存的 M7 结果，不调用 Provider、不重跑 Agent、不修改补丁或官方评测结果。它把 74 条冻结逻辑运行转换为可离线复核的统计、失败归因和对外材料。

M8 的价值不是把结果包装成正向结论，而是让任何结论都能追溯到输入制品，并在结果不支持假设时明确保留反证。

## 输入与绑定

M8 必须同时读取以下两类不可变输入：

- M7 continuation report：固定 74 个逻辑身份，标注 13 个保留的 64-turn 结果与 61 个 128-turn continuation 结果；
- 通过的 M7 security audit：覆盖全部 74 条轨迹和 patch-policy 快照。

对每条有最终补丁的运行，M8 复核 `RunResult`、`evaluation-normalized.json`、官方评测 hash、尝试 ID 和 resolved 值的一致性。对 3 条未形成最终快照的 Agent 终态失败，M8 复核其逐请求 `token-ledger.jsonl`：所有 reservation 必须均已 settled，不能把 unknown/unverified usage 当作真实消耗。

任一 hash、身份、官方评测绑定、Token 结算或安全审计不一致，M8 拒绝发布报告。

## 指标口径

### 主分母

主指标为 intention-to-treat Resolved Rate：

```text
official_resolved / 74 frozen logical runs
```

未生成最终快照的 Agent 终态失败保留在 74 的分母中。仅在 71 条有官方 Evaluator 的运行中计算的 evaluated-only rate 是辅助描述，不能替代主指标。

### 对照与统计

`pi-general` 与 `repofix-full` 的主比较仅在 `group_id=main`、相同 `instance_id`、相同 replicate、相同 `max_model_turns` 的完整配对内进行。M8 输出：

- 每个配置/turn stratum 的 Resolved Rate 及 Wilson 95% 区间；
- `repofix-full - pi-general` 的配对差值；
- 精确 McNemar 双侧 p 值；
- 以仓库为 cluster、固定 seed 和 10,000 次抽样的 repository bootstrap 区间；
- leave-one-repository-out 敏感性结果。

M7 的 64-turn 保留层和 128-turn continuation 层绝不合并为单一固定预算的性能比较。

### 工程与安全指标

M8 还汇总：

- Token：全部 74 条运行的 `accounted_tokens` 和 Provider actual Token；失败运行使用已结算 token ledger；
- CNY：仅当每条运行都有完整冻结价格证据时输出，否则严格输出 unavailable；
- 耗时：只对有 `RunResult` 的运行汇总，缺失 wall-time 证据不作补估；
- 官方测试：fail-to-pass 与 pass-to-pass；
- 稳定性：完整 replicate group 和 outcome 不一致的 group；
- 安全：blocked operation、policy violation、sandbox escape attempt 及 unblocked escape attempt。

## 失败根因

每条未 resolved 运行被分到一个互斥类别：

1. `agent_no_final_snapshot`；
2. `candidate_patch_not_applied`；
3. `evaluator_timeout`；
4. `fail_to_pass_failure`；
5. `pass_to_pass_regression`；
6. `official_unresolved_other`。

最终报告至少展示前三个非零类别及可追溯的 source run ID 样例。

## 输出与不可变性

执行 M8 后在本地 `artifacts/m8/report/` 发布同一 SHA-256 绑定的 JSON、Markdown 和静态 HTML。采用临时文件、fsync、hard-link 发布；同名输出若内容不同则失败，不覆盖已有证据。

## 结论边界

- 当前结论只适用于冻结的 26 个 SWE-bench Multilingual JS/TS 任务、固定模型版本和对应 Docker 环境；
- 统计不支持时不得声称 RepoFix 优于 Pi；
- 不以测试级 F2P/P2P 比例替代任务级 resolved rate；
- 不用缺失的价格分项反推 CNY；
- M8 不消除 M7 的轮数分层，也不把历史失败重跑为更好看的结果。
