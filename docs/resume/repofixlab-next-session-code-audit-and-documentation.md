# RepoFixLab：下一会话代码审查与核心注释交接

## 0. 本文件的用途与当前边界

本文件为下一会话提供工作上下文。当前会话只完成了事实核对和任务拆解，**没有实施代码重构，也没有为核心代码新增注释**。

下一会话有两项工作：

1. 审查 RepoFix 核心实现是否存在可消除的冗余、重复职责或不一致的控制逻辑。
2. 为核心实现补充解释架构、契约、不变量和失败语义的 TSDoc 注释。

先输出有证据的审查结论和拟修改清单，再请求用户确认是否实施重构或注释修改。不要把“疑似重复”直接删除，也不要把“需要解释”直接变成大规模逐行注释。

本文件不是 R2 实验结果的唯一来源；结果、执行边界和实现行为应以第 2 节列出的权威材料与本地制品复核。

## 1. RepoFix 是什么，以及 Pi 在哪里

RepoFix 不是替代 Pi 的另一个模型循环。Pi 的 createAgentSession / session.prompt 仍是模型推理、工具调用和多轮交互的执行底座；RepoFix 是包裹该循环的受控修复工作流。

RepoFix 的职责包括：

- 将修复过程划分为理解、定位、计划、实现、受控验证、精炼和自审阶段；
- 为每个阶段限定可用工具，并要求提交结构化阶段产物；
- 通过 Controller 管理仓库、验证目录、隔离 clone、路径和命令策略；
- 将模型可见上下文与完整审计轨迹分开，阶段边界生成受控 handoff；
- 保存 P0、V0/V1/V2、P1、轨迹、账本和官方评测制品；
- 在阶段产物缺失或 schema 被拒绝时进行有限的 completion-only 恢复，而不是无限重试。

当前 R2 工作流的简化链路是：

    R2 batch → formal runner → M4 workflow → worker readiness probe
      → Pi session + RepoFix stage hooks
      → UNDERSTAND → LOCALIZE → PLAN → IMPLEMENT → P0
      → V0 → REFINE_1 → V1 → V1 verification → REFINE_2
      → V2 → V2 verification → SELF_REVIEW → P1
      → official evaluator

LOCALIZE 与 verification feedback 可由实验配置消融；它们是否各自带来因果收益，不能仅由当前完整工作流的成功率推导，仍需按冻结计划进行配对的 RepoFix-only 消融分析。

## 2. 先读什么：事实来源与证据优先级

按以下顺序读取，并在做任何结论前检查当前 Git 状态。工作区可能包含其他会话的未提交实验或测试文件；不得重置、清理、暂存或覆盖它们。

1. [总体设计规格](../designs/repofixlab.md)：系统边界、控制面、数据和安全设计。
2. [R2 执行契约](../designs/repofixlab-r2-execution-contract.md)：当前 Pi loop / RepoFix 边界、阶段流程、验证契约、停止策略和实验隔离。
3. [R2 阶段化修复复盘](../designs/repofixlab-r2-remediation-postmortem.md)：问题、已实施修复、仍未解决的语义缺口及其证据。
4. [实验结果摘要](../reports/repofixlab-experiment-summary.md)：指标和可比较性边界。
5. R2 冻结配置：packages/repofixlab/configs/experiments/r2-v6.yaml。
6. 与当前结论有关的本地 artifacts、run result、trajectory、P0/V0/V1/V2/P1 和官方评测结果。文档可以说明历史结论，但制品才是某次运行的直接证据。

若文档、代码和制品不一致，按以下优先级处理：

1. 不可变的运行制品、哈希和官方评测；
2. 当前代码与冻结配置；
3. R2 执行契约；
4. 复盘和摘要；
5. 本文件。

不要假定历史上曾存在另一份“问题与解决方案”文档。当前已明确定位的是 R2 复盘、R2 执行契约和总体设计规格；若需要更新问题记录，至少更新 R2 复盘，并先搜索确认是否还有更合适的现存文档。

## 3. 已核对的实验状态与表述禁区

### 3.1 正确的结果口径

当前资料包含多个来源不同的结果，必须分开陈述：

| 口径 | 结果 | 含义 |
| --- | ---: | --- |
| 历史 R2 Full 初始结果 | 20/26 | 不是后续恢复/定向修复后的结果。 |
| corrected R2 Full | 22/26 | 仅替换三个 Controller 身份基础设施失败的恢复结果。 |
| 最新来源标注的替换视图 | 24/26 | 融合 R3 Full、Controller identity recovery、语义修复、R9、R12 和 immutable-js 携带制品；不是一次重新执行的同质 26 任务 Full。 |
| 该替换视图的测试证据 | F2P 30/32，P2P 592/592 | 同样是来源标注的复合证据。 |
| Pi-general 摘要 | 21/26，F2P 29/32，P2P 587/592 | 不能与 24/26 写成同一批次、同一预算下的直接胜负比较。 |

因此可以说：在当前来源标注的替换视图中，RepoFix 为 24/26，数值高于 Pi-general 摘要的 21/26；不能说“RepoFix 已通过一次同质、配对实验证明全面超过 Pi”。

R2 的后续执行仍限定为 RepoFix-only。不要重跑 Pi；不要在没有用户授权时启动 R2 消融。

### 3.2 已解决的控制问题与仍未证明的能力

已实施或已记录为有效的工作流改进包括：

- stage_complete 的可诊断 wire payload、严格规范化和有限恢复；
- completion-only turn 通过 Pi 的 shouldStopAfterTurn 结束当前 native loop；
- 8 个模型轮次或 8 次仓库调用改为轨迹检查点，而非工具准入硬阈值；
- R2 中 max_tool_calls 为 null，仍保留模型轮次、Token、Provider timeout 和墙钟上限；
- Controller-owned repo_list readiness probe；
- 由 Controller 管理的验证 catalog、隔离 local clone、基线/候选对照和稳定的 environment_failure 分类；
- 执行 namespace 参与 Controller attempt / repo operation 身份，避免跨运行重放；
- 有界的有效 JSON handoff，而不是字符截断 JSON；
- PLAN obligation / invariant 的处置和 SELF_REVIEW 覆盖检查。

这些机制证明的是可控性、可观测性、失败可分类性或特定工作流缺陷已被修复；它们**不自动证明**模型补丁的语义正确性。

剩余两个最新有效语义未解决任务是：

| 任务 | 当前结果 | 直接缺口 |
| --- | --- | --- |
| preactjs__preact-3345 | F2P 0/1，P2P 16/16 | 修复未完整实现 cleanup handle、继续遍历、错误上报、DOM 卸载和 ErrorBoundary 可观察顺序。 |
| preactjs__preact-3567 | F2P 0/1，P2P 20/20 | 修复未分离 tentative render 数据与 committed hook state，也未实现重入/延迟状态语义。 |

它们当前应视为有效的语义修复失败，而不是 Controller、环境或官方 evaluator 失败。后续若改进 RepoFix，方向应是增强语义验证闭环：把通用回归通过、接受行为已证明、结果不充分三者分开；不能把 P2P 通过、diff inspection 或“风险罕见”误写为任务核心行为已证明。

### 3.3 安全数据应如何理解

历史 M8 证据记录 148 次 Controller 拒绝、42 个按审计规则分类的 sandbox-escape 输入、0 个未阻断 escape 和 0 个 patch policy violation。

这些数字证明当前控制面曾拦截越界格式或违规请求，但不能被表述为 148 次恶意行为：

- 148 是 runtime request 被拒绝的总数，现有制品没有可安全相加的细分；
- 42 是静态规则识别的路径或可执行文件逃逸格式，也可能是无恶意的错误用法；
- 常见拒绝规则包括非白名单工具、字段不合法、绝对路径、..、反斜杠、符号链接穿越、测试目录写入、带路径的可执行文件、shell 和超时超限；
- 受控工作流与阶段结构化产物使边界可审计、可拒绝和可追踪，但安全成功本身不构成修复质量提升的证据。

RepoFix 阶段不授权任意 repo_exec；不要把这句话扩大为“系统中不存在 repo_exec”，因为工具注册和其他受控路径仍可能包含该能力。

## 4. 核心实现地图

先完整阅读下列文件再审查或编辑。路径按职责排序，不表示其中一定有问题。

| 优先级 | 路径 | 应理解的职责 |
| --- | --- | --- |
| P0 | packages/repofixlab/src/agent/repofix.ts | RepoFix session、stage prompt / handoff、trajectory、completion-only recovery、Pi hook 安装和总工作流入口。 |
| P0 | packages/repofixlab/src/agent/repofix-fsm.ts | 阶段 schema、stage_complete、状态机、按阶段工具授权、PLAN 到 IMPLEMENT/SELF_REVIEW 的 obligation / invariant 覆盖。 |
| P0 | packages/repofixlab/src/agent/repofix-config.ts | Full、No-localize、No-verification-feedback 与 Pi-general 的配置差异。 |
| P0 | packages/repofixlab/src/sandbox/repo-tools.ts 及 protocol.ts | Pi 工具适配、模型可见输出预算、结果协议与 Controller 调用边界。 |
| P0 | packages/repofixlab/controller/src/repofixlab_controller/runtime_tools.py | 受信 Controller 的路径/输入/argv 策略、verification catalog、基线/候选隔离 clone 验证。 |
| P0 | packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py | Controller 服务、请求身份、生命周期和运行时边界。 |
| P1 | packages/repofixlab/src/runner/m4-dev-workflow.ts | worker readiness、受控验证、轨迹与 final snapshot 的持久化决策。 |
| P1 | packages/repofixlab/src/m7/formal-runner.ts | M4 成功、final snapshot 和官方评测之间的准入边界。 |
| P1 | packages/repofixlab/src/r2/batch-runner.ts | R2 cohort 选择、执行根隔离、恢复替换范围。 |
| P2 | packages/repofixlab/src/storage/、src/contracts/、src/metrics/、src/runner/ | 制品、schema、指标、预算和批处理状态的单一事实源。 |

关键事实：单次模型可见的仓库工具输出预算为 12 KiB、每阶段为 48 KiB。这是 RepoFix 为避免重复上下文膨胀设置的模型可见工具输出预算，**不是** DeepSeek 或 Pi 规定的 48K 模型输出上限。审查时不得把该预算误删、误述为 Provider 限制，或在没有实验依据时改写为新的固定探索阈值。

## 5. 任务一：冗余审查应该怎样做

### 5.1 审查目标

目标不是压缩代码行数，而是确保每项工作流语义只有一个权威实现，同时保留安全、审计、实验可复现性和跨语言边界所需的刻意重复。

优先查找以下风险：

- 同一 stage policy、工具授权、停止条件或 failure reason 在多个位置独立实现且可能漂移；
- Pi hook、completion-only 恢复、prompt/handoff 构造或 trajectory 记录有重叠分支；
- stage artifact、schema 规范化、obligation disposition 和 final snapshot 判定存在重复转换；
- Controller 响应、验证结果和环境失败分类在 TS / Python 边界出现语义不一致；
- R2 cohort / recovery 的 provenance 规则、结果替换和报告逻辑重复且可能误改历史制品；
- 预算、超时、路径、工具输出截断或状态序列化的常量散落而没有权威来源；
- 生产路径为了实验而重复实现，或实验路径错误地耦入生产工作流。

以下情况通常不是可直接删除的冗余：

- 完整审计日志与模型可见摘要的双重表示；
- TypeScript 适配层与 Python Controller 对同一协议分别执行的防御性校验；
- 基线 / 候选 clone 的并行验证；
- 历史 Full 制品与独立 recovery cohort 的并存；
- 各阶段的显式工具白名单和拒绝审计；
- 为防止跨运行重放而保留的 execution namespace 与 operation identity。

### 5.2 必须交付的审查报告

不要先改代码。先输出候选清单，每项至少包含：

| 字段 | 要求 |
| --- | --- |
| 位置 | 文件、符号和相关调用链。 |
| 重复对象 | 重复的是状态、规则、转换、常量、日志还是控制流。 |
| 证据 | 两处或多处行为为何可能等价，及调用时机。 |
| 行为差异 | 是否存在阶段、错误语义、安全或审计差异；不确定时明确标为未证实。 |
| 分类 | 可安全合并 / 需验证后重构 / 刻意冗余 / 暂不处理。 |
| 风险 | 可能影响的安全、artifact provenance、实验可比性、Pi session 或官方评测。 |
| 最小方案 | 若获批准，拟保留哪个单一事实源，如何迁移和如何测试。 |

特别禁止：

- 用“看起来重复”删除 schema、Controller 校验、路径校验、审计记录或历史制品隔离；
- 为了统一代码而改变 R2 实验口径、覆盖已有 artifact 或重跑已完成任务；
- 把 8 次仓库调用检查点恢复成硬阻断；
- 放宽 Docker、固定工作树、无 shell、测试目录写保护、网络、路径或超时边界；
- 将 3345/3567 的语义失败归因于外部环境，或把可控性当作语义成功证明。

## 6. 任务二：核心代码注释标准

使用 TypeScript TSDoc 和 Python docstring 的项目原生风格。用户给出的 RRFFusion 示例要求的是解释深度，不是复制 Python 的长 docstring 外观。

应优先给下列符号写注释：

- repofix.ts：createStageCompletionControl、installStageHooks、stageHandoff、stageCompletionContext、runRepoFixWorkflow；
- repofix-fsm.ts：RepoFixStageMachine、stage artifact 的规范化与 validation、PLAN obligation / invariant 覆盖函数；
- m4-dev-workflow.ts：Controller readiness probe、controlledVerify、trajectory 持久化、retained final snapshot 判定；
- runtime_tools.py：RepositoryToolExecutor、路径解析、verification catalog、隔离基线/候选验证；
- formal-runner.ts：M4 到官方评测的准入边界；
- r2/batch-runner.ts：cohort provenance 和结果隔离。

每段注释应回答与代码实际一致的问题：

1. 该组件为什么存在，位于 Controller、RepoFix、Pi 或 evaluator 的哪条信任边界？
2. 输入、输出、持久化副作用和失败语义是什么？
3. 必须保持哪些不变量？例如 P1 与 V2 的 hash 一致、P1 没有 edit tool、同一 attempt 内幂等而跨 execution 不重放。
4. 哪些结果只是 regression_pass 或 inconclusive，不能当作 acceptance_proven？
5. 它如何避免已知故障：无限 tool retry、失效 stage_complete、Git worktree 所有权问题、HTTP 409 重放、非终止验证或语义义务漏报？
6. 若存在阈值，它是安全边界、资源上限、轨迹检查点还是实验配置？其依据是什么，是否可配置？

不要写以下类型的注释：

- 逐行复述显而易见的语法、类型或变量名；
- 未经证实的性能、安全或模型能力承诺；
- 将历史指标写成当前代码的永恒不变量；
- 把模型声明的 evidence 与 Controller 观察到的 acceptance evidence 混为一谈；
- 为了覆盖率给私有 helper 叠加无信息注释。

复杂类/函数的推荐结构：

1. 一句职责和所在边界；
2. 关键机制或数据流；
3. 可观测不变量；
4. 输入、返回、错误/失败状态和副作用；
5. 必要时给一个短的调用示例或状态流转。

## 7. 推荐执行顺序

1. 检查 AGENTS.md、Git 状态和当前分支；记录但不要触碰无关修改。
2. 完整阅读第 2 节材料和第 4 节 P0 文件；绘制实际调用链，而不是只根据文件名推断。
3. 对比代码、契约、复盘和 artifacts，列出事实冲突或过期描述。
4. 仅输出冗余候选报告、核心注释计划和风险分级，等待用户确认。
5. 获准后按最小批次实施：先做语义无争议的注释；对任何重构单独说明行为保持条件。
6. 若修改代码，执行 npm run check 并修复全部错误、warning 和 info；不要擅自运行 npm run build、npm test 或全量 vitest。
7. 若修改了设计含义、实现了工作流修复或更正了实验解释，再更新 R2 复盘；不要用文档修改掩盖未完成的实验或语义修复。
8. 未获用户明确要求，不提交、不推送、不启动 R2 消融或真实 Provider 实验。

## 8. 完成标准

下一会话的“审查完成”至少应满足：

- 有完整的调用链和责任边界，而非仅有 grep 结果；
- 每个冗余候选都有证据、分类和风险，且明确区分刻意冗余；
- 注释计划覆盖 P0 信任边界和工作流状态机，不以注释数量作为目标；
- 不夸大 24/26、148/42 或 3345/3567 的结论；
- 所有拟议变更保持实验 provenance、安全边界、Pi loop 行为和历史结果不可变；
- 对“定位是否有用”“验证反馈是否有用”明确标为尚待消融证实，除非新的配对证据已完成并被引用。

这两项任务的成功标准是让 RepoFix 的控制逻辑、语义验证边界和证据链更容易审查和维护，而不是用重构或注释掩盖仍未解决的语义修复问题。
