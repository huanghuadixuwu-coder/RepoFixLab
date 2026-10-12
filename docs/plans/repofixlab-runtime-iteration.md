# RepoFix 运行时迭代规格与工作流

- 规格版本：1.8
- 创建日期：2026-10-11
- 最终目标：用户已确认，包含已使用容器的重置复用。
- 开发基线：`codex/skill`，`be8cb251b170801cfc5ceec431193d6ac5bb56be`。
- 当前阶段：WF0–WF7 全部完成，开发分支为 `docker`。

本文件是本次迭代的执行依据，集中记录最终目标、验收条件、工作流与进度。每次继续工作时先读取全文，再根据进度执行一个工作流。

## 1. 最终目标

让多个 RepoFix 修复任务有界并发验证，通过 Worker 和 Evaluator 的环境预热、容器池及已使用容器的受控重置复用，降低环境准备和等待开销，提高固定资源下的批次吞吐量，同时保持任务隔离、评测结果一致和异常可恢复。

最终交付必须包含：

1. 真正并行执行的任务调度与 Controller 容量控制。
2. 按可信环境身份匹配的镜像准备和 Worker、Evaluator 预热池。
3. Worker、Evaluator 已使用容器的重置、验证、再次分配机制。
4. 超时、取消、重置失败和 Controller 重启后的资源与租约恢复。
5. 固定任务及补丁的对照实验、性能报告和可重复执行入口。

完成全部工作流并通过最终验收，才算完成本次迭代。各阶段都保留已用容器复用这一最终目标；调整最终交付范围须由用户明确确认并更新本规格。

## 2. 起点与范围

### 2.1 已核实的基线事实

以下路径与行号对应开发基线提交，后续实现可能改变行号：

| 起点 | 代码位置 |
| --- | --- |
| 批次逐个等待完整 run | `packages/repofixlab/src/runner/batch-runner.ts:338` |
| Controller 容量为 1，以一个 attempt 占用槽位 | `packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py:267` |
| 全局执行锁覆盖 precheck、journal 与耗时 perform | `packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py:756` |
| Worker 准备包括独立卷、容器启动、helper 注入和 readiness | `packages/repofixlab/controller/src/repofixlab_controller/runtime_docker.py:796` |
| 正式评测要求 Worker 已销毁、清理完成且 snapshot 匹配 | `packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py:539` |
| Evaluator 输入、卷、命令及身份在创建时绑定 | `packages/repofixlab/controller/src/repofixlab_controller/runtime_docker.py:1000` |
| 产物 ACK 后清理评测资源，恢复按 attempt 标签定位 | `packages/repofixlab/controller/src/repofixlab_controller/runtime_docker.py:1552` |

任务镜像已提前构建并通过固定环境锁校验。镜像准备、容器预创建、启动后就绪，以及已用容器重置复用分别计量。

### 2.2 本次迭代边界

实施范围为现有 orchestrator 调度、Controller 生命周期、预算与产物协调、必要协议、定向测试和性能实验。优先在现有模块中完成修改，新增模块需要明确的职责边界。

RepoFix PLAN skill、FSM、记忆策略、模型配置、补丁策略和 V0/V1/V2 验证语义沿用冻结基线。性能实验固定这些输入，并记录对应身份哈希。Post-training 和修复质量算法迭代另行规划。

池化需要演进现有“销毁 Worker 后正式评测”的清理契约。新契约必须证明 Worker 租约结束、任务状态已清除、Evaluator 处于干净环境，并提供可追溯证据。

## 3. 最终验收要求

### R1. 有界并发与资源准入

- 至少两个独立任务的实际执行时间发生重叠，同一任务内有状态操作按确定顺序执行。
- Worker、Evaluator、预热中和空闲池资源共同受宿主机资源预算约束；临时 seed、准备容器及验证子进程也计入预算。
- 任务队列有界，容量满时执行可解释的排队或拒绝；资源不足与队列超时有稳定状态。
- 全局 token 预约、结算和账本持久化顺序正确；run 与 attempt 的日志和结果独立归档。

### R2. 环境身份与租约

- 池按角色、准确镜像 ID、任务环境锁和对应安全配置匹配；Evaluator 同时验证私有数据作用域。
- 每个容器同时由一个有效租约持有，租约绑定 attempt 和当前代次。
- 已结束租约的请求被拒绝；operation 幂等重放只能返回对应请求与租约的结果。
- 预热资源和租约资源都有可信归属记录，用户请求不能自行选择镜像、挂载或 Docker 配置。

### R3. Worker 与 Evaluator 预热池

- 两类角色均具有容量、就绪检查、补充、空闲过期和淘汰机制，预热资源计入容量。
- 就绪状态需要完整环境校验，准备中或校验失败的容器不能分配。
- 已知任务可提前准备其确定的环境；Evaluator 在补丁、snapshot 和评测身份绑定完成后才进入可执行状态。
- 池未命中时，使用同一受控容量与干净环境创建路径；记录命中、未命中、等待和准备失败。

### R4. 已使用容器重置复用

- Worker、Evaluator 分别完成“领取 → 执行 → 重置 → 验证 → 再次领取”，并保留相同物理容器 ID 的跨租约证据。
- 复用发生在兼容环境身份内；角色和不兼容任务环境分别管理。
- 对全部可变位置形成清单：工作树及 Git 状态、未跟踪文件、可写依赖与缓存、临时目录、子进程、输入、输出和评测证据。
- 只读依赖验证身份；可写依赖恢复基线。任务文件、进程和缓存残留测试验证下一租约获得干净环境。
- 重置后有机械校验结果；失败或无法确认的容器进入隔离并销毁，后续任务从干净环境获得替代资源。
- 准备、重置及失败替代的成本全部进入耗时与资源报告。

### R5. 评测一致性与证据归属

- 固定任务、base commit、补丁及正式 harness 下，各运行模式的 resolved、F2P、P2P 和终止分类与基线一致。
- 每份产物绑定实际 run、attempt、snapshot、租约和环境身份；重复请求不能覆盖已发布结果。
- Worker 与 Evaluator 的输入、输出及私有数据保持角色隔离。上一任务的状态不能进入下一任务的执行或报告。
- 池保留资源有明确归属和干净状态证据；游离容器、卷、失效租约及未归档产物的数量为零。

### R6. 取消、故障与恢复

- 排队、预热、执行、重置各阶段取消后，资源、队列和租约可核对；取消影响限定于对应任务。
- Controller 在这些阶段重启后能恢复已知状态，拒绝失效租约，处理未完成操作并回收未知状态资源。
- 预算预约、结算与结果发布保持幂等，未知用量按现有保守记账规则处理。
- 超时、OOM、准备失败、重置失败和产物 ACK 中断均有定向故障测试和处置证据。

### R7. 可复现的性能收益

- 使用冻结任务、已有补丁、相同机器资源与镜像身份，比较串行按需、并发按需、并发预热池、并发重置复用四种模式。
- 同时覆盖同环境重复任务和不同环境任务，固定任务顺序、重复次数、并发数和冷／热条件。
- 主指标为批次总耗时、任务准备延迟和吞吐量；同时报告排队延迟、p50/p95、重置耗时、命中率、峰值资源和失败率。
- 从启动准备到最后产物归档计量完整批次；预热、重置、失败重试及空闲资源消耗纳入报告。
- 数值门槛在 WF1 基线测量后、性能实现前写入本规格。WF1 未冻结门槛时不能完成；后续降低门槛需要用户明确确认。
- 未达到冻结性能门槛时，保留完整结果并继续定位；最终验收保持未通过。

### R8. 工程交付

- 修改的定向测试通过，代码变更后的仓库 `npm run check` 无错误、警告或 info。
- 提供运行配置、容量与池生命周期说明、故障恢复步骤、基准入口和报告。
- 基线已有检查失败在 WF1 留存原始输出、原因与修复范围。修复作为当前工作流的必要前置记录，不能通过忽略或降低检查标准完成验收。

## 4. 一次执行一个工作流

每轮采用以下流程：

```text
读取本规格与进度
  → 核对 skill 基线、工作区与前置工作流
  → 记录本轮唯一 workflow ID、范围和验收清单
  → 实现与定向验证
  → 保存验收证据
  → 更新进度、遗留问题和下一工作流
  → 汇报并结束本轮
```

执行规则：

1. 每次用户启动工作时，只处理指定工作流。用户说“继续”时，优先恢复状态为 in_progress 或 blocked 的 `active_workflow`；当前无未完成工作流时，才启动 `next_workflow`。
2. 一个工作流内可包含必要子步骤，验收后结束本轮；下一工作流由下一次用户指令启动。
3. 修改范围以当前工作流为界。发现必须提前处理的依赖，先在本文件记录原因、必要范围与对应要求，再处理该前置问题。
4. 验收失败继续修复当前工作流；外部条件缺失时记录阻塞、已完成部分和恢复入口，保持该工作流未完成，并保留 `active_workflow`。验收完成后清空 `active_workflow`，将 `next_workflow` 更新为后继工作流；WF7 完成后两者均为空。
5. 工作流完成以验收证据为依据。编码结束、部分测试通过或单次性能提升都不能单独完成验收。
6. 每轮更新同一份进度，保留历史验收记录；新增方向与最终范围调整先更新规格并取得用户确认。
7. 提交和推送按仓库规则及用户指令执行。每轮进度记录实际 commit；未提交时记录工作区路径与明确文件列表。

## 5. 顺序工作流

### WF0：确认最终目标与执行约定

交付本规格、顺序工作流和 `AGENTS.md` 入口。

验收：用户确认已用容器重置复用纳入最终交付；开发基线、角色范围、单工作流执行方式与后续验收条件已记录。

### WF1：计时基线与实验冻结

范围：在现有执行链路补充分段计时和资源观察，建立固定补丁基准输入；完整复现已有检查失败并界定必要修复。

验收：

- 记录排队、镜像校验、容器创建／启动、helper／kernel／输入准备、验证执行、清理和归档时间，区分 Worker 与 Evaluator。
- 持续时间使用单调时钟；并行阶段分别报告，不把重叠时间简单相加为总耗时。
- 基准 manifest 固定任务、补丁哈希、环境锁、资源、重复次数、样本顺序及冷／热操作；性能基准使用固定补丁回放。
- 基线原始数据和报告可重复生成；失败样本进入报告。
- 冻结准备延迟改善、吞吐量改善及资源上限的具体门槛，并填入第 6 节。
- 新增／修改的定向测试与 `npm run check` 通过。

后继：WF2。

### WF2：有界并发与账本协调

范围：批次调度、Controller 容量、锁粒度、journal 写入顺序、预算与产物协调。

验收：

- 两个真实运行时任务有执行重叠；同一 attempt 的冲突操作确定性排序。
- 容量满时队列和资源数受限；取消等待任务不会损伤正在执行的任务。
- 并发预约、结算、journal 和账本落盘通过竞争测试，结果按对应身份发布。
- 定向测试、两任务运行时验证和 `npm run check` 通过。

后继：WF3。

### WF3：环境预热与一次性 Worker 池

范围：根据已知任务队列提前准备可信镜像和 Worker，完成就绪检查、容量管理、领取和用后清理。

验收：

- 同一环境的重复准备请求合并；环境身份不匹配时拒绝分配。
- 任务从 ready Worker 领取唯一租约；预热、空闲和执行资源均计入总容量。
- 首版 Worker 使用一次后清理，任务取消、池过期和准备失败均可回收。
- 命中、未命中和提前准备成本可测量；定向测试、真实 Docker 验证和 `npm run check` 通过。

后继：WF4；最终交付继续包含 WF5 的已用容器复用。

### WF4：Evaluator 预热池与清理契约演进

范围：正式评测的准备链路、可信输入绑定、Evaluator 预热池及对应审计／恢复协议。

验收：

- 明确哪些步骤可提前准备、哪些步骤依赖 snapshot；物理挂载与命令绑定符合实际 Docker 生命周期。
- Worker 租约结束与任务清理证据通过后，Evaluator 绑定精确补丁和评测身份执行。
- 相同输入在按需与池化路径的正式评测结果一致；私有数据、产物及角色隔离测试通过。
- 池生命周期和零游离资源可验证；定向测试、真实 Docker 验证和 `npm run check` 通过。

后继：WF5。

### WF5：Worker 与 Evaluator 已用容器重置复用

范围：可变状态清单、重置策略、验证、租约代次、隔离淘汰和跨租约结果归属。

验收：

- 两类角色分别完成至少两次租约执行，证据显示复用了同一物理容器。
- 在兼容环境内执行 A → B → A 测试，注入工作树、未跟踪文件、可写依赖、缓存、临时文件、残留进程及评测输出污染，并验证清除。
- 已结束租约的请求与结果不能作用于新租约；不同环境和角色不能错误匹配。
- 重置失败进入隔离并销毁，通过干净替代路径继续后续任务；污染测试和评测结果一致性通过。
- 两类角色的重置耗时单独记录；定向测试、真实 Docker 验证和 `npm run check` 通过。

后继：WF6。

### WF6：故障注入与重启恢复

范围：在完整并发、预热和复用链路上验证超时、取消、OOM、进程崩溃、重启及 ACK 中断。

验收：

- 排队、准备、执行、重置和归档阶段均覆盖对应故障。
- 恢复后租约、池容量、预算和产物能核对；未知状态资源隔离回收，其他任务能继续执行。
- 重复恢复与重试不会重复结算、覆盖产物或交叉重放任务操作。
- 定向故障测试、真实 Docker 验证和 `npm run check` 通过。

后继：WF7。

### WF7：对照评测与最终交付

范围：按 WF1 冻结实验比较四种模式，产出性能、正确性、资源和故障结果；完善运行说明。

验收：

- R1–R8 均有对应证据；WF1 冻结的性能与资源门槛通过。
- 四种模式使用相同任务、补丁、资源与镜像身份；完整保留失败、池未命中和重置替代的结果。
- 交付逐任务与整批报告、原始制品、可重复命令、已用容器复用证据及故障恢复说明。
- 更新最终状态并明确已实现能力、观测收益、适用任务和资源条件。

后继：本次迭代完成。

## 6. 性能验收冻结区

在 WF1 完成前填写全部项目，后续对照实验使用相同配置：

| 项目 | 冻结值 |
| --- | --- |
| 基准 manifest 路径与哈希 | `packages/repofixlab/configs/benchmarks/docker-v1/manifest.json`；文件 SHA256 `82cbd68f78459ef81f84146125be25addb54a54a706bc5ae66730c755800e9a6`；canonical SHA256 `0470c259c51950f7f958e37ff8ee6404f0d6f7d1977b5f0e2e0e0f576c80adb2` |
| 宿主机配置与总资源上限 | Docker 29.3.1、Linux/amd64、12 CPU、WSL 配置内存 20 GiB；Engine 实际报告 20,972,773,376 字节。运行预算总计 10 CPU、18 GiB，包含 Controller、Worker、Evaluator、预热／空闲池及全部 helper。Controller 1 CPU／512 MiB，角色环境保持冻结的 4 CPU／8 GiB／PID 512。manifest 中 `docker_memory_bytes` 表示 WSL 配置上限；实测 Engine 信息保存在 `engine-baseline.json` |
| 同环境／不同环境任务集合 | same：Preact 4316 → Preact 4316；mixed：Preact 4316 → Axios 6539。Preact 回放成功补丁，Axios 回放空补丁；两个补丁 SHA256、base commit、准确镜像 ID 和环境锁见 manifest |
| 并发数、重复次数与运行顺序 | 基线串行；后续模式并发上限 2。重复 3 轮，共 12 个样本；先轮次，再 same／mixed，再声明的任务顺序。失败保留；重试另记样本和成本 |
| 冷／热条件及操作 | 镜像已缓存；每个样本新建 Worker、Evaluator。第 0 轮 first_pass，第 1、2 轮 repeated；宿主页面缓存自然变化。后续预热与重置在同一批次计时边界内执行 |
| 准备延迟指标与改善门槛 | 两组分别比较 Worker／Evaluator prepare 的 p50，最终复用模式各项至少降低 30%；p95 各项不超过基线的 1.05 倍。same 基线 p50 为 5.275753472／12.405969307 秒，p95 为 6.606043995／14.416612026 秒；mixed 基线 p50 为 6.7388369995／12.364291267 秒，p95 为 16.227909453／13.793841114 秒 |
| 吞吐量指标与改善门槛 | 最终复用模式整批吞吐至少为基线的 1.20 倍；same 活动区间吞吐至少 1.30 倍，mixed 至少 1.15 倍。基线分别为整批 0.6336341526062844、same 1.25623619418446、mixed 0.4241039145083294 个完成任务／分钟。整批计时从后端初始化前至最后归档、清理及采样收尾；队列、提前准备、重置、失败替代均计入。各组活动区间使用并集，整批使用完整墙钟 |
| 资源消耗和失败率上限 | CPU／内存预算与峰值上限为 10 CPU／18 GiB；预留与实际用量分别报告。基础设施失败率 0%，固定输入正式评分一致率 100%，游离容器／卷／租约 0；基准保留所有失败和未执行样本。未来状态转换的资源预算须先准入再启动，不能以采样时尚未达到峰值作为准入依据 |
| 采样与结果一致性判定规则 | 单调时钟纳秒区间，nested／overlap 按并集计算；p50 为 median，p95 为 nearest-rank，未开始阶段单列。CPU／内存每 0.5 秒采样，精确 create／start／remove 事件覆盖短命 helper 和未启动 initializer。检查 resolved、F2P、P2P、status_map_sha256 及 run／attempt／job／任务／补丁／base 归属；归档核对文件和集合哈希后 ACK |

冻结于 2026-10-11，真实串行基准完成之后、WF2 开始之前。后续降低门槛或变更冻结资源／任务条件需用户明确确认。WF2–WF6 逐项交付能力并记录指标；以上性能门槛在 WF7 的四模式对照中验收。

控制面镜像固定为 `sha256:25a2af725976fcef1360225f4ae4a6fe4a2d40ff7d93de2c74d6566bf468e986`，作为预先部署的测量平台；Docker CLI 创建该平台容器的宿主耗时在批次计量边界外。提前准备 Worker／Evaluator／helper 的全部成本位于批次计量边界内。

## 7. 进度与恢复入口

### 7.1 当前状态

- `spec_revision`：1.8。
- `baseline_commit`：`be8cb251b170801cfc5ceec431193d6ac5bb56be`。
- `active_workflow`：无。
- `next_workflow`：无。
- `open_decisions`：无。
- `last_updated`：2026-10-12。
- `workspace`：`E:/pi`，分支 `docker`，从冻结的 `codex/skill` 基线创建。
- `uncommitted_files`：WF1–WF7 的改动均未提交；本次迭代 62 个文件的完整清单与哈希见 `artifacts/docker-wf7/validation.json`，此前历史快照保留在各自 validation 中。WF7 修改 13 个文件，其余 49 个前置文件哈希保持不变；没有创建提交。

| 工作流 | 状态 | 验收证据 | 完成日期 |
| --- | --- | --- | --- |
| WF0 | completed | 用户在本次会话确认已用容器复用纳入最终交付；本规格与 AGENTS 入口 | 2026-10-11 |
| WF1 | completed | 12 个真实 Docker 样本、931 个计时区间、84 个任务容器的完整生命周期；固定输入、性能门槛、20 项 Python／174 项 TS／2 项检查回归通过 | 2026-10-11 |
| WF2 | completed | 12 个真实 Docker 样本、6 组 Worker 验证重叠、105 个持久操作；27 项 Python／186 项 TS／2 项检查回归通过 | 2026-10-11 |
| WF3 | completed | 12 个真实 Docker 样本、9 次池命中、1093 个计时区间；44 项 Python／32 项 TS／2 项检查回归及 2 项真实 Docker 清理验证通过 | 2026-10-11 |
| WF4 | completed | 12 个真实 Docker 样本、6 次 Evaluator 命中、6 次准备交叠；56 项 Python／32 项 TS／2 项检查回归及 2 项真实 Docker 清理验证通过 | 2026-10-11 |
| WF5 | completed | 12 个真实 Docker 样本；两角色同容器 A → B → A 污染清除及重置失败替代；66 项 Python／32 项 TS／2 项检查回归通过 | 2026-10-11 |
| WF6 | completed | 24 个真实 Docker 故障场景、302 条操作日志、7 组评分产物；81 项 Python／34 项 TS／2 项检查回归通过 | 2026-10-11 |
| WF7 | completed | 四模式 48 个样本评分一致、11 项性能门槛通过；最终 24 个 Docker 故障场景、真实污染隔离、131 项定向测试及 R1–R8 审计通过 | 2026-10-12 |

### 7.2 每轮验收记录模板

每次执行工作流时在本节追加一条记录，并同步当前状态和状态表：

```text
workflow_id:
spec_revision:
status: in_progress / blocked / completed
started_at:
completed_at:
workspace_and_branch:
commit_or_uncommitted_files:
scope_and_required_prerequisites:
acceptance_results: 逐项列出要求、结果及证据
evidence_paths_and_hashes:
checks_and_tests: 命令、结果、原始输出位置
remaining_issues:
next_workflow:
resume_action:
```

恢复时先核对实际代码和制品，再读取该记录。只有前置工作流验收完整且状态为 completed，才能开始下一工作流。

### 7.3 WF1 前置问题：恢复原 Docker 数据盘

- 用户于 2026-10-11 指示先解决 Pi 容器在 Docker Desktop 中不显示的问题，再继续 WF1。
- 恢复前 Docker Desktop 的 `CustomWslDistroDir` 为 `E:/WSL2/DockerDesktopWSL`，数据盘创建于 2026-09-14，含 13 个 MCM 容器，其中 7 个正在运行。
- 原数据盘位于 `E:/WSL/DockerDesktopWSL/disk/docker_data.vhdx`，大小 180.39 GiB，恢复前最后写入为 2026-09-10。只读解析已确认其中有 60 个容器（28 个 RepoFix）、57 个数据卷，包含原数据集卷、Controller 候选目录与工作卷。
- 两个数据盘的 Docker engine ID 不同。当前问题已定位为 Desktop 使用另一套数据目录；原 RepoFix 数据仍在旧盘中。
- 只读检查进一步核对了冻结配置中 26 个任务的 Worker、Evaluator、官方源镜像身份文件，共 78 项，其 SHA256 全部匹配；镜像完整性与 Engine 可用性在切换后继续验证。
- 证据：`artifacts/docker-wf1/docker-old-disk-inventory.json`、`artifacts/docker-wf1/docker-desktop-recovery/current-engine-before.json`、`artifacts/docker-wf1/docker-desktop-recovery/settings-before.json`。
- 恢复范围：正常停止 Desktop，冷备份当前 MCM 数据盘与配置，将 `CustomWslDistroDir` 指向原目录，重新启动并核对容器、镜像与数据卷身份。保留两套数据盘，恢复失败时使用原配置切回 MCM。
- 用户已确认“现在切回 Pi”。2026-10-11 已正常停止 Desktop，完成 MCM 冷备份并切回原目录，Desktop 重新启动成功。当前配置的 `CustomWslDistroDir` 为 `E:/WSL/DockerDesktopWSL`。
- MCM 冷备份位于 `artifacts/docker-wf1/docker-desktop-recovery/cold-backup-20261011-102546/`，包含配置、数据盘和内核盘；两个磁盘副本的 SHA256 均与源文件一致。原 MCM 数据目录保留。
- 内核盘首次备份期间仍被异步关闭的 WSL 占用；确认 WSL 停止后重新复制并通过哈希核对，随后才修改数据目录配置。
- 切换后 Engine ID 为 `380d8f76-b103-4b17-a9f0-c3ce41e95df6`，与旧盘一致。Engine 识别 60 个容器、169 个镜像、57 个数据卷；60 个容器 ID 和 57 个卷名与恢复前清单无差异。26 个任务涉及的 78 项冻结镜像 ID 均通过 `docker image inspect`。
- 原 RepoFix 容器目前为停止状态，历史任务容器保留。恢复验收为容器、镜像、数据卷身份与 Engine 可用性；运行时基准验证在 WF1 中继续执行。
- 恢复证据：`artifacts/docker-wf1/docker-desktop-recovery/restored-engine-verification.json`、冷备份目录中的 `backup-hashes.json`、`recovery-execution.log` 和 `recovery-resume.log`。回到 MCM 时先正常停止 Desktop，再将 `CustomWslDistroDir` 改回 `E:/WSL2/DockerDesktopWSL` 并启动；无需覆盖任何数据盘。
- Docker 数据盘恢复前置问题已完成。恢复完成时 WF1 为 `in_progress`，随后继续分段计时、固定补丁基准及基线检查修复；最终验收见 7.5。

### 7.4 WF1 检查前置修复范围

- 原始 `npm run check` 输出保留于 `artifacts/docker-wf1/check-baseline.log`：Biome 自动格式化 19 个文件并报告 4 项 `useTemplate` info；依赖检查随后因 `.repofixlab-cache/llama.cpp` 的外部清单失败。
- 依赖检查将按 Git 管理的文件及未忽略的新文件检查 package.json，保留新增直接依赖的精确版本要求，排除已经声明忽略的下载缓存。
- 本机现有 node_modules 来自另一套安装布局，根目录 Node 类型版本与根清单、对应 undici-types 不匹配。使用支持当前 npm 配置的独立 npm 工具，执行 `npm ci --ignore-scripts`，按已有锁文件恢复安装；不修改类型检查标准。
- 3 处既有 lint info 作等价模板字符串调整，并运行受影响的定向测试；其余长原始字符串在按锁文件恢复的 Biome 下通过检查。自动格式化改动归档为检查前置修复，最终文件清单与验证结果在 WF1 验收记录中列出。
- 相对导入检查也误扫了 `.repofixlab-cache`。两项检查统一检查 Git 已跟踪文件及未忽略的新文件；用临时 Git 仓库验证缓存排除、新文件和已跟踪文件的违规仍被拒绝。
- 按锁文件安装后，根类型检查发现 RepoFix 旧测试夹具缺少新接口字段：M7 CLI 注入、read/edit 元数据、七阶段 completion、V0/V1/V2 验证目录与反馈、M4 汇总及异步 stream 返回值。本轮只同步测试夹具和断言，保留生产接口和检查规则。Controller 的旧 Docker fake 同步 read 元数据。
- Windows 上的目录 `fsync` 不支持现有制品持久化测试。使用恢复镜像 `repofixlab-orchestrator` 在 Linux 中挂载只读源文件运行定向测试；在现有 `repofixlab-controller:runtime-test` 中运行 Python 定向测试。未改动持久化实现。
- 已有测试结果：TypeScript 19 个定向文件、174 项通过；Python 计时、固定回放、Docker 后端、服务定向测试通过。最终日志与新增加的操作 ID 冲突回归结果在验收记录补齐。
- 第一个完整基准尝试在第二个任务遇到回放脚本 operation ID 冲突。失败样本与报告保留于 `artifacts/docker-wf1/baseline-1/`；脚本改用逐 attempt 前缀，新增跨任务冲突回归测试。正式固定输入基准继续于 `baseline-2/`，不覆盖已有结果。

### 7.5 WF1 验收记录

- `workflow_id`：WF1；`spec_revision`：1.1；`status`：completed；完成于 2026-10-11。
- 工作区：`E:/pi`，分支 `docker`，HEAD 保持冻结的 skill 基线 `be8cb251b170801cfc5ceec431193d6ac5bb56be`。全部改动未提交、未推送；明确文件列表及文件哈希见 `artifacts/docker-wf1/validation.json`。
- 范围：可选单调时钟计时、SDK 观察器、固定补丁回放、资源和制品核对、性能门槛冻结；必要检查修复见 7.4。运行时原有串行锁、可信环境锁、安全配置、快照／正式评测／ACK 契约沿用。
- 分段计时验收通过：931 个区间记录了队列、镜像、容器 create／start、卷、Worker helper 注入、Evaluator kernel／私有任务／输入准备、验证、正式 grading、清理、归档；角色、父节点、区间边界及持续时间全部通过核对。报告提供角色、同／不同环境、first_pass／repeated 分组。
- 固定输入验收通过：两类环境、准确镜像、任务锁、base commit、补丁和 edits 文件哈希在 manifest 冻结。运行使用 Controller 生产服务和后端；快照字节哈希与固定补丁相同。
- 基准验收通过：12/12 样本完成，基础设施失败 0，清理全部通过。整批耗时 1136.302386856 秒，吞吐 0.6336341526062844 个任务／分钟。same 的任务活动区间为 286.570313502 秒，mixed 为 848.848566789 秒。
- 评分一致性验收通过：9 个 Preact 样本全部 resolved=true，F2P 1/1、P2P 10/10；3 个 Axios 空补丁样本全部 resolved=false，F2P 0/1、P2P 0/0。每类任务的 status_map_sha256 一致，归档文件与集合哈希、run／attempt／job／任务／base／补丁身份全部通过核对。
- 资源观察验收通过：任务链路创建 84 个容器，其中 72 个启动、12 个 kernel initializer 未启动；全部移除。包括 Controller 和 helper 的预留峰值为 7 CPU／12.5 GiB；采样峰值 CPU 4.5511 核、内存 2,462,724,096 字节；采样累计 CPU 563.851 秒。实际采样可能遗漏短峰，准入不能依赖事后采样。initializer 的未设置资源限制在原始数据保留，WF2 要求统一管理所有 helper。
- 零残留验收通过：WF1 attempt 标签对应的容器和卷均为 0，Engine 回到原有 60 个容器、57 个卷。历史数据保留。
- 报告复现验收：`--report-only` 在无 Docker socket 的镜像中读取保存的 manifest 和 raw.ndjson，重复生成 report.json；文件哈希一致。失败批次和试跑结果保留，默认报告包含失败及未执行数。
- 前置试跑记录：pilot-1 因旧配置内核哈希失败，pilot-2 因源目录缺少共享 DatasetLock 失败；核对实际内核与恢复镜像一致后固定聚合哈希，使用冻结镜像的共享运行锁。pilot-3 的 Preact 3345 历史补丁评分与其历史证据同为 unresolved；pilot-4 改用历史成功的 Preact 4316 补丁并通过。正式基准的任务集合在首次完整执行前冻结。
- 检查／测试：`npm run check` 无错误、警告、info，且最终运行没有格式化改动；`node --test scripts/check-repository-scope.test.mjs` 2 项通过；Controller 20 项定向测试通过；19 个 TS 定向文件共 174 项通过。仅格式化的旧 `m1-faux-docker-e2e.ts` 按原有开关加载，1 项默认跳过；真实 Docker 验证由上述固定回放基准完成。
- 制品：`artifacts/docker-wf1/baseline-2/raw.ndjson` SHA256 `fed9ea39d16b00f6dae2ae4e5df57d05d9816d1a5b4f1a0db27e1fd8cdc9a52e`；`report.json` SHA256 `3e4e98b4a7611da66eeeeceb8c96c45696ca914c62b9a7b272fd97604e739a40`；核对结果 `acceptance-audit.json`；检查输出 `check-final.log`、`python-tests.log`、`check-scope-tests.log`、`faux-test-load.log`。
- 性能冻结验收通过：第 6 节全部项目已填写，性能实现尚未开始。
- `remaining_issues`：WF1 无未完成项。阶段预算、并发、预热、已用容器复用及故障恢复按 WF2–WF7 推进。
- `next_workflow`：WF2；恢复动作：完整读取本规格，核对 `docker` 工作区、WF1 制品和文件列表，开始有界并发、各阶段资源准入与全局账本协调。

### 7.6 WF2 验收记录

- `workflow_id`：WF2；`spec_revision`：1.2；`status`：completed；开始、完成于 2026-10-11。
- 工作区：`E:/pi`，分支 `docker`。已核对 WF1 的 44 个文件哈希与基准报告哈希，均与验收记录一致；沿用未提交的 WF1 改动。
- 范围：批次有界调度、Controller 容量与 attempt 锁、journal 顺序、阶段资源准入、全局 token 账本持久化、结果归属。
- 验收清单：两个真实任务执行重叠；同 attempt 操作排序；队列和资源受限；排队取消隔离；预算、journal 与结果发布竞争测试；定向测试及 `npm run check`。
- 资源条件沿用第 6 节：10 CPU／18 GiB 总预算，Controller 与全部 helper 计入；Worker／Evaluator 各 4 CPU／8 GiB。
- 实现约定：批次最多保留 2 个执行中的 Promise；Controller 默认 2 个 attempt 槽位、2 个等待位置。每个 attempt 按请求登记顺序执行，读取与 ACK 共用该 attempt 的锁；journal 的追加与 hash chain 单独串行持久化。
- 阶段准入：Worker 预约 4 CPU／8 GiB，销毁并核对零残留后释放；M6 Evaluator 预约 6 CPU／12 GiB，覆盖 4 CPU／8 GiB 的 Evaluator 与 2 CPU／4 GiB 的 finalizer，ACK 或恢复清理通过后释放。当前预算允许两个 Worker 并行，Evaluator 阶段排队。未启动 kernel initializer 也设置 2 CPU／4 GiB 限制并计入阶段预约。
- 取消约定：排队取消先唤醒对应 attempt 的容量／资源等待，再按该 attempt 顺序执行清理；其他 attempt 继续。等待超时使用单调时钟，默认上限 300 秒。
- 全局账本与批次状态：各自使用进程内串行写入队列，保证检查、余额变更、追加及 fsync 的顺序；进程间 owner／writer lease 沿用。临时预算不足时等待执行中的结算，再判断后续准入。
- 停止与取消：批次取消只终止尚未启动的任务，已启动任务完成并结算；前置准备失败触发停止派发时，退回尚未交付 executor 的预约，再等待所有已启动任务结束后释放进程租约。
- 必要调用链修复：Worker 准备／资源排队失败可能发生在 lease 返回之前，M4 也须调用 attempt abort；M7 的 Evaluator 阶段失败须完成对应 attempt 的清理请求并保留已知 Provider 用量。该范围用于回收 WF2 新增的容量与阶段预约，沿用现有 abort 契约。
- 并发验收通过：`artifacts/docker-wf2/concurrent-1/` 的 12/12 样本完成，1036 个计时区间通过角色、父节点和持续时间核对。六组两个 Worker 的实际验证均有重叠；same 三轮重叠分别为 21.8078、22.2037、22.0000 秒，mixed 为 9.6580、19.9044、20.1397 秒。
- 排序与 journal 验收通过：210 个连续 hash chain 事件对应 105 个 accepted／completed 操作；不同 attempt 的操作同时进行，同一 attempt 的操作保持顺序。并发预约／结算、未知用量、容量满、取消、超时、准备失败清理和停止派发期间的预约退回均有竞争或调用链回归。
- 评分与归属验收通过：9 个 Preact 成功补丁样本和 3 个 Axios 空补丁样本的 resolved、F2P、P2P、status_map_sha256 全部与 WF1 相同。12 个 Worker lease、job、evaluation 身份独立；run／attempt／任务／base／补丁绑定、每份归档文件 SHA256、集合哈希和对应 ACK 全部通过核对。
- 资源与清理验收通过：84 个任务容器创建、72 个启动、12 个未启动 initializer，全部移除且全部设置 CPU、内存和 PID 限制。包含 Controller 与 helper 的预约峰值为 9 CPU／16.5 GiB；采样峰值为 8.5702 CPU 核、5,093,629,952 字节，累计 CPU 545.698 秒。原有 60 个容器的 ID／名称／镜像／状态及 57 个卷名均与运行前一致，新增游离容器／卷为 0。
- 性能记录：整批耗时 971.965999744 秒，较 WF1 降低 14.46%；吞吐 0.740766652526566 个任务／分钟，为基线的 1.1691 倍。same 活动区间 207.447115887 秒，吞吐 1.7353820440487502，为基线的 1.3814 倍；mixed 活动区间 763.715160141 秒，吞吐 0.47137993166658554，为基线的 1.1115 倍。
- 排队观察：prepare 包含资源等待。same 的 Worker p50／p95 为 7.3408／13.7229 秒，Evaluator 为 22.1708／29.9008 秒；mixed 分别为 6.3095／18.1063 和 114.8150／209.0569 秒。mixed 较早完成的 Worker 等待较长验证任务释放资源；后续预热设计沿用总预算并保留这部分成本。第 6 节最终复用性能门槛继续在 WF7 验收。
- 检查／测试通过：27 项 Python、20 个文件共 186 项 TypeScript、2 项检查回归，共 215 项；`npm run check` 无错误、警告、info，最终运行无格式化改动；`git diff --check` 通过。M7 失败清理测试用持久 token ledger 核对保留用量，全部模型会话使用 faux provider。TS 测试在只读源码的 Linux 镜像中运行，配置缓存 tmpfs 使用可写的 1777 模式。
- 基准证据增加执行模式、并发数、6 个 Python 运行时源文件哈希与持久 journal 副本。冻结 manifest、补丁、镜像及任务集合沿用 WF1。
- 报告复现验收通过：无 Docker socket 的 `--report-only` 重生成报告后 SHA256 不变。原始数据 SHA256 为 `4bb8cf600d779d65ebdff3baa3f9666aee87e4423d6a9aabbc1ff298b3cede9c`；报告为 `b6bba9e3a148b37756e530735c1cb6396b7d91fba9e38b550b19f2cf7b7684db`；journal 为 `8fcf75949de2dc745c855ce86fc1f2a2a7927671a25f3729bc564fb771b7c9c5`。
- 制品：核对结果 `artifacts/docker-wf2/concurrent-1/acceptance-audit.json`；可重复核对脚本 `artifacts/docker-wf2/acceptance-audit.mjs`；检查与测试输出 `check-final.log`、`python-tests-final.log`、`ts-tests-final.log`、`ts-regressions.log`、`ts-cleanup-tests.log`、`check-scope-tests.log`；重生成核对 `report-regeneration.log`。命令、明确修改清单及哈希见 `artifacts/docker-wf2/validation.json`。
- `remaining_issues`：WF2 无未完成项；WF3–WF7 保持 pending。全部代码与文档未提交、未推送，HEAD 沿用冻结的 skill 基线。
- `next_workflow`：WF3；恢复动作：完整读取本规格，核对 `E:/pi` 的 `docker` 分支与 WF2 validation／报告源文件哈希，开始可信环境预热与一次性 Worker 池，遵守第 6 节总预算及 WF2 阶段准入。

### 7.7 WF3 验收记录

- `workflow_id`：WF3；`spec_revision`：1.3；`status`：completed；开始、完成于 2026-10-11。
- 工作区：`E:/pi`，分支 `docker`，HEAD 保持 skill 基线。WF2 的 55 个文件哈希均已核对；原有改动继续保留。
- 范围：已知任务通过现有 preflight 提供可信 candidate／instance，异步准备 Worker；相同环境合并为一个准备请求，容量最多 2 个准备中／空闲 Worker。环境键绑定角色、准确镜像、candidate、任务锁、helper 和完整安全配置。
- 资源约定：预热先做非阻塞准入，资源不足时跳过，领取未命中走原有有界按需路径。领取时原子转移预约；Evaluator 准入前淘汰未领取的预热资源，避免空闲池占用资源造成等待。准备、空闲、领取、清理都计入同一预算。
- 生命周期：ready 必须通过容器策略、helper、工作树和 base commit 检查；物理资源保留不可变池归属标签，逻辑 attempt 映射至物理归属。任务取消、空闲过期、准备失败、关闭均清理；清理失败保留预约并阻止池继续分配。首次使用后销毁。
- 必要前置：池容器标签不能在 Docker 创建后修改，因此补充资源预约原子转移、池归属审计与服务关闭钩子；启动清理限定于当前 journal 对应的池命名空间。完整跨阶段故障矩阵仍在 WF6。
- 池命名空间在 journal 的独占 owner lease 下生成、fsync 并持久化，保证不同数据卷即使使用相同容器内路径也互相独立，重启时身份保持一致。
- 已知队列入口：现有 preflight 接受可信 candidate／instance，异步启动准备。Node 调用链在每个 attempt 的 preflight 开始预热；固定回放入口在派发前先 preflight 同一已知 cohort，并等待准备结束。未新增 HTTP 协议。Controller 默认池容量 2、空闲期限 120 秒，可通过环境变量调整；按需基准默认关闭池，正式 WF3 基准通过 `--worker-pool` 启用。
- 功能验收通过：相同环境准备合并；并发领取使用独立物理 Worker 和 lease；领取复查实际镜像、安全策略、helper、干净工作树和 base；取消、空闲过期、准备失败、脏清理阻塞、关闭和限定命名空间的启动清理均有定向回归。取消一个共享准备请求保留其他任务的准备兴趣。
- 固定输入与评分验收通过：`artifacts/docker-wf3/worker-pool-1/` 的 12/12 样本完成，9 个 Preact 成功补丁和 3 个 Axios 空补丁样本的 resolved、F2P、P2P、status_map_sha256 全部与 WF1 相同；run／attempt／任务／base／补丁、12 个独立 lease／job／evaluation、归档文件及集合哈希均通过核对。
- 池命中验收通过：准备 9 个 Worker，合并 3 次，命中 9 次、未命中 3 次，命中率 75%。每轮 same 的两次请求合并为一个准备，另一次走冷路径；mixed 的两个不同环境各准备一个 Worker。9 个命中的物理容器均只有一次领取和一次最终销毁，首次使用后复用继续在 WF5 实施。
- 计时与排序验收通过：1093 个区间的父节点、角色、持续时间和完成状态有效；六组实际 Worker 验证都有重叠。journal 的 210 个连续 hash chain 事件对应 105 个操作，不同 attempt 同时执行，同一 attempt 保持排序，ACK 与对应产物绑定。
- 资源与零残留验收通过：84 个任务容器创建、72 个启动，包含 12 个未启动 initializer；全部有资源限制并最终移除。包含 Controller 和 helper 的预约峰值为 9 CPU／16.5 GiB，符合 10 CPU／18 GiB 总预算；采样峰值 7.2846 CPU 核、4,241,948,672 字节，累计 CPU 546.281719 秒。最终池、预约、等待和领取映射均为空；Engine 保留原有 60 个容器、57 个卷，新增残留为零。
- 预热成本：9 次准备累计工作时间 64.148211536 秒，六组队列预热活动区间共 47.508158107 秒，全部计入批次计时。same 的领取阶段 Worker prepare p50／p95 为 3.1712／8.6750 秒，mixed 为 0.5186／0.6964 秒；WF2 分别为 7.3408／13.7229 和 6.3095／18.1063 秒。
- 完整性能记录：整批耗时 977.565476454 秒，吞吐 0.7365235550376764 个任务／分钟，较 WF1 耗时降低 13.97%；较 WF2 的 971.965999744 秒增加 0.58%，吞吐为 WF2 的 0.9943 倍。包括预热的 same／mixed 活动区间分别为 217.119620155／759.621555436 秒，吞吐分别为基线的 1.3199／1.1175 倍。领取等待降低，整批吞吐与 WF2 接近。WF7 的最终门槛保持冻结。
- 测量源码边界：正式 12 样本测量结束后补充两项清理修复：领取期间取消保留 `runtime_queue_cancelled` 分类，冷路径 Worker 登记关闭清理归属。两个回归在修复前失败、修复后通过，最终源码又通过两项真实 Docker 清理验证；正常评测路径沿用测量实现。测量时的两个模块保存于 `benchmark-sources/`，核对脚本分别验证测量哈希与最终源码哈希。
- 真实 Docker 清理验证通过：最终源码在领取预约转移期间注入取消，返回预期取消状态并清理；服务关闭回收仍在使用的冷路径 Worker 及全部卷。证据为 `artifacts/docker-wf3/lifecycle-probe.py`、`lifecycle-probe.json` 和日志。
- 检查／测试通过：44 项 Python、4 个文件共 32 项 TypeScript、2 项检查回归，共 78 项。`npm run check` 无错误、警告、info，且未格式化文件；`git diff --check` 通过。TS 使用 faux provider。两个新增清理回归的修复前失败日志保留为 `post-benchmark-regressions-before-fix.log`。
- 试跑记录：pilot-1／pilot-2 暴露镜像继承标签与管理标签的严格等值比较问题，改为验证可信管理标签集合并核对完整容器策略；失败试跑均清理通过。pilot-3 的 Preact 成功补丁评分及清理通过。试跑与正式基准分别归档。
- 报告复现通过：无 Docker socket 的 `--report-only` 重生成 report.json 后哈希相同。raw.ndjson SHA256 `4b5960122aa8a1d0720c42595cd737d3a157fcba87749c1761e4a6c2a224ffe9`；report.json 为 `daf5b2b6e4890aa2160da5ed16382cff9848248c5020e257986f0390fdf78452`；journal 为 `157fe77e8f77ae8a3b70aea90d4e1dbf41fe192100a29601a20224d256000673`。
- 制品：可重复核对脚本 `artifacts/docker-wf3/acceptance-audit.mjs`，核对结果 `worker-pool-1/acceptance-audit.json`，最终文件清单与命令 `validation.json`；检查、测试、试跑和正式测量日志保留在同一目录。
- `remaining_issues`：WF3 无未完成项。Evaluator 池、已用容器重置复用、完整故障矩阵与最终对照按 WF4–WF7 执行。全部改动未提交、未推送。
- `next_workflow`：WF4；恢复动作：完整读取本规格，核对 `E:/pi` 的 `docker` 分支、WF3 validation、测量源码快照与最终源码哈希，在现有预算与私有数据隔离约束下实施一次性 Evaluator 预热池。

### 7.8 WF4 验收记录

- `workflow_id`：WF4；`spec_revision`：1.4；`status`：completed；开始、完成于 2026-10-11。
- 已核对 `docker` 分支、skill 基线和 WF3 的 58 个文件哈希；沿用未提交改动，前置核对及源码快照保存在 `artifacts/docker-wf4/`。
- 可提前准备：可信镜像校验、独立 workspace／input／evidence 卷、任务专属只读私有材料、kernel 和待命 Evaluator。补丁及 run／attempt／job／evaluation 身份在 Worker 清理证明通过后领取时绑定。
- 触发与重叠：Worker 干净销毁且 snapshot 策略通过后，异步尝试预热该任务的 Evaluator；资源允许时与另一 Worker 的工作重叠，预算不足则走受控按需路径。基准使用这条生产触发链，记录实际重叠。
- 预算：待命 Evaluator 预约 4 CPU／8 GiB，准备 helper 依次运行并在启动待命容器前清理；执行前原子领取并扩展至 6 CPU／12 GiB，覆盖 Evaluator 与 2 CPU／4 GiB 的输入 staging／正式 grading helper。池默认容量 1，保证当前预算下阶段扩展可取得进展。阶段等待保留现有预约并支持取消，全部资源计入冻结总预算。
- 必要前置：扩展预约必须同时完成容量检查、逻辑归属转移和取消检查；保留资源的阶段在扩展可容纳时优先完成，避免冷路径队首依赖其释放而形成循环等待；新建阶段继续 FIFO 准入。池协调器增加角色参数，沿用 WF3 的一次性领取、过期和审计清理机制。
- 挂载与执行：创建时固定 workspace／evidence 可写、input／private 只读挂载；待命进程等待 Controller 原子发布的启动材料。领取后 staging helper 写入独立 input 卷，核对精确 patch SHA256，再发布可信命令，待命进程以原 PID 替换为正式 evaluator。
- 生命周期：首次执行后在对应产物归档、哈希核对及 ACK 后销毁；取消、过期、准备失败、关闭与启动恢复按池物理归属审计。Worker 清理证据与 Evaluator 预热归属分别核对。
- 验收清单：提前／依赖 snapshot 的步骤分离、资源扩展竞争与取消、私有数据及角色隔离、输入和评测身份绑定、唯一领取及失效请求拒绝、评分一致、实际预热重叠、池生命周期和零残留、定向测试与 `npm run check`。
- 定向测试通过：56 项 Python、4 个文件共 32 项 TypeScript、2 项仓库检查回归，共 90 项。覆盖待命空状态、精确输入与 job 身份绑定、幂等重放、Worker 清理门控、另一 Worker 运行期间的准备和扩容、取消、超时、冷路径回退、激活失败、过期、清理失败继续计费及禁用池后的命名空间恢复。镜像、内核、私有任务、命令、输入、证据或待发布激活文件漂移均拒绝领取。
- 仓库检查通过：`npm run check` 无错误、警告或 info，未格式化源码；`git diff --check` 通过。TS 模型会话使用 faux provider。
- 两项真实 Docker 生命周期验证通过：待命 Evaluator 在服务关闭时完整回收；扩容等待时取消返回 `runtime_queue_cancelled`，清理对应待命资源，保留另一个运行中的 Worker。等待期间预约保持 9 CPU／16.5 GiB，清理后仅留下 Controller 基础预约。最终实现哈希记录在 `artifacts/docker-wf4/lifecycle-probe.json`。
- 单样本 pilot-1 验证 Preact 成功补丁的待命准备、领取、官方评分及 ACK 清理；试跑与正式 12 样本测量分开归档。正式测量开始后保持实现不变，七个运行时模块哈希随报告保存。
- 正式评分与归属验收通过：12/12 样本完成，9 个 Preact 成功补丁及 3 个 Axios 空补丁的 resolved、F2P、P2P、status_map_sha256 均与 WF1 一致。12 个 Worker lease、job 和 evaluation 身份独立，快照／清理／激活／每份归档文件／集合哈希及 ACK 全部匹配。1174 个计时区间的父节点、角色、持续时间和完成状态有效；210 个 journal 事件形成连续 hash chain，对应 105 个确定顺序的操作。
- 池与交叠验收通过：Worker 池准备 9 次、命中 9 次、未命中 3 次；Evaluator 池准备 6 次、命中 6 次、未命中 6 次，命中率 50%，同环境合并 3 次，资源不足跳过 3 次。全部命中容器只有一次领取与最终销毁。6 次 Evaluator 预热与其他 Worker 验证实际交叠，共 46.676968502 秒；Evaluator 准备累计工作时间 67.465736271 秒，Worker 准备累计 61.609348359 秒、已知队列预热墙钟 45.955923335 秒，全部计入批次耗时。
- 资源与零残留验收通过：84 个任务容器创建、72 个启动及 12 个未启动 initializer 全部移除，均有资源限制。包含 Controller 和 helper 的预约峰值 9 CPU／16.5 GiB，采样峰值 6.3128 CPU 核、2,981,031,936 字节，累计 CPU 546.755889 秒。两个角色池、等待队列及领取映射为空，仅留下 Controller 基础预约。原有 60 个容器的 ID／名称／镜像／状态和 57 个卷名保持一致，新增残留为零。
- 完整性能记录：整批耗时 919.753305348 秒，吞吐 0.7828186056124898 个任务／分钟；较 WF1 耗时降低 19.06%，吞吐为基线 1.2354 倍；较 WF3 的 977.565476454 秒减少 57.812171106 秒（5.91%），吞吐为 WF3 的 1.0629 倍；较 WF2 耗时降低 5.37%。包含预热的 same／mixed 活动区间分别为 193.381703313／725.611802086 秒，吞吐为基线 1.4819／1.1698 倍。当前固定样本显示了准备交叠与整批耗时改善，第 6 节最终复用性能门槛继续在 WF7 验收。
- 等待观察：Evaluator prepare 包含待命领取、扩容等待和输入绑定，same p50／p95 为 18.1703／24.6304 秒，mixed 为 102.5878／186.2145 秒。另一 Worker 占用资源期间，待命环境保持计费；正式执行仍需满足完整阶段预算。已用容器的重置与再次分配在 WF5 实施。
- 报告复现通过：无 Docker socket 的 `--report-only` 重生成报告后 SHA256 不变。raw.ndjson SHA256 `fdc888e1b1d0c93d04f9b7b76207fd1029cb6af7c1e736b884d771c7f1fb0a77`；report.json 为 `930bb23488ef48484dd0fb5039800a28aac800c7a17a1d51fdec974c9ef1e9b1`；journal 为 `6372bfc0a2fda300a6ae6c63b59f5ea83eb8ade0408e8cf71029f9ce222dd521`。正式测量及真实清理验证的实现哈希与最终源码一致。
- 制品：`artifacts/docker-wf4/role-pools-1/` 保存全部样本、原始记录、报告、journal 和核对结果；可重复核对脚本 `acceptance-audit.mjs`，最终文件清单、哈希与运行命令 `validation.json`。检查、测试、试跑、生命周期验证及重生成日志保留在同一目录。
- `remaining_issues`：WF4 无未完成项。WF5–WF7 保持 pending；本轮只修改 12 个规格、运行时与测试文件，此前另外 47 个文件的哈希保持不变。全部改动未提交、未推送。
- `next_workflow`：WF5；恢复动作：完整读取本规格，核对 `E:/pi` 的 `docker` 分支及 WF4 validation／正式测量源码哈希，实施 Worker 与 Evaluator 已用容器的重置、验证、租约代次及跨租约隔离，保持冻结评分输入和总资源预算。

### 7.9 WF5 验收记录

- `workflow_id`：WF5；`spec_revision`：1.5；`status`：completed；开始、完成于 2026-10-11。
- 前置核对：`E:/pi` 的 `docker` 分支，HEAD 为冻结 skill 基线；WF4 的 59 个文件哈希全部匹配，原有改动保留。
- 范围：两个角色的已用容器停止、可写卷完整恢复、校验、停机池保留、再次领取；代次与清理证明；失败隔离；A → B → A 污染验证、评分一致性与完整计时。
- 必要契约演进：清理计数表示结束租约的游离资源；已验证的池资源转移至独立物理归属。清理响应附带持久化 release_evidence，绑定角色、容器、环境、attempt 与代次；服务仍须先完成 Worker 清理证明，再允许正式评测。
- 重置策略：先停止并核对容器退出，再使用冻结角色镜像中未挂载的原始目录恢复全部可写卷，逐树校验内容、类型、链接、权限与归属；完整恢复 Git、依赖及缓存。输入、证据清空；只读镜像及私有材料身份复查。启动同一容器时重新注入可信 helper/kernel，tmpfs 随停机清除，上一租约进程全部结束。
- 预算：运行及待命角色沿用 4 CPU／8 GiB。确认停机后预约缩至重置 helper 上限 2 CPU／4 GiB；helper 移除且恢复校验通过后，停机池预约为 0 CPU／0 内存，仍占池容量并受过期／关闭管理。领取先扩展至 Worker 4 CPU／8 GiB 或 Evaluator 6 CPU／12 GiB，再启动。所有准备、重置、校验、重启和替代均进入批次计时；总预算仍为 10 CPU／18 GiB。
- 验收清单：同容器跨租约、两角色 A → B → A 污染清除、旧租约／旧结果拒绝、环境与角色隔离、失败销毁及替代、机械校验、评分一致、预算与零游离资源、定向测试与 npm run check。
- 可变位置补充核对：实际 mountinfo 确认根文件系统、`/etc/hosts`／hostname／resolv.conf 只读；Docker 默认 `/dev`、`/dev/shm` 和 `/dev/mqueue` 由容器生命周期管理。A → B → A 验证额外注入共享内存文件、POSIX 消息队列及 Evaluator 的 `/dev` 文件，核对停机重启后的清除与 IPC namespace 隔离。挂载清单保存在 `artifacts/docker-wf5/mount-inventory-observed.json`。
- 已完成正式测量：`artifacts/docker-wf5/reuse-1/` 的 12/12 样本完成、评分与 WF1 一致、基础设施失败 0。整批耗时 976.786618012 秒，包含预热、重置、再次校验、重启、归档和收尾；较 WF4 增加 6.20%，较 WF1 减少 14.04%。Worker 10 次重置累计 122.947070937 秒，Evaluator 6 次累计 62.088268142 秒；两类重置失败均为 0。4 个 Worker 与 1 个 Evaluator 物理容器出现跨代次领取。
- 已完成工程检查：66 项 Python、4 个文件共 32 项 TypeScript、2 项仓库检查回归，共 100 项通过；`npm run check` 无错误、警告、info，未格式化源码；`git diff --check` 通过。测量时的 8 个运行时模块与当前源码、保存的 benchmark-sources 哈希相同。
- 真实隔离验收通过：`isolation-7/` 中 Worker 物理 ID `c31b87dac435449132b7f3160571f2412ff37f756dc5ffdcaf6ccf8da77462d0`、Evaluator 物理 ID `11b44df098bf7e31b1528b22180507d4d0cb66b78965e1db197166e457b7e8a8` 各完成代次 1 → 2 → 3。A 回放 Preact 成功补丁，B 回放空补丁，再次 A；两次 A 的 resolved=true、F2P 1/1、P2P 10/10、status_map_sha256 相同，B 为 resolved=false、F2P 0/1、P2P 10/10。
- 污染清除验收通过：三个租约均注入跟踪文件、`.git/config`／refs、未跟踪文件、可写 node_modules、缓存、`/tmp`、共享内存、消息队列、存活子进程及 Evaluator 输入／证据残留。下一租约验证完整树恢复、污染对象消失、进程结束；两个角色均为私有 IPC，与同时运行的 Controller 分离。工作树及依赖基线为 30,191 项、258,764,475 字节，恢复树身份与原始准确镜像一致。
- 租约与失败验收通过：服务拒绝结束租约的执行及结果读取；后端拒绝旧代次句柄。角色及不兼容环境键分别核对。两个角色各注入一次真实 reset helper 失败，响应为 quarantined_destroyed，原容器与全部所属卷不存在；Worker 替代环境执行 repo_list，Evaluator 替代环境完成正式评分与产物归档、ACK。
- 清理证明与预算验收通过：操作 journal 持久化 release_evidence 后才发布 ready；停机池保留独立归属且计算预约为零。1176 个计时区间、210 条 journal 记录及 105 个操作的 hash chain、顺序、输入和结果归属全部通过机械核对。6 组 Worker 验证实际重叠。85 个容器创建并全部移除，88 次 start 包含再次启动，16 次 stop 对应验证重置。包括 Controller 与 helper 的预约峰值为 9 CPU／16.5 GiB，采样峰值 6.4862 CPU 核、2,881,642,496 字节，累计 CPU 749.50659 秒。
- 零残留验收通过：正式批次及隔离验证关闭后，两类池、领取映射、代次、等待队列、额外预约均为零；保留 Controller 基础预约。Engine ID 与原 Pi 数据盘一致，原有 60 个容器的 ID／名称／镜像／状态、57 个卷名保持一致，镜像数仍为 169。
- 完整性能记录：吞吐为 0.7371108353893877 个任务／分钟，较 WF1 为 1.1633 倍。包含预热的 same／mixed 活动区间为 213.395111365／759.955553233 秒，吞吐为基线的 1.3429／1.1170 倍。same 的 Worker／Evaluator prepare p50 为 3.1335／15.8206 秒，p95 为 5.9757／24.0689 秒；mixed p50 为 8.7625／97.6655 秒，p95 为 21.5400／201.6470 秒。全树重置与再次校验增加了成本；当前整批及 mixed 吞吐、Evaluator 准备和 mixed Worker 准备尚未达到最终冻结门槛。逐项观测值与门槛保存在 acceptance-audit.json，最终性能验收仍在 WF7，门槛保持不变。
- 报告复现通过：无 Docker socket 的 `--report-only` 重生成后字节哈希不变。raw.ndjson SHA256 `5c35288beecf379208887524fef6127e1e9a3f48059ab991c2067cc3a83b2a60`；report.json 为 `78deb10ba844ac0f1d17e344936d86f293e2cc724d3afe6c76dc7c9523af6c91`；journal 为 `2cd1ee809dfda721a1ece7420f1d8a72c501fcd79dcacb29473b40cbb137f879`。最终源码、正式测量快照及隔离验证模块身份一致。
- 试跑记录：pilot-1 的成功补丁、评分、重置与关闭清理通过。早期污染脚本遇到 Worker 文件权限限制，改由已准入的可信 helper 注入卷污染；全部失败试跑清理通过。isolation-6 在污染对象已清除后，因要求不同生命周期的 IPC 编号不同而断言失败；isolation-7 使用实际私有配置、同时运行的 Controller 命名空间及残留对象清除验证隔离，通过全部 6 项检查。运行时实现在正式测量与最终隔离验证期间保持不变；原始失败记录全部保留。
- 制品：`artifacts/docker-wf5/reuse-1/` 保存逐样本输入、租约、snapshot、清理证明、激活、归档、ACK、报告、raw 和 journal；`isolation-7/` 保存最终 A → B → A 及失败替代证据。可重复验证脚本为 `acceptance-audit.mjs`、`isolation-probe.py`，完整文件清单／哈希／命令为 `validation.json`。检查、测试、试跑、挂载清单与报告重生成日志保留在同一目录。
- `remaining_issues`：WF5 无未完成项。WF6 的完整故障矩阵与重启恢复、WF7 的最终性能定位和四模式对照保持 pending。全部改动未提交、未推送。
- `next_workflow`：WF6；恢复动作：完整读取本规格，核对 `E:/pi` 的 `docker` 分支、WF5 validation、正式测量源码哈希和最终隔离证据，在现有并发、预热、复用与冻结预算内验证超时、取消、OOM、Controller 崩溃、重启及 ACK 中断。

### 7.10 WF6 执行记录

- `workflow_id`：WF6；`spec_revision`：1.6；`status`：completed；完成于 2026-10-11。
- 前置核对：`E:/pi`，分支 `docker`，HEAD 为冻结 skill 基线；WF5 的 61 个文件哈希全部一致，原有改动与真实 Docker 制品保留。核对记录为 `artifacts/docker-wf6/predecessor-verification.json`。
- 范围：排队、准备、执行、重置、归档阶段的超时／取消／OOM／崩溃／重启／ACK 中断，资源归属、代次、队列、预算和产物恢复；保持两角色池与已用容器复用开启。
- 验收矩阵：各阶段取消与 Controller 进程中断；Worker／Evaluator 准备失败和执行失败；真实 cgroup OOM 与有界超时；重置失败／中断；产物归档与 ACK 的持久化边界；重复恢复、原请求重放及交叉请求拒绝；其他任务继续执行与零新增残留。
- 实现：取消唤醒排队请求，并停止该任务物理归属下正在运行的容器与 helper；共享预热保留剩余任务的兴趣。创建前后检查阻止取消竞态留下新容器，取消中的 Docker 调用释放全局注册锁，其他任务可继续注册与执行。清理失败继续保留预约，审计通过后释放。
- 恢复：清理失败状态在后续启动重试，恢复操作身份绑定该 attempt 最新日志序号，成功恢复后解除历史准入阻塞；已恢复的中断操作还原为终态，重复启动不再清理或追加重复记录。旧租约／job 与交叉任务操作被拒绝。
- 日志：SIGKILL 造成的未完成末尾先经 fsync 与原子发布保存为带内容哈希的取证副本，再截断至完整校验前缀；支持空初始文件与 UTF-8 字节中断。完整记录的 JSON、哈希链或绑定损坏继续拒绝。实际 ACK 半写入强杀后恢复、取证与重放通过。
- 预算：取得独占账本写租约后，遗留预约按已有未知用量策略一次性保守计费，进入待核对状态；核对前暂停新的 Provider 准入。已完成任务与重复恢复均保持账本和结果字节不变。17 项新增回归覆盖这些缺口与租约、清理、OOM 归因。
- 真实崩溃验证方式：故障驱动器和 Controller 子进程运行于同一个受限控制容器，journal 位于父进程保留的 Linux 目录；SIGKILL 结束子进程，随后启动新服务读取同一 journal 与 Docker 归属。控制容器总计 1 CPU／512 MiB，角色与 helper 继续沿用冻结配置，总预算为 10 CPU／18 GiB。
- 真实故障矩阵通过：13 个 SIGKILL／恢复场景覆盖 Worker 排队、准备、执行、重置、停机容器重新领取，Evaluator 准备、执行、重置，归档后 ACK 前、ACK 持久化前后／响应后与日志半写入；8 个取消场景覆盖上述两角色阶段及重新领取；2 个角色均在原 8 GiB 上限触发实际 OOMKilled／137；执行与排队超时验证通过。两个并发 Worker 中取消一项后另一项继续执行。
- 证据审计通过：24／24 个场景；302 条连续哈希链记录、151 个操作，每个已接受操作恰有一个终态。7 组归档的 21 份评分文件及 7 份索引字节／集合哈希保持一致；Preact 4316 成功补丁评分仍为 F2P 1／1、P2P 10／10，测试状态映射 SHA256 与 WF5 相同。重复恢复、原请求重放、过期租约拒绝与跨 attempt 拒绝均通过。
- 资源与隔离：冻结上限仍为 10 CPU／18 GiB，生命周期峰值为 9 CPU／16.5 GiB；重置与准备 helper 均计入。结束后原 60 个容器和 57 个卷身份保持不变，镜像总数仍为 169，新增容器与卷残留均为零；所有故障验证模块哈希与最终代码一致。
- 测试与检查：81 项 Python、4 个文件共 34 项 TypeScript、2 项仓库检查回归，共 117 项通过；`npm run check` 无错误、警告或 info，`git diff --check` 通过。新增 15 项 Python 与 2 项 TS 回归；修复前复现缺口的失败日志与最终结果均保留。
- 试跑记录：faults-1 的三个 Worker 崩溃场景通过。faults-2 的 19 项完成验证保留；Evaluator OOM 注入中的同命名空间 SIGSTOP 未暂停 PID 1，改由 Docker daemon 从父命名空间发送并核对进程暂停状态。faults-3 留存已通过的 Evaluator 执行与日志半写入，重新领取场景的驱动器重放表缺少 abort；补全后在 faults-4 通过对应重新领取／取消、Evaluator 取消与实际 OOM、超时。修复驱动器后补跑涉及的场景，保留失败批次，验收审计逐场景选择已核对的最终证据。
- 制品：`artifacts/docker-wf6/faults-2/`、`faults-3/`、`faults-4/` 保留逐场景请求、journal、物理状态、池与 SDK 原始记录、归档与恢复结果；各版本驱动器快照保留。`acceptance-audit.json`／脚本核对完整矩阵与前置文件，`validation.json` 记录 62 个文件哈希、命令及制品绑定；检查、修复前失败与最终测试日志均保留。
- `remaining_issues`：WF6 无未完成项；未知 Provider 用量保持待核对门控，最终性能差距及四模式对照继续保留至 WF7。全部改动未提交、未推送。
- `next_workflow`：WF7；恢复动作：完整读取本规格，核对 `E:/pi` 的 `docker` 分支与 WF6 validation／故障审计的源码和制品哈希，在冻结输入与预算下定位性能差距并完成四模式对照。本轮停在 WF6。

### 7.11 WF7 验收记录

- `workflow_id`：WF7；`spec_revision`：1.7；`status`：completed；完成于 2026-10-12。
- 前置核对：`E:/pi`，分支 `docker`，冻结 skill HEAD；WF6 的 62 个文件哈希一致，validation SHA256 为 `9b2632b8b707f35d1fe66601021e7c70a017501dc3b6e23114c7ee83b283d31a`。保留全部既有改动与 Docker 历史资源。
- 范围：最终性能定位、四模式固定回放、R1–R8 证据索引、运行与恢复说明。第 6 节输入、资源与门槛保持冻结。
- 必要前置：WF5 的 mixed Evaluator prepare p50 为 97.6655 秒，主要等待另一 Worker 释放资源。当前整段预约 6 CPU／12 GiB，覆盖时间上相继运行的角色和 helper。改为每个物理阶段先准入；待命容器确认停机后才缩减至 helper 预算，helper 移除后才准入并启动角色，角色确认退出后才准入 finalizer。保留总预算 10 CPU／18 GiB 与角色 4 CPU／8 GiB，并新增资源与取消竞态回归。
- 复用定位：领取重复创建 helper 扫描不可变镜像与恢复卷。计划复用可信重置证明中的完整树身份，每次领取仍扫描恢复卷的全部内容、元数据和链接，并核对准确镜像与安全配置；减少重复扫描和额外容器启动，污染拒绝与失败隔离继续验证。
- 第一版完整试跑：`artifacts/docker-wf7/reuse-1/` 的 12 个样本评分一致、资源与制品核对通过；整批 999.33109428 秒，3／11 性能门槛通过。保留原始报告、审计及源码快照。
- 重置优化前置：全量删除并重拷贝依赖占用大量写入与等待。逐条读取内容和元数据后只替换有差异的条目，删除额外条目、拆除硬链接，结束时仍完整比较树身份。加入类型、链接、权限、扩展属性、未改文件 inode 与污染恢复回归。
- 池保留前置：120 秒空闲期限短于 Axios 的冻结验证窗口，Preact 环境在批次中重复过期；两个空闲 Preact Worker 占满容量后，新 Axios 环境无法提前准备。默认空闲期限调整为有限的 300 秒，满池时只淘汰无任务兴趣的 ready 重复环境，确认清理后补充；角色限制、容量与第 6 节输入／门槛保持冻结。
- 领取竞争定位：两个任务等待一个 preparing 环境时，后领取者先支付完整等待，再走新建路径。下一轮根据完整报告验证是否需要限制一个环境的等待领取者，其他同环境需求立即进入受控按需路径；保持唯一租约、取消、失败清理及总预算约束。
- 第二版完整试跑：`artifacts/docker-wf7/reuse-2/` 的 12 个样本评分一致，整批 908.533734849 秒，整批／same／mixed 吞吐为基线的 1.2507／1.5392／1.1830 倍；5／11 性能门槛通过，准备延迟仍有 6 项差距。原始数据、审计与本版源码快照保留。
- 锁与冷路径前置：领取绑定在池锁外执行，claiming 状态继续占容量，失败／取消确认清理后才释放；每个 preparing 环境只保留一个等待领取者，其余需求走按需。预算可直接满足冷路径时保留有用预热；不足时继续按 demand 清理与有界准入。冷 Evaluator 先封好输入卷再首次启动待命角色，复用相同检查与激活契约，省去停机、二次启动和重复内核注入。
- 已知队列补充：已归还的一个 ready 物理容器只满足一个待领取任务；已知队列存在第二个兼容需求时，可回收无任务兴趣的 ready 不兼容环境并准备第二个物理容器。保持新鲜 preparing 环境的合并、池容量、逐任务预算与过期规则；补充成本计入该组 queue warmup 和整批时间。
- 停机等待前置：Worker 快照和 Evaluator 归档完成后，或待命 Evaluator 尚未激活时，可信 PID 1 无需保留任务工作。Docker stop 使用 0 秒宽限，确认实际退出后才调整预约或重置；移除每次固定的 1 秒等待，继续验证子进程、临时挂载与故障清理。
- 第三版完整试跑：`artifacts/docker-wf7/reuse-3/` 的 12 个样本评分一致，整批吞吐为基线的 1.2628 倍，10／11 性能门槛通过；same Evaluator prepare p50 为 12.5740 秒，目标 8.6842 秒。原始数据、审计和源码快照保留。
- 已知队列 Evaluator 前置：可信 preflight 同时提出两角色的环境需求，准备后停止 Evaluator，完整核对基线树和空输入／证据后停机入池；计算预约为零。领取仍完整扫描恢复卷，重新注入内核并复查配置与私有材料。已知队列等待两角色准备完成，全部成本计入 queue warmup 和整批墙钟；Worker 清理、快照策略、精确补丁和任务身份的正式激活门控保持完整。
- 第四版试跑与根因：`reuse-4/` 的 12 个样本评分一致、整批 900.390329045 秒；审计发现首个 Evaluator 预热校验失败并按需替代。只读诊断比较全部 30,191 项，唯一差异为初次 `git status` 刷新的 `.git/index`，证据为 `warm-drift.json`。初次就绪检查后使用同一可信全树恢复流程规范化并校验，再停机入池；领取阶段继续严格只校验，污染仍拒绝。回归在修复前复现失败，全部试跑和失败成本保留。
- 工程与真实隔离前置通过：95 项 Python、34 项 TypeScript、2 项仓库检查回归，共 131 项通过；`check-10.log` 保存完整 `npm run check`。`isolation-8/` 通过初次 Evaluator 正常预热停机、两角色同容器代次 1 → 2 → 3、完整污染清除、两角色失败销毁与替代及角色／环境隔离，共 7 项检查。源码快照为 `benchmark-sources/`；isolation-7 的驱动器记录索引错误保留，修正驱动器后在相同源码通过。
- 最终复用模式通过：`reuse-5/` 的 12 个样本评分一致、基础设施失败 0、零新增残留；整批 896.614106942 秒，吞吐为 WF1 的 1.2673 倍，same／mixed 吞吐分别为 1.5904／1.1922 倍。same Worker／Evaluator prepare p50 为 1.4551／7.3692 秒，mixed 为 1.4916／7.5428 秒；4 项 p95 与全部 11 项冻结门槛通过。包含 Controller／helper 的预约峰值 9 CPU／16.5 GiB。`run-final.ps1` 先核对复用模式门槛，再依次完成同一源码的串行、并发按需与预热池对照，最后执行完整故障矩阵。
- 四模式最终对照通过：同一源码下 `sequential-5/`、`concurrent-5/`、`pools-5/`、`reuse-5/` 分别为 1074.796760006、840.293397010、926.534503309、896.614106942 秒。48／48 评分一致，基础设施失败 0，制品、租约、资源与清理审计通过；无 Docker socket 重生成四份报告的字节哈希保持一致。当前固定批次并发按需最快，复用比本版并发按需慢 6.70%；复用相对 WF1 减少耗时 21.09%，通过全部 11 项冻结门槛。
- 故障复验前置：`faults-1/` 在 Worker 准备期间强杀 Controller 后，Docker 尚在处理的 Evaluator 创建请求晚于首轮清理盘点完成，首次启动清理失败。现有运行时拒绝启动和新任务，下次启动继续清理；保留首次失败与清理证据。最终驱动器显式验证拒绝启动、限定同一命名空间的后续恢复、原请求重放和重复恢复字节不变，最多四次启动，并保存每次拒绝的物理状态；生产源码保持与四模式测量一致。通过 `run-faults.ps1` 在新目录 `faults-2/` 复验完整 24 场景。
- 最终仓库检查：`check-11.log` 保存完整 `npm run check` 输出，无错误、警告、info 或自动格式化改动。
- 故障采集前置：`faults-2/` 的 24 个场景均通过，汇总 SDK 生命周期报出 11 CPU／20.5 GiB。逐事件定位为 worker_resume 强杀前的快照漏记一个从未启动的 kernel initializer 删除事件；该对象在强杀后物理盘点已不存在，但汇总将其 2 CPU／4 GiB 配额带入下一场景。保留失败汇总和逐事件诊断；驱动器在每个场景结束后保存真实命名空间零残留盘点，并用明确标记的“盘点确认已移除”事件闭合采集缺口，随后在 `faults-3/` 重跑完整矩阵。生产源码、资源上限和四模式结果保持不变。
- 最终故障复验通过：`faults-3/` 的 24／24 场景、300 条连续日志和 21 份评分文件审计通过，预约峰值 9 CPU／16.5 GiB。六次清理未完成的启动均拒绝新任务，后续同 journal 启动在最多四次内完成恢复；重复恢复保持字节不变。每个场景的真实物理盘点均为零容器／卷残留，原始 SDK 和池记录完整保留，本次采集无需补充漏记删除事件。19 个 Controller 模块哈希与最终源码一致。
- 修改范围核对通过：本轮 13 个文件，包括记录物理退出释放计算预约的 benchmark 回归。该测试此前遗漏于验收脚本的范围清单；移除新增测试后的重建字节哈希与 WF6 原文件相同，证明该差异完整归属本轮。更新范围索引后，其余 49 个前置文件保持原哈希，证据为 `scope-verification.json`。
- 最终工程验收通过：95 项 Python、34 项 TypeScript、2 项检查回归，共 131 项；最后一次仓库检查为 `check-12.log`，无错误、警告、info 或自动格式化改动。四模式报告在无 Docker socket 下重生成字节哈希一致，最终隔离为 `isolation-8/`，性能测量与最终故障验证期间生产源码保持冻结。
- R1–R8 与交付：`artifacts/docker-wf7/acceptance-audit.json` 汇总全部要求、四模式报告和故障审计；`report.md` 给出完整批次、准备 p50／p95、预热、命中、重置、资源与适用条件；`validation.json` 记录 62 个迭代文件、13 个本轮文件、测试、命令及制品哈希。基准 README 提供运行参数、复用生命周期与恢复步骤，全部原始试跑和失败证据保留。
- 最终资源身份：原有 60 个容器、57 个卷、169 个镜像保留，新增容器、卷、有效租约与等待残留均为零。工作区为 `E:/pi` 的 `docker` 分支，HEAD 保持冻结 skill 基线，全部改动未提交、未推送。
- `remaining_issues`：本次规格无未完成验收项。固定批次中并发按需整批最快，复用模式通过冻结性能门槛并降低准备延迟；收益与成本按四模式实测值保留。
- `next_workflow`：无；本次迭代完成。
- `resume_action`：读取本规格、`artifacts/docker-wf7/validation.json` 与交付报告，核对 `E:/pi` 的 docker 分支、冻结 skill HEAD 及最终文件／制品哈希。当前无活动或后继工作流。

### 7.12 分支发布记录

- 用户于 2026-10-12 要求更新 docker 分支 README，并提交、推送到 GitHub。
- 必要前置：提交前复核发现关闭两类池时，按需 Evaluator 未登记关闭清理归属。Worker 已销毁、Evaluator 已启动但未 ACK 时关闭服务，会留下评测容器、卷与预约。新增回归已复现容器未清理；修复范围为按需 Evaluator 归属登记及关闭回归，对应 R5、R6、R8。
- 测量边界：7.11 的四模式、隔离和故障结果来自 WF7 冻结源码。此次发布另含关闭清理修复，旧测量制品与哈希保留，发布验证单独记录。
- 关闭修复验收通过：新增回归在修复前复现容器残留，修复后 96 项 Python 通过。真实 M6 按需路径在 Evaluator 激活前通过 daemon 暂停 PID 1，启动后直接关闭服务；1 个评测容器、5 个所属卷、有效预约、等待和归属映射均清零，既有 Docker 容器／卷／镜像身份保持一致。证据为 `pre-push-cold-shutdown.json`／脚本与日志；发布 runtime_docker.py SHA256 为 `5c421f64601ead9971ef844e37fd2c319dfea07491750c3e809a6e8ff027aba3`，WF7 测量版本为 `340fb6153044706cbf832de66f90a642debc84b8915e9396a17f7baf6f0e2eac`。
- 工程复验通过：96 项 Python、20 个 TS 修改文件共 188 项测试、2 项仓库检查回归，合计 286 项；完整 `npm run check` 无错误、警告、info 或格式化改动。新增规则限定冻结 `.patch` 夹具，保留统一 diff 必需的上下文空白与字节身份。
- 分支 README 记录 WF0–WF7、三种配置及真实四模式结果：当前固定批次并发按需最快，预热和复用保留为可配置模式，现有默认值沿用。
- 发布验证与提交：进行中。
