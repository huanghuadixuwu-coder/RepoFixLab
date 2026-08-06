# RepoFixLab Layered Memory 增量压缩复测

## 结果

- 日期：2026-08-06
- 任务：`preactjs__preact-4182`
- Run ID：`run-358a1e0af22042f688e6d69f63791199`
- Memory policy：`layered-memory-v1`
- 正式运行状态：`completed`
- 官方评测：`official_unresolved`
- Provider 实际及计费用量：1,769,571 tokens
- Agent turns：50/64
- 总 wall time：1,778,595 ms
- 最终补丁：空补丁

## 记忆系统结论（复盘校正）

本次运行完成全部 7 个阶段并生成最终快照，没有再次出现
`protected_context_exceeds_budget`、阶段恢复失败或 token 上限耗尽。

与修正前的 Layered 正式运行比较：

| 指标 | 修正前 | 本次 | 变化 |
|---|---:|---:|---:|
| Provider tokens | 2,385,810 | 1,769,571 | -25.8% |
| Agent 请求 | 37 | 50 | +13 |
| Condenser 请求 | 14 | 1 | -13 |
| 最大 Agent prompt | 90,788 | 76,021 | -16.3% |
| 压缩成功次数 | 14 | 1 | -13 |
| 上下文组装耗时 | 145,935 ms | 17,260 ms | -88.2% |
| 完成阶段数 | 4 | 7 | +3 |

本次 L1 增量保存 7 个阶段制品；L2 增量保存 224 条事件、4,276,483 bytes
完整证据。唯一一次压缩发生在 IMPLEMENT：condenser 输入 66,327 tokens，输出
1,319 tokens。阶段切换后 prompt 能回落，没有继续携带上一阶段全文增长。

本次 Agent wall time 增加到 1,746,148 ms，主要来自多个单次 Provider 长推理；
记忆存储、组装和 token 计数合计约 25.2 秒，不是 wall time 增长的主要来源。

上述结果证明滚动 Condensation 降低了重复压缩成本，但不能证明 L0 已正确增量演进。进一步比较同一任务修正前后的 L0 快照后确认：上一轮只实现了“上一版 summary + 新增 delta”，压缩前的文件工作集仍按 query 每轮重选，因此存在功能性回归。

## 空补丁根因

此前“空补丁不是记忆系统故障”的结论不成立。执行轨迹包含 71 次仓库工具调用：

- `repo_read`：58
- `repo_diff`：5
- `repo_list`：4
- `repo_search`：4
- `repo_edit`：0

IMPLEMENT 制品声称 `src/diff/index.js` 已修改，但工作区从未发生编辑。REFINE_1、
REFINE_2 和 SELF_REVIEW 都明确记录 `repo_diff` 为空；SELF_REVIEW 仍将未落盘的
修订标为 `implemented`，随后阶段完成被接受，最终官方评测收到空补丁。

同一任务的上一版 Layered 运行在 IMPLEMENT 读取 6 次后成功调用一次 `repo_edit`，生成 729 bytes 的 P0 patch；本次运行使用相同 PLAN、IMPLEMENT 阶段提示和工具集合，却在 IMPLEMENT 连续读取 13 次且没有编辑。L0 快照显示本次 IMPLEMENT 的文件块工作集为：

```text
0 → 2 → 1 → 1 → 6 → 2 → 1 → 2 → 2
```

当前 Assembler 只保留最近完整 assistant/tool 轮次，将更早 `repo_read` 正文排除出普通历史，再根据“冻结阶段 query + 最新 assistant”重新选择 file view。尚未触发压缩时，刚取得的代码证据已经可能退出下一轮 L0。模型因此重复读取，达到每阶段 48 KiB 模型可见仓库输出上限后进入 completion-only，`repo_edit` 才被执行层移除。

完整因果链为：

```text
压缩前 L0 按 query 有损重组
→ 当前阶段代码证据反复消失
→ Agent 重复 repo_read
→ 48 KiB 阶段输出额度耗尽
→ completion-only 禁止 repo_edit
→ FSM 接受没有实际 diff 的完成声明
→ 最终空补丁
```

因此存在三个独立事实：

1. Memory 的 L0 组装破坏了当前阶段工作证据的连续性，是重复读取和失去编辑机会的实际因果因素。
2. Agent 在允许编辑的 IMPLEMENT/REFINE 阶段没有调用 `repo_edit`。
3. RepoFix 阶段完成校验信任模型声明，没有用实际 diff/编辑证据阻止错误进入下一阶段。

第三项属于 RepoFix 执行层/FSM 的完成条件，不属于记忆的存储、压缩或上下文组装。Memory 不参与执行，但其上下文组装必须保证：当前阶段已经进入 L0 的证据只能在被可追溯压缩或阶段结束时退出，不能因下一轮 query 未命中而退出。

本次唯一一次 Condenser 调用发生在 IMPLEMENT 后段；PLAN 在未触发压缩时已经出现文件块 `0 → 2 → 1 → 0 → 0` 的回退。因此直接问题不是 L2、L1 或语义摘要内容，而是压缩前的 L0 组装规则。

## 本轮修正方向

1. 压缩前，当前阶段尚未被压缩覆盖的消息、工具结果和文件片段按 `source_event_id` 单调累积。
2. query 只从 L2 追加新证据和大文件片段，不淘汰当前阶段已有工作集。
3. 压缩成功后，只有出现在 `Condensation.source_event_ids` 中的原文才可退出 L0；系统校验“压缩前来源 = 原文保留来源 ∪ 压缩覆盖来源”。
4. 阶段结束时重置 L0；L1、L2 保持完整、增量、不可变。
5. FSM 是否接受 `implemented` 仍需以实际编辑或非空 diff 为依据，但该修正与 Memory 分开实施。

## 证据

- `artifacts/memory-pilot/preactjs-preact-4182/layered-incremental-fix/result.json`
- `artifacts/m4-dev/runs/run-358a1e0af22042f688e6d69f63791199/m4-dev-summary.json`
- `artifacts/m4-dev/runs/run-358a1e0af22042f688e6d69f63791199/token-ledger.jsonl`
- `artifacts/m4-dev/runs/run-358a1e0af22042f688e6d69f63791199/repofix-control-trajectory.json`
- `artifacts/m4-dev/runs/run-358a1e0af22042f688e6d69f63791199/trajectory.json`
- `artifacts/m4-dev/runs/run-358a1e0af22042f688e6d69f63791199/stages/self_review.json`
