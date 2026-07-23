# RepoFixLab R2 阶段化修复复盘

| 项目 | 内容 |
| --- | --- |
| 状态 | 已记录 R2 的阶段性结果、问题、解决方法和后续修复要求 |
| 日期 | 2026-07-23 |
| 范围 | R2 Full、Controller 身份恢复和语义工作流定向修复 |
| 执行依据 | [R2 执行契约](repofixlab-r2-execution-contract.md) |

## 1. 结论与统计口径

RepoFix 的阶段性成功率从 **20/26（76.9%）**、**22/26（84.6%）** 到 **23/26（88.5%）**。三项结果不是可直接并列的三次独立 Full 批次，必须按下表标注：

| 阶段 | 任务成功率 | 结果口径 | 结论 |
| --- | ---: | --- | --- |
| 阶段 1：R2 Full 初始结果 | 20/26（76.9%） | 19 个直接 Full 已解决任务，加 1 个携带的 `immutable-js__immutable-js-2005` 定向结果 | 另有 3 个官方未解决和 3 个 Controller 身份基础设施失败；基础设施失败不属于修复质量失败。 |
| 阶段 2：Controller 身份恢复后的修正 Full | 22/26（84.6%） | 仅以三任务恢复结果替换阶段 1 的 3 个基础设施失败 | 2 个恢复任务已解决，1 个仍未解决；历史上标注为 “corrected R2 Full”。 |
| 阶段 3：语义工作流定向修复 | 23/26（88.5%） | 仅以 `semantic-workflow-4` 中已解决任务替换相应历史未解决结果 | 4 个有效未解决任务中解决 1 个，保留 3 个未解决；这是“假设替换后的 23/3”，不是原始 R2 Full 的重写。 |

原始 R2 Full 必须继续报告为阶段 1 的 20/26；修正后的 R2 Full 为 22/26；定向语义修复后的替换口径为 23/26。各阶段均须保留 P0、V0/V1/V2、P1、官方评估、轨迹和账本证据。

## 2. 阶段 1：R2 Full 初始结果（20/26，76.9%）

### 2.1 结果

阶段 1 包含 20 个官方已解决、3 个官方未解决和 3 个 Controller 身份基础设施失败。20 个已解决结果由 19 个直接执行的 Full 任务和 1 个 `immutable-js__immutable-js-2005` 的定向诊断结果组成；该定向结果证明修复后工作流能够完成该任务，但不是独立 Full 批次证据。

`mrdoob__three.js-26589`、`preactjs__preact-4245` 和 `preactjs__preact-4316` 在首次仓库操作前即因历史 Controller 操作身份重放或失效 worker 返回 HTTP 409 而失败，模型没有可用的仓库环境。因此三项均为基础设施失败，不得写成修复失败。

### 2.2 RepoFix 问题与已实施解决方法

| RepoFix 问题 | 根因 | 已实施的解决方法 |
| --- | --- | --- |
| 无效 `stage_complete` 在 Pi 参数校验层提前被拒绝，RepoFix 看不到拒绝事件，模型反复探索或重复提交。 | 工具声明 schema 比 RepoFix 状态机可诊断的输入更严格；`afterToolCall` 无法接收执行前拒绝。 | `stage_complete` 接收可诊断的 wire payload，再由 RepoFix 严格规范化和校验；首次失败后只允许两次 completion-only 恢复，仍失败则以 `stage_schema_error` 终止。 |
| 工具输出和会话历史持续重传，输入 Token 随轮次膨胀。 | 搜索、读取、错误和阶段提示被完整保留并重复送入 Provider。 | 分离审计视图与模型视图；工具结果分页、截断和结构化摘要；阶段边界生成带来源和哈希的最小交接包。 |
| 基础设施故障后通过新批次重启，造成重复 Provider 调用和账本混合。 | 镜像、secret 挂载、权限、原子发布和 Controller 生命周期未在零模型调用阶段验证。 | 增加 `m6-readiness` 和 quiescent checkpoint；就绪失败时 Provider 请求数必须为 0，中断不得重复发送可能已计费的 request。 |
| 受控验证把可恢复的命令或环境错误升级为 attempt 终止。 | PLAN 的 argv 被 Runner 直接执行，缺少命令、依赖、写路径和超时预检。 | Controller 从预检过的 `package.json` 脚本生成验证目录；模型仅选择候选 ID；V0/V1/V2 返回结构化结果，不因 Controller 错误直接终止。 |
| 原始 R2 v6 的工具调用阈值阻塞 completion-only 恢复。 | 固定 100 次工具准入和阶段调用上限被当作控制边界；Pi 原生 `session.prompt()` 未在恢复请求后停止。 | 暴露 `shouldStopAfterTurn`；8 个模型轮次或 8 次仓库调用仅作轨迹检查点；`max_tool_calls` 设为 `null`，保留 Token、模型轮次、Provider 超时和墙钟上限。 |

### 2.3 有效官方未解决任务

阶段 1 的有效官方未解决任务为 `preactjs__preact-3062`、`preactjs__preact-3345` 和 `preactjs__preact-3567`；`preactjs__preact-4316` 在阶段 1 先被归类为 Controller 身份基础设施失败，须在阶段 2 恢复后再判定。

这些任务共同暴露出 V0/V1/V2 没有产生可用语义反馈：资源耗尽、clone/package 解析失败、缺失构建产物或不可写缓存导致基线与候选均失败。相同失败属于非比较证据，不能当作补丁正确性的证明。

## 3. 阶段 2：Controller 身份恢复后的修正 Full（22/26，84.6%）

### 3.1 问题与原因

阶段 1 使用了新的 artifact root，但 batch `attempt_id` 仅由确定性的逻辑 `run_id` 派生。Controller 在全局 journal 中持久化 operation ID：相同请求重放历史 lifecycle 响应，不同请求或失效的历史 worker 返回 HTTP 409。这是三个基础设施失败的直接原因。

### 3.2 解决方法

- 将每个 Controller attempt ID 绑定到持久化的 execution namespace。
- 使 `repo_*` operation ID 同时派生自 attempt ID 与模型 tool-call ID：同一 attempt 内保持幂等，跨执行不可重放历史 lifecycle。
- worker 准备阶段先运行 Controller 自有的 `repo_list` readiness probe；probe 失败作为 pre-Provider 基础设施失败停止批次，不能让模型在 409 上循环。
- 三项原始失败结果在 `r2-v6-r3/full` 中保持不可变；恢复仅在独立根 `r2-v6-r4/controller-identity-3` 中执行，并用 `recovery-cohort.json` 声明替换范围。

### 3.3 结果和预期修复方案

恢复仅覆盖 `mrdoob__three.js-26589`、`preactjs__preact-4245` 和 `preactjs__preact-4316`：前两项官方已解决，`preactjs__preact-4316` 为有效但官方未解决。因此修正后的 R2 Full 为 **22 已解决 / 4 未解决（22/26，84.6%）**。

随后针对有效官方未解决任务的预期工作流修复为：

- 当冻结的 `package.json` 声明缺失 package entrypoint 且存在 `build` 脚本时，Controller 在每个隔离 clone 内执行固定的 `npm run build` 前置步骤。
- 为每个 clone 提供可写 Babel cache；将资源、缓存、构建产物和共享 resolver 故障稳定分类为 `environment_failure`。
- PLAN 记录由仓库证据支持的邻近行为不变量、回调、重入和延迟状态转换检查；REFINE 与 SELF_REVIEW 必须明确消除、缩小或保留风险，不能以“罕见”或“基线失败”替代论证。

## 4. 阶段 3：语义工作流定向修复（23/26，88.5%）

### 4.1 范围与结果

`r2-v6-r5/semantic-workflow-4` 仅运行 `preactjs__preact-3062`、`preactjs__preact-3345`、`preactjs__preact-3567` 和 `preactjs__preact-4316`。四项均产生 P0/V1/V2/P1 并运行官方评估。

| 任务 | 官方结果 | 复盘结论 |
| --- | --- | --- |
| `preactjs__preact-3062` | F2P 1/1，P2P 66/66，已解决 | 修复限定在 `tabIndex` 的强制转换边界：数值保留为 attribute，nullish 值移除 attribute。 |
| `preactjs__preact-4316` | F2P 1/1，P2P 9/10，未解决 | 补丁将所有 fallback 事件名小写化，修复 focus 事件时回归 CamelCase 自定义事件；已知风险被错误接受为“罕见”。 |
| `preactjs__preact-3345` | F2P 0/1，P2P 16/16，未解决 | 仅继续 unmount cleanup 遍历，未在调用前清除 cleanup handle，也未实现所有要求的 error/cleanup 顺序。 |
| `preactjs__preact-3567` | F2P 0/1，P2P 20/20，未解决 | 仅移除 `_args` reset，未分离 tentative render 数据和 committed hook state，未实现重入/延迟状态语义。 |

该 cohort 将 4 个未解决任务减少至 3 个。按替换口径为 **23/26（88.5%）**，但历史 corrected R2 Full 仍是 **22/26**，报告必须同时保留这两个口径。

### 4.2 RepoFix 问题、解决方法与预期补丁

| RepoFix 问题 | 根因 | 解决方法 | 任务级预期补丁 |
| --- | --- | --- | --- |
| 已知可观测回归可被标记为“罕见”或“可接受”后继续进入 P1。 | 风险叙述不是安全门，计划中的保留行为没有对应可验证反例。 | 将保留不变量转为具体反例；proposed diff 与不变量冲突，或无测试/证据处置时拒绝阶段完成。 | `4316` 只对 focus-in/focus-out 使用窄规则；未识别自定义事件后缀保持原始大小写。 |
| PLAN 列出的语义义务与最终 diff 不一致，但 IMPLEMENT/SELF_REVIEW 未报告缺项。 | PLAN-to-diff 覆盖关系未强制。 | 每个计划代码点必须记录 `implemented`、`ruled_out by repository evidence` 或 `blocked`；未处置代码点拒绝阶段完成。 | `3345` 调用前清除 cleanup 引用，完成指定遍历和错误上报边界，并覆盖所有有仓库证据的 context。 |
| 非终止或非比较的受控验证被当作正向信号。 | `test:karma:hooks` 含 `--no-single-run`；宽泛 `npm test` 会在并行构建中 `EAGAIN`。 | 验证目录只暴露确定终止的候选，或由冻结脚本元数据派生并预检 Controller 自有 single-run 变体；只有正常退出才是可用验证。 | `3567` 分别建模 committed 与 pending 的 hook args/value，仅在 render path 稳定后提交 pending state；覆盖 render 中 `setState`、依赖变化、effect cleanup、layout effect 和 memo state。 |

### 4.3 下一轮准入条件

下一轮仅可在上述三项工作流修复先通过 faux-provider/unit fixture 和 Controller catalog 测试后启动，并且只重跑三个剩余逻辑任务。每项必须满足：

- `4316` 没有 P2P 回归。
- 每项达到 F2P 1/1 并保留 P2P。
- 保留可终止的 V0/V1/V2 及基线/候选比较记录。
- 保留覆盖所有 PLAN 语义义务的 PLAN-to-diff 处置记录。
- 不重跑 Pi，也不在本阶段启动 R2 ablation。

## 5. 报告规则与证据入口

- 不修改 Pi 核心 agent loop；修复范围限于 `packages/repofixlab` 的 session 包装、工具契约、Controller、runner 和产物层。
- 不放宽 Docker、固定工作树、PATH-only、无 shell、测试文件保护、网络、写路径和超时边界。
- 不为节省 Token 删除原始轨迹；仅限制模型可见的重复上下文。
- `command_invalid`、`environment_failure`、`timed_out` 与语义补丁失败分开报告；相同基线/候选失败不构成正确性证据。
- [R2 执行契约](repofixlab-r2-execution-contract.md)
- [RepoFix 阶段控制](../../packages/repofixlab/src/agent/repofix.ts)
- [阶段产物 schema 与状态机](../../packages/repofixlab/src/agent/repofix-fsm.ts)
- [仓库工具的模型可见输出](../../packages/repofixlab/src/sandbox/repo-tools.ts)

原始运行证据位于本地 `artifacts/r2-forensics/`、`r2-v6-r3/`、`r2-v6-r4/controller-identity-3/` 与 `r2-v6-r5/semantic-workflow-4/` 下的账本、轨迹、控制记录、验证记录和官方评估产物。它们不提交到 Git；正式报告以冻结哈希和相对路径引用它们。
