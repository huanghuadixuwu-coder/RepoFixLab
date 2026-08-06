# RepoFixLab Layered Memory PLAN 失败记录

## 1. 事件信息

- 日期：2026-08-05
- 任务：`preactjs__preact-4182`
- Run ID：`run-a7c219d8b6e4f9a8d156b03e7c42f611`
- Memory policy：`layered-memory-v1`
- 停止阶段：`PLAN`
- 表面错误：`stage_completion_missing_after_recovery: PLAN`
- 实际错误：`repofixlab_memory_infrastructure_failure: protected_context_exceeds_budget`

## 2. 现象

Layered Agent 正常完成 `UNDERSTAND` 和 `LOCALIZE`。`PLAN` 的第三次 Provider 请求完成后，Agent 又读取了三个文件，但下一次 Provider 请求没有发出。两次 completion-only 恢复同样没有调用 Provider，工作流最终以缺少 `stage_complete` 结束。

这次失败不是 Token 预留越界。21 次 Provider 预留全部以 `131072` tokens 打开并正常结算，也没有工具结果截断。

## 3. 证据

最后一个成功的 PLAN 请求具有以下特征：

- 请求 ID：`attempt-run-a7c219d8b6e4f9a8d156b03e7c42f611-001:provider:0020`
- Provider prompt：77668 tokens
- Provider completion：26285 tokens
- 其中 reasoning：26078 tokens
- assistant thinking：97646 字符
- 工具调用：3 个 `repo_read`
- 三个工具结果的模型可见文本合计约 6.7 KiB

该请求前的未压缩上下文估算为 80486 tokens，低于 70% 触发线 91750，因此没有触发压缩。请求完成后，Context Assembler 将最新完整 assistant/tool 轮次原样放入 L0 tail；其中超长 reasoning 也被视为不可压缩内容。

同一时刻，受保护索引包含 145 项，序列化后为 58770 字符。最新轮次与受保护索引叠加后，受保护上下文本身超过 50% 压缩目标；完整输入再加 16384 tokens 输出预留也超过 131072 tokens 窗口，因此组装器在 Provider 调用前失败。

运行证据：

- `artifacts/m4-dev/runs/run-a7c219d8b6e4f9a8d156b03e7c42f611/failed-trajectory.json`
- `artifacts/m4-dev/runs/run-a7c219d8b6e4f9a8d156b03e7c42f611/token-ledger.jsonl`
- `artifacts/m4-dev/runs/run-a7c219d8b6e4f9a8d156b03e7c42f611/repofix-control-trajectory.json`
- `artifacts/m4-dev/runs/run-a7c219d8b6e4f9a8d156b03e7c42f611/memory-metrics.json`

## 4. 根因

根因是 L0 压缩边界的错误假设：系统假定“最近一个完整 assistant/tool 轮次”一定能够整体放入受保护预算。Provider 可以产生远大于普通回复的 reasoning；当 reasoning 与工具调用位于同一 assistant 消息时，现有 tail 规则使 reasoning 无法进入语义压缩区间。

失败后还有两个放大因素：

1. `RepoFixMemoryRuntime` 将一次请求相关的容量失败记录为永久基础设施故障，后续请求不再尝试重新组装。
2. 工作流将两次 context preparation error 最终报告成 `stage_completion_missing_after_recovery`，使表面错误掩盖了真实原因。

## 5. 修复决定

保持四层记忆定义不变，只修改 L0 视图和请求级故障处理：

1. assistant/tool 原始消息仍完整、增量写入 L2。
2. L0 最近工具轮次保留原生 tool call 与对应 tool result 的协议结构。
3. 同一 assistant 消息中的 text/reasoning 从原生 tail 分离，作为带 L2 事件引用的自由文本视图参与现有 head-summary-tail 压缩。
4. `protected_context_exceeds_budget` 等请求相关容量错误只终止当前组装，不永久锁死 Memory Runtime；完整性和存储错误仍保持 fail-closed。
5. 不修改 L1、L2 原始记录，不增加新的记忆层或执行模块。

## 6. 验证要求

回归测试必须证明：

- 超长最近 reasoning 会进入 condenser 输入，而不是继续留在受保护 tail。
- 组装后的 L0 不再包含未压缩 reasoning。
- tool call 和 tool result 的原生协议结构仍存在。
- L2 中仍保存完整 assistant 原始消息。
- 一次请求级容量失败后，同一个 Memory Runtime 可以重新组装后续安全请求。

验证结果：

- `memory-system.test.ts`：8/8 通过。
- RepoFixLab TypeScript `--noEmit`：通过。
- 修改文件的 Biome 检查：通过。

## 7. 正式复测结果

- 日期：2026-08-06
- Run ID：`run-3e21c7a0d2b844029c943f9e66f5b1a7`
- 任务：`preactjs__preact-4182`
- Memory policy：`layered-memory-v1`
- Provider 预算：2,500,000 tokens
- 最终阶段：`REFINE_1`

原故障已通过正式运行验证修复。运行在 `LOCALIZE` 首次把约 92,032 tokens 的未压缩视图压缩为约 54,655 tokens，随后正常越过旧故障所在的 `PLAN`，并依次进入 `IMPLEMENT`、`V0` 和 `REFINE_1`。全程没有出现 `protected_context_exceeds_budget`；L2 增量保存了 167 个事件和约 4.54 MB 原始证据。

需要区分终止阶段指标与整次运行指标：`m4-dev-summary.json` 中的 `truncated_calls: 0` 只表示终止时的 `REFINE_1`。整次运行的模型可见工具输出截断次数依次为：`UNDERSTAND` 3 次、`LOCALIZE` 3 次、`PLAN` 2 次、`IMPLEMENT` 1 次、`REFINE_1` 0 次。

本次共触发压缩 17 次，成功生成 14 个压缩视图。部分 PLAN 视图变化如下：

- 91,929 -> 34,817 tokens
- 99,322 -> 36,667 tokens
- 96,902 -> 33,440 tokens

运行没有完成正式评测，但原因已经改变。51 个 Provider 请求实际结算 2,385,810 tokens，其中 Agent 使用 1,709,868，Condenser 使用 675,942。剩余额度 114,190 tokens，低于单请求确定性预留量 131,072；`REFINE_1` 的后续 Agent/Condenser 请求共被拒绝 6 次，最终以 `stage_completion_missing_after_recovery: REFINE_1` 结束，未生成最终快照。

`V0` 的基线与候选验证均因相同的任务环境构建错误失败：

- `test/shared/createContext.test.js` 无法解析 `../../`
- `test/shared/createElement.test.js` 无法解析 `../../`
- `test/shared/exports.test.js` 无法解析 `../../`
- `test/shared/isValidElement.test.js` 无法解析 `../../`

因此，本次正式复测得到两个独立结论：

1. L0 tail 压缩修复有效，原 PLAN 上下文组装故障已消失。
2. 当前完整任务受验证基线错误和 2.5M Provider 预算限制，不能据此判断候选补丁是否通过官方评测。

复测证据：

- `artifacts/m4-dev/runs/run-3e21c7a0d2b844029c943f9e66f5b1a7/m4-dev-summary.json`
- `artifacts/m4-dev/runs/run-3e21c7a0d2b844029c943f9e66f5b1a7/token-ledger.jsonl`
- `artifacts/m4-dev/runs/run-3e21c7a0d2b844029c943f9e66f5b1a7/controlled-verify-v0.json`
- `artifacts/memory-pilot/preactjs-preact-4182/layered-tail-fix/result.json`

## 8. 完整失败根因

### 8.1 直接终止条件

本次运行结算了 51 个 Provider 请求，共使用 2,385,810 tokens：

| 类型 | 请求数 | Tokens |
|---|---:|---:|
| Agent | 37 | 1,709,868 |
| Condenser | 14 | 675,942 |
| 总计 | 51 | 2,385,810 |

预算剩余 114,190 tokens，低于 Agent 和 Condenser 共用的确定性单请求预留量 131,072。`REFINE_1` 随后三轮请求都先发生 Condenser 准入拒绝，再回退到未压缩视图并发生 Agent 准入拒绝，共形成 6 个 `budget_exhausted` 事件。阶段无法提交 `stage_complete`，最终才表现为 `stage_completion_missing_after_recovery: REFINE_1`。

因此，预算耗尽是直接终止条件，`stage_completion_missing_after_recovery` 和 `M7 Agent did not produce a retained final snapshot` 都是后续表面错误。

### 8.2 首要根因：每次请求重新全量压缩

当前 L0 组装每次都重新扫描全部 L1、当前阶段全部历史消息、工具结果、匹配文件块和 reasoning，并从原始单元重新构造 `middle`。只要新增一条消息或工具结果，`input_sha256` 就会变化，之前的 condensation 不能命中。

实际运行中压缩触发 17 次、成功 14 次，并保存了 14 个不同的 condensation，旧压缩制品复用次数为 0。当前过程是：

```text
raw-history-1 -> summary-1
raw-history-1 + delta-2 -> summary-2
raw-history-1 + delta-2 + delta-3 -> summary-3
```

而不是增量过程：

```text
summary-1 + delta-2 -> summary-2
summary-2 + delta-3 -> summary-3
```

这使 condensation 虽然被保存进 L2，却没有成为后续 L0 视图演进的有效状态。

### 8.3 reasoning、工具结果和文件块被反复处理

把 reasoning 从不可压缩 tail 移入可压缩视图解决了旧的 `protected_context_exceeds_budget`，但在全量压缩机制下成为本次预算耗尽的重要原因之一：

- 进入过 Condenser 的唯一 reasoning 为 137,524 字符，累计被处理 685,947 字符，平均约 5.0 次。
- 唯一工具结果为 112,120 字符，累计被处理 489,445 字符，平均约 4.4 次。
- 唯一文件块为 89,075 字符，累计被处理 914,489 字符，平均约 10.3 次。

历史 tool result 已包含代码原文；同一路径又会通过 L2 file view 被加载，因此相同代码可能以 tool result 和 file chunk 两种形式同时进入压缩输入。

文件视图还存在按路径过宽召回的问题。`src/diff/index.js` 在本次任务中形成 16 个 file views、16 个 chunks、合计 49,244 字符。只要当前阶段历史文本出现该路径，单块视图就会整体加载；最终一次 L0 最多加载 20 个文件块，`unloaded_ranges` 始终为 0。

### 8.4 L1 引用机械进入不可压缩区

L1 保存完整阶段制品和 L2 引用本身没有问题。问题发生在上下文组装：所有历史 L1 证据引用都被复制进每个 L0 的 `protected_index`。

最终 `REFINE_1` L0 的 protected index 包含 269 项、序列化后为 104,224 bytes，其中 225 项来自 L1，194 项是 `/evidence_refs`。这些 `artifact_id + sha256` 不可压缩，并约占最终 L0 序列化内容的三分之一。

这说明“L1 完整保存引用”与“L0 每轮携带全部引用”被错误地等同了。前者应保留，后者不应发生。

### 8.5 压缩触发过早且没有摊销

70% 压缩触发线为 91,750 tokens，硬输入上限为 114,688 tokens。本次最大未压缩 Agent 视图为 109,321 tokens，加 16,384 输出预算后仍低于 131,072 窗口。因此 14 次成功压缩都不是为避免当轮立即越窗，而是主动触发。

按当前策略估算，14 次压缩共减少约 775,937 个策略估算输入 tokens；按基础序列化估算约减少 620,751，而 Condenser 实际使用 675,942 tokens。不同估算方法不能构成精确反事实，但足以说明当前全量压缩没有形成明确的成本摊销。

### 8.6 IMPLEMENT 是主要消耗阶段

| 阶段 | Agent 请求 | Condenser 请求 | Tokens |
|---|---:|---:|---:|
| UNDERSTAND | 9 | 0 | 194,963 |
| LOCALIZE | 4 | 1 | 195,728 |
| PLAN | 7 | 3 | 518,126 |
| IMPLEMENT | 15 | 10 | 1,343,237 |
| REFINE_1 | 2 | 0 | 133,756 |

IMPLEMENT 单阶段占总 Token 约 56.3%。达到触发线后，几乎每个 Agent 请求前都重新压缩增长后的完整历史。总 Provider 用量中 prompt 为 2,305,606 tokens，占约 96.6%；completion 只有 80,204，占约 3.4%。因此主要问题明确位于上下文输入，而不是模型输出。

### 8.7 执行层放大因素

以下因素会增加请求数，但不属于记忆分层本身：

1. 单次工具结果限制为 12 KiB，每阶段累计限制为 48 KiB；前四阶段都达到阶段上限并进入 completion-only 模式。
2. `V0` 的 baseline 和 candidate 都因相同的 `Could not resolve "../../"` 环境构建错误失败，验证结果不可比较，增加了 REFINE 阶段的无效调查。
3. Condenser 和 Agent 的确定性准入都已明确失败后，工作流仍继续两次 completion-only 恢复，形成 6 次无效拒绝，并用阶段完成错误掩盖了 `budget_exhausted`。

这些问题应在执行层和验证层分别处理，不能让 memory 参与阶段判断或任务执行。

## 9. 已确认的修正方向

四层记忆定义保持不变，记忆系统仍只负责内容存储、压缩和上下文组装。修正目标是让 L0 成为增量演进的高密度视图，而不是每轮从完整记忆重新生成视图。

确定方向如下：

1. L2 继续完整、增量保存原始消息、reasoning、工具证据和文件内容，不压缩、不覆盖。
2. L1 继续完整、增量保存阶段制品及可追溯引用；完整引用留在记忆中，不等于全部进入当前上下文。
3. L0 压缩改为 `上一版压缩视图 + 本轮新增内容`，不再对完整历史反复全量压缩。
4. reasoning 第一次进入压缩后只保留高密度摘要和 L2 引用；已压缩 reasoning 不再自动以原文回流。
5. 工具结果与 file view 在同一 L0 中只保留一种正文表示，避免相同代码重复进入上下文。
6. 文件视图按路径、范围和内容去重；只有当前 query 明确召回的 chunk 才进入 L0，不因历史中曾出现路径而加载全部视图。
7. L0 默认只携带 L1 高密度阶段视图和阶段制品引用；具体 L2 事件引用按 query 召回，不再机械复制全部 evidence refs。
8. 当前阶段的压缩 query 保持稳定；completion-only 等执行控制提示不得改变记忆检索和压缩的任务 query。

执行层另行处理两个问题：预算准入确定失败后直接暴露 `budget_exhausted` 并停止无效恢复；验证层修正 baseline 与 candidate 同源构建失败的分类。两者不并入 memory 设计。

Legacy 运行只能用于量化无记忆上下文的对照成本，不再是定位本次根因的必要条件。

## 10. 修正实施结果

已按第 9 节方向完成 L0 修正，未改变 L1、L2 或 RepoFix 阶段执行关系：

1. 每个阶段冻结第一次请求作为压缩 query；completion-only 请求不改变检索和压缩目标。
2. Condensation 增加 `previous_condensation_ref` 和 `delta_source_event_ids`；后续压缩只输入上一版 summary 与新增 delta。
3. 已被 summary 覆盖的 reasoning、消息和工具视图不再自动以原文回流。
4. L0 对每个已完成阶段默认只携带一条 L1 阶段制品引用；具体 L2 事件、覆盖状态和文件视图按 query 召回。
5. 同一路径文件视图按来源顺序和内容哈希去重；同一 `repo_read` 的正文由原生 tool result 保留时，不再重复装入 file view 正文。
6. L0 滚动状态在阶段边界显式重置；L1、L2 仍完整、增量、不可变。

本地验证结果：

- `memory-system.test.ts`：11/11 通过。
- `memory-comparison.test.ts` 与 `token-supervisor.test.ts`：6/6 通过。
- `runtime-factory.test.ts`：9/9 通过。
- M4 workflow 的 5 个用例在 Windows 目录 `fsync` 处统一失败，尚未进入 memory 断言。
- 全仓 `npm run check` 在既有的 2 个 Biome error、9 个 warning 和 4 个 info 处停止；本次 memory 文件的定向 Biome 检查无错误、警告或 info。

## 11. 后续复测校正：上一轮修正不完整

`run-358a1e0af22042f688e6d69f63791199` 证明第 10 节的实施结果只完整解决了重复全量压缩，没有完整解决阶段内 L0 连续性。

已实现的部分是：后续 Condensation 以“上一版 summary + 新增 delta”为输入，Condenser 调用由 14 次降为 1 次。未实现好的部分是：压缩前的文件视图仍按“冻结阶段 query + 最新 assistant”逐轮重新选择；更早的 `repo_read` 正文被排除出普通历史后，如果当前 selector 未再次命中，就同时失去 tool result 正文和 file view 正文。

实际 IMPLEMENT 文件工作集出现 `0 → 2 → 1 → 1 → 6 → 2 → 1 → 2 → 2` 的非单调变化。Agent 连续发出 13 次 `repo_read`、没有调用 `repo_edit`，随后耗尽 48 KiB 阶段输出额度并进入 completion-only。上一版同任务 Layered 运行则在 6 次读取后调用了 `repo_edit` 并生成非空 P0 patch。

因此第 9 节第 3 项“L0 压缩改为上一版压缩视图 + 本轮新增内容”需要补充为两个同时成立的规则：

1. 压缩链增量：`上一版 summary + 新增 delta`。
2. 压缩前工作集增量：当前阶段已进入 L0、尚未被压缩覆盖的来源只追加，不因 query 变化退出。

本轮修正只涉及 Context Assembler 和对应测试。query 继续用于追加召回和大文件分块，但不再用来重算当前阶段工作集；压缩结果必须通过来源集合覆盖等式后才能替换原文。L1、L2 和 RepoFix 执行关系不变。

## 12. 近期工具轮仍不可压缩的问题

`run-e460867259c7465091e2d86016b9114b` 在 4M 预算下只使用 289,411 tokens 就停止于 LOCALIZE。账本没有预算拒绝，但三次记录压缩触发、零次调用 Condenser。根因是 L0 只压缩 middle delta，最近 assistant/tool 轮次整体留在 tail；当系统提示、近期推理和大工具结果已经超过 50% 压缩目标时，`summary_max_tokens < 1`，Provider 请求在组装阶段失败。

修正保持 L2 原文不变：

1. 最近 assistant 推理和工具结果作为带 L2 事件 ID、SHA-256 的来源单元进入压缩 delta。
2. 压缩成功后，L0 只保留原生 tool call/tool result 协议骨架；tool result 正文替换为 L2 引用。
3. 已被 rolling condensation 覆盖的近期轮次在下一请求中继续使用压缩骨架，不允许原文回流。
4. 新增“大推理 + 大工具结果 + completion recovery”回归，证明 Condenser 只调用一次且恢复请求不会重新装入原文。

## 13. 分段文件视图替代误判

`run-9f1c2e4a6b8d47e0a13579c2468bef01` 暴露了修正后的附加问题：LOCALIZE 的完整失败轨迹出现 `working_set_source_missing`。分段 `repo_read` 的原始 tool result 在下一轮被精确 file chunk、coverage status 和 missing ranges 替代，但连续性检查只允许 `complete` file view 替代原始来源，错误地把 `partial_known`/`partial_unknown` 视图判为来源丢失。

修正后，所有已经建立 file view 的 `repo_read` 都允许由“文件块 + 覆盖状态 + L2 原文引用”替代；非文件工具结果仍要求原来源或 condensation 覆盖。新增分段读取回归验证该替代不会导致来源丢失，也不会把未取得范围伪装成完整内容。

最终本地验证：

- `memory-system.test.ts`：14/14 通过。
- `memory-comparison.test.ts`：2/2 通过。
- 修改文件的定向 Biome 检查通过。
- RepoFixLab 生产 TypeScript 构建通过。

## 14. 4M / 128 turns 最终正式结果

最终运行 `run-7d2e9a4c1f6b4380b5d8e3a02469cf17` 成功完成任务和官方评测：

| 指标 | 结果 |
|---|---:|
| 终止原因 | `official_resolved` |
| 官方 resolved | `true` |
| Agent 请求 | 62 |
| Condenser 请求 | 2 |
| Provider tokens | 2,344,688 |
| 总耗时 | 1,493,585 ms |
| 压缩次数 | 2 |
| L1 记录 | 7 |
| L2 事件 | 250 |
| L2 bytes | 4,695,181 |
| 准入拒绝 | 0 |

两次实际压缩分别为：

- LOCALIZE：103,631 → 18,214 tokens。
- REFINE_1：95,784 → 32,265 tokens。

最终补丁只修改 `src/diff/index.js`：当祖先错误边界处理 diff 异常时，把 `oldVNode._dom` 传给失败的新 vnode，使边界后续重渲染能够移除旧 DOM。官方评测中 1/1 fail-to-pass 和 5/5 pass-to-pass 全部通过。

## 15. 成功轨迹的性能复盘

官方 resolved 只证明修复结果正确，不证明当前记忆实现高效。与同任务 Legacy 成功轨迹和 64-turn Layered 失败轨迹对比如下：

| 指标 | Legacy 成功 | Layered 成功 | Layered 64-turn 失败 |
|---|---:|---:|---:|
| 正式评测 | resolved | resolved | 未完成 |
| Provider token | 225.6 万 | 234.5 万 | 289.7 万 |
| 总耗时 | 9.0 分钟 | 24.9 分钟 | 32.6 分钟 |
| Agent 请求 | 66 | 62 | 64 |
| 仓库工具调用 | 63 | 83 | 98 |
| 输入缓存占比 | 83.9% | 22.2% | 14.4% |

成功后的主要问题确定为：

1. **Provider 缓存被每轮重组破坏。** Layered 每次都用新的 `<memory>...</memory>` 重写第一条 user message，导致 prompt 前缀持续变化。未缓存输入从 35.5 万增加到 163.7 万，约为 4.62 倍；本地记忆组装最多只占总耗时约 1.8%，主要耗时发生在 Provider。
2. **当前视图没有稳定呈现已发生的阶段活动。** IMPLEMENT 第 3 轮已经编辑，之后仍产生 27 个模型回合、15 次 `repo_read`、13 次 `repo_diff` 和约 105 万 tokens。Memory 不能判断阶段完成，但应把执行层已经产生的最新编辑、仓库修订和 diff 事实稳定组装进 L0。
3. **工作集缺少合并、失效和版本语义。** IMPLEMENT 的 L0 从 15,371 增长到约 49,734 tokens；`src/diff/index.js` 被读取 16 次，其中 8 次为完全相同范围。当前 `source_sha256` 证明一次返回文本，不代表仓库文件版本，不能据此判断编辑前证据是否已过期。
4. **70% 压缩不是重复读取的正确处理方式。** IMPLEMENT 最高约 49,700 tokens，没有触发压缩。为循环增加更早的模型压缩会增加成本；完全相同或已失效的证据应先通过确定性合并和版本替代消除。

这四项不通过新增记忆层、Loop Detector 或 ActionGate 解决。下一轮只修改 L0 的消息物化方式和当前工作集表示；L1、L2 完整原文、70% 语义压缩边界和 RepoFix 阶段状态机保持不变。

## 16. 缓存友好与版本化工作集修复

本轮按第 15 节问题完成最小实现：

1. 首次请求物化阶段原始请求和 L0 checkpoint；普通后续请求保留上一轮完整 Provider message sequence，只追加新 assistant/tool 消息和 L0 delta。
2. 成功 `repo_edit` 机械增加全局 revision 和目标路径 revision，并触发一次 checkpoint；旧版本证据只退出 L0，L2 原始事件不删除。
3. 同一逻辑证据键只保留一份正文，重复原生 tool result 替换为带 event ID、逻辑键和 SHA-256 的短 stub。
4. L0 固定呈现已经发生的最新编辑和 diff 事实，不生成阶段完成或动作许可字段。

新增确定性测试证明：连续普通请求满足严格消息前缀；16 次相同读取形成 16 份 L2 工具事件但 L0 只有一份正文；编辑后旧文件正文不进入新 checkpoint且重新读取形成新版本；同 revision 的重复 diff 只保留一份正文。`memory-system.test.ts` 当前 18/18 通过。

正式 `preactjs__preact-4182` Layered 复跑等待 Provider secret；本节不提前声明缓存比例、耗时或 official resolved 的实测改善。
