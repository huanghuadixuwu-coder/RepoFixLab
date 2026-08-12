# 16 GiB 本机高并发实施与验收计划

本文是 [执行计划.md](./执行计划.md) 的本机验证配置层，背景和架构分别见 [BACKGROUND.md](./BACKGROUND.md)、[DESIGN.md](./DESIGN.md)，完整实现教学见 [SRUCTURE.md](./SRUCTURE.md)，开发问题复盘见 [PROBLEM_RESOLUTION.md](./PROBLEM_RESOLUTION.md)。生产状态机、模块边界、数据库选择、注释规范保持不变，只缩放任务数量和并发参数。

## 验证结论边界

- 本计划证明架构方法在 16 GiB 本机环境、20 并发下有效。
- 本计划不证明企业环境 200 并发的生产容量。
- 生产容量必须在企业环境使用真实资源配额完成独立压测。

## 固定本机配置

| 项目 | 本机值 | 验证目的 |
| --- | ---: | --- |
| 受控压测任务数 | 100 | 形成持续队列压力，不代表真实修改任务 |
| 提交窗口 | 60 秒 | 保持平均每 3 秒提交 5 个任务的原场景速率 |
| WorkerPool 上限 | 20 | 保持任务数与并发数 5:1 |
| 首轮排队数 | 80 | 证明先排队再占资源 |
| 模型闸门上限 | 2 | 保持模型并发占活跃任务 10% |
| 幂等并发请求数 | 20 | 触发唯一约束竞争 |
| 同仓库并发任务数 | 20 | 触发工作区写入竞争 |
| 强制终止执行器数 | 4 | 注入 20% 活跃执行器失联 |
| PostgreSQL 中断时间 | 5 秒 | 验证停止领取与恢复 |
| 租约时钟推进 | 61 秒 | 超过 60 秒租约有效期 |
| 真实定位任务数 | 26 | 覆盖现有冻结任务全集 |
| 真实定位并发数 | 4 | 验证任务级 Worker 隔离 |
| 真实定位批次数 | 7 | 前六批各 4 项，末批 2 项 |
| 真实执行终点 | `LOCALIZE` | 限定本机验收范围 |
| 测试资源峰值 | 12 GiB | 给操作系统保留运行空间 |
| 系统可用内存下限 | 2 GiB | 防止交换空间掩盖架构问题 |

CPU 核心数、磁盘类型、PostgreSQL 版本必须写入验收报告，不作为本机通过门槛。

## 非玩具测试边界

真实组件：

- PostgreSQL、迁移脚本、`PostgresTaskStore`。
- `AdmissionService`、`TaskScheduler`、`WorkerPool`、`LeaseManager`。
- 本地文件系统、`WorkspaceManager`、`ArtifactStore`、`ResultGate`。
- 状态版本竞争、领导租约、任务租约、原子制品发布。
- 真实 Controller HTTP 协议与任务级 Controller 实例隔离。

受控边界：

- WORKSTREAM1 至 WORKSTREAM6 使用确定性 faux provider，不调用付费模型。
- WORKSTREAM7 使用项目现有 RepoFix 模型配置，真实执行至 `LOCALIZE`。
- 外部 Git、CI 使用本地夹具，不依赖企业网络。
- 执行耗时、执行器退出、数据库中断、制品失败由测试夹具精确触发。

受控组件不得替换 PostgreSQL、`TaskStore`、调度器、租约管理器、工作区管理器、结果门禁。

## 本机新增测试资产

- 新增 `packages/repofixlab/configs/concurrency/local-16gb.json`：保存本机固定参数。
- 新增 `packages/repofixlab/test/concurrency/local-profile.ts`：加载并校验本机参数，拒绝运行时改写。
- 新增 `packages/repofixlab/test/concurrency/controlled-task-executor.ts`：实现可阻塞、可失败、可统计的 `TaskExecutor` 测试适配器。
- 新增 `packages/repofixlab/test/concurrency/local-evidence.ts`：收集硬件、配置、队列、并发、内存、故障恢复证据。
- `load-profile.test.ts` 负责 100 任务受控并发验收。
- `localize-local-profile.test.ts` 负责 26 任务、4 并发真实 RepoFix 定位链路验收。
- 所有脚本遵守 [执行计划.md](./执行计划.md#注释核心约束) 定义的三类中文注释格式。

## WORKSTREAM1: 契约与数据库本机验收

任务：使用真实 PostgreSQL 验证状态版本、事务原子性和审计一致性。

具体实现：

- 执行 `001_concurrency.sql` 创建真实表结构。
- 使用独立测试数据库和固定连接串，测试结束后删除本次任务数据。
- WORKSTREAM1 通过版本化迁移函数验证数据库不变量，WORKSTREAM2 通过 `PostgresTaskStore` 复验相同行为。

交付条件：

- badcase：20 个并发事务更新同一状态版本，成功事务数等于 1。
- badcase：`completed` 任务重新进入 `running`，任务主记录和审计事件均不变化。
- badcase：状态主记录写入失败，审计事件写入数量为 0。

## WORKSTREAM2: 准入与幂等本机验收

任务：验证集中提交下的稳定任务 ID、幂等冲突和数据库失败语义。

具体实现：

- 20 个客户端并发调用 `AdmissionService.submit()`。
- 请求哈希、幂等键、响应任务 ID 全部写入验收证据。
- 数据库断开时直接返回持久化失败，不保留内存任务。

交付条件：

- badcase：20 个相同幂等请求只生成 1 个任务，20 个响应返回同一任务 ID。
- badcase：相同幂等键提交两份不同内容，第二份返回 `idempotency_key_conflict`。
- badcase：提交事务中断后，任务主记录和审计事件数量均为 0。

## WORKSTREAM3: 调度与上游闸门本机验收

任务：用 100 任务、20 并发验证排队、领导租约、槽位释放和上游保护。

具体实现：

- 60 秒内分 20 批提交任务，每 3 秒提交 5 个任务。
- `ControlledTaskExecutor` 阻塞首批任务，直到 20 个槽位全部占用。
- 模型闸门固定为 2，记录等待时间和并发峰值。
- 同时启动两个 `TaskScheduler` 实例竞争同一领导租约。

交付条件：

- badcase：首批任务阻塞时活跃任务数等于 20，排队任务数等于 80。
- badcase：完整运行期间活跃任务数始终不超过 20。
- badcase：第二个调度器领取任务数等于 0。
- badcase：模型调用并发峰值等于 2。
- badcase：执行器失败后槽位计数立即回落，下一排队任务取得槽位。

## WORKSTREAM4: 工作区与缓存本机验收

任务：用真实文件系统验证同仓库任务隔离、只读缓存和回收失败语义。

具体实现：

- 20 个任务基于同一本地仓库和同一提交修改同名文件。
- 每个任务写入独立内容标识，再生成制品清单。
- 依赖缓存使用内容哈希目录并以只读权限挂载。

交付条件：

- badcase：源仓库内容保持不变，20 个工作区结果互不相同。
- badcase：任务写入只读缓存时失败，其他 19 个任务继续执行。
- badcase：缓存哈希不匹配时重建缓存，不读取损坏内容。
- badcase：工作区回收失败时任务进入 `failed`，失败原因为 `workspace_cleanup_failed`。

## WORKSTREAM5: 租约与恢复本机验收

任务：使用测试时钟和进程终止验证失联发现、单所有者恢复和 checkpoint 判定。

具体实现：

- 20 个任务进入 `running` 后终止其中 4 个执行器。
- 测试时钟推进 61 秒，不进行真实等待。
- 两个恢复执行器同时竞争同一失效任务。
- 完整 checkpoint、缺失 checkpoint 分别使用固定夹具。

交付条件：

- badcase：4 个失联任务全部进入 `recovering`，正常任务状态不变化。
- badcase：同一失效任务的新租约数量等于 1。
- badcase：完整 checkpoint 继续原 attempt，模型费用记录不重复。
- badcase：缺失 checkpoint 的任务进入 `failed`，失败原因为 `checkpoint_incomplete`。

## WORKSTREAM6: 结果门禁本机验收

任务：使用真实 `ArtifactStore` 验证基线变化、不可变发布和失败证据。

具体实现：

- 20 个任务写入独立暂存目录并发布到独立最终目录。
- 推进 4 个任务对应的目标分支提交，触发基线失效。
- 对 4 个任务注入制品发布失败。
- 对同一任务发起两次结果发布竞争。

交付条件：

- badcase：4 个基线失效任务全部进入 `revalidation_required`。
- badcase：4 个发布失败任务保持 `publishing`，最终目录不存在半成品。
- badcase：同一任务只有一份结果发布成功，首份制品字节保持不变。
- badcase：结果清单哈希不一致时任务进入 `failed`，失败原因为 `result_manifest_invalid`。

## WORKSTREAM7: 真实定位接线与证据报告

任务：对现有 26 项冻结任务真实执行 RepoFix，以 `LOCALIZE` 结果发布成功作为任务完成条件并生成可展示报告。

具体实现：

- 从现有冻结任务集读取 26 项任务，不复制任务，不生成扩充任务。
- 固定任务并发为 4，固定执行 7 批，前六批各 4 项，末批 2 项。
- 每项任务运行真实 RepoFix `UNDERSTAND`、`LOCALIZE` 阶段，完成 `LOCALIZE` 后立即停止后续阶段。
- 每项任务使用独立 Controller Worker 容器和独立工作区，共享单个受信 Controller HTTP 门面；Controller 运行容量固定为 4。
- `LOCALIZE` 产物写入独立暂存目录，经 `ResultGate` 校验及原子发布后进入 `completed`。
- 不执行 `IMPLEMENT`、`REFINE`、代码测试和代码修复结果评价。
- 执行期间中断 PostgreSQL 5 秒，恢复后继续处理原队列。
- 输出 `<run-root>/reports/local-16gb-report.json` 和 `<run-root>/reports/local-16gb-report.md`。
- 报告记录 Git 提交、操作系统、CPU 核心数、总内存、PostgreSQL 版本、配置 SHA-256。
- 报告记录队列曲线、活跃峰值、模型峰值、定位吞吐量、P95 排队时间、P95 定位时间、内存峰值、系统最低可用内存。
- 报告指标使用“定位完成率”，不记录“修复成功率”。

交付条件：

- badcase：PostgreSQL 中断期间新领取任务数等于 0，内存态完成记录数等于 0。
- badcase：PostgreSQL 恢复后原队列继续执行，不生成重复任务。
- badcase：测试进程与容器峰值内存不超过 12 GiB，系统最低可用内存不低于 2 GiB。
- badcase：26 项任务全部完成 `LOCALIZE`，全部发布定位结果清单，全部进入 `completed`。
- badcase：活跃任务峰值等于 4，模型调用峰值等于 2。
- badcase：任务结束后，重复任务数、交叉写入数、制品覆盖数、丢失终态数、残留活跃租约数均为 0。
- badcase：结果目录不存在 `IMPLEMENT`、`REFINE`、代码测试产物。
- badcase：定位完成率等于 100%，报告不生成修复成功率字段。
- badcase：JSON 报告与 Markdown 报告的配置哈希、任务计数、通过状态完全一致。

## 验收判定

- 全部 badcase 通过时，本机架构验证结论为 `accepted`。
- 任一 badcase 失败时，本机架构验证结论为 `rejected`。
- P95 排队时间、P95 定位时间、定位吞吐量只记录实测值，不设置未确认门槛。
- 报告必须明确写出：本机结果不能替代企业环境 200 并发容量测试。

## 执行顺序

1. WORKSTREAM1：契约与数据库。
2. WORKSTREAM2：准入与幂等。
3. WORKSTREAM3：调度与闸门。
4. WORKSTREAM4：工作区与缓存。
5. WORKSTREAM5：租约与恢复。
6. WORKSTREAM6：结果门禁。
7. WORKSTREAM7：真实定位接线与报告。
