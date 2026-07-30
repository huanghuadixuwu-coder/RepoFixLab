# RepoFixLab 项目复习题库

本题库共 9 章、54 题。答案是复习提示，不是权威事实；每次讲解前必须与当前代码、冻结配置、R2 契约及可用制品核对。表内以 `src/`、`controller/`、`evaluator/` 或 `dataset-preparer/` 开头的路径，均相对于 `packages/repofixlab/`。

## 第 1 章：项目定位与证据口径

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 1-01 | RepoFixLab 要解决什么核心问题，它为什么不是普通“自动改代码 Demo”？ | 基础 | 项目定位 | 面向真实 Issue，在固定环境中生成候选补丁并由独立官方评测判定；同时保留成本、轨迹、失败、安全和 provenance，成功与失败都进入固定分母。 | `docs/designs/repofixlab.md` 第 1–4 节 |
| 1-02 | Pi、RepoFix Agent 和 RepoFixLab 平台三者是什么关系？ | 基础 | 职责分层 | Pi 提供模型/工具循环与 session；RepoFix 在 Pi 外层实施阶段、工具授权、产物与恢复；RepoFixLab 还包含 Controller、Evaluator、批处理、预算、制品和报告。 | 交接文档第 1 节；`src/agent/pi-general.ts`；`src/agent/repofix.ts` |
| 1-03 | 为什么不能说 RepoFix 已在一次同质 26 任务实验中全面胜过 Pi？ | 进阶 | 可比较性 | Pi 21/26 是 M9 首次任务视图；RepoFix 24/26 是 R3、恢复、定向修复、R9/R12 和携带制品构成的来源标注替换视图，批次、时点和干预不同。 | `docs/reports/repofixlab-experiment-summary.md` |
| 1-04 | 20/26、22/26 和 24/26 分别代表什么？ | 进阶 | 历史口径 | 20/26 是初始 R2 Full 口径；22/26 只替换三项 Controller 身份基础设施失败；24/26 是采用每任务最新有效官方制品的复合替换视图，不能覆盖历史结果。 | R2 复盘第 1 节 |
| 1-05 | 当文档、代码、配置和 artifacts 不一致时，应如何确定事实？ | 深挖 | 证据优先级 | 先不可变运行制品/哈希/官方评测，再当前代码与冻结配置，再执行契约，最后设计、复盘、摘要和交接；缺 artifact 时必须声明未核验。 | 交接文档第 2 节 |
| 1-06 | “工作流可控”和“补丁语义正确”为什么是两个命题？ | 深挖 | 结论边界 | schema、有限恢复、工具门控、P1 保留和 evaluator 调用只能证明控制流与证据链；语义正确仍需目标接受行为的可比较证据和官方 F2P/P2P。 | R2 复盘第 4.4–4.5 节 |

## 第 2 章：系统架构与信任边界

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 2-01 | Node Orchestrator 负责什么，为什么不持有 Docker socket？ | 基础 | Orchestrator | 它拥有模型调用、Pi session、预算、状态机、实验调度和规范化制品；不持 socket 可避免模型凭据与 Docker daemon 高权限聚合。 | 设计规格第 6.1 节；`src/runner/` |
| 2-02 | Trusted Controller 为什么是可信控制面而不是沙箱？ | 基础 | Controller 权限 | 它是唯一 Docker socket owner，socket 等价 daemon 高权限；安全来自窄 RPC、固定镜像/命令/挂载策略和审计，而非把 Controller 本身隔离为不可信代码。 | `controller/.../app.py`；`runtime_service.py`；设计规格第 6.1 节 |
| 2-03 | Agent Worker 不能看到或拥有哪些东西？ | 进阶 | Worker 隔离 | 不持模型凭据、Docker socket、网络、gold patch、test patch、未来 Git 对象和宿主源码；只在受限工作目录经仓库工具读写。 | `runtime_docker.py`；`runtime_worker_entry.py`；设计规格第 8 节 |
| 2-04 | 为什么 Evaluator 必须使用与 Worker 分离的干净容器？ | 进阶 | 独立判定 | 防止 Agent 修改测试状态或环境后自证成功；Evaluator 重新应用候选 patch 与私有 test patch，并用固定 official oracle 判定。 | `runtime_docker.py`；`evaluator/.../runner.py` |
| 2-05 | Dataset Preparer 和 Artifact Store 的写入职责有何不同？ | 进阶 | 数据/制品边界 | Preparer 在准备期生成并封存 public/control/private generation 与锁；Artifact Store 由 Orchestrator 在运行期原子发布规范化 run artifacts。 | `dataset-preparer/`；`src/storage/artifact-store.ts` |
| 2-06 | 如果把模型 key 和 Docker socket 放入同一个服务，会破坏什么设计目标？ | 深挖 | 权限聚合风险 | 一个被模型输入或候选代码影响的高权限组件将同时拥有外部凭据和宿主级容器控制能力，扩大泄露与逃逸影响面，也破坏职责审计。 | 设计规格第 6、8、16 节 |

## 第 3 章：RepoFix 工作流与状态机

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 3-01 | RepoFix 从 UNDERSTAND 到 SELF_REVIEW 的阶段顺序是什么？ | 基础 | 阶段流 | UNDERSTAND → LOCALIZE → PLAN → IMPLEMENT → P0/V0 → REFINE_1 → V1/V1 验证 → REFINE_2 → V2/V2 验证 → SELF_REVIEW → P1。 | `src/agent/repofix.ts`；R2 执行契约 Workflow |
| 3-02 | 为什么阶段边界不能只靠 prompt 约束？ | 进阶 | 状态机强制 | 模型可能越阶段调用工具或遗漏产物；FSM 必须控制允许工具、校验结构化 artifact、记录拒绝并决定转移/终止。 | `src/agent/repofix-fsm.ts` |
| 3-03 | `stage_complete` 为什么使用可诊断 wire payload 后再严格规范化？ | 进阶 | schema 诊断 | 过严工具声明会在 Pi 参数校验前拒绝，使 RepoFix 看不到字段错误；宽 wire 入口让 FSM 返回字段级安全错误并执行有限恢复，最终 artifact 仍严格。 | `repofix-fsm.ts`；R2 复盘第 2.2 节 |
| 3-04 | completion-only 恢复如何避免无限工具重试？ | 深挖 | 有限恢复 | 缺失/被拒 artifact 只允许固定两次只提交完成产物的 Provider turn；Pi 的 `shouldStopAfterTurn` 使当前 native loop 在每次恢复 turn 后退出，失败则确定终止。 | `src/agent/repofix.ts`；R2 执行契约 |
| 3-05 | 8 次模型轮次或仓库调用在当前 R2 中是什么？ | 基础 | 检查点语义 | 只是轨迹观察与收束检查点，不是第九次调用的硬阻断；仍由 Token、模型轮次、Provider timeout 和 wall time 约束。 | R2 执行契约 Targeted forensic record |
| 3-06 | 为什么 P1 必须与 V2 hash 一致？ | 深挖 | 快照不变量 | SELF_REVIEW 阶段没有 edit 工具，只能审查和提交处置；因此最终保留 P1 不应改变 V2 补丁，hash 不一致表示边界被破坏。 | `m4-dev-workflow.ts`；`formal-runner.ts`；R2 契约 Provenance |

## 第 4 章：Pi 会话、工具与 Controller 接口

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 4-01 | RepoFix 为什么复用一个 Pi session，而每个 attempt 又必须新建 session？ | 进阶 | 会话隔离 | 同一 attempt 的阶段需要连续上下文和统一轨迹；不同 attempt 可能代表基础设施重试，不能继承失败状态、消息、工具结果或预算偏差。 | `src/runner/runtime-factory.ts`；设计规格第 6.3 节 |
| 4-02 | 评测 session 为什么关闭内建工具、skills、扩展和项目上下文自动发现？ | 进阶 | 公平/隔离 | 防止宿主配置、用户技能、AGENTS、凭据或未冻结工具隐式进入实验；只注册版本化 prompt 与容器仓库工具 allowlist。 | `runtime-factory.ts`；`pi-general.ts` |
| 4-03 | TypeScript repo 工具层和 Python Controller 为什么都要校验请求？ | 深挖 | 刻意防御冗余 | TS 负责模型协议、输出预算和友好错误；Python 是实际 Docker/文件边界，必须独立执行路径、argv、测试写保护和 allowlist，不能信任上游。 | `src/sandbox/protocol.ts`；`repo-tools.ts`；`runtime_tools.py` |
| 4-04 | 12 KiB 与 48 KiB 预算限制的是什么？ | 基础 | 模型可见输出 | 分别限制单工具和单阶段回送模型的工具输出，完整原始日志仍作审计制品；它们不是 Provider 上下文窗口或模型输出上限。 | `src/sandbox/repo-tools.ts`；交接文档第 4 节 |
| 4-05 | `ControllerClient` 中 operation ID 需要绑定哪些身份？ | 进阶 | 幂等与重放 | 需要绑定 execution namespace、attempt 和模型 tool-call；同 attempt 重试保持幂等，跨 execution 的相同逻辑任务不能重放历史生命周期。 | `src/controller/client.ts`；`runtime_service.py` |
| 4-06 | Pi-general 与 RepoFix 的公平对照中，哪些相同，哪些允许不同？ | 深挖 | 控制变量 | 模型、任务、预算、容器工具后端和资源限制应相同；RepoFix 的阶段 prompt、工具启停、结构化 artifact 和验证反馈是被研究的显式干预。 | `repofix-config.ts`；设计规格第 7.4、10.3 节 |

## 第 5 章：受控验证与官方 Evaluator

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 5-01 | 为什么验证命令由 Controller catalog 提供而不是模型自由编写 argv？ | 基础 | 命令所有权 | Controller 从预检过的 package scripts 派生候选，固定 cwd、argv、timeout 和缓存；模型只选 ID，减少 shell、非终止命令和路径越界。 | `runtime_tools.py`；R2 契约 Workflow |
| 5-02 | 为什么每次受控验证要创建 baseline 和 candidate 两个独立 clone？ | 进阶 | 可比较验证 | 同命令分别运行未修改基线和候选补丁，才能区分既有环境/测试失败与补丁引入变化；独立 Git metadata 避免源 worktree 所有权问题。 | `runtime_tools.py` |
| 5-03 | 五种受控验证状态分别表达什么？ | 基础 | 失败分类 | `passed` 正常退出通过；`test_failed` 测试失败；`command_invalid` 候选/命令不合约；`environment_failure` 环境无法有效运行；`timed_out` 未在期限内正常结束。 | `src/contracts/v1.ts`；`runtime_tools.py` |
| 5-04 | 为什么 baseline 和 candidate 都通过也未必证明 Issue 已修复？ | 深挖 | 证据范围 | 通用回归脚本可能根本不覆盖目标接受行为，只能形成 regression signal；必须有对应复现/行为 probe 或官方 F2P 才能证明 acceptance。 | R2 复盘第 4.4–4.5 节 |
| 5-05 | Official Evaluator 如何定义任务 `resolved`？ | 基础 | 官方判定 | candidate 可应用、测试补丁正确注入，所有 F2P 通过且全部 P2P 保持通过；Agent 自测或模型声明不进入主判定。 | `evaluator/.../runner.py`；`tap.py`；实验摘要 |
| 5-06 | no-verification-feedback 消融如何保持公平？ | 深挖 | 消融设计 | Full 与消融都执行相同 V0/V1/V2；消融只屏蔽传给 REFINE/SELF_REVIEW 的结果，仍保留相同修订机会和官方 evaluator。 | `repofix-config.ts`；R2 契约 Workflow |

## 第 6 章：契约、制品与恢复

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 6-01 | 为什么 canonical JSON 要参与 run、snapshot 和锁文件身份？ | 进阶 | 内容寻址 | 固定键序、换行和序列化后才能跨 TS/Python 稳定计算 hash，检测字段/顺序漂移并绑定制品 provenance。 | `src/contracts/canonical-json.ts`；`evaluator/.../canonical.py` |
| 6-02 | TypeBox 类型和生成 JSON Schema 各自扮演什么角色？ | 基础 | 单一事实源 | TypeBox 定义是 Node 侧源；生成 schema 供跨语言和落盘制品校验，生成文档必须可重复且不能手改漂移。 | `src/contracts/`；`schemas/v1/` |
| 6-03 | ArtifactStore 为什么采用临时文件、fsync/原子替换和不可变发布？ | 进阶 | 崩溃一致性 | 防止进程中断留下半文件，保证读者只看到完整 artifact；已发布身份不能被普通 resume 覆盖。 | `src/storage/artifact-store.ts` |
| 6-04 | `run_id` 与 `attempt_id` 有何区别？ | 基础 | 身份模型 | run 表示任务×配置×replicate 的逻辑观察；attempt 表示一次基础设施执行，重试不能抹掉旧 attempt 的成本和失败证据。 | `run-contracts.ts`；设计规格第 12.2 节 |
| 6-05 | 什么条件下才允许原地恢复同一个 attempt？ | 深挖 | quiescent checkpoint | session、容器、快照、trace/ledger/journal offset 均存在且 hash 一致，无 in-flight Provider/tool/RPC 和 open reservation；否则终止旧 attempt 并新建 attempt。 | `batch-state.ts`；设计规格第 12.2 节 |
| 6-06 | Controller journal 为什么既要同请求重放，又要拒绝跨执行历史重放？ | 深挖 | 幂等语义 | 网络重试需要同 operation/request 返回同一结果；新 execution 必须有新 namespace，否则会复用旧 worker/lifecycle 并产生 HTTP 409 或错误证据归属。 | `runtime_journal.py`；`runtime_service.py`；R2 契约 |

## 第 7 章：批处理、预算与指标

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 7-01 | `repofixlab run` 到 R2 单次正式运行经过哪些主要层？ | 进阶 | 调用链 | CLI 解析/分派 → M7 batch 入口 → R2 batch runner → formal runner → M4 workflow → Controller/Pi → official evaluator → batch state/metrics/report。 | `src/cli/main.ts`；`m7/batch-runner.ts`；`r2/batch-runner.ts` |
| 7-02 | GlobalBudgetLedger 与 TokenSupervisor 为什么需要分工？ | 进阶 | 预算所有权 | Ledger 是跨 run/experiment 的持久总账和 writer lease；Supervisor 包装当前 session 的请求 reservation、usage 校验、结算和 admission。 | `global-budget-ledger.ts`；`token-supervisor.ts` |
| 7-03 | usage 不完整或计费状态不明时为什么要保守记账？ | 深挖 | fail-closed 成本 | 不能假设未计费；按 reservation 计入并暂停对账可避免重复调用突破总预算，旧 attempt 成本也不得丢弃。 | `token-supervisor.ts`；设计规格第 10.4–10.5 节 |
| 7-04 | 为什么每次运行只能有一个 termination reason，却可以有多个 quality label？ | 基础 | 聚合不重计 | termination reason 表示最先进入的唯一终止状态，便于固定分母聚合；定位错误、过大 patch、无效迭代等可并列为诊断标签。 | `src/contracts/v1.ts`；设计规格第 11.4 节 |
| 7-05 | F2P、P2P 与任务成功率为何不能互相替代？ | 基础 | 指标层级 | F2P 衡量目标失败转通过，P2P 衡量既有通过保持；只有某任务全部 F2P/P2P 同时通过才计 resolved，测试用例比例不等于任务比例。 | `experiment-metrics.ts`；实验摘要 |
| 7-06 | 为什么失败、超时和环境问题必须保留在预定义分母中？ | 深挖 | 选择偏差 | 删除难跑或失败样本会抬高结果并破坏预注册比较；可另做条件敏感性分析，但不能替代主指标。 | 设计规格第 11.1、14.2 节 |

## 第 8 章：数据、环境与安全

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 8-01 | 43 个 JS/TS 候选任务为什么最终只冻结 26 个？ | 基础 | 数据预检 | 只有 base/gold 官方判定、镜像净化、测试集合和 pristine/adapted harness 等价门禁都通过的任务才可评测；17 个拒绝项仍保留证据。 | 设计规格第 9.2–9.3 节 |
| 8-02 | 为什么应说“运行时隐藏测试”而不是“零泄露隐藏测试”？ | 进阶 | 污染边界 | gold/test patch 不在运行时暴露给 Agent，但公开任务可能进入模型训练，平台无法证明训练阶段绝对未见。 | 设计规格第 9.4、17 节 |
| 8-03 | TaskEnvironmentLock 需要绑定哪些关键身份？ | 进阶 | 环境可复现 | source repository digest/local ID、精确 worker/evaluator image ID、platform、sanitizer/adapter、资源和文件系统 profile、任务/数据锁与预检证据。 | `task-environment-lock.ts`；`official-image-source-lock.ts` |
| 8-04 | 为什么路径、反斜杠、`..`、shell、测试目录写入和带路径 executable 要 fail closed？ | 基础 | 工具策略 | 防止工作区逃逸、绕过 PATH allowlist、修改评测相关文件或借 shell 拼接任意命令；真正执行边界在 Controller。 | `runtime_tools.py`；`src/sandbox/protocol.ts` |
| 8-05 | 148 次拒绝和 42 个 escape-pattern 输入能证明什么，不能证明什么？ | 深挖 | 安全证据 | 证明控制面记录并阻止了这些越界/不合约请求，且审计中无未阻断 escape；不能把全部拒绝或 42 项都称为恶意攻击。 | 交接文档第 3.3 节；`src/m7/security-audit.ts` |
| 8-06 | Docker 在本项目的安全承诺边界是什么？ | 深挖 | 威胁模型 | 降低误操作、凭据泄露、网络取答、资源失控和任务污染风险；不保证抵御 daemon/内核逃逸、恶意基础镜像或侧信道，强敌对场景需 VM/microVM。 | 设计规格第 8.6、17 节 |

## 第 9 章：实验口径、失败案例与取舍

| 题号 | 问题 | 难度 | 考察要点 | 参考答案要点 | 代码/证据入口 |
| --- | --- | --- | --- | --- | --- |
| 9-01 | Full、no-localize 和 no-verification-feedback 三种 RepoFix 配置分别研究什么？ | 基础 | 消融变量 | Full 含完整阶段与反馈；no-localize 移除显式定位门/产物但保留搜索能力；no-feedback 执行验证但屏蔽反馈，研究定位和反馈的受控关联。 | `repofix-config.ts`；设计规格第 10.1 节 |
| 9-02 | 为什么不能仅从 Full 24/26 推断 LOCALIZE 或验证反馈有效？ | 深挖 | 因果归因 | Full 同时包含多项干预，整体结果不能分解单组件因果贡献；必须使用冻结配对消融并报告不确定性。 | 交接文档第 1、8 节；R2 契约 release criteria |
| 9-03 | Controller identity 三任务恢复修复了什么根因？ | 进阶 | 历史故障 | 逻辑 run ID 派生的旧 attempt/operation 身份跨 artifact root 重用，导致 journal 重放或 409；加入 execution namespace 并在 Provider 前 readiness probe。 | R2 契约 Controller identity isolation |
| 9-04 | `preactjs__preact-3345` 为什么 P2P 16/16 仍是语义未解决？ | 深挖 | 接受行为缺失 | 补丁继续 cleanup 遍历但未完整处理调用前 handle、错误上报、DOM 卸载和 ErrorBoundary 顺序；通用测试通过未覆盖私有 F2P 接受行为。 | R2 复盘第 4.4–4.5 节 |
| 9-05 | `preactjs__preact-3567` 的核心语义缺口是什么？ | 深挖 | 状态转移 | 候选没有分离 tentative render 数据与 committed hook state，也未实现 render 重入、setState 与延迟 effect 的状态提交语义；P2P 20/20 只说明未观察到既有回归。 | R2 复盘第 4.5 节 |
| 9-06 | 如果下一步增强 RepoFix 的语义验证闭环，应保持哪些硬边界？ | 深挖 | 改进取舍 | 由 Controller 从公开复现/预审测试/声明式 probe 生成候选，模型只选 ID；区分 regression/acceptance/inconclusive，不暴露私有评测，不放宽 Docker/路径/命令策略，不覆盖历史 artifacts。 | R2 复盘第 4.5、5 节 |

## 题库统计

| 章节 | 题数 | 基础 | 进阶 | 深挖 |
| --- | ---: | ---: | ---: | ---: |
| 第 1 章：项目定位与证据口径 | 6 | 2 | 2 | 2 |
| 第 2 章：系统架构与信任边界 | 6 | 2 | 3 | 1 |
| 第 3 章：RepoFix 工作流与状态机 | 6 | 2 | 2 | 2 |
| 第 4 章：Pi 会话、工具与 Controller 接口 | 6 | 1 | 3 | 2 |
| 第 5 章：受控验证与官方 Evaluator | 6 | 3 | 1 | 2 |
| 第 6 章：契约、制品与恢复 | 6 | 2 | 2 | 2 |
| 第 7 章：批处理、预算与指标 | 6 | 2 | 2 | 2 |
| 第 8 章：数据、环境与安全 | 6 | 2 | 2 | 2 |
| 第 9 章：实验口径、失败案例与取舍 | 6 | 1 | 1 | 4 |
| 合计 | 54 | 17 | 18 | 19 |
