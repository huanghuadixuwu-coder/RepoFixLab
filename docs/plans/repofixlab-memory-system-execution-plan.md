# RepoFixLab 记忆系统执行与评测计划

## 1. 目标

本计划依据 [RepoFixLab 记忆系统设计](../resume/repofixlab-memory-system-design.md)，完成两项交付：

1. 实现 L0、L1、L2；SWE-bench 中 L3 固定关闭。
2. 使用同一批真实 Dev 任务，对比加入记忆前后的 token 和任务耗时。

记忆只保存、压缩和组装上下文，不修改 RepoFix 阶段状态机、工具权限、验证流程、重试和循环终止。

“8 个候选、目标位于第 5 项”是合成回归场景，不是 RepoFixLab 数据集中的真实任务。它只用于验证集合不会被截断。

## 2. 当前问题

当前实现存在四个与记忆直接相关的问题：

1. `stageHandoff()` 将数组固定截为前三项，后续阶段可能丢失候选。
2. 历史仓库工具输出被替换为密封文本，后续上下文不能重新取回原文。
3. 大文件只能分页进入模型；当前没有完整 L2 制品和可寻址文件视图。
4. 增量压缩修正后，压缩前的 L0 仍按 query 每轮重选文件视图；刚取得的当前阶段代码证据会退出下一轮上下文，导致重复读取并耗尽阶段工具输出额度。

现有 `token-ledger.jsonl` 已保存 Provider token，但缺少阶段关联和记忆耗时。因此计划先补齐统一计量，再启用记忆。

## 3. 最小实现结构

只新增三个记忆代码文件：

```text
packages/repofixlab/src/
  memory/
    store.ts       # L1、L2 的保存与读取
    assembler.ts   # 分块取回、语义压缩与 L0 组装
  contracts/
    memory.ts      # L1、L2、L0 的固定数据契约
```

指标继续写入现有 token ledger、RepoFix 轨迹和报告模块，不新增独立指标系统。

现有文件只做必要接入：

- `agent/repofix.ts`：从现有 `afterToolCall` 的 `result.details` 增量保存 Controller 返回，在 Provider 调用前保存尚未写入的 current-stage 消息并接入 assembler；用 L1 和 L0 替换前三项 handoff 与历史密封文本。
- `runner/token-supervisor.ts`：按请求接收 `request_id`、`request_kind`、`stage_id` 和 `max_output_tokens`，分别计量 Agent 与 Condenser。
- `runner/runtime-factory.ts`：保持冻结模型、温度和超时不变，同时允许调用方把输出上限从 Agent 的 16384 降到 Condenser 的 `summary_max_tokens`。
- `runner/m4-dev-workflow.ts`：创建任务记忆，向 assembler 提供由同一冻结模型和 Token Supervisor 构造的 Condenser 回调，保存制品并记录耗时。
- `metrics`、`report`：生成加入记忆前后的配对结果。

现有 `repo-tools.ts` 已在模型可见文本之外保留 `response.result`，因此不修改 Controller 协议，也不改变单次 12 KiB 字符和单阶段 48 KiB 字符的模型可见工具输出限制。

## 4. 实施步骤

### 步骤一：建立可比较的计量边界

在不改变 Provider Context 内容的条件下完成：

- 每个 Provider 请求生成唯一 `request_id`，并标记 `request_kind` 为 `agent` 或 `condenser`。
- `request_id` 同时写入阶段轨迹和 token ledger。
- 记录 `stage_id`、Provider 输入/输出 token、Provider 等待时间和阶段耗时。
- Token Supervisor 分别计算 Agent 和 Condenser 最终实际发送的 Provider Context，不计算未发送的候选视图；每次请求使用自己的 `max_output_tokens` 进行准入预留。
- 固定 legacy Provider Context 的快照测试，保证计量改造前后字节一致。

完成门：legacy context 快照、token ledger 和阶段轨迹能够通过 `request_id` 一一对应。

### 步骤二：实现记忆

一次完成 L2、L1 和 L0：

```text
已执行工具的返回按事件增量追加 ──> L2 完整工具证据
每个阶段的完整交接制品 + L2 引用 ──追加──> L1
L1 + L2 已取得内容 + 当前阶段事件 ──> 候选视图 + 受保护索引
候选视图 ──达到 70%──> query 引导的 Condensation ──> L0
systemPrompt + tools + materialize(L0, 当前阶段请求) ──> Provider Context
```

具体改动：

1. `agent/repofix.ts` 在 `afterToolCall` 中读取现有 `result.details`，把每次完整 Controller 返回立即追加为 L2 事件；Provider 调用前将尚未保存的 current-stage user、assistant 和 tool result 事件按原顺序追加。记忆模块不主动发起仓库操作。
2. `store.ts` 使用现有 `ArtifactStore` 保存 sidecar。`artifact_id` 直接使用 ArtifactStore 相对路径；事件路径固定为 `memory/l2/stages/<stage_sequence>/events/<event_sequence>.json`，`event_id` 固定为 `attempt_id:stage_id:event_sequence`。事件只追加、不覆盖。
3. 单次工具返回被截断或只覆盖部分范围时记录 `partial_known` 或 `partial_unknown`；外部执行系统后续取得的分页或分段结果作为同一 `coverage_key` 的新事件追加。Assembler 按事件顺序合并覆盖范围并派生累计状态，覆盖完整后才返回 `complete`；旧事件不改写，记忆模块不主动补读。
4. 每个阶段结束时向 L1 追加一份不可变记录，包含 `stage_id`、`stage_sequence`、完整 schema 交接制品、按 `event_sequence` 排列的本阶段全部 L2 证据引用和自身 `sha256`。旧阶段记录不覆盖；交接字段和数组成员不执行 `top-N`、240 字符截断或其他二次缩减。
5. `assembler.ts` 读取全部 L1，并且只按明确的 `artifact_id`、文件路径、行号或 chunk 引用新增召回 L2 已取得内容；没有明确引用时不猜测。首次召回后，该来源进入当前阶段连续工作集，在被有效 `Condensation` 覆盖或阶段结束前不再接受 query 淘汰。来源固定按 L1 阶段、L2 制品、当前阶段事件排列。
6. `assembler.ts` 从候选视图机械生成受保护索引，完整复制 L1 集合成员标识并为每个已完成阶段保留一条阶段制品引用；具体 L2 覆盖状态和证据引用首次由 query 明确召回时进入 L0，随后按当前阶段工作集连续性规则保留。模型只压缩受保护索引以外的自由文本。
7. Provider Context 的 `systemPrompt` 和 `tools` 不变。历史部分由 L0 替换；当前阶段原始请求只出现一次，并与 L0 记忆块使用固定分隔符组成首个 current-stage user message。达到压缩线前，当前阶段尚未被压缩覆盖的消息、工具结果和文件片段按 `source_event_id` 单调累积；最近完整 assistant/tool 轮次按原消息类型和顺序保留。
8. 未压缩 Provider Context 达到窗口的 70% 时，`assembler.ts` 保留受保护索引、阶段固定 head 和最近工具协议轮次，以本阶段第一次 Controller 请求作为冻结 query，通过回调压缩“上一版 summary + 新增 delta”，并把带上一版引用和 delta 来源的 `Condensation` 追加到 L2。压缩结果使用前必须满足“压缩前来源集合 = 原文保留来源集合 ∪ Condensation 累计覆盖来源集合”；不相等时拒绝该结果。
9. Condenser 通过独立的受监督 Provider 回调调用同一冻结模型，不经过会增加 RepoFix 阶段轮次或修改 session history 的 `session.agent.streamFn`。它不允许工具调用、不重试，`max_output_tokens=summary_max_tokens≤4096`，并通过同一 Token Supervisor 计入 run cap。相同三项输入哈希直接复用已有结果。
10. Condenser 失败时，未压缩输入在模型窗口内安全可发送则回退到未压缩 L0，否则返回记忆基础设施失败。受保护索引超过安全预算时同样失败，不允许删减。
11. L0 写明受保护索引、使用的 `Condensation`、已装入和未装入的文件范围；请求结束后将 L0 快照追加到 L2，但不把该快照作为新事实来源。
12. SWE-bench 配置中的 L3 输入固定为空数组，禁止读取和写入跨任务经验。

所有 L0/L1/L2/Condensation 哈希复用现有 `canonicalContractSha256`：对不含自身 `sha256` 的 payload 计算 canonical JSON SHA-256，再写入外层记录；读取时复算验证。

完成门：连续完成两个阶段后 L1 存在两份记录且第一份 `sha256` 不变；合成 8 候选场景的受保护索引机械校验为 8/8；分段工具结果能够由追加事件累计到 `complete`；大文件场景只取回已有明确引用的 chunk 并报告其余范围；同一阶段连续读取多个文件后，即使后续 query 只提到其中一个，其他尚未被压缩覆盖的文件证据仍在 L0；触发压缩后来源集合覆盖等式成立且 L1、L2 原始内容不变；相同已保存 `Condensation` 得到相同 `assembled_context_sha256`。L0 审计记录因 `request_id` 不同而有各自的记录 `sha256`。

### 步骤三：执行固定配对实验

使用 M3 清单已经冻结的 5 个 Dev 任务，不重新选择任务：

```text
5 个真实 Dev 任务 × 2 个 memory policy × 1 次运行 = 10 runs
```

真实实验开始前必须把现有 M3 split manifest 的安全相对路径和文件 SHA-256 写入本次实验输入制品，并验证其中 Dev 集合恰好是冻结的 5 个任务。路径、哈希或任务数任一缺失、不匹配时停止，不重新选样，也不使用文档中的合成 8 候选场景代替真实任务。

两组配置：

| 配置项 | 对照组 | 记忆组 |
| --- | --- | --- |
| RepoFix workflow | `repofix-full` | `repofix-full` |
| Memory policy | `legacy-context-v1` | `layered-memory-v1` |
| L3 | 关闭 | 关闭 |
| 模型、token 上限、轮次、工具、镜像、验证 | 相同 | 相同 |

运行顺序按 M3 Dev 清单顺序交错：任务 1 legacy、任务 1 memory、任务 2 legacy、任务 2 memory，依次完成。并发固定为 1。

每个 run 的 admission cap 固定为 200k，Agent 和 Condenser 请求共同占用该 cap；10 runs 的最大准入量为 2M accounted tokens。真实 Provider 运行必须在代码和 faux provider 测试全部通过后，由用户单独授权。

## 5. 记忆内容

### L2

每份工具证据 L2 制品固定包含：

- `artifact_id`
- `task_id`
- `attempt_id`
- `stage_id`
- `event_id`
- `event_sequence`
- `tool_call_id`
- `tool_name`
- 规范化工具输入
- 文件路径或搜索范围
- `coverage_key`：规范化目标和范围类型的稳定哈希
- `coverage_status`：`complete`、`partial_known`、`partial_unknown`
- 覆盖类型：`full_file`、`full_result_set`、`file_range`、`result_page`
- 已覆盖范围；仅在 Controller 返回足够信息时记录精确未覆盖范围
- Controller `truncated`
- 原始字节数
- `sha256`

对六个仓库工具都把本次操作的完整 Controller 返回作为不可变事件追加保存：`repo_list`、`repo_read`、`repo_search`、`repo_edit`、`repo_exec`、`repo_diff`。Controller 单次原始返回仍受 64 KiB 限制；`truncated=true` 时该事件标记为 `partial_known` 或 `partial_unknown`，不能标记为完整文件或完整结果集。后续分页或分段调用继续追加；累计状态由相同 `coverage_key` 的事件确定性派生，不建立可变覆盖记录。L2 写入失败时，该次 attempt 记录为基础设施失败。

语义压缩结果作为派生制品写入 L2，固定包含 `summary`、`source_event_ids`、`query_sha256`、`input_sha256`、`policy_sha256` 和自身 `sha256`。它不覆盖来源事件。

### L1

每份 L1 固定包含：

- `stage_id`
- `stage_sequence`
- 完整、通过当前阶段 schema 验证的 `handoff`
- `evidence_refs`，每项包含证据的 `artifact_id` 和 `sha256`
- L1 记录自身的 `sha256`

L1 按 `stage_sequence` 递增追加，每个已完成阶段恰好写入一份记录。旧记录不可覆盖或改写。`handoff` 的完整性以阶段 schema 为边界：保留 schema 中的全部字段和全部集合成员，不执行字符串截断、`top-N` 或其他二次缩减。阶段全部对话、工具输出、文件内容、补丁和验证结果保存在 L2，不复制进 L1。

### L0

每份 L0 固定包含：

- 从 L1/L2 机械生成并通过数量、顺序和来源哈希校验的受保护索引
- 按当前请求选择的已完成阶段 L1 视图
- 当前阶段请求以外的 current-stage 历史事件视图
- 当前阶段已进入工作集且尚未被 `Condensation` 覆盖的连续来源集合
- L1 引用的 L2 原文或文件视图
- 有序 `source_event_ids`
- 使用的 `Condensation` 引用
- 已装入 chunk
- 未装入 chunk 和行范围
- memory policy 版本
- L0 `sha256`

L0 按 Provider 请求生成。压缩只作用于从 L1/L2 生成的候选视图，不改写 L1 或 L2；请求结束后，L0 快照作为审计证据追加到 L2，不作为下一次组装的新事实来源。

L0 快照不是下一轮的事实来源，但 Assembler 必须持有本阶段的确定性工作集状态：已进入工作集的 `source_event_id` 只追加，直到压缩覆盖或阶段边界重置。query 只能向该集合追加新召回项，不能移除已有项。

## 6. 分块取回与语义压缩规则

### 6.1 大文件分块取回

分块用于读取超过单次上下文容量的大文件，不作为压缩：

1. `.js`、`.jsx`、`.ts`、`.tsx` 使用仓库现有固定版本 TypeScript `5.9.3` parser，生成 imports、类、函数和方法的结构目录，不新增解析依赖。
2. 单个结构节点上限为 4096 tokens。
3. 超过 4096 tokens 的节点按行边界继续切分，每片上限 4096 tokens，重叠 256 tokens。
4. 其他文件或解析失败文件使用同样的 4096/256 规则切分。
5. chunk 顺序固定为文件起始行升序。
6. 每个 chunk 保存文件 `sha256`、`chunk_id`、起止行和 chunk `sha256`。

只对 L2 已取得的文件范围生成目录和 chunk。Assembler 仅按明确的 `artifact_id`、路径、行号或 `chunk_id` 取回；未取得范围只报告覆盖状态，Agent 是否调用现有 `repo_read` 由 RepoFix 执行流程决定。

### 6.2 Query 引导的语义压缩

每次 Provider 请求前，复用 Token Supervisor 的确定性估算公式计算：

```text
固定提示词 + 工具定义 + 当前阶段请求 + 未压缩 L0
```

```text
base_tokens = ceil(JSON UTF-8 bytes / 4)
estimated_tokens = ceil(base_tokens × 1.25) + 512
```

估算器版本、`1.25` 和 `512` 写入 memory policy；70% 触发、安全回退和 Agent/Condenser 准入均使用同一 `estimated_tokens`。

达到 `floor(context_window × 70%)` 时触发压缩，目标是降到窗口的 50% 以内：

1. 原始任务和当前阶段请求不参与压缩。
2. 从候选视图机械复制受保护索引，完整保留 L1 集合成员标识、未决项和失败结果；每个已完成阶段默认只加入一条阶段制品引用，具体 L2 覆盖状态和证据引用按 query 召回。模型不处理这些字段。
3. 阶段开始时固定 head；阶段内不重新选择，阶段切换时重置。
4. 保留最近工具轮次的原生 tool call 与对应 tool result；assistant text/reasoning 分离为可压缩 delta。
5. 第一次压缩只处理未覆盖 delta；后续压缩只处理“上一版 summary + 新增 delta”，不重新读取已覆盖原文。
6. 使用固定提示词和本阶段第一次 Controller 请求作为冻结 query；completion-only 控制请求不改变 query。
7. 保存带 `previous_condensation_ref`、累计 `source_event_ids` 和本次 `delta_source_event_ids` 的 `Condensation`；L0 使用“受保护索引 + head + summary + 未压缩 delta + 最近工具协议轮次”，L1 阶段记录和 L2 原始事件不变。
8. query 只选择尚未进入当前阶段工作集的 L2 证据和文件片段；已经进入工作集且尚未被压缩覆盖的来源必须继续进入未压缩 delta。压缩结果只有在来源集合覆盖等式成立时才能替换原文。

压缩输出上限固定按以下公式计算：

```text
summary_max_tokens = min(4096, floor(context_window × 50%) - protected_context_tokens)
```

`protected_context_tokens` 包含固定提示词、工具定义、当前阶段请求、受保护索引、固定 head 和最近工具协议轮次。

受保护索引使用来源集合数量、固定顺序和来源哈希校验；以 8 候选为例，L1 为 8 项时 L0 必须为 8/8。Condenser 不允许工具调用、不重试，不执行分批或递归压缩。模型、提示词、参数和 Token 估算策略都写入 memory policy。相同 `input_sha256`、`query_sha256` 和 `policy_sha256` 命中已有 `Condensation` 时直接复用。

Condenser 使用同一冻结模型、温度和超时，但输出上限使用本次 `summary_max_tokens`。它通过独立的受监督 Provider 回调发送，不调用 `session.agent.streamFn`，因此不增加 RepoFix 的阶段模型轮次、不触发阶段上下文密封，也不写入 Agent session history。

调用 Condenser 前验证 `condenser_estimated_input_tokens + summary_max_tokens <= context_window`。不满足时不调用模型，直接返回记忆基础设施失败；不增加分批或递归压缩。

Condenser 调用失败或 `summary_max_tokens < 1` 时：

```text
uncompressed_input_tokens + agent_max_output_tokens <= context_window
  → 使用未压缩 L0
否则
  → 返回记忆基础设施失败
```

受保护索引本身超过安全预算时直接返回同一基础设施失败，不允许通过删减集合成员或证据引用继续运行。

## 7. 测试

不调用真实 Provider 的测试固定为九项，压缩模型使用 faux provider：

1. 连续追加 LOCALIZE、PLAN 两份 L1 后记录数为 2，LOCALIZE 的 `sha256` 不变；其受保护索引通过数量、顺序和来源哈希校验为 8/8，第 5 项引用可解析。
2. 模型可见工具输出被截断时，L2 sidecar 的 `sha256` 对应完整 Controller 返回；首个事件为 `partial_known` 或 `partial_unknown`，后续分段事件只追加并可累计到 `complete`，`event_id` 和 `artifact_id` 符合固定规则。
3. 大文件目标位于已取得的中部 chunk 时只取回对应 chunk 并列出其他范围；目标范围尚未取得时不猜测内容，只报告覆盖状态和已有引用。
4. 69% 不触发压缩；70% 只触发一次语义压缩，受保护索引不进入模型且保持 8/8，`source_event_ids` 精确对应被覆盖事件，且 L1、L2 原始记录的 `sha256` 不变。
5. 第二次压缩的模型输入只包含上一版 summary 和新增 delta，不含第一次已压缩原文；completion-only 请求不改变冻结 query，并保存上一版引用和 delta 来源。
6. 相同三项输入哈希连续组装两次，只生成一次 `Condensation`；Condenser 使用独立回调和本次输出上限，不增加 RepoFix 阶段模型轮次；失败不重试，安全时回退未压缩 L0，不安全时返回记忆基础设施失败。
7. 同一路径的多个文件视图只选择 query 精确命中的视图；同一 `repo_read` 正文不能同时以原生 tool result 和 file view 两次进入 L0。
8. 同一阶段依次读取 A、B、C 三份代码证据后，下一轮 query 只明确提到 B，未触发压缩时 A、B、C 仍同时进入 L0；触发压缩后，A、B、C 的来源必须分别出现在原文保留集合或 `Condensation.source_event_ids` 中，不能无引用消失。
9. SWE-bench 配置读取和写入 L3 的次数均为 0。

集成测试固定验证：

- memory-off 的 Provider Context 与 legacy 快照一致。
- memory-on 保持 `systemPrompt` 和 `tools` 不变；当前阶段请求恰好出现一次，L0 历史块和最近 assistant/tool 轮次符合固定物化顺序。
- memory-on 只改变 Provider Context 的历史表示，不改变 RepoFix FSM、工具集合和 P0/V0/V1/V2/P1 流程。
- memory-on 的当前阶段工作集在压缩前单调增长；query 变化不能使已取得且尚未压缩覆盖的工具证据或文件块退出下一轮 Provider Context。
- `request_id` 能连接阶段轨迹、L0、token ledger 和 Provider usage。
- sidecar 只来自当前 Worker 已执行的工具操作。

实现完成后运行修改到的定向测试和 `npm run check`。本步骤不调用真实 Provider。

## 8. Token 与耗时指标

每个 Provider 请求记录：

- `request_kind`：`agent` 或 `condenser`
- `provider_input_tokens`
- `provider_output_tokens`
- `provider_total_tokens`
- `uncompressed_context_tokens`
- `assembled_context_tokens`
- `memory_store_ms`
- `memory_assemble_ms`
- `token_count_ms`
- `provider_wait_ms`
- `stage_wall_ms`

其中 Provider token 和 `provider_wait_ms` 对两类请求都记录；`uncompressed_context_tokens`、`assembled_context_tokens` 和本地组装耗时只属于 `request_kind=agent`，Condenser 行固定为 `null`，不重复归集。

每个任务聚合：

- `request_kind=agent` 与 `request_kind=condenser` 各自的输入、输出和总 token；每次调用只计入一类
- Agent 模型轮次；Condenser 请求数按 `request_kind` 单独报告，不计入 RepoFix 阶段模型轮次
- 仓库工具调用次数
- 记忆本地耗时：`memory_store_ms + memory_assemble_ms + token_count_ms`
- Agent wall time
- Task wall time
- official resolved、F2P、P2P

直接压缩量：

```text
uncompressed_context_tokens - assembled_context_tokens
```

端到端 token 变化包含 Agent 和 Condenser，但每次 Provider 请求只计算一次：

```text
sum(memory 组所有 request_kind 的 provider_total_tokens)
- sum(legacy 组所有 request_kind 的 provider_total_tokens)
```

端到端耗时变化包含压缩模型等待时间：

```text
memory 组 task_wall_ms - legacy 组 task_wall_ms
```

## 9. 报告

报告输出 5 行逐任务结果和 1 行总计，不增加重复实验或后续扩展阶段：

| 任务 | legacy tokens | memory tokens | token 差值 | legacy time | memory time | 时间差值 | legacy resolved | memory resolved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Dev task 1 |  |  |  |  |  |  |  |  |
| Dev task 2 |  |  |  |  |  |  |  |  |
| Dev task 3 |  |  |  |  |  |  |  |  |
| Dev task 4 |  |  |  |  |  |  |  |  |
| Dev task 5 |  |  |  |  |  |  |  |  |
| 总计 |  |  |  |  |  |  |  |  |

报告另外列出记忆本地总耗时、L2 存储字节和压缩触发次数，用于区分本地开销与模型行为变化。

## 10. 执行顺序与完成定义

```text
步骤一：计量边界
  → 步骤二：记忆实现
  → 九项 faux provider 测试
  → 用户授权
  → 步骤三：10-run 配对实验
  → 生成报告
```

完成定义：

- 九项 faux provider 测试全部通过。
- `npm run check` 无错误、警告和 info。
- 真实实验输入制品记录 M3 split manifest 的安全相对路径和文件 SHA-256，并验证 Dev 任务数为 5。
- 10 个 run 均保留 token、耗时、L0/L1/L2 和官方评测制品；失败 run 同样进入报告。
- 报告只陈述这 5 个 Dev 任务的观测结果，不外推到全部 SWE-bench 任务。

## 11. 本轮修正范围

上一轮已经实现滚动 Condensation，但没有实现压缩前的 L0 工作集连续性。本轮只修改 `memory/assembler.ts` 及对应测试，不增加新的记忆层、检索服务或执行模块：

1. 为当前阶段维护只追加的未压缩来源集合。
2. 将 query 召回结果并入该集合，不用 query 重算或替换该集合。
3. 在压缩成功后，仅移除已被 `Condensation.source_event_ids` 覆盖的原文；未覆盖来源继续保留。
4. 阶段边界重置 L0 工作集，L1、L2 保持完整、增量、不可变。

本轮完成门是新增的第 8 项 faux provider 回归通过，并在同一真实任务的 Layered 复测中不再出现因文件证据退出 L0 而重复读取的轨迹。是否允许阶段完成、是否存在实际补丁仍由 RepoFix 执行层单独校验，不并入 Memory。

## 12. 本轮最小落地（已实施）

目标只包含两项：恢复阶段内 Provider 前缀复用；让当前工作集具备合并、失效和版本语义。阶段活动视图由同一数据机械生成，不新增模块。

### 12.1 修改范围

只修改现有三个记忆文件和对应测试：

- `contracts/memory.ts`：为 L2/file view 增加 `repository_revision`、`path_revision` 和逻辑证据键；为 L0 增加 `checkpoint`/`delta` 类型及紧凑活动视图。
- `memory/store.ts`：从已执行的成功 `repo_edit` 事件递增 revision；为工具证据生成逻辑键。全部原始事件仍追加到 L2。
- `memory/assembler.ts`：把 `stageWorkingSourceKeys` Set 替换为 `ActiveEvidence` Map；实现重复合并、编辑后失效、L0 delta 追加和 checkpoint 重建。
- `test/memory-system.test.ts`：增加下面四项确定性回归。

不修改 Controller 工具协议、RepoFix FSM、工具额度、阶段完成规则或官方评测流程。

### 12.2 实施顺序

1. **版本与逻辑键。** Store 初始 revision 为 0；只有成功 `repo_edit` 增加全局 revision 和对应 path revision。所有 L2 事件记录当时 revision。
2. **工作集归并。** Assembler 按逻辑键维护一份有效正文；重复事件只增加来源引用。编辑后删除被修改路径旧 revision 的活动表示，L2 不删除。
3. **活动视图。** 从现有事件生成最新编辑、最新 diff 和已有验证引用；禁止生成完成判断字段。
4. **消息级增量组装。** 保存上一次实际 Provider 消息视图，只追加新 session 消息和 L0 delta。首次阶段请求独立、原样位于动态 memory 之前。
5. **checkpoint。** 仅在 70% 压缩或成功编辑后重建；压缩继续使用现有 rolling Condensation，编辑 checkpoint 不调用模型。
6. **指标。** 在现有 L0 审计中增加 `view_kind`、`repository_revision`、`active_evidence_count` 和 `stable_prefix_message_count`，不新增指标系统。

### 12.3 确定性测试

1. 连续两个未压缩请求中，第二个 Provider 消息序列以第一个请求的完整消息序列开头，然后才追加 assistant/tool 和 memory delta。
2. 同一路径、revision 和行范围连续读取 16 次时，L2 有 16 份工具事件，L0 只有 1 份文件正文；重复 result 使用短引用 stub。
3. 成功编辑后 revision 加 1，编辑前目标路径的 file view/chunk 不再进入新 checkpoint；编辑后重新读取形成新版本，旧证据仍可从 L2 按引用读取。
4. 同一 revision 的重复 `repo_diff` 在 L0 只保留一份；活动视图指向最新编辑和当前 revision 的 diff，但不包含阶段完成判断。

现有 70% 边界、滚动压缩、8 候选、部分文件覆盖和 L2 完整性测试必须保持通过。

### 12.4 完成门

代码完成门全部是机械条件：

- 非 checkpoint 请求满足“上一 Provider 消息序列是下一请求的严格前缀”。
- 重复工具证据不增加 `active_evidence_count`。
- 编辑前目标文件证据不进入编辑后的 current checkpoint，且 L2 事件数不减少。
- Memory 输出不包含动作许可或阶段转换字段。
- 定向测试和仓库级 `npm run check` 通过。

完成后只复跑 `preactjs__preact-4182` 的 Layered 组，与本次成功轨迹比较 Provider cache read、未缓存输入、总耗时、工具调用和官方 resolved。性能指标用于验证效果；正确性仍以确定性测试和官方评测为准。

### 12.5 实施状态

2026-08-06 已按上述范围完成代码：

- L2 工具事件增加仓库 revision、路径 revision 和逻辑证据键，原始事件仍完整追加。
- L0 使用 checkpoint/delta 消息视图；非 checkpoint 请求复用上一轮完整 Provider 消息前缀。
- 当前工作集按逻辑证据键归并；成功编辑后重建 checkpoint，并使目标路径旧版本退出 L0。
- 活动视图只投影最新编辑、当前 revision 和最新 diff，不包含执行判断。

定向 `memory-system.test.ts` 共 18 项通过，其中新增 4 项覆盖严格前缀、16 次重复读取、编辑后版本失效和重复 diff。目标文件 Biome 检查及仓库的 pinned dependency、TS import、shrinkwrap、install lock、browser smoke 检查通过；仓库级 TypeScript 检查仍有本轮范围外的既有错误，目标文件没有 TypeScript 错误。

正式 Layered 复跑尚未启动：当前执行环境没有 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_API_KEY_FILE`。取得 Provider secret 后，按 4M、128 turns、2,700,000 ms 参数只复跑 `preactjs__preact-4182`。
