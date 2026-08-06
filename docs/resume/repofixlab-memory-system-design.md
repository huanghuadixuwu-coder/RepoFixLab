# RepoFixLab 记忆系统设计

本文是 RepoFixLab 记忆系统的现行设计说明。后续修正已经合并进对应章节，不再按时间追加相互冲突的旧方案。

## 1. 要解决的问题

RepoFix Agent 面临两个同时存在的限制：Provider 上下文窗口有限，仓库工具输出也有限。当前模型可见仓库输出保持单次 12 KiB 字符、单阶段累计 48 KiB 字符；Controller 单次原始返回最多 64 KiB。

典型失败是：

```text
LOCALIZE 找到 8 个候选，真正目标是第 5 个
→ 交接只保留前三项
→ IMPLEMENT 无法取回第 5 个候选的证据
→ 修改错误文件
→ 验证没有解决问题
```

还存在三类相邻问题：

- 单个代码文件过大，无法完整放入一次上下文。
- 同一代码范围、diff 或验证结果被重复带入上下文，增加 token 并破坏 Provider 缓存。
- 原始证据虽然被保存，但“已经确认的分析结论”没有稳定呈现，模型仍会重复推导调用链、重复读取。

设计的核心思想是：

> 完整内容留在深层记忆，当前上下文只携带高密度、可追溯的视图。

记忆系统缓解信息截断、输入重复和上下文失真。它不能单独保证 Agent 停止探索或按时结束阶段。

## 2. 范围与边界

记忆系统只负责三件事：

1. 内容存在哪一层。
2. 内容如何压缩。
3. 内容如何组装进 Provider Context。

记忆系统不负责：

- 选择或切换 RepoFix 阶段；
- 允许或禁止工具动作；
- 主动读取文件或运行验证；
- 判断补丁是否完成；
- 重试、循环检测或阶段终止。

记忆可以稳定呈现“已经发生的编辑、当前仓库修订、最新 diff、验证结果和分析结论”，但不能据此替执行系统决定下一步动作。

## 3. 整体关系

```text
已完成阶段 ──追加完整交接──> L1
对话、reasoning、工具返回、文件、补丁、验证 ──追加原文──> L2
生产环境通用经验 ──按需读取──> L3（SWE-bench 关闭）

L1 + L2 + L3 + 当前阶段新增内容
                 │
                 ▼
          Context Assembler
          ├── 检索与分块
          ├── 合并与版本失效
          ├── 语义压缩
          └── checkpoint / delta 物化
                 │
                 ▼
          L0：本次请求的工作记忆视图
                 │
                 ▼
systemPrompt + tools + L0 messages = Provider Context
```

正确关系是：

- L1、L2、L3 是可持久保存的内容来源。
- L0 是针对一次 Provider 请求生成的动态消息视图。
- L0 是 Provider Context 的历史部分，不包含 `systemPrompt` 和工具定义，因此不等于完整上下文。
- 每层记忆都只服务于上下文组装，不参与任务执行。

## 4. 四层记忆的最终定义

| 层级 | 保存内容 | 生命周期 | 进入上下文的方式 |
| --- | --- | --- | --- |
| L0 工作记忆 | 本次 Provider 请求使用的 checkpoint 或 delta 视图 | 一次请求；阶段内连续演进 | 直接物化为 `messages` |
| L1 交接记忆 | 每个已完成阶段的完整 schema handoff、全部集合成员、L2 引用及 SHA-256 | 本次任务；按阶段只追加 | 受保护索引和阶段高密度视图 |
| L2 任务长期记忆 | 本任务原始输入、消息、reasoning、完整 Controller 返回、文件视图、补丁、验证、压缩制品和 L0 审计 | 本次任务；按事件只追加 | 按 query、引用、路径、行号或 chunk 受控取回 |
| L3 跨任务记忆 | 经验证的通用修复经验 | 跨任务 | 生产环境按需取回；SWE-bench 禁用 |

### 4.1 L1：完整交接，不是完整历史

每个已完成阶段恰好追加一份 L1：

```text
L1
├── 01 UNDERSTAND handoff
├── 02 LOCALIZE handoff
├── 03 PLAN handoff
├── 04 IMPLEMENT handoff
└── ...
```

每份记录包含：

```text
stage_id
stage_sequence
handoff                 # 当前阶段 schema 的全部字段和集合成员
evidence_refs           # 本阶段 L2 artifact_id + sha256
sha256
```

L1 不执行 `top-N`、字符串截断或二次摘要。它不复制本阶段全部对话和工具正文；这些内容属于 L2。

### 4.2 L2：完整保存已经取得的内容

L2 只追加、不覆盖。事件标识和路径固定为：

```text
event_id = attempt_id + ":" + stage_id + ":" + event_sequence
artifact = memory/l2/stages/<stage_sequence>/events/<event_sequence>.json
```

“完整工具证据”指完整保存本次 Controller 已返回的内容，不代表系统凭空拥有未返回的文件部分。若 Controller 返回被截断或只覆盖一个范围，事件仍完整保存，但覆盖状态只能是：

- `complete`：本次或累计事件已经覆盖目标；
- `partial_known`：已知已覆盖和缺失范围；
- `partial_unknown`：知道不完整，但无法确定全部缺失范围。

后续分页或分段结果继续追加。Assembler 按相同 `coverage_key` 的事件顺序派生累计覆盖状态，不改写旧事件。

### 4.3 L3：评测隔离

生产环境可以按需使用 L3。SWE-bench 运行中 L3 的读取和写入都固定为零，避免跨任务泄漏。

## 5. 写入与派生

记忆写入顺序固定如下：

1. 任务开始时，将原始任务输入写入 L2。
2. 阶段开始由外部执行系统提供 `task_id`、`stage_id` 和 `stage_sequence`。
3. 新 user、assistant、reasoning 和 tool result 按出现顺序写入 L2。
4. 每个已执行仓库工具的完整 Controller 返回立即写入 L2。
5. `repo_read` 已取得的正文派生为可寻址 file view 和 chunks；来源事件保持不变。
6. 阶段完成时，把完整 handoff 和本阶段 L2 引用追加到 L1。
7. Condensation 和 L0 快照作为派生审计制品写入 L2，但不成为新的原始事实。

所有制品使用 canonical JSON SHA-256：先对不含自身 `sha256` 的 payload 计算哈希，再写入外层记录；读取时按相同规则复算。

## 6. 当前阶段工作集

### 6.1 ActiveEvidence：确定性合并与版本失效

L2 保存所有重复事件，L0 只保留当前仓库版本下一份有效正文。当前实现维护：

```text
repository_revision      # 成功 repo_edit 后 +1
path_revision[path]      # 该路径成功 repo_edit 后 +1
```

失败或超时的编辑不增加 revision。当前证据按逻辑键合并：

```text
repo_read  = path + path_revision + line range + content_sha256
repo_search = repository_revision + normalized_input_sha256 + result_sha256
repo_diff   = repository_revision + result_sha256
repo_list   = repository_revision + normalized_input_sha256 + result_sha256
```

同一逻辑键重复出现时：

- L2 继续保存全部事件和来源引用；
- L0 只保留一份正文；
- 重复 tool result 使用带 `event_id`、逻辑键和 `sha256` 的短 stub。

成功编辑某路径后，该路径旧 revision 的文件证据退出新的 L0 checkpoint；旧证据仍完整保存在 L2。搜索、列表和 diff 随全局 repository revision 更新。

### 6.2 阶段活动视图

Assembler 从已执行事件机械生成紧凑活动视图：

```text
stage_id
repository_revision
latest_successful_edit
latest_diff
latest_verification_ref
```

该视图只陈述已经发生的事实，不包含 `ready`、`done`、`next_stage` 或动作许可。

### 6.3 已确认分析结论

当前实现尚未建立独立、稳定的“已确认结论视图”。L1 handoff 能稳定传递已完成阶段的结论，滚动 summary 也可能保留部分分析，但当前阶段结论仍可能只存在于长 reasoning 或自由文本中。因此现有实现能做证据级去重，不能可靠阻止模型重新推导同一调用链。

现行设计要求补充一个轻量视图，但不增加新的记忆层或额外模型调用：

```text
confirmed_findings[]
├── finding                 # 同一 Agent 响应中明确写出的结论
├── evidence_refs[]         # L2 event / artifact / 文件位置
├── repository_revision
├── path_revisions[]
└── source_sha256
```

规则是：

- 原始结论文本和证据保存在 L2；已完成阶段的结论继续由 L1 handoff 提供。
- 记忆系统不从隐藏 reasoning 猜测“已确认”；结论必须由现有阶段输出或同一 Agent 响应显式提供。
- L0 始终在自由历史之前稳定呈现仍有效的结论。
- 仓库或路径 revision 变化时，相关结论标为过期并保留来源引用，不静默删除。
- 结论视图属于上下文表示，不决定 Agent 是否停止或进入下一阶段。

这项视图是已确认的设计缺口，当前代码尚未实现。

## 7. 大文件的分块取回

L2 完整保存已取得的文件范围，但不把大文件全文强行放入 L0。`repo_read` 结果派生为：

```text
file view
├── path、path_revision、source_sha256
├── coverage_status
├── structure：imports、类、函数、方法及行范围
└── chunks[]：chunk_id、起止行、正文、sha256
```

当前规则：

- JS/JSX/TS/TSX 使用仓库现有 TypeScript parser 提取结构。
- 每个 chunk 目标上限 4096 tokens，重叠 256 tokens；实现使用确定性字节近似。
- chunk 按起始行排序。
- 只为 L2 已取得的正文生成 chunk，不把未知范围表示为已知。

取回顺序固定为：

1. query 或最新 assistant 明确给出的 artifact、路径、行号或 `chunk_id`；
2. 已经进入当前阶段工作集且仍有效的文件片段；
3. 最近原生 tool turn 为维持协议所需的证据；
4. 其余范围只列入 `unloaded_ranges`。

以 8 个候选、目标为第 5 个为例：

```text
L1：8/8 候选及阶段引用
+ L2：第 5 个文件的结构目录
+ L2：query 命中的第 5 个文件片段
+ 当前阶段最近消息和工具协议
= L0
```

因此不会丢失第 5 个候选，也不要求把第 5 个大文件全文塞入一次上下文。

## 8. Provider Context 的组装

### 8.1 固定前缀

以下内容保持稳定：

1. `systemPrompt`；
2. 工具定义；
3. 当前阶段第一次原始请求；
4. checkpoint 之后、下一次 checkpoint 之前已经发送的 Provider 消息序列。

阶段原始请求不再与动态 `<memory>` 拼成同一条不断变化的首条 user message。

### 8.2 Checkpoint

一个阶段的首次请求物化为：

```text
messages =
  current_stage_initial_request
  + user(<memory view_kind="checkpoint">...</memory>)
  + 必要的最近 assistant/tool 协议轮次
```

checkpoint 包含：

```text
activity
protected_index
head
rolling summary
尚未压缩的 delta
```

只在两个时机重建 checkpoint：

1. 上下文达到 70% 并成功生成新的 Condensation；
2. 成功 `repo_edit` 改变 repository/path revision，需要移除旧版本工作证据。

checkpoint 会造成一次预期的 Provider 缓存前缀重置。

### 8.3 Delta

普通后续请求不重写 checkpoint，而是在上一次实际发送的消息序列后追加：

```text
新 assistant/tool 消息
+ 新增 protected index entries
+ 新增且经过合并的 evidence delta
+ 更新后的 activity
```

没有新记忆时不追加空 delta。在没有 checkpoint 的连续请求之间：

```text
上一请求的完整 messages 是下一请求 messages 的严格前缀
```

这使 `systemPrompt`、工具定义、阶段请求和历史消息能够被 Provider 前缀缓存复用。

### 8.4 工作集连续性

query 只向当前阶段工作集追加召回，不能用来重新筛掉已经进入 L0 的来源。一个来源正文只有在以下情况才能退出：

1. 已被通过来源覆盖校验的 Condensation 表示；
2. 被确定性重复合并；
3. repository/path revision 变化使其失效；
4. 外部执行系统声明阶段结束。

L0 快照只用于审计。下一轮事实仍来自 L1、L2 和阶段内确定性状态，不把 L0 快照反向当作原始事实。

## 9. 语义压缩

### 9.1 压缩对象

压缩的是准备进入 L0 的自由文本视图，不是 L1 或 L2：

```text
L1/L2 原始内容：保持不变
候选视图：允许压缩
Condensation：作为派生制品追加到 L2
L0：使用原文或 Condensation
```

受保护索引不进入模型压缩。它机械保留 L1 集合成员、被选证据引用、coverage 和文件 chunk 元数据。例如 L1 有 8 个候选，压缩后的 protected index 仍必须是 8/8。

### 9.2 触发条件

每次 Provider 请求组装前使用固定估算：

```text
base_tokens = ceil(JSON UTF-8 bytes / 4)
estimated_tokens = ceil(base_tokens × 1.25) + 512
```

```text
estimated_tokens >= floor(context_window × 70%)
→ 触发压缩

目标：assembled_tokens <= floor(context_window × 50%)
```

当前窗口为 131,072，Agent 最大输出预留为 16,384。压缩摘要上限为：

```text
summary_max_tokens = min(4096, target_tokens - protected_context_tokens)
```

### 9.3 Query 与滚动压缩

每个阶段第一次原始请求冻结为该阶段 query，不额外调用模型生成 query。completion-only 等控制请求不改变 query；最新 assistant 中明确出现的路径、行号、chunk 和 artifact 只用于增量精确取回。

自由文本采用 OpenHands 的 head-summary-tail 思想：

1. 阶段开始固定前 4 个 source units 为 head。
2. assistant text/reasoning 作为可压缩自由文本；tool call/tool result 的协议骨架保留。
3. 第一次压缩处理尚未覆盖的 delta。
4. 后续压缩只处理“上一版 summary + 上次之后新增的 delta”，不重新压缩全部历史。
5. 被压缩的 reasoning 和工具正文保留在 L2，后续 L0 使用 summary、协议 stub 和来源引用，不自动回流原文。

每份 Condensation 包含：

```text
summary
previous_condensation_ref
source_event_ids
delta_source_event_ids
query_sha256
input_sha256
policy_sha256
sha256
```

相同 `input_sha256 + query_sha256 + policy_sha256` 直接复用已有制品。Condenser 使用同一冻结模型，通过独立 Provider 回调调用；不允许工具、不修改 Agent session history、不计入 Agent 阶段轮次，但计入本次 run 的 Provider token 和耗时。

### 9.4 压缩完整性

模型只生成 summary，不决定覆盖范围。系统机械校验：

```text
压缩前全部 source keys
= 压缩后继续保留的原文 source keys
∪ Condensation 覆盖的 source keys
```

集合不相等时拒绝该压缩结果。该校验只能证明每个输入来源有表示，不能证明摘要语义正确或所有结论都被保留；语义正确性通过固定 prompt、固定 query、来源引用和压缩制品复用降低风险。

### 9.5 失败处理

- Condenser 失败不重试。
- 未压缩上下文加 Agent 输出预留仍在窗口内时，可以回退到未压缩视图。
- 无法安全回退时返回记忆基础设施错误。
- 受保护内容本身超出预算时不删减关键集合成员来强行继续。

## 10. 大段验证输出的上下文表示

验证的完整 stdout/stderr 属于 L2，不应在每个后续请求中反复携带。目标视图固定为：

```text
command
exit_code / timed_out
passed_count / failed_count
首批不重复错误：文件、行号、错误类型、短消息
artifact_id
sha256
```

成功验证只需一条高密度摘要；失败验证保留有限诊断片段。模型需要更多细节时，再按错误关键词、文件位置或 artifact 引用从 L2 取回相关块。

当前实现已经把完整工具返回写入 L2，并能对重复工具证据做逻辑键合并，但 `latest_verification_ref` 尚未接入，验证专用摘要视图也尚未实现。因此“大验证输出不直接进入后续上下文”是现行设计要求，不应误写成当前已完成能力。

## 11. 一次阶段如何工作

```text
外部系统声明阶段开始
  │
  ├── Memory Store 开始新的 L2 event_sequence
  ├── Assembler 冻结第一条阶段请求为 query
  └── 创建首个 L0 checkpoint
          │
          ▼
模型和工具由外部执行系统运行
          │
          ├── 新消息和完整工具返回追加到 L2
          ├── 重复证据合并、旧 revision 失效
          └── 普通请求只追加 L0 delta
                  │
                  ├── < 70%：继续 delta
                  └── >= 70%：rolling condensation → 新 checkpoint
          │
          ▼
外部系统声明阶段完成
  │
  ├── 完整 handoff 与证据引用追加到 L1
  └── 重置阶段内 L0、query 和工作集状态
```

## 12. 一次任务如何工作

```text
任务输入 → L2
  │
  ├── UNDERSTAND：L2 追加事件 → L1 追加 handoff
  ├── LOCALIZE：读取已有 L1/L2 → L2 追加事件 → L1 追加 handoff
  ├── PLAN / IMPLEMENT / REFINE：重复相同记忆流程
  └── 验证和最终制品继续追加到 L2
```

L1 在整个任务中累积所有已完成阶段；L2 累积完整已取得证据；L0 只在当前阶段和当前请求中存在。记忆系统不判断下一阶段是否应当开始。

## 13. 确定性要求

在来源制品、query、memory policy 和已保存 Condensation 相同时：

- 选择的 L1/L2 记录相同；
- protected index 的成员、数量和顺序相同；
- ActiveEvidence 合并与 revision 失效结果相同；
- checkpoint/delta 排列相同；
- 复用的 Condensation 相同；
- `assembled_context_sha256` 相同。

模型生成的新 summary 不能保证跨调用逐字一致。因此确定性边界是：固定模型、prompt、参数和输入哈希；同一输入只生成一次，随后复用不可变制品。

## 14. 当前实现状态与能力边界

| 能力 | 状态 |
| --- | --- |
| L1 按阶段完整追加，保留全部集合成员和 L2 引用 | 已实现 |
| L2 按事件保存消息、reasoning、完整 Controller 返回和覆盖状态 | 已实现 |
| 大文件 file view、结构目录和 chunks | 已实现 |
| protected index 与来源覆盖校验 | 已实现 |
| 阶段内工作集连续性 | 已实现 |
| rolling `previous summary + new delta` 压缩 | 已实现 |
| checkpoint/delta 缓存友好组装 | 已实现 |
| 重复证据合并、repository/path revision 失效 | 已实现 |
| 最新编辑和 diff 活动视图 | 已实现 |
| 已确认分析结论的稳定视图 | 尚未实现 |
| 验证专用高密度视图与 `latest_verification_ref` | 尚未实现 |
| L3 生产实现 | 未实现；SWE-bench 固定关闭 |

当前实现已经解决候选截断、证据原文不可追溯、大文件无法整篇装入、重复正文和缓存前缀频繁重写等问题。它仍然主要是证据与 token 层面的去重：没有稳定保存和呈现当前阶段“已经确认的分析结论”，所以不能消除语义上的重复思考。

减少串行模型请求也不属于记忆系统。可在不改变阶段逻辑的前提下，由执行层并行同一阶段内互不依赖的读取、搜索和验证，再把结果一次性交给 Context Assembler；编辑、依赖操作和阶段转换仍保持串行。
