# RepoFixLab M6 校准可靠性与 Token 成本复盘

| 项目 | 内容 |
| --- | --- |
| 状态 | 已记录的问题与修复设计；尚未实施本文的改动 |
| 日期 | 2026-07-20 |
| 范围 | M6 Dev 校准及其前置启动/重跑过程 |
| 关联设计 | [系统设计规格](repofixlab.md) |

## 1. 结论

本次异常消耗不能解释为“`preactjs__preact-4182` 天然极难，RepoFix 因此不断尝试才完成”。更准确的结论是：

1. M6 尚未形成通过的校准报告，也未产生可用于 SWE-bench 主结论的官方 `resolved` 结果。
2. RepoFix 的高消耗主要来自三类可修复的工程问题：阶段完成工具的结构化参数恢复不完整、完整会话历史与大工具输出重复进入每次请求、基础设施故障后以新批次重新启动。
3. `pi-general` 没有 RepoFix 的阶段完成协议，因此不触发同一种错误；这不代表 Pi 没有工具错误或天然更省 Token。
4. 在修复这些控制问题、完成单任务无付费回归后，不能再启动完整 16 逻辑运行的 M6 校准批次。

本文是一次失败样本的工程复盘，不把任何已完成的 Agent 工作流表述为官方修复成功。

## 2. 证据与口径

### 2.1 M6 的设计目的

M6 是 Dev 校准，不是正式评测。它冻结 5 个 Dev 任务，在 `pi-general` 和 `repofix-full` 两个主配置上运行：每个任务各一次，再对 3 个仓库代表任务各追加一次，因此共 16 个逻辑运行。其唯一目标是从 provider 的实际 usage 中校准 Token 估算器，随后才允许进入有成本上限的正式实验。

当前实现为确保校准不会被“尚未校准的估算器”提前拒绝，将 M6 的每运行和项目准入上限设为 `Number.MAX_SAFE_INTEGER`。这只应适用于已通过就绪检查的小规模校准，不应被当作可以无限重跑的许可。实现位于 [dev-calibration-runner.ts](../../packages/repofixlab/src/m6/dev-calibration-runner.ts) 和 [calibration-cohort.ts](../../packages/repofixlab/src/m6/calibration-cohort.ts)。

### 2.2 本地账本观察

下表来自 `artifacts/**/token-ledger.jsonl` 中已结算的 provider 请求，按 provider 请求标识去重。它用于解释本地运行消耗，不等同于服务商账单的最终对账。

| M6 类别 | 请求数 | 记录 Token | 含义 |
| --- | ---: | ---: | --- |
| `repofix-full` | 591 | 21,476,653 | RepoFix 完整工作流及其重复启动 |
| `pi-general` | 147 | 5,505,390 | Pi 基线校准运行 |
| 中断/暂存运行 | 142 | 5,178,773 | 启动、修复基础设施后遗留的未形成完整批次的运行 |
| provider smoke | 2 | 271 | 提供方连通性检查 |
| **M6 合计** | **882** | **32,161,087** | 校准阶段的本地已结算账本 |

其中 `preactjs__preact-4182` 的 `repofix-full` 运行累计为 **17,032,936 Token / 474 次请求**。该数字覆盖多次校准启动和中断，不是一次成功修复的成本。

最新三个完成 M4 开发工作流合计约 7,773,185 Token，仅占上述 M6 与历史 M1 本地记录总量的一小部分。M4 的“completed”表示 Agent 工作流与产物写入完成，不表示通过独立官方 Evaluator。

### 2.3 已观察到的轨迹特征

`preactjs__preact-4182` 的 RepoFix 轨迹中：

- 输入 Token 约 4,010,710，输出 Token 约 17,483；主要成本不是生成长文本，而是重复发送上下文。
- 49 次模型请求、104 条轨迹消息、49 次工具调用。
- 可见工具结果中有 20 次错误，其中 `stage_complete` 为 11 次。
- `repo_search` 的成功输出约 197,016 字符，`repo_read` 成功输出约 96,834 字符。

对照而言，Pi 基线也并非没有重试。例如 `preactjs__preact-3562` 的 Pi 运行有 59 次请求、21 次工具错误和约 300 万 Token；Axios 运行有 31 次请求和约 127 万 Token。因此不能从单个低成本 Pi 任务推导“Pi 一般都很省”。

## 3. 问题一：阶段完成参数被拒绝后，恢复路径不完整

### 3.1 发生了什么

RepoFix 每个阶段都必须调用 `stage_complete`，提交阶段产物后才能进入下一阶段。以 `LOCALIZE` 为例，`candidates` 必须是对象数组，每个对象有 `path`、`symbol`、`evidence` 三个字段；普通文字列表没有足够信息，不能安全地猜测文件与符号。

```json
{
  "stage": "LOCALIZE",
  "candidates": [
    {
      "path": "src/file.ts",
      "symbol": "target",
      "evidence": "why this code is relevant"
    }
  ],
  "exclusions": ["reason"]
}
```

实际模型有时会提交类似 `[{"candidates": ["Modify the prop normalization logic"]}]` 的语义性描述，而不是对象数组；也可能把嵌套 JSON 序列化为字符串、遗漏必填字段、混入额外字段，或将 `stage_complete` 和仓库工具放在同一批工具调用中。

严格拒绝这些内容本身是正确的：让控制面猜测路径、符号或证据会污染可审计的阶段产物。问题在于拒绝发生的位置和后续控制不足。

### 3.2 为什么会重复调用

目前存在两层校验：

1. 工具声明层：Pi/提供方兼容层会按函数参数 schema 校验工具调用。
2. RepoFix 状态机层：`stage_complete` 执行时会尝试规范化部分 JSON 字符串，再按严格 v1 阶段 schema 校验并推进状态机。

代码已经兼容一部分 OpenAI 兼容服务常见的“嵌套 JSON 变成字符串”问题，也会在一次执行到达 RepoFix 工具时记录被拒绝的阶段完成，并切换到最多两次的 completion-only 恢复。[repofix-fsm.ts](../../packages/repofixlab/src/agent/repofix-fsm.ts) 与 [repofix.ts](../../packages/repofixlab/src/agent/repofix.ts) 中已有这部分逻辑和回归测试。

但当结构错误在工具执行前就被 Pi 的参数校验拦截时，RepoFix 的 `afterToolCall` 恢复钩子看不到该调用。模型只收到底层参数错误，仍可能继续普通探索或再次提交格式错误的工具参数。完整会话历史又会带着这些错误信息进入下一轮，于是一次协议错误被放大成多次模型请求。

这属于 RepoFix 的工具边界与恢复策略问题，不是“模型已经证明无法修复该 Issue”。

### 3.3 修复方案

不修改 Pi 的核心 agent loop，在 RepoFix 包内把 `stage_complete` 改为两层边界：

```text
模型工具调用
  -> 宽松但有明确字段的 wire payload
  -> RepoFix 规范化与严格阶段 schema
  -> 成功：状态机推进
  -> 失败：受控的 stage_completion_rejected 结果
```

具体要求：

1. **接收层允许被诊断，而非在执行前丢失。** 工具参数使用可表达已知 provider 序列化变体的 wire schema；字段完整性、对象数组结构和 `additionalProperties: false` 仍由 RepoFix 状态机严格校验。
2. **拒绝结果必须结构化。** 返回当前阶段、失败字段、期望类型、最多一个符合要求的示例；不得回显大段 schema 或原始上下文。
3. **第一次拒绝立即收敛。** 一次 `stage_complete` 失败后马上进入 completion-only 模式，禁止继续搜索、读文件、编辑或执行命令；初始调用加至多两次恢复调用，仍失败则终止该 attempt，并分类为 `stage_schema_error`。
4. **保留原始证据。** 原始工具参数、严格校验错误、恢复次数和最终终止原因写入产物；模型只看到最小纠错说明。
5. **补齐真实变体回归。** 用记录的 provider 工具参数夹具测试：JSON 字符串数组、普通文本数组、缺失字段、额外字段、阶段不匹配、与其他工具混批。每种失败都必须证明不会执行仓库工具，也不会超过“初始一次 + 恢复两次”的模型调用上限。

### 3.4 验收标准

- 任何无效 `stage_complete` 都被标记为 `stage_completion_rejected` 或 `stage_schema_error`，不存在无分类的底层参数失败。
- 一个阶段最多产生 3 次完成尝试，失败不会消耗后续阶段预算。
- `LOCALIZE` 的普通文本候选仍被拒绝，不能为了通过而放宽为不可信产物。
- 新增回归测试不使用真实 provider 或付费 Token。

## 4. 问题二：输入 Token 随轮次膨胀

### 4.1 发生了什么

RepoFix 会话明确关闭了 Pi 自动 compaction，目的是保留完整轨迹；同时 [repo-tools.ts](../../packages/repofixlab/src/sandbox/repo-tools.ts) 允许每次工具调用向模型暴露最多 64 KiB 的 `stdout`/`stderr`。Pi 在后续请求中携带已有消息，因此大搜索结果、文件读取结果、工具错误和阶段提示会不断累积，并重复编码为 provider 输入。

这解释了“输出 Token 很少而总消耗极高”：高成本来自重复上传历史，不是模型一次生成了大量代码。

### 4.2 处理原则

必须区分两份信息：

- **审计视图**：保留完整原始工具输出、轨迹与哈希，供报告和人工复核。
- **模型视图**：只保留下一步决策所需的有界、可定位内容。

不能以删除证据来节省 Token，也不能在不记录摘要来源的情况下让模型“遗忘”上下文。

### 4.3 修复方案

1. **模型可见工具输出预算。** 将 64 KiB 上限改为版本化配置，并先在 Dev 使用较小的实验值，例如 8–16 KiB。输出必须包含总命中数、已返回范围、截断标记和可继续读取的 cursor，而不是静默裁剪。
2. **搜索和读取分页化。** `repo_search` 按稳定顺序返回有限文件/行匹配；`repo_read` 必须支持明确的行区间或继续读取游标。模型需要更多信息时再发起精确请求，不能一次把整个搜索空间放入对话。
3. **结构化摘要替代原文堆积。** 每次工具调用向模型返回简短结构化摘要，例如命中文件、行范围、退出码、截断状态与下一步 cursor；完整 `stdout`/`stderr` 只保存在 `details` 和运行产物中。
4. **阶段边界上下文交接。** 在每个已完成阶段生成确定性的最小交接包：问题、已完成的阶段产物、已定位文件与行范围、当前 diff、受控验证摘要。发送给模型的上下文可以由 RepoFix 的 `streamFn` 包装层重建，但完整原始轨迹不得修改或丢弃。
5. **上下文预算先于成本预算。** 每次 provider 请求前估算模型视图大小；超过冻结的上下文阈值时，先执行上述确定性交接，再调用模型。该阈值限制的是重复输入大小，不是“Token 花费上限”，因此不会违反 M6 需要观察真实 usage 的校准目的。
6. **按阶段度量。** 报告每阶段的请求数、provider 输入/输出 Token、模型可见工具字符数、截断次数、context handoff 次数和工具错误次数。

### 4.4 验收标准

- 审计产物仍可重建完整原始轨迹，模型输出截断不导致证据缺失。
- 同一搜索结果不会在每个后续请求重复携带完整 64 KiB 内容。
- 每次上下文交接都有输入哈希、来源工具调用标识和摘要版本。
- 在固定夹具上，修复后的 provider 输入 Token 峰值和总输入 Token 显著低于现有实现；数值由一次无故障 Dev 校准冻结，不预先宣称提升比例。

## 5. 问题三：基础设施错误导致重新启动 M6

### 5.1 已发生的错误类型

M6 前后出现过以下非模型错误：

| 错误 | 直接后果 | 是否应在模型调用前发现 |
| --- | --- | --- |
| Compose secret 挂载与只读 runner 服务不兼容 | runner 无法创建或读取预期 secret | 是 |
| Orchestrator 中缺少 `@earendil-works/pi-ai/dist/compat.js` | 运行时模块加载失败 | 是 |
| Orchestrator 镜像构建链失败 | 容器无法启动 | 是 |
| `/artifacts` bind mount 的 UID/权限与原子目录发布不匹配 | staging 目录无法 rename 为正式运行目录 | 是 |
| provider 余额/限流 | 运行中断 | 否，但应显式分类并停止 |

这些问题本身并不意味着 Agent 修复失败；但在已有模型请求后中断时，Token 已经产生。当前 M6 校准 runner 是 fail-fast：一个逻辑运行失败后停止本批次；重新执行会创建新的 M6 运行目录，而不是从该批次的安全检查点恢复。因而“修一个基础设施问题后再运行”会形成新的模型调用集合。

### 5.2 是否可以避免

前四类问题大部分可以避免，且应当在 **零模型调用** 的就绪阶段阻止。余额或服务端限流不能完全避免，但必须在首个事件后停止并保留账本，不能静默重试或重新开一批。

### 5.3 M6 就绪门禁设计

在 M6 校准前新增一个独立、可重复、不会调用模型的 `m6-readiness` 命令。只有生成不可变的 `M6ReadinessReceipt` 后，校准入口才允许读取模型凭据并发起 provider 请求。

```text
m6-readiness（0 provider 调用）
  -> 固定镜像构建与模块 smoke
  -> Compose 渲染、Controller 健康检查
  -> secret 存在性与挂载路径检查（不回显内容）
  -> 实际 Worker UID 下的工具与 artifact 原子发布 canary
  -> 5 个 Dev 任务环境锁和 Controller preflight
  -> receipt（镜像 ID、Compose hash、锁 hash、权限探针结果）

m6-calibration
  -> 验证 receipt 未漂移
  -> 仅此时创建 provider session
```

门禁必须覆盖：

1. **镜像与依赖。** 用最终的、带 `--no-build` 的 Orchestrator 镜像执行模块 smoke；不得仅在宿主机 `node_modules` 上验证。
2. **Compose 与 secret。** 解析实际 profile 的 Compose 配置，验证 secret 对短生命周期 Orchestrator 可读、对 Controller/Worker/Evaluator 不可见；只检查长度、文件权限和挂载存在性，日志不得输出值或路径外的内容。
3. **权限和原子发布。** 使用与真实 Orchestrator 相同 UID/GID，在 `/artifacts` 上执行 create、fsync、rename、只读发布和清理 canary。该检查正是为了提前捕获本次 `EACCES rename`。
4. **Controller 生命周期。** 对 5 个 Dev 任务分别执行不含模型的 `preflight -> prepare -> minimal repo tool -> abort`，验证镜像、卷、锁与清理。
5. **提供方协议。** 需要时单独执行一次标记为 `provider-contract-smoke` 的最小付费请求，验证工具调用、usage 结算与错误分类。它不属于 M6 任务，不可自动重试，账本单独展示。

### 5.4 断点恢复与重启规则

M6 需要实现批次级状态表，至少包含：

```text
logical_run_id
  status: not_started | running | quiescent | terminal
  receipt_hash
  attempt_id
  session/checkpoint reference
  controller lease state
  token-ledger offset
  terminal reason
```

恢复只允许发生在 quiescent checkpoint：没有 in-flight provider 请求、账本已 fsync、工具批次完成、Controller lease 与阶段状态一致。否则该 attempt 必须封存为 `infrastructure_failed` 或 `provider_usage_unverified`，由人决定是否创建新的、显式关联的 attempt。

禁止以下行为：

- 失败后自动重新发送可能已计费的 provider 请求；
- 覆盖既有 run 目录或 ledger；
- 在没有新的就绪 receipt 时重新启动整批 M6；
- 将基础设施失败从实验报告中删除。

## 6. 实施顺序与重新启动条件

| 顺序 | 改动 | 是否需要真实 provider | 完成条件 |
| ---: | --- | --- | --- |
| P0 | 新增 M6 readiness 门禁与失败分类 | 否 | 注入 secret、模块、权限、生命周期错误时，provider 请求数为 0 |
| P1 | 修复 `stage_complete` wire schema 与受控恢复 | 否 | 所有错误夹具在最多 3 次完成尝试内终止或成功 |
| P2 | 工具分页、模型视图预算、阶段交接包 | 否 | 原始证据完整，模型视图有界且可追溯 |
| P3 | 批次状态、quiescent checkpoint 与恢复 | 否 | 中断注入不会重复同一 request_id 或覆盖账本 |
| P4 | 单任务、单配置 Dev 校准 | 是 | 就绪 receipt、Token 分阶段指标和官方结果产物均完整 |
| P5 | 冻结新的 16 逻辑运行 M6 批次 | 是 | P4 没有基础设施/协议错误，且估算器与预算策略已审阅 |

P0–P3 不应消耗模型额度。P4 只能在用户确认后执行。P5 不能因为 P4 失败而自动触发。

## 7. 不改变的边界

- 不修改 Pi 的核心 agent loop；修复限定在 `packages/repofixlab` 的 session 包装、工具契约、Runner 与产物层。
- 不放宽 Docker 安全边界，不向 Agent 暴露 test patch、gold patch、Docker socket 或模型密钥。
- 不为了省 Token 删除原始轨迹；节省的是模型可见的重复上下文。
- 不把 Dev 校准中的 Agent 轨迹写成正式 SWE-bench 成功率。
- 不对失败请求静默重试；所有 attempt、Token、错误分类与恢复决定保留在报告中。

## 8. 关联实现与证据入口

- [RepoFix 阶段控制](../../packages/repofixlab/src/agent/repofix.ts)
- [阶段产物 schema 与状态机](../../packages/repofixlab/src/agent/repofix-fsm.ts)
- [仓库工具的模型可见输出](../../packages/repofixlab/src/sandbox/repo-tools.ts)
- [M4 开发工作流与 Token supervisor 接入](../../packages/repofixlab/src/runner/m4-dev-workflow.ts)
- [M6 校准 runner](../../packages/repofixlab/src/m6/dev-calibration-runner.ts)
- [RepoFix 工作流回归测试](../../packages/repofixlab/test/repofix-workflow.test.ts)
- [M6 校准 runner 测试](../../packages/repofixlab/test/m6-dev-calibration-runner.test.ts)

原始运行证据位于本地 `artifacts/m6-calibration/`、嵌套的 `m4-dev/runs/` 和各运行目录的 `token-ledger.jsonl`、`trajectory.json` 或 `failed-trajectory.json`。这些证据不提交到 Git；正式报告必须以冻结的哈希和相对路径引用它们。

## 9. M7–M9 追加发现：工作流质量、消融与安全边界

本节记录 M7、M8、M9 冻结结果带来的后续问题和拟议修复。它不修改 M6 的历史口径，也不把未实施方案表述为已验证收益。

### 9.1 当前结果的正确口径

M9 的 26 任务汇总中，`pi-general` 首次解决 21/26，`repofix-full` 首次解决 16/26；一次受控恢复后 RepoFix 为 18/26。该汇总混入 Dev、Validation 和 Test，且复用结果包含 64 与 128 模型轮次，因此不能替代冻结 17 个 Test 任务上的固定预算主结论。

按冻结 Test 清单重算，首次结果为 Pi 13/17、RepoFix 8/17；一次受控恢复后 RepoFix 为 10/17。五个 Pi-only 首次胜出任务中，`preactjs__preact-2757`、`preactjs__preact-2896`、`preactjs__preact-3739` 在 P0 后因受控验证的 Controller 请求被拒绝而没有最终快照。这是工作流和基础设施失败，不是补丁语义质量的测量结果。

### 9.2 消融没有证明 LOCALIZE 或验证反馈有效

两项消融各覆盖 8 个与主实验重叠的任务：

| 对照 | 全部 8 个重叠任务 | 同任务且同模型轮次的可配对任务 | 当前解释 |
| --- | --- | --- | --- |
| `repofix-no-localize` 对 `repofix-full` | 两者均为 6/8 | 5 对中均为 4/5，零个不一致结果 | 未观察到 LOCALIZE 的收益，不能证明它无效 |
| `repofix-no-verify-feedback` 对 `repofix-full` | 两者均为 6/8 | 5 对中均为 4/5，零个不一致结果 | 未观察到验证反馈的收益，不能证明它无效 |

三个任务在消融和完整流程之间分别保留为 64 轮或继续为 128 轮，不能进入固定预算因果比较。样本也不足以检测小到中等的效果。当前实验只支持“这两个额外阶段尚未展示可测增益”，不支持“它们没有价值”。

### 9.3 安全证据的准确解释

M8 审计记录 148 次 Controller 拒绝、42 个审计定义的 sandbox-escape 输入、零个未拦截的 sandbox-escape 输入，以及零个补丁策略违反。这里的计数不是对模型意图的判断：

- **148 次被拦截操作**是仓库工具返回 `runtime request was rejected` 或 Controller HTTP 400 的总数。当前制品没有按底层规则保存可加总的细分，因此不能宣称 148 次都属于同一种风险，或都属于恶意操作。
- Controller 会拒绝非白名单工具、字段缺失/多余或类型错误、绝对路径、`..`、反斜杠、符号链接穿越、禁止修改 `test`/`tests`、绝对或带路径的可执行文件、shell 解释器，以及超出固定超时上限的执行请求。这些规则分别保护固定工作树、私有测试、无 shell 执行边界和资源上限；并不代表每一条规则都在本批 148 次中被触发。
- **42 个 sandbox-escape 输入**是审计的静态分类：读取/编辑使用非法仓库路径，列举/搜索指定非法路径，或 `repo_exec` 使用绝对路径、带 `/` 或 `\\` 的可执行文件。它包括可能无恶意的错误用法，例如尝试直接执行 `./node_modules/.bin/karma`；其含义是“请求试图绕过固定工作树或 PATH-only 边界”，不是“42 次确认的攻击”。审计确认这些请求全部返回错误，未实际越界执行。

结构化阶段产物与安全边界是不同层次的控制。`stage_complete`、阶段 schema 和工具白名单使流程可审计、可复现，并减少模型能够提出的操作集合；真正使安全边界可强制的是 Controller 的路径、编辑、命令、超时和快照策略，以及隔离的 Docker 挂载。即使状态机或提示词失效，Controller 仍必须拒绝越界请求。

### 9.4 问题四：受控验证把可恢复错误升级为 attempt 终止

当前流程在 IMPLEMENT 后捕获 P0，再由 Runner 直接执行 PLAN 的 `targeted_test_argv`。该 argv 仅被校验为非空字符串数组，没有在执行前验证可执行文件、仓库脚本、工作目录或写路径。Controller 抛出的 `RuntimeToolError` 会向上传播，阻止 REFINE、SELF_REVIEW、P1 快照和官方评测。

这与受控验证的目的相反：验证本应产生“可用于下一次修改的证据”，现在却成为单点终止器。`karma` 不在 PATH、构建产物目录不可写等环境问题，被错误地计入 Agent 没有产出最终修复。

#### 拟议修复：受控自适应验证循环

```text
UNDERSTAND -> LOCALIZE -> PLAN -> verification-plan preflight
                                      |
                                      v
                         IMPLEMENT <-> targeted verification
                                      |
                                      v
                           REVIEW -> P1 -> official evaluator
```

1. PLAN 选择版本化 `VerificationPlan`，而不是任意 argv。候选命令从实际 package scripts、已解析的本地二进制和任务环境生成，并记录命令 ID、argv、工作目录、可写缓存目录和超时。
2. preflight 在 P0 前检查命令是否可启动、依赖是否存在、所需输出目录是否可写；这一步不消耗模型轮次。
3. 验证始终返回结构化结果：`passed`、`test_failed`、`command_invalid`、`environment_failure` 或 `timed_out`。后四类是模型可见的反馈，不得因 Controller 400 直接终止 attempt。
4. IMPLEMENT/REFINE 允许有限次数、仅限已批准 `VerificationPlan` 的目标验证；保留 PATH-only、无 shell、超时、网络和写路径限制。这样增加修复迭代能力，而不退回无限制的自由 Agent。
5. 即使验证环境最终不可用，也必须保存 P0/P1 快照并进入官方评测；环境失败单列报告，不能以“无最终快照”覆盖候选补丁。

### 9.5 问题五：阶段约束、提示词与消融设计混杂

RepoFix 在 PLAN 和 IMPLEMENT 阶段禁止 `repo_exec`，只在 P0 后执行一次外部验证；Pi 可以在同一会话中持续“搜索、修改、测试、查看 diff、再修改”。同时，Pi 基线的系统提示词包含检查 package scripts、不要猜测命令、诊断失败和检查 diff 等工程指导，而 RepoFix 提示词主要强调协议约束。因此当前差距不能只归因于“自由工作流”和“结构化工作流”的差异。

#### 拟议修复：公平工作流比较与可验证增益

1. 把相同的工程修复指导放入 Pi 与 RepoFix 的共享提示词；唯一实验变量是工作流、工具阶段门和结构化产物。
2. 在 Dev 上冻结 `VerificationPlan`、错误分类和单任务回归后，才重新运行 Test。
3. 重新注册主对照：仅限冻结 17 个 Test、同一模型、同一 128 轮上限、同一任务环境和相同首次运行规则。
4. 重新注册两项消融：每项与完整 RepoFix 使用相同任务、相同模型轮次、相同提示词和相同命令计划；报告配对四格、P0 到 P1 的变化、验证结果被采纳率、命令预检失败率和基础设施错误率。
5. 保留原始官方 report 与 test log，而不只保留哈希和归一化摘要；规格、执行计划、协议和实际模型/预算必须收敛为一个版本化执行合同。

### 9.6 追加验收标准

- Controller 拒绝必须记录机器可聚合的 `reason_code`，例如 `invalid_path`、`test_edit_prohibited`、`shell_prohibited`、`argv_not_found` 或 `environment_not_writable`；报告不得只给一个总数。
- 任何 `command_invalid` 或 `environment_failure` 都不丢弃 P0/P1 候选补丁，并在报告中与语义修复失败分开。
- 受控验证的命令预检、结构化反馈和有限循环必须有无需真实 provider 的回归测试。
- 主实验和消融只有在相同任务、模型、轮次、提示词和任务环境下才可作因果比较。
- 安全审计持续要求零个未拦截 escape 输入、零个补丁策略违反；安全控制的成功不应被表述为修复质量提升的证据。
