# RepoFixLab 高并发基础设施结构与实现教学

本文采用“总述建立全局认识，分述拆解实现细节”的结构，完整说明 RepoFixLab 高并发基础设施怎样落地、每层解决什么问题、脚本怎样协作、核心函数怎样推进任务状态。

相关文档：

- 场景定义：[BACKGROUND.md](./BACKGROUND.md)
- 目标设计：[DESIGN.md](./DESIGN.md)
- 本机计划：[ACTUAL_IMPLEMENTATION.md](./ACTUAL_IMPLEMENTATION.md)
- 开发复盘：[PROBLEM_RESOLUTION.md](./PROBLEM_RESOLUTION.md)
- 分步计划：[执行计划.md](./执行计划.md)

---

# 总篇：先理解整套基础设施

## 1. 一句话结论

这套基础设施把集中到达的代码开发任务转换成一条可排队、可限流、可隔离、可恢复、可审计、可验证的执行流水线，使任务高峰不会直接变成容器高峰、模型调用高峰和共享目录写入高峰。

它直接处理八个核心问题：

| 问题 | 固定解法 | 结果 |
| --- | --- | --- |
| 突发任务压垮系统 | PostgreSQL 持久队列加固定 Worker 槽位 | 排队任务不提前占用执行资源 |
| 客户端重试导致重复执行 | 幂等键、稳定任务 ID、请求哈希、数据库唯一约束 | 同一请求只生成一个任务 |
| 多任务污染同一仓库 | 一任务一工作区、所有权凭据、只读共享缓存 | 可写状态不跨任务共享 |
| 模型服务被并发请求打满 | 独立 `CapacityGate` | 模型调用峰值被硬限制 |
| 执行器退出后任务卡死 | 任务租约、20 秒心跳、60 秒到期、单所有者恢复 | 失联任务进入确定恢复流程 |
| 进程重启导致状态丢失 | PostgreSQL 保存队列、状态版本、租约、审计事件 | 内存不是任务真相源 |
| 执行结束时基线已经变化 | 发布前重新读取目标提交 | 失效结果进入 `revalidation_required` |
| 多任务结果互相覆盖 | 任务 ID 结果目录、独占写入、原子目录发布、清单哈希复核 | 结果具备不可覆盖性和完整性证据 |

## 2. 三个规模必须分开理解

| 层级 | 固定规模 | 证明内容 |
| --- | --- | --- |
| 企业场景设计 | 10 分钟提交 1,000 项任务，活跃任务上限 200 | 架构目标和模块边界 |
| 16 GiB 受控验收 | 100 项任务，Worker 上限 20，模型上限 2 | 排队、调度、闸门、隔离、恢复、发布方法有效 |
| 真实 RepoFix 验收 | 26 项冻结任务，Worker 上限 4，模型上限 2 | 真实 Controller、真实模型、真实 `UNDERSTAND` 与 `LOCALIZE` 链路可运行 |

本机结果证明架构方法有效，不代表企业环境 200 并发的容量结论。企业容量必须在生产同等级资源中完成独立压测。

## 3. 总体数据流

```text
客户端请求
  │
  ▼
AdmissionService.submit
  ├─ 校验身份字段
  ├─ 计算规范请求 SHA-256
  └─ 根据幂等键生成稳定 task_id
  │
  ▼
PostgresTaskStore.submit
  ├─ 写入 concurrency_tasks
  └─ 同事务写入 concurrency_task_events
  │
  ▼
TaskScheduler.tick
  ├─ 取得单调度器领导租约
  ├─ 读取 WorkerPool 可用槽位
  └─ 按 enqueue_sequence 领取 queued 任务
  │
  ▼
WorkerPool.submit
  ├─ 固定执行槽位
  ├─ 为任务创建独立 TaskExecutor
  └─ 失败后登记稳定失败状态并释放槽位
  │
  ▼
LocalizeTaskExecutorFactory.executeTask
  ├─ preparing → running
  ├─ 启动任务心跳
  ├─ Controller 准备独立 Worker
  ├─ CapacityGate 取得模型名额
  ├─ 执行 UNDERSTAND 与 LOCALIZE
  ├─ running → validating
  ├─ 基线复核
  ├─ validating → publishing
  ├─ 原子发布结果清单
  └─ publishing → completed
  │
  ▼
PostgreSQL 终态 + 不可变结果目录 + 审计报告
```

## 4. 核心不变量

以下规则不是运行建议，而是代码和数据库共同执行的硬约束：

1. 同一幂等键只绑定一份请求。
2. 一个任务在同一时刻只有一个有效 attempt。
3. 调度器领取数量等于当前 Worker 可用槽位数。
4. 单次状态写入必须携带上一版本号。
5. 每次状态更新只允许版本号增加 1。
6. 每次状态更新与审计事件处于同一数据库事务。
7. 排队任务不创建 Worker，不调用模型。
8. 模型占用数不超过 `CapacityGate` 固定容量。
9. 结果清单发布完成并通过复核后，任务才能进入 `completed`。
10. 终态任务不再进入执行态。

## 5. 模块解耦方式

基础设施采用“契约、端口、适配器、协调器、执行接线”五层结构：

| 层 | 代表脚本 | 只负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| 契约层 | `contracts.ts` | 状态、失败码、任务结构、执行接口 | 数据库、文件系统、网络 |
| 端口层 | `task-store.ts` | 定义准入、调度、租约、结果持久化能力 | PostgreSQL 语句 |
| 适配器层 | `postgres-task-store.ts`、`workspace-manager.ts`、`result-gate.ts` | 把端口映射到真实数据库和文件系统 | 全局调度顺序 |
| 协调器层 | `scheduler.ts`、`worker-pool.ts`、`lease-manager.ts` | 协调容量、领取、执行、恢复 | RepoFix 阶段细节 |
| 执行接线层 | `localize-task-executor.ts`、`localize-workflow.ts` | 接入真实 Controller 和 RepoFix | 队列存储实现 |

关键解耦点：

- `AdmissionService` 只依赖 `TaskSubmissionStore`，不依赖 `pg`。
- `TaskScheduler` 只依赖 `TaskSchedulingStore` 和 `WorkerPool`，不创建 RepoFix 会话。
- `WorkerPool` 只依赖 `TaskExecutorFactory`，不识别模型供应商。
- `LeaseManager` 只依赖 `TaskLeaseStore` 和 `RecoveryCheckpointSource`，不执行任务主体。
- `ResultGate` 只依赖任务存储端口、基线读取端口和 `ArtifactStore`。
- `LocalizeTaskExecutorFactory` 负责组装真实依赖，不把 Controller 细节泄漏到调度器。

## 6. 为什么只使用 PostgreSQL

当前实现不使用 Redis。PostgreSQL 已经同时承担四项职责：

- `concurrency_tasks` 保存持久队列和任务当前状态。
- `FOR UPDATE SKIP LOCKED` 提供并发安全的任务领取。
- `concurrency_scheduler_lease` 提供单调度器领导租约。
- 数据库触发器在同一事务写入不可变审计事件。

本场景没有高频读取缓存需求。加入 Redis 会引入双写一致性、缓存失效、故障切换和额外运维面，不能增加当前基础设施的正确性。企业压测确认 PostgreSQL 队列成为瓶颈后，再根据实测数据拆分读取加速层；任务真相源仍保持 PostgreSQL。

---

# 分篇：逐层完成基础设施

## 7. 第一层：冻结任务契约和状态机

### 7.1 解决的问题

高并发状态写入最危险的问题是两个执行方同时推进同一任务，后写结果覆盖先写结果。第一层先冻结状态机、失败码、状态版本和执行接口，使所有后续模块遵循同一套规则。

### 7.2 脚本与核心符号

| 脚本 | 类、接口、函数 | 作用 |
| --- | --- | --- |
| [`contracts.ts`](../../packages/repofixlab/src/concurrency/contracts.ts) | `TASK_STATUSES` | 冻结十个任务状态 |
| 同上 | `TASK_TRANSITIONS` | 冻结合法状态转换矩阵 |
| 同上 | `ConcurrencyTask` | 定义任务身份、请求、版本、attempt、租约、失败和结果字段 |
| 同上 | `TaskExecutor` | 定义单任务执行入口 `execute()` |
| 同上 | `TaskExecutorFactory` | 定义执行器创建入口 `create()` |
| 同上 | `assertTaskTransition()` | 在 TypeScript 层拒绝未声明转换 |
| 同上 | `TaskTransitionError` | 返回稳定的前态和目标态错误字段 |
| [`001_concurrency.sql`](../../packages/repofixlab/migrations/001_concurrency.sql) | `concurrency_task_transition_allowed()` | 在数据库层复刻状态转换矩阵 |
| 同上 | `enforce_concurrency_task_update()` | 检查不可变字段、版本增量和合法转换 |
| 同上 | `record_concurrency_task_event()` | 每次插入和更新后写入审计事件 |
| 同上 | `transition_concurrency_task()` | 按 `task_id + expected_version` 原子推进状态 |

### 7.3 状态逻辑

正常链路：

```text
queued → preparing → running → validating → publishing → completed
```

故障链路：

```text
preparing、running、validating、publishing → recovering
recovering → running
recovering → failed
validating、publishing → revalidation_required
可失败执行态 → failed
queued → cancelled
```

终态为 `revalidation_required`、`completed`、`failed`、`cancelled`。终态在转换矩阵中没有后继状态。

### 7.4 数据库怎样防止并发覆盖

`transition_concurrency_task()` 的执行步骤固定为：

1. 根据 `task_id` 定位任务。
2. 要求当前 `status_version` 等于调用方的 `expected_version`。
3. 将 `status_version` 增加 1。
4. 由 `enforce_concurrency_task_update()` 校验状态转换。
5. 由 `record_concurrency_task_event()` 写入新版本事件。
6. 事务提交后返回新任务快照。

二十个事务携带同一版本同时更新时，只有一个事务可以成功。其余十九个事务因为版本已经变化而失败。

### 7.5 对应验收

- [`contracts.test.ts`](../../packages/repofixlab/test/concurrency/contracts.test.ts) 穷举接受全部声明转换并拒绝全部未声明转换。
- [`workstream1-postgres.mjs`](../../packages/repofixlab/test/concurrency/workstream1-postgres.mjs) 让二十个事务竞争同一版本，确认成功数为 1、冲突数为 19。
- 同一脚本确认 `completed → running` 被拒绝，主记录和审计事件均不变化。

## 8. 第二层：准入、幂等和持久队列

### 8.1 解决的问题

网络超时会触发客户端重试。平台不能根据“收到多少次请求”创建任务，必须根据“请求身份是否相同”决定任务数量。

### 8.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`admission-service.ts`](../../packages/repofixlab/src/concurrency/admission-service.ts) | `taskRequestSha256()` | 规范序列化请求并计算 SHA-256 |
| 同上 | `taskIdForIdempotencyKey()` | 根据幂等键生成稳定任务 ID |
| 同上 | `AdmissionService.submit()` | 校验字段后提交持久化命令 |
| 同上 | `AdmissionValidationError` | 返回稳定准入错误码 |
| [`task-store.ts`](../../packages/repofixlab/src/concurrency/task-store.ts) | `TaskSubmissionStore.submit()` | 定义幂等提交端口 |
| [`postgres-task-store.ts`](../../packages/repofixlab/src/concurrency/postgres-task-store.ts) | `PostgresTaskStore.submit()` | 用事务和唯一约束处理并发提交 |
| 同上 | `IdempotencyKeyConflictError` | 表达同键不同内容冲突 |
| 同上 | `runTransaction()` | 统一执行连接、提交、回滚和错误包装 |

### 8.3 准入逻辑

`AdmissionService.submit()` 依次执行：

1. 校验幂等键格式。
2. 校验仓库文本非空。
3. 校验基线提交为四十位小写十六进制。
4. 校验任务内容非空。
5. 校验调用身份非空。
6. 使用 `stableStringify()` 生成规范请求字节。
7. 使用 `taskRequestSha256()` 计算请求摘要。
8. 使用 `taskIdForIdempotencyKey()` 生成稳定任务 ID。
9. 调用 `TaskSubmissionStore.submit()`。

### 8.4 PostgreSQL 幂等逻辑

`PostgresTaskStore.submit()` 在一个事务内执行：

1. `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` 尝试创建任务。
2. 插入成功时返回 `disposition: created`。
3. 唯一约束竞争失败时使用 `FOR UPDATE` 读取已有任务。
4. 请求哈希和 JSON 内容全部一致时返回 `disposition: existing`。
5. 任一请求字段不一致时抛出 `idempotency_key_conflict`。
6. 连接、SQL、提交失败统一包装为 `task_persistence_failed`。

`AdmissionService` 不保存内存任务。数据库不可用时，请求失败且不会生成无法恢复的本地队列副本。

### 8.5 对应验收

- [`admission.test.ts`](../../packages/repofixlab/test/concurrency/admission.test.ts) 验证请求哈希、任务 ID 和字段校验。
- [`workstream2-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream2-postgres.ts) 并发提交二十个相同请求，确认数据库任务数为 1，二十个响应 task ID 完全相同。
- 同一脚本提交同键不同内容，确认返回 `idempotency_key_conflict`。
- 同一脚本断开数据库并注入事务失败，确认任务记录和审计事件数量均为 0。

## 9. 第三层：调度、Worker 槽位和上游闸门

### 9.1 解决的问题

任务提交量不能直接等于执行并发。平台必须先计算剩余执行能力，再领取相同数量的排队任务。模型调用容量还要独立于任务执行容量。

### 9.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`scheduler.ts`](../../packages/repofixlab/src/concurrency/scheduler.ts) | `TaskScheduler.start()` | 启动首次 tick 和固定周期 tick |
| 同上 | `TaskScheduler.tick()` | 取得领导权、计算槽位、领取任务、提交执行 |
| 同上 | `TaskScheduler.stop()` | 停止定时器并排空 tick 队列 |
| [`worker-pool.ts`](../../packages/repofixlab/src/concurrency/worker-pool.ts) | `WorkerPool.submit()` | 占用槽位、执行任务、登记失败、保证释放 |
| 同上 | `WorkerPool.availableSlots()` | 返回当前可领取任务数量 |
| 同上 | `WorkerPool.drain()` | 等待全部活动任务结束 |
| [`capacity-gate.ts`](../../packages/repofixlab/src/concurrency/capacity-gate.ts) | `CapacityGate.acquire()` | 取得上游名额，满载时进入先进先出等待队列 |
| 同上 | `CapacityGate.release()` | 释放名额并唤醒队首等待者 |
| [`postgres-task-store.ts`](../../packages/repofixlab/src/concurrency/postgres-task-store.ts) | `acquireSchedulerLease()` | 取得单调度器领导租约 |
| 同上 | `claimQueued()` | 按队列顺序原子领取任务 |

### 9.3 单领导调度

`TaskScheduler.tick()` 的固定步骤：

1. 通过内部 `tickQueue` 串行化当前实例的 tick。
2. 调用 `acquireSchedulerLease()` 取得领导租约。
3. 领导租约被其他实例持有时，本次领取数为 0。
4. 调用 `WorkerPool.availableSlots()` 计算空闲槽位。
5. 空闲槽位为 0 时不访问任务领取 SQL。
6. 将空闲槽位作为 `claimQueued()` 的 `limit`。
7. 将领取结果逐项提交给 `WorkerPool.submit()`。
8. 任一任务释放槽位后立即触发新 tick，加快队列补位。

### 9.4 数据库队列领取

`PostgresTaskStore.claimQueued()` 使用以下关键 SQL 语义：

- `WHERE status = 'queued'` 只读取排队任务。
- `ORDER BY enqueue_sequence` 保持先进先出。
- `FOR UPDATE SKIP LOCKED` 跳过已被其他事务锁定的行。
- `LIMIT` 等于 Worker 可用槽位。
- 同一 SQL 将任务更新为 `preparing`。
- 同一 SQL 生成 `attempt_id`、租约所有者、到期时间和心跳时间。

任务在领取事务提交前不会暴露为已占用状态。

### 9.5 Worker 槽位释放

`WorkerPool.submit()` 在进入执行前增加 `active`，在 `finally` 中无条件减少 `active`。执行器创建失败、任务执行失败、结果绑定失败都会释放槽位。

执行失败时，`TaskStoreExecutionLifecycle.recordFailure()` 使用当前状态版本把任务推进到 `failed`，失败码固定为 `task_executor_failure`。执行错误和失败状态持久化错误同时发生时，函数抛出 `AggregateError`，防止持久化失败被隐藏。

### 9.6 模型闸门

`CapacityGate` 与 `WorkerPool` 是两层不同容量：

- Worker 槽位限制正在执行的任务数。
- 模型闸门限制正在调用模型的任务数。

真实验收中 Worker 容量为 4，模型容量为 2。四项任务可以同时准备环境，其中两项进入模型调用，另外两项停留在闸门等待队列。模型调用完成后，名额直接交给队首任务。

### 9.7 对应验收

- [`capacity-gate.test.ts`](../../packages/repofixlab/test/concurrency/capacity-gate.test.ts) 验证固定上限和无占用释放错误。
- [`worker-pool.test.ts`](../../packages/repofixlab/test/concurrency/worker-pool.test.ts) 验证失败任务立即释放槽位。
- [`controlled-task-executor.ts`](../../packages/repofixlab/test/concurrency/controlled-task-executor.ts) 提供可阻塞、可失败、可统计的确定性外部执行夹具。
- [`workstream3-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream3-postgres.ts) 验证 100 项任务中 20 项活跃、80 项排队、Worker 峰值 20、模型峰值 2、跟随调度器领取数 0。

## 10. 第四层：工作区和缓存隔离

### 10.1 解决的问题

多个任务基于同一仓库运行时，Git 索引、源码文件、依赖安装产物和测试临时文件不能进入同一可写目录。共享缓存可以减少重复复制，但共享部分必须只读并具备内容校验。

### 10.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`workspace-manager.ts`](../../packages/repofixlab/src/concurrency/workspace-manager.ts) | `WorkspaceManager.prepare()` | 创建任务独占源码、暂存区和缓存入口 |
| 同上 | `directoryContentSha256()` | 对目录结构、路径和文件字节计算稳定哈希 |
| 同上 | `ensureCache()` | 串行化同一内容缓存的校验与构建 |
| 同上 | `ensureCacheEntry()` | 校验现有缓存，损坏时从可信源原子重建 |
| 同上 | `verifyOwnership()` | 校验目录路径和所有权记录 |
| 同上 | `cleanup()` | 只删除当前任务确权目录 |
| [`workspace-cleanup-lifecycle.ts`](../../packages/repofixlab/src/concurrency/workspace-cleanup-lifecycle.ts) | `TaskStoreWorkspaceCleanupLifecycle.cleanup()` | 回收失败时登记 `workspace_cleanup_failed` |

### 10.3 目录结构

```text
<run-root>/
  workspaces/<task-id>/
    .repofixlab-workspace-owner.json
    repository/
    cache/
      writable/dependencies/
      read-only/git/
      read-only/dependencies/
  results/.staging-<task-id>/
    .repofixlab-workspace-owner.json
  cache/
    git/<content-sha256>/
    dependencies/<content-sha256>/
```

每项任务有独立 `repository` 和独立可写依赖缓存。Git 内容缓存和可信依赖缓存使用内容哈希目录，通过只读链接进入任务工作区。

### 10.4 缓存构建逻辑

`ensureCacheEntry()` 执行：

1. 对可信源执行 `directoryContentSha256()`。
2. 可信源哈希不匹配时直接拒绝使用。
3. 根据 `cache kind + content SHA-256` 派生缓存路径。
4. 现有缓存哈希正确时直接复用。
5. 现有缓存损坏时恢复删除权限并移除损坏目录。
6. 复制可信源到随机暂存目录。
7. 再次计算哈希。
8. 将目录权限收紧为只读。
9. 使用 `rename()` 原子发布到内容寻址路径。
10. 并发发布冲突时复核胜出目录哈希。

`cacheOperations` 让同一进程内针对同一内容的构建共享一个 Promise，避免重复复制。

### 10.5 所有权和安全删除

`prepare()` 在工作区和结果暂存区各写一份所有权记录，记录 `task_id`、`baseline_commit` 和随机 `ownership_token`。

`cleanup()` 删除前执行三项检查：

1. 目标路径必须严格位于受管根目录内。
2. 实际路径必须等于根据 task ID 推导的固定路径。
3. 磁盘所有权记录必须与内存分配完全一致。

任一检查失败时拒绝删除。`TaskStoreWorkspaceCleanupLifecycle.cleanup()` 随后把任务推进到 `failed`，失败码为 `workspace_cleanup_failed`，使资源回收失败进入审计链。

### 10.6 实际接线边界

WORKSTREAM4 直接验收 `WorkspaceManager`。WORKSTREAM7 的真实 RepoFix 任务由受信 Controller 创建任务级 Worker 容器和独立运行目录，结果暂存区由 `ArtifactStore` 管理。两条链路共同证明文件隔离方法，当前 `LocalizeTaskExecutorFactory` 没有直接调用 `WorkspaceManager.prepare()`。

### 10.7 对应验收

- [`workspace-isolation.test.ts`](../../packages/repofixlab/test/concurrency/workspace-isolation.test.ts) 验证独立可写状态和损坏缓存重建。
- [`workstream4-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream4-postgres.ts) 让二十项任务修改同名文件，确认源仓库不变、二十份结果互不相同、只读缓存写入失败、损坏缓存得到重建。
- 同一脚本注入回收失败，确认任务状态为 `failed`，失败码为 `workspace_cleanup_failed`，审计事件数量为 1。

## 11. 第五层：租约、心跳和故障恢复

### 11.1 解决的问题

执行器退出后，数据库中的 `running` 不能永久保留。系统需要判断旧执行器已经失去所有权，还要保证两个恢复实例不能同时接管同一任务。

### 11.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`lease-manager.ts`](../../packages/repofixlab/src/concurrency/lease-manager.ts) | `TASK_HEARTBEAT_INTERVAL_MS` | 固定 20 秒心跳周期 |
| 同上 | `TASK_LEASE_DURATION_MS` | 固定 60 秒任务租约 |
| 同上 | `LeaseManager.startHeartbeat()` | 立即续租并启动定时心跳 |
| 同上 | `LeaseManager.stopHeartbeat()` | 停止单任务心跳 |
| 同上 | `LeaseManager.recoverExpired()` | 查询、竞争领取并处理到期任务 |
| 同上 | `resolveRecovery()` | 根据 checkpoint 完整性决定继续和失败 |
| [`postgres-task-store.ts`](../../packages/repofixlab/src/concurrency/postgres-task-store.ts) | `heartbeat()` | 仅为当前所有者续租 |
| 同上 | `findExpiredLeases()` | 按到期时间读取恢复候选 |
| 同上 | `claimExpiredLease()` | 使用版本和原所有者双条件原子接管 |

### 11.3 心跳逻辑

`startHeartbeat()` 先执行一次同步心跳。首次心跳被拒绝时，不创建定时器。首次心跳成功后，每 20 秒调用 `sendHeartbeat()`，把租约延长到当前时间后 60 秒。

`runScheduledHeartbeat()` 使用任务内 `running` 标记避免同一任务的心跳重叠。数据库返回所有者失配时，管理器停止该任务心跳，防止旧执行器继续续租新所有者的任务。

### 11.4 恢复逻辑

`recoverExpired(limit)` 执行：

1. 查询租约已经到期的执行态任务。
2. 每个恢复实例都能看到候选快照。
3. 使用 `task_id + expected_version + previous lease owner` 调用 `claimExpiredLease()`。
4. 只有一个实例能把任务推进到 `recovering`。
5. 读取当前 attempt 的 checkpoint。
6. 校验 checkpoint 的 `attempt_id` 和旧租约所有者。
7. 调用 `evaluateAttemptRecovery()` 评估完整性。
8. 完整 checkpoint 使任务回到 `running`，attempt ID 保持不变。
9. 缺失、读取失败、绑定错误、不完整 checkpoint 使任务进入 `failed`。
10. 失败码固定为 `checkpoint_incomplete`。

继续原 attempt 能保持 token 账本偏移不变，防止模型费用重复登记。

### 11.5 对应验收

- [`lease-manager.test.ts`](../../packages/repofixlab/test/concurrency/lease-manager.test.ts) 验证固定心跳和只恢复完整 checkpoint。
- [`workstream5-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream5-postgres.ts) 终止四项活动任务并推进测试时钟 61 秒。
- 两个恢复所有者同时竞争后，四项任务的恢复领取次数均为 1。
- 两份完整 checkpoint 回到 `running`，两份不完整 checkpoint 进入 `failed`，模型账本记录数不增加。

## 12. 第六层：基线门禁和不可变结果

### 12.1 解决的问题

任务开始时的代码基线可能在执行期间失效。任务产物也可能写到一半、被重复发布、被篡改、被写到其他任务目录。完成状态必须建立在基线一致和结果完整两个事实之上。

### 12.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`result-gate.ts`](../../packages/repofixlab/src/concurrency/result-gate.ts) | `ResultGate.verifyBaseline()` | 比较冻结基线和目标当前提交 |
| 同上 | `ResultGate.publish()` | 生成清单并原子发布结果目录 |
| 同上 | `ResultGate.recordManifest()` | 复核清单和清单列出的全部产物后完成任务 |
| 同上 | `parseManifest()` | 校验清单结构、枚举、路径和重复项 |
| [`artifact-store.ts`](../../packages/repofixlab/src/storage/artifact-store.ts) | `ArtifactStore.createNew()` | 创建全新暂存目录，拒绝复用历史目录 |
| 同上 | `ArtifactStore.writeNew()` | 独占创建文件并记录字节数、哈希和来源 |
| 同上 | `ArtifactStore.publishTo()` | 使用同级目录原子重命名完成发布 |
| 同上 | `ArtifactStore.listArtifacts()` | 按路径稳定排序返回产物元数据 |
| [`postgres-task-store.ts`](../../packages/repofixlab/src/concurrency/postgres-task-store.ts) | `recordResult()` | 原子绑定最终清单并进入 `completed` |

### 12.3 基线复核

`verifyBaseline()` 只接受 `validating` 任务：

1. 通过 `BaselineSource.currentCommit()` 重新读取目标提交。
2. 当前提交等于任务冻结基线时进入 `publishing`。
3. 当前提交已经变化时进入 `revalidation_required`。
4. 基线未通过时不创建最终结果目录。

### 12.4 不可变发布

`ArtifactStore.writeNew()` 使用以下步骤保证单文件不覆盖：

1. 校验相对路径，拒绝绝对路径、反斜线、空段和目录穿越。
2. 使用 `wx` 创建随机临时文件。
3. 写入完整字节并执行文件同步。
4. 通过硬链接独占创建目标文件。
5. 删除临时文件并同步父目录。
6. 保存字节数、SHA-256、媒体类型、敏感级别和生产者。

`ArtifactStore.publishTo()` 要求目标与暂存目录属于同一父目录，目标不存在，追加流全部关闭。满足条件后使用 `rename()` 原子发布整个目录。

### 12.5 清单复核

`ResultGate.recordManifest()` 重新从最终目录读取证据：

1. 检查发布凭据绑定当前 task ID 和基线。
2. 检查清单路径固定为 `results/<task-id>/result-manifest.json`。
3. 检查最终目录和清单都是非链接的普通目录及文件。
4. 重新计算清单 SHA-256。
5. 解析清单并检查产物路径不重复。
6. 逐项读取产物，复核字节数和 SHA-256。
7. 全部通过后调用 `recordResult()` 进入 `completed`。
8. 任一项失败时进入 `failed`，失败码为 `result_manifest_invalid`。

### 12.6 对应验收

- [`result-gate.test.ts`](../../packages/repofixlab/test/concurrency/result-gate.test.ts) 验证基线变化后直接进入 `revalidation_required`。
- [`workstream6-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream6-postgres.ts) 验证四项基线失效、四项发布失败、一次清单损坏和同任务双发布竞争。
- 双发布竞争只有一方成功，首次发布的产物字节不变化。
- 最终状态固定为 11 项 `completed`、1 项 `failed`、4 项 `publishing`、4 项 `revalidation_required`。

## 13. 第七层：真实 RepoFix 定位接线

### 13.1 解决的问题

前六层证明基础模块正确，第七层证明这些模块能够承载真实 Controller、真实模型调用和真实 RepoFix 阶段，不是只对测试执行器有效的演示结构。

### 13.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`localize-workflow.ts`](../../packages/repofixlab/src/concurrency/localize-workflow.ts) | `runRepoFixLocalization()` | 真实执行 `UNDERSTAND`、`LOCALIZE` 并在边界停止 |
| 同上 | `LocalizationBoundaryReached` | 内部控制信号，表示定位产物已经完整落盘 |
| [`localize-task-executor.ts`](../../packages/repofixlab/src/concurrency/localize-task-executor.ts) | `runLocalizationAttempt()` | 完成任务绑定、Controller、模型、证据和回收闭环 |
| 同上 | `LocalizeTaskExecutor` | 绑定单项任务和 attempt |
| 同上 | `LocalizeTaskExecutorFactory.create()` | 根据幂等键实例映射创建独立执行器 |
| 同上 | `LocalizeTaskExecutorFactory.executeTask()` | 推进状态、心跳、定位、基线、发布、终态 |
| 同上 | `createDefaultLocalizeExecutionDependencies()` | 创建真实 Controller、冻结任务源和 DeepSeek 会话依赖 |
| [`workstream7-localize.ts`](../../packages/repofixlab/test/concurrency/workstream7-localize.ts) | `main()` | 组装 26 项真实任务并生成验收报告 |
| 同上 | `auditPublishedResults()` | 独立审计结果归属、覆盖、完整性和阶段边界 |

### 13.3 单任务执行闭环

`LocalizeTaskExecutorFactory.executeTask()` 的完整顺序：

1. 根据幂等键取得冻结实例 ID。
2. 把任务从 `preparing` 推进到 `running`。
3. 启动 `LeaseManager` 心跳。
4. 为当前 task ID 创建独占 `ArtifactStore` 暂存区。
5. 调用 `runLocalizationAttempt()`。
6. 保存 Controller 观察到的真实基线。
7. 把任务从 `running` 推进到 `validating`。
8. 调用 `ResultGate.verifyBaseline()`。
9. 基线一致时调用 `ResultGate.publish()`。
10. 调用 `ResultGate.recordManifest()` 完成清单复核。
11. 确认任务状态为 `completed`。
12. 在 `finally` 中停止心跳并减少活动计数。

执行失败时，函数尝试写入 `execution-error.json`，随后把仍处于执行态的任务推进到 `failed`。

WORKSTREAM7 创建 `WorkerPool` 时使用 `SelfManagedExecutionLifecycle`。该空适配器不重复登记失败，因为 `LocalizeTaskExecutorFactory.executeTask()` 已经持久化当前准确状态和失败原因，避免 WorkerPool 使用旧任务快照再次推进状态。

### 13.4 Controller 与模型调用闭环

`runLocalizationAttempt()` 执行：

1. 加载冻结任务环境锁和公共任务记录。
2. 核对仓库、基线、问题文本与队列请求完全一致。
3. 写入公共任务和环境锁证据。
4. 调用 Controller `preflight()` 核对候选哈希、环境锁哈希和基线。
5. 调用 Controller `prepare()` 创建任务级 Worker 并取得 lease ID。
6. 发送一次 `repo_list` 探针，确认 Worker 工具链可用。
7. 调用 `modelGate.acquire()` 取得模型名额。
8. 创建冻结 RepoFix 会话并安装 32 轮模型调用上限。
9. 调用 `runRepoFixLocalization()`。
10. 将 `UNDERSTAND`、`LOCALIZE`、上下文预算、恢复事件、控制轨迹和消息轨迹写入暂存区。
11. 统计模型轮次、Provider token、模型等待时间和 Agent 墙钟时间。
12. 在 `finally` 中释放会话、临时目录、模型名额并中止 Controller attempt。
13. Controller 返回 `clean=true` 后写入 `localize-summary.json`。

模型凭据只进入 Orchestrator 进程。Controller 只接收任务运行请求和工具调用，不接触模型密钥。

### 13.5 为什么在 LOCALIZE 停止

`runRepoFixLocalization()` 检查工作流前两阶段必须为 `UNDERSTAND` 和 `LOCALIZE`。`LOCALIZE` 的阶段完成回调成功后抛出内部 `LocalizationBoundaryReached`，函数只捕获这一种边界信号。

同时配置：

- `capturePatch()` 固定抛出 `repofix_localization_patch_capture_forbidden`。
- `controlledVerify()` 固定抛出 `repofix_localization_verification_forbidden`。
- 完成后要求阶段集合精确等于 `UNDERSTAND`、`LOCALIZE`。

因此真实验收执行了代码理解和定位，没有执行 `IMPLEMENT`、`REFINE`、补丁生成和代码测试。这个边界节省本机验收时间，同时保留真实模型、真实仓库工具、真实 Controller 和真实结果发布链路。

### 13.6 对应验收

- [`localize-workflow.test.ts`](../../packages/repofixlab/test/concurrency/localize-workflow.test.ts) 确认完成 `UNDERSTAND`、`LOCALIZE` 后不进入 `PLAN`。
- [`workstream7-preflight.ts`](../../packages/repofixlab/test/concurrency/workstream7-preflight.ts) 在模型调用前检查 26 项任务绑定，首批同时准备 4 个 Worker，随后全部回收。
- [`workstream7-localize.ts`](../../packages/repofixlab/test/concurrency/workstream7-localize.ts) 真实执行 26 项任务并发布结果报告。

## 14. 第八层：Controller 容量和运行信任链

### 14.1 解决的问题

真实任务并发不能通过复制未受信 Controller 服务实现。Controller 必须保持唯一受信身份，同时管理多个任务级隔离 Worker，并且容量需要明确上限。

### 14.2 脚本与核心符号

| 脚本 | 类、函数 | 作用 |
| --- | --- | --- |
| [`runtime_service.py`](../../packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py) | `RuntimeOperationService.__init__()` | 校验 1 到 16 的容量并恢复持久状态 |
| 同上 | `RuntimeOperationService.preflight()` | 返回任务绑定和当前容量证据 |
| 同上 | `RuntimeOperationService.prepare_worker()` | 容量未满时创建 Worker 并登记 attempt |
| 同上 | `destroy_worker()`、`abort_attempt()`、`acknowledge_artifacts()` | 回收后释放 attempt 容量 |
| [`app.py`](../../packages/repofixlab/controller/src/repofixlab_controller/app.py) | `_runtime_capacity_from_environment()` | 严格解析 `REPOFIXLAB_RUNTIME_CAPACITY` |
| [`container_factory.py`](../../packages/repofixlab/controller/src/repofixlab_controller/container_factory.py) | `inspect_controller_execution()` | 校验 Controller 容器、镜像、Compose、网络和安全配置 |
| [`runtime_docker.py`](../../packages/repofixlab/controller/src/repofixlab_controller/runtime_docker.py) | `evaluator_kernel_aggregate()` | 计算冻结 evaluator 文件聚合哈希 |
| [`compose.yaml`](../../compose.yaml) | `controller` | 本机容量固定为 4，保留单一受信服务名 |

### 14.3 容量逻辑

`RuntimeOperationService` 使用 `_capacity_attempt_ids` 集合保存占用者：

1. `prepare_worker()` 检查集合大小。
2. 集合大小达到容量时抛出 `RuntimeCapacityBusy`。
3. Worker 创建成功后加入 attempt ID。
4. Worker 销毁、attempt 中止、产物确认后移除 attempt ID。
5. Controller 恢复并清理残留资源后重建容量状态。

本机 `compose.yaml` 将 `REPOFIXLAB_RUNTIME_CAPACITY` 固定为 4。代码默认值保持 1，未显式配置的既有运行保持单任务安全行为。

### 14.4 信任链逻辑

`inspect_controller_execution()` 固定检查：

- 容器主机名匹配精确容器 ID 前缀。
- Compose 项目名匹配受信项目。
- Compose 服务名精确等于 `controller`。
- 正在运行的镜像 ID 可被精确读取。
- 镜像标签中的 Compose 配置哈希等于容器配置哈希。
- 根文件系统只读。
- Linux capabilities 精确移除 `ALL`。
- `no-new-privileges` 已启用。
- 不发布宿主机端口。
- 只连接一个受信控制网络。

`evaluator_kernel_aggregate()` 对 evaluator 文件路径、字节数和 SHA-256 做规范聚合。Controller 启动时复算并比对冻结哈希，代码漂移时拒绝加载运行内核。

### 14.5 形成的架构决策

本机并发采用一个受信 Controller HTTP 门面管理四个独立 Worker 容器。该结构保留 Controller 身份校验，任务隔离发生在 Worker 层，容量控制发生在 Controller 服务层。

实际问题和修复过程见 [PROBLEM_RESOLUTION.md](./PROBLEM_RESOLUTION.md)。

## 15. 第九层：本机 Docker 验收环境

### 15.1 固定配置

[`local-16gb.json`](../../packages/repofixlab/configs/concurrency/local-16gb.json) 保存全部本机参数：

| 参数 | 值 |
| --- | ---: |
| 受控任务数 | 100 |
| 提交批次 | 20 |
| 每批任务数 | 5 |
| 提交间隔 | 3 秒 |
| Worker 容量 | 20 |
| 模型容量 | 2 |
| 真实定位任务数 | 26 |
| 真实定位 Worker 容量 | 4 |
| 真实定位批次 | 7 |
| PostgreSQL 中断 | 5 秒 |
| 调度 tick | 1 秒 |
| 调度租约 | 5 秒 |
| 任务租约 | 60 秒 |
| 容器内存峰值上限 | 12 GiB |
| 系统可用内存下限 | 2 GiB |

[`local-profile.ts`](../../packages/repofixlab/test/concurrency/local-profile.ts) 的 `loadLocalConcurrencyProfile()` 不只是读取 JSON，还逐字段核对全部固定值。配置被临时改写时，验收脚本直接报 `local_concurrency_profile_contract_mismatch`，防止降低压力后仍输出通过结论。

### 15.2 Compose 服务

[`compose.yaml`](../../compose.yaml) 中的关键服务：

| 服务 | 作用 | 关键限制 |
| --- | --- | --- |
| `concurrency-postgres` | 提供 PostgreSQL 16 测试真相源 | 1 GiB、1 CPU、tmpfs 数据目录 |
| `concurrency-workspace-test` | 在只读容器中运行工作区验收 | 只给 `/run/repofixlab` 可写 tmpfs |
| `controller` | 单一受信 Controller 门面 | 只读根、无额外 capability、容量 4 |
| `concurrency-workstream7-preflight` | 模型调用前检查任务和 Worker 绑定 | 不加载模型密钥 |
| `concurrency-workstream7-localize` | 执行真实 26 项定位任务 | 12 GiB、4 CPU、模型密钥以 secret 文件挂载 |

[`concurrency-localize.Dockerfile`](../../packages/repofixlab/docker/concurrency-localize.Dockerfile) 基于已验收 Orchestrator 镜像，安装锁定依赖，复制当前 RepoFixLab 源码，并把 Compose 配置 SHA-256 写入镜像标签。

### 15.3 PostgreSQL 中断注入

WORKSTREAM7 不是删除数据库容器，而是将同一 PostgreSQL 容器从控制网络断开 5 秒后重新连接。这样能够验证“连接短时不可用后继续原队列”，不会把测试改变成 tmpfs 数据丢失测试。

`workstream7-localize.ts` 在 Worker 活跃数达到 4 后，独占写入 `db-interruption-ready.json`。宿主机根据文件触发故障，不依赖控制台日志到达时间。数据库断开期间：

- 调度 tick 失败并计数。
- 报告轮询失败并计数。
- 不创建内存态完成记录。
- 数据库恢复后继续读取原任务状态。

## 16. WORKSTREAM1 到 WORKSTREAM7 怎样逐步完成

| 工作流 | 入口脚本 | 新增能力 | 关键 badcase |
| --- | --- | --- | --- |
| WORKSTREAM1 | [`workstream1-postgres.mjs`](../../packages/repofixlab/test/concurrency/workstream1-postgres.mjs) | 状态机、版本、事务审计 | 二十事务竞争同一版本只有一次成功 |
| WORKSTREAM2 | [`workstream2-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream2-postgres.ts) | 准入和幂等 | 二十次同请求只生成一个任务 |
| WORKSTREAM3 | [`workstream3-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream3-postgres.ts) | 调度、Worker 槽位、模型闸门 | 20 活跃、80 排队、模型峰值 2 |
| WORKSTREAM4 | [`workstream4-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream4-postgres.ts) | 工作区、缓存、确权回收 | 二十任务同名写入无污染 |
| WORKSTREAM5 | [`workstream5-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream5-postgres.ts) | 心跳、租约、恢复 | 双恢复实例只产生一个接管者 |
| WORKSTREAM6 | [`workstream6-postgres.ts`](../../packages/repofixlab/test/concurrency/workstream6-postgres.ts) | 基线和结果门禁 | 双发布只有一份结果成功 |
| WORKSTREAM7 | [`workstream7-localize.ts`](../../packages/repofixlab/test/concurrency/workstream7-localize.ts) | 真实 Controller、真实模型、真实 RepoFix | 数据库中断后 26 项定位全部完成 |

这个顺序遵循一个原则：先冻结真相和原子性，再增加并发；先证明资源隔离和恢复，再接入真实付费模型。

## 17. 真实验收报告怎样判定通过

`workstream7-localize.ts` 的 `main()` 从 PostgreSQL、文件系统、进程、cgroup 和系统内存收集证据。`accepted` 必须同时满足：

- 完成任务数为 26。
- 失败任务数为 0。
- 结果清单绑定数为 26。
- 重复任务数为 0。
- 交叉写入数为 0。
- 产物覆盖数为 0。
- 产物完整性失败数为 0。
- 越界阶段产物数为 0。
- 残留活跃租约数为 0。
- Worker 峰值为 4。
- 模型峰值为 2。
- 数据库中断已经被调度失败及轮询失败观测。
- 容器内存峰值不超过 12 GiB。
- 系统可用内存不低于 2 GiB。

`auditPublishedResults()` 逐任务重新读取最终清单和清单列出的全部产物，不信任执行器内存统计。报告通过 `ArtifactStore` 写入 `.staging-reports`，再原子发布到 `reports`。

已接受证据：[`local-16gb-report.json`](../../artifacts/concurrency/workstream7/workstream7-20260809T092401878Z-26-localize-v3/reports/local-16gb-report.json)

实测结果：

| 指标 | 结果 |
| --- | ---: |
| 真实任务 | 26 |
| 完成 | 26 |
| 失败 | 0 |
| Worker 峰值 | 4 |
| 模型峰值 | 2 |
| 结果清单 | 26 |
| 定位候选 | 87 |
| 调度 tick 失败 | 3 |
| 重复任务 | 0 |
| 交叉写入 | 0 |
| 产物覆盖 | 0 |
| 完整性失败 | 0 |
| 越界阶段产物 | 0 |
| 丢失终态 | 0 |
| 残留活跃租约 | 0 |
| 最终状态 | `accepted` |

## 18. 注释核心约束

并发脚本使用三种统一中文注释格式。注释描述责任和边界，不复述语句表面行为。

### 18.1 脚本级

```ts
/**
 * 脚本职责：说明该文件拥有的唯一职责。
 * 输入边界：说明该文件接收的数据和可信边界。
 * 输出边界：说明该文件产生的状态、结果和副作用。
 */
```

### 18.2 类级

```ts
/**
 * 类职责：说明该类协调的业务能力。
 * 持有状态：说明实例内部保存的状态。
 * 协作边界：说明该类明确不承担的职责。
 */
```

### 18.3 函数级

```ts
/**
 * 函数职责：说明函数完成的单项工作。
 * 输入约束：说明调用前必须成立的条件。
 * 返回结果：说明成功后的确定输出。
 * 失败语义：说明失败时抛出的错误和状态保证。
 */
```

Python 脚本使用对应字段的 docstring。SQL 函数通过函数名、参数约束和测试脚本表达相同边界。

## 19. 开发者阅读和扩展顺序

新开发者按以下顺序阅读，能够最快建立正确心智模型：

1. 阅读 `contracts.ts` 和 `001_concurrency.sql`，理解状态真相。
2. 阅读 `task-store.ts` 和 `postgres-task-store.ts`，理解原子持久化。
3. 阅读 `admission-service.ts`，理解任务身份。
4. 阅读 `scheduler.ts`、`worker-pool.ts`、`capacity-gate.ts`，理解流量控制。
5. 阅读 `workspace-manager.ts`，理解文件隔离和缓存。
6. 阅读 `lease-manager.ts`，理解失联恢复。
7. 阅读 `artifact-store.ts` 和 `result-gate.ts`，理解完成门槛。
8. 阅读 `localize-workflow.ts` 和 `localize-task-executor.ts`，理解真实 RepoFix 接线。
9. 阅读七个 WORKSTREAM 脚本，理解每项不变量怎样被 badcase 触发。
10. 阅读真实报告，核对实现结论和范围边界。

## 20. 当前已完成范围和待完成范围

### 20.1 已完成

- PostgreSQL 持久队列、状态版本和审计事件。
- 幂等准入和稳定任务 ID。
- 单领导调度和固定 Worker 容量。
- 独立模型容量闸门。
- 工作区隔离、内容寻址只读缓存和安全回收。
- 任务租约、心跳、单所有者恢复和 checkpoint 判定。
- 基线复核、不可变制品发布和清单完整性复核。
- 单一受信 Controller 管理多任务 Worker。
- 26 项真实 RepoFix 定位、本机故障注入和可展示报告。

### 20.2 明确未完成

- 企业环境 1,000 任务、200 活跃任务容量压测。
- `IMPLEMENT`、`REFINE`、代码测试和修复质量评价。
- Git、测试服务、制品服务的独立生产闸门接线。
- 多租户配额、单仓库配额和任务优先级。
- 生产监控面板、告警规则和自动扩缩容。
- 取消接口和超时治理。

这些内容不能从本机 `accepted` 结论中推导为已经完成。

## 21. 最终理解

这套基础设施的核心不是“同时启动更多任务”，而是把并发拆成五个可独立控制的事实：

1. 请求身份由幂等键和请求哈希确定。
2. 任务状态由 PostgreSQL 版本和审计事务确定。
3. 执行压力由 Worker 槽位和上游闸门确定。
4. 任务归属由工作区所有权和租约确定。
5. 完成事实由基线检查、结果清单和文件哈希确定。

五个事实互相解耦又在任务 ID 上汇合，形成了当前高并发代码开发场景的基础设施闭环。
