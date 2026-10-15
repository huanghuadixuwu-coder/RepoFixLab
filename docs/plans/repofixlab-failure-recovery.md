# RepoFix 失败恢复规格

- 版本：1.4（两工作流交付完成与发布核对）。
- 更新日期：2026-10-15。
- 开发基线：`docker@777e1828007ca795a9d4ee28ba701e6063bf98a0`。
- 工作区：`E:/pi`。界面工作区 `E:/codex-home-restored/worktrees/96c1/pi` 是另一份工作树。
- 前置交付：[Docker 运行时迭代 WF0–WF7](repofixlab-runtime-iteration.md)。
- 已确认规则：[F1 逐项确认记录](repofixlab-failure-recovery-f1.md)。

## 1. 最终目标与讨论方式

让 RepoFix 在容器准备、执行和清理故障后，按确认的条件等待、转按需、取回已有结果、从检查点恢复或停止任务。保留任务进度、评分结果、失败记录和资源归属。

逐类与用户讨论措施，再逐项确认次数和停止条件，确认后写入规格。执行工作流时以本文和 F1 记录为依据，每次完成一个工作流。

最初 F1 草稿中的次数、语义阶段回退、协议设计、验收数量和性能门槛由助手自行提出。用户随后要求逐类讨论；本版以之后的明确确认替代原草稿。

## 2. 已确认范围

| 类别 | 已确认处理 |
| --- | --- |
| 容器池与按需创建 | 池未命中正常按需；池中容器启动失败或污染后清理并转按需；清理残留按销毁失败规则处理 |
| 临时资源不足 | 统一调度，最多排队等待 5 分钟；超时资源阻塞，保留进度，停止自动重试；用户取消结束等待 |
| Docker 不可用 | 暂停派发，每 5 秒统一探测，最多等待 5 分钟；恢复后核对执行状态；超时基础设施阻塞 |
| 镜像或配置错误 | 镜像身份／内容校验不符阻塞依赖任务；任务配置错误阻塞对应任务 |
| Worker 退出 | 每任务最多恢复 1 次，从当前或更早阶段最近有效检查点继续；无有效检查点或恢复额度耗尽则终止 |
| 快照保存失败 | 已保存则取回；确认未保存且 Worker 正常，额外重试 1 次；仍失败终止 |
| Evaluator 故障 | 基础设施中断后，每任务额外重评最多 1 次，使用同一补丁；已完成则取回结果；正常测试未通过则归档正式结果 |
| 重置与销毁失败 | 重置失败直接销毁；销毁失败额外重试 1 次，仍失败则隔离、记录残留、保留资源占用，等待人工处理；保留已完成结果 |

规则细节、计数与讨论边界见 F1。

## 3. Agent 职责与检查点恢复

IMPLEMENT 按计划生成首版补丁；REFINE_1／REFINE_2 处理实现错误与遗漏；PLAN 完成后计划固定。各阶段继续使用已有的产物校验与补交机制。

Worker 故障恢复时，优先使用当前阶段最近的有效检查点；没有则向前查找上一阶段、更早阶段。恢复检查点对应的代码与阶段状态，重新执行其后未可靠完成的工作。例如 IMPLEMENT 中断后，可恢复 PLAN 完成后的检查点再执行 IMPLEMENT。

这项恢复服务于执行中断，遵循原有阶段职责、配置与工具权限。恢复计数按原任务累计，新 Worker 不刷新额度。

已核对并实现：初始空补丁快照绑定早期阶段产物；IMPLEMENT 之后复用 P0／V1／V2／P1。Controller 保留封存代码，Orchestrator 在现有制品目录记录阶段前缀和验证进度。快照已保存而验证中断时，恢复当前代码并完成验证，再进入下一阶段。

## 4. 时间参数的源码核对

`src/m7/formal-runner.ts` 有 `maxWallTimeMs`，默认 1,800,000 ms，目前用于写入 manifest；该执行链没有根据该值强制终止整个任务。

`controller/src/repofixlab_controller/runtime_admission.py` 的准入等待默认 300 秒，实际超时会返回 `runtime_queue_timeout`。本轮确认沿用 5 分钟排队等待，超时资源阻塞并停止自动重试。

本轮等待策略使用上述排队时限与已确认的 Docker 探测时限。现有 token 账本和 CPU／内存准入约束继续应用于恢复执行。

## 5. 本轮排除与沿用的机制

- 用户明确排除 Controller 重启或意外退出的恢复。
- 镜像问题只纳入身份／内容校验阻塞；配置问题只纳入配置错误阻塞。
- 结果归档重试、ACK 响应恢复未纳入本轮新增措施。
- Agent 实现纠错沿用两次 REFINE；语义错误触发重新 PLAN／LOCALIZE 的方案已撤回。
- 阶段产物校验及不合规输出的补交沿用现有实现。
- 整个任务的强制截止时间、统一 2 次恢复额度、5% 性能门槛、63 项固定验收清单未获确认。

## 6. 工作流进度

| ID | 当前范围或状态 |
| --- | --- |
| WF1 | 运行时回退规则、针对性测试与真实 Docker 故障验证，completed |
| WF2 | Worker 检查点恢复：最近有效检查点、代码与阶段状态恢复、继续未完成工作、每任务仅恢复 1 次；恢复测试与文档，completed |

用户要求缩短工作流，已授权按两个工作流开始本次迭代。沿用前述已确认规则，优先复用现有代码，以 checkpoint、等待轮询和确定性条件分支实现。新增职责、恢复类别或限制先讨论。

## 7. 恢复入口

- `active_workflow`：无，WF1／WF2 已完成。
- `next_action`：无；本轮实现与验收完成，提交与合并记录见分支 Git 历史。
- `next_workflow`：无。
- `last_updated`：2026-10-15。
- `confirmed_scope`：运行时故障恢复及 Worker 检查点续跑；Agent 阶段职责固定。
- `open_design_items`：无。
- `validation`：最终 npm run check、102 项 Python、65 项 TypeScript 和 WF2 两项真实 Docker 恢复通过。WF1 的两项故障验证记录保留。
- `changed_files`：Controller 运行时／HTTP、RepoFix workflow、M4 runner、Controller 客户端、预算准入、对应测试、CHANGELOG 和规格入口；见 git diff 与交付验证记录。
- `resume_action`：读取本规格、F1 和 `artifacts/failure-recovery/wf2/validation.json`，核对 E:/pi 的 docker 分支。当前无后继工作流；后续新增规则先讨论。

每个工作流完成后记录修改文件、验收结果、证据位置、遗留问题和下一步。新增恢复类别、数值或改变职责边界需要先与用户讨论。

## 8. WF1 完成记录

- 实现：沿用现有准入和 journal，增加共享 Docker 可用性探测、按任务／角色的池故障转按需、稳定阻塞原因、快照单次重试、Evaluator 单次重评、重置失败销毁和销毁单次重试。残留资源隔离并继续计费；正式评分与清理记录分别归档。
- `npm run check`：通过，完整输出见本次执行记录。机器未提供 npm，使用已有 Node 镜像中的 npm 作为临时工具；依赖与锁文件无变更。
- Python：指定运行时、准入、池、重置和故障模块共 98 项通过。使用已有带 Git 的 Linux 测试镜像，避免本机缺少 Python 依赖。
- TypeScript：`runtime-recovery.test.ts` 与 `m4-dev-workflow.test.ts` 共 13 项通过。使用已有 Linux 测试镜像；Windows 目录 fsync 的既有平台限制保留。
- 真实 Docker：Preact 4316 冻结成功补丁；池容器 helper 污染后按需继续，54.722 秒；Evaluator 被终止后额外重评 1 次，58.065 秒。两项均 resolved，F2P 1／1、P2P 10／10，status map SHA256 同为 `41189711079f762f473c6ed97af8c4e591f6ac15522b973640387396401911a0`。
- 清理核对：两项均无命名空间内残留容器／卷，角色预约 active／waiting 均为 0，只剩 Controller 基础预约。
- 证据：`artifacts/failure-recovery/wf1/real-docker-3/summary.json`、各场景 `report.json`、journal 与评分归档。
- 试跑修正：第一次配置引用的 source 目录缺少共享 DatasetLock；改为冻结 Controller 镜像中的只读运行锁。第二次污染注入因文件只读失败；改为以文件所属 Worker 用户执行注入。两次均已结束并清理所建资源。
- 下一步：WF2，恢复代码与对应有效阶段产物，复用原 token 账本和固定阶段职责。

## 9. WF2 完成记录

- 实现：Controller 从本任务 journal 中选取策略通过的封存快照，销毁异常 Worker，按需创建新 Worker，恢复补丁并校验基线树与候选树。恢复次数属于原任务，最多 1 次；旧租约失效，同一恢复操作重放返回已有新租约。
- 阶段续跑：使用现有 FSM 校验已完成前缀，跳过有效检查点内的阶段。当前快照后的验证若未完成，先补完该验证。PLAN、两个 REFINE、阶段权限及现有产物补交规则保持原职责。
- 制品：`initial.patch`、`checkpoints/*.json`、`worker-recovery.json` 和中断轨迹写入原运行目录；恢复后的阶段／记忆制品位于 `recovery-1/`，统一注册到原制品索引。优先选择最近有效检查点，失败时向前查找；全部无效则终止。
- 预算：原 token ledger、逻辑任务身份、Provider 请求序列和实际模型请求计数延续。Worker 故障后在预算预留前阻止下一轮 Provider 调用，再由恢复入口续跑。
- 覆盖：RepoFix 七阶段、无 LOCALIZE、无验证反馈配置；layered memory 与冻结 `plan-robustness-v1` skill；当前验证中断、较早检查点、无检查点、二次退出、预算不刷新、恢复响应丢失和旧租约拒绝。
- 工程验证：完整 `npm run check` 通过，最后一次无自动格式化修改；102 项 Python 和 65 项 TypeScript 通过。测试使用既有 Linux 镜像与 faux Provider，依赖及锁文件无修改。
- 真实 Docker：Preact 4316 冻结成功补丁；基线恢复 53.544 秒、补丁恢复 52.915 秒。补丁恢复场景另注入未封存修改，再确认新 Worker 只恢复封存代码。两项均恢复 1 次、操作重放返回已有租约、resolved，F2P 1／1、P2P 10／10，status map SHA256 与 WF1 相同。
- 清理核对：最终两项均无场景内残留容器／卷，active／waiting 为 0，资源只剩 Controller 基础预约。首次成功验证保留在 `real-docker-1/`；简化清理参数、共用快照重试规则后在 `real-docker-2/` 复验。
- 证据：`artifacts/failure-recovery/wf2/real-docker-2/summary.json`、各场景 journal／checkpoint／verification／评分归档、`validation.json`。
- 遗留与下一步：已确认范围无未完成项；WF2 完成时改动尚未提交。WF1／WF2 完成，发布核对见第 10 节。

## 10. 发布核对

- 2026-10-15 用户授权提交并推送 `docker` 分支，再合并至 GitHub `main`。
- 发布前完整 `npm run check` 通过，无自动格式化修改；运行时相关 10 个 Python 测试模块共 114 项、5 个 TypeScript 测试文件共 61 项通过。
- WF2 验收记录中的 8 个核心源码哈希与当前文件一致；WF1／WF2 的真实 Docker 故障验证记录继续保留。
- `main` 保留用户审核通过的项目 README，合并时同步代码发布状态。
