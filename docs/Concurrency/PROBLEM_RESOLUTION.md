# 高并发基础设施问题解决记录

## 1. 文档目的

本文记录高并发基础设施开发和 WORKSTREAM7 真实定位验收期间遇到的实际问题，说明现象、根因、具体解决、验证结果和保留边界。

相关文档：

- 场景定义：[BACKGROUND.md](./BACKGROUND.md)
- 架构设计：[DESIGN.md](./DESIGN.md)
- 本机实施：[ACTUAL_IMPLEMENTATION.md](./ACTUAL_IMPLEMENTATION.md)
- 执行计划：[执行计划.md](./执行计划.md)

## 2. 最终结果

最终通过运行：`workstream7-20260809T092401878Z-26-localize-v3`。

关键结果：

- 真实定位任务数：26。
- 定位完成数：26。
- 失败数：0。
- Worker 峰值：4。
- 模型调用峰值：2。
- PostgreSQL 中断观测：通过。
- 重复任务数：0。
- 交叉写入数：0。
- 制品覆盖数：0。
- 越界阶段产物数：0。
- 丢失终态数：0。
- 残留活跃租约数：0。
- 最终状态：`accepted`。

验收证据：[local-16gb-report.json](../../artifacts/concurrency/workstream7/workstream7-20260809T092401878Z-26-localize-v3/reports/local-16gb-report.json)

## 3. 问题一：Controller 只能运行一个任务

### 现象

首次真实运行按 4 并发提交 26 项任务，最终只有 1 项完成，25 项失败。失败证据统一为：

```text
Controller runtime returned HTTP 429: runtime capacity is busy
```

失败运行 ID：`workstream7-20260809T084611516Z-26-localize-v1`。

失败证据：[local-16gb-report.json](../../artifacts/concurrency/workstream7/workstream7-20260809T084611516Z-26-localize-v1/reports/local-16gb-report.json)

### 根因

`RuntimeOperationService` 使用单个 `_capacity_attempt_id` 保存容量所有者。一个 attempt 准备 Worker 后，其他 attempt 全部被容量门禁拒绝。预检清单中的容量也固定为 1。

该实现满足原有单任务安全策略，但不能支持 WORKSTREAM7 的 4 任务并发。

### 具体解决

1. 在 `RuntimeOperationService.__init__()` 增加 `capacity` 参数，默认值保持 1。
2. 将容量允许范围固定为 1 到 16，拒绝布尔值、越界整数和非整数。
3. 使用 `_capacity_attempt_ids` 集合保存当前容量所有者。
4. `prepare_worker()` 在集合数量达到容量时返回 `RuntimeCapacityBusy`。
5. Worker 准备成功后登记 attempt 标识。
6. Worker 销毁、attempt 中止、产物确认成功后释放 attempt 标识。
7. Controller 重启恢复结束后清空已回收容量。
8. `app.py` 从 `REPOFIXLAB_RUNTIME_CAPACITY` 读取规范整数。
9. `compose.yaml` 将本机 Controller 容量固定为 4。

对应实现：

- `packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py`
- `packages/repofixlab/controller/src/repofixlab_controller/app.py`
- `packages/repofixlab/controller/tests/test_runtime_capacity.py`
- `packages/repofixlab/controller/tests/test_app.py`
- `compose.yaml`

### 验证结果

- 容量单测确认前 4 个 attempt 成功占用容量，第 5 个 attempt 被拒绝。
- 回收 1 个 attempt 后，第 5 个 attempt 成功进入。
- 真实预检同时准备 4 个 Worker，模型调用数为 0。
- 最终真实运行的 Worker 峰值为 4，26 项任务全部完成。

## 4. 问题二：横向复制 Controller 被信任校验拒绝

### 现象

最初尝试创建 4 个 Controller 服务实例。4 个容器启动后全部退出，固定错误为：

```text
Controller Compose identity does not match
```

### 根因

Controller 会自检 Docker 容器身份。`inspect_controller_execution()` 固定校验：

- Compose 项目必须为 `repofixlab`。
- Compose 服务名必须为 `controller`。
- 当前容器 ID 必须与主机名一致。
- 镜像标签中的 Compose 配置哈希必须等于容器配置哈希。
- Controller 只能连接一个受信网络。

复制服务使用新服务名和新配置哈希，不满足现有信任边界。直接放宽校验会降低 Controller 的运行身份可信度。

### 具体解决

1. 撤销多 Controller 服务方案。
2. 删除 4 个失败容器和 4 个空工作卷。
3. 保留单个受信 Controller HTTP 门面。
4. 由单个 Controller 管理 4 个独立 Worker 容器。
5. 每个任务继续持有独立工作区、租约和结果目录。
6. 不修改 `inspect_controller_execution()` 的信任规则。

对应实现：

- `packages/repofixlab/controller/src/repofixlab_controller/container_factory.py`
- `packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py`
- `packages/repofixlab/test/concurrency/workstream7-preflight.ts`

### 验证结果

- Controller 服务身份保持为 `controller`。
- Controller 健康检查通过。
- 预检报告中的 `prepared_controllers` 为 4。
- 真实运行期间同时存在 4 个任务级 Worker 容器。
- 运行结束后 Worker 容器全部回收。

## 5. 问题三：Controller 镜像与 Compose 配置哈希不一致

### 现象

增加 `REPOFIXLAB_RUNTIME_CAPACITY=4` 后重建 Controller 容器，旧镜像无法启动。固定错误为：

```text
Controller running image or Compose config binding does not match
```

### 根因

Controller 镜像在构建时写入标签 `io.repofixlab.compose-config-sha256`。服务配置变化后，容器的 `com.docker.compose.config-hash` 发生变化，旧镜像标签仍保存旧哈希。

镜像与容器配置不再属于同一份受信配置，Controller 按设计拒绝启动。

### 具体解决

1. 使用最终 `compose.yaml` 创建 Controller 容器配置。
2. 从容器标签读取最终 `com.docker.compose.config-hash`。
3. 使用该哈希作为 `REPOFIXLAB_COMPOSE_CONFIG_SHA256` 构建参数。
4. 重建 `repofixlab-controller` 镜像。
5. 强制重建 Controller 容器，保留 `controller-work-v2` 工作卷。
6. 对比镜像标签和容器配置哈希，要求两者完全相同。

对应实现：

- `packages/repofixlab/docker/controller.Dockerfile`
- `packages/repofixlab/controller/src/repofixlab_controller/container_factory.py`
- `compose.yaml`

### 验证结果

- 镜像标签与容器配置哈希均为 `afa91137e3814eae62432a33b606a2f5e5abafc6d6714e28ca9232082c67bd0e`。
- Controller 状态为 `running`。
- Controller 健康状态为 `healthy`。
- 原工作卷和运行日志得到保留。

## 6. 问题四：evaluator 冻结哈希漂移

### 现象

Controller 完成身份哈希绑定后，启动阶段再次失败。固定错误为：

```text
evaluator kernel aggregate drifted
```

### 根因

当前仓库中的 evaluator 文件聚合哈希为：

```text
2383940496a01fbf7dcd36de1d7774e3a6e9a8a753f3ffa4b18260e4d8bc8517
```

`controller.Dockerfile` 仍保存旧冻结哈希。`DockerRuntimeBackend` 会重新计算 evaluator 文件集合的聚合哈希，并与配置值逐字比较，因此拒绝加载不一致的运行内核。

### 具体解决

1. 复用 `evaluator_kernel_aggregate()` 计算当前 evaluator 文件集合哈希。
2. 将 Dockerfile 中的 `REPOFIXLAB_RUNTIME_EVALUATOR_KERNEL_SHA256` 更新为计算结果。
3. 重建 Controller 镜像。
4. 保留 `DockerRuntimeBackend` 的哈希校验，不增加跳过开关。

对应实现：

- `packages/repofixlab/controller/src/repofixlab_controller/runtime_docker.py`
- `packages/repofixlab/docker/controller.Dockerfile`

### 验证结果

- Controller 启动阶段完成 evaluator 哈希校验。
- Controller 健康检查通过。
- 4 Worker 真实预检通过。
- 26 项真实定位任务均使用该冻结 evaluator 配置。

## 7. 问题五：数据库故障注入信号被控制台缓冲

### 现象

运行器输出 `db_interruption_ready` 后，宿主机本应立即中断 PostgreSQL 5 秒。实际运行中，Docker 命令输出直到进程结束才返回，宿主机无法按事件时点执行故障注入。

### 根因

控制台输出经过 PowerShell、Docker Compose 和进程管道传递，事件文本不是可靠的跨进程同步信号。依赖日志到达时间无法保证确定触发。

### 具体解决

1. 运行器等待 `WorkerPool` 活跃数达到 4。
2. 在运行根目录写入 `db-interruption-ready.json`。
3. 文件内容保存事件名和运行 ID。
4. 写入使用 `flag: "wx"`，禁止覆盖旧信号。
5. 写入成功后继续输出同名控制台事件，保留人工可读日志。
6. 宿主机轮询固定标记路径，发现文件后立即执行 5 秒故障注入。

对应实现：

- `packages/repofixlab/test/concurrency/workstream7-localize.ts`

### 验证结果

- 标记文件在 4 个任务进入活跃状态后生成。
- 宿主机在真实运行期间发现标记。
- PostgreSQL 故障注入在任务尚未完成时执行。
- 最终报告记录 `database_interruption_observed=true`。

## 8. 问题六：故障标记父目录不存在

### 现象

第二次真实运行尝试写入标记文件时退出：

```text
ENOENT: no such file or directory, open '/artifacts/concurrency/workstream7/<run-id>/db-interruption-ready.json'
```

### 根因

运行根目录此前依赖任务制品写入流程间接创建。调度器达到 4 个活跃任务时，制品目录尚未完成创建，标记写入先于目录创建。

### 具体解决

1. 在 `main()` 中计算 `runRoot`。
2. 在重建数据库结构和提交任务前执行：

   ```ts
   await mkdir(runRoot, { recursive: true });
   ```

3. 使用新运行 ID 重试，避免复用失败运行的目录和状态。

对应实现：

- `packages/repofixlab/test/concurrency/workstream7-localize.ts`

### 验证结果

- 新运行成功创建标记文件。
- 标记文件使用独占写入，没有覆盖历史证据。
- 运行器继续执行到 26 项任务全部终态。

## 9. 问题七：数据库中断不能破坏测试数据

### 现象

本机 PostgreSQL 数据目录使用 tmpfs。直接删除容器再创建会清空数据库，无法验证“短时中断后继续原队列”。

### 根因

测试目标是验证连接短时不可用后的调度恢复，不是验证数据库数据卷灾难恢复。重建 tmpfs 容器会改变故障类型，并使原队列失去验证基础。

### 具体解决

1. 保持 PostgreSQL 容器、进程和 tmpfs 数据不变。
2. 将 PostgreSQL 容器从 `repofixlab_repofix-control` 网络断开。
3. 保持断开状态 5 秒。
4. 将同一容器重新连接到原网络。
5. 运行器在查询失败期间只记录失败次数，不写入内存终态。
6. 网络恢复后由 PostgreSQL 中的原任务状态继续调度。

### 验证结果

- `scheduler_tick_failures=3`。
- `database_interruption_observed=true`。
- PostgreSQL 恢复后完成剩余任务。
- 完成任务数为 26，失败数为 0。
- 重复任务数、丢失终态数、残留活跃租约数均为 0。

## 10. 问题八：本机缺少 npm 且 pnpm 改写工作区

### 现象

执行仓库规定的 `npm run check` 时，本机找不到 npm。改用 pnpm 后，pnpm 尝试接管依赖安装，生成 `pnpm-lock.yaml`，随后因 `node_modules` 权限失败。

### 根因

Codex 本机运行时提供 Node.js 和 pnpm，没有提供 npm。仓库使用 npm workspaces，pnpm 不读取相同工作区契约，直接运行会引入无关依赖行为。

### 具体解决

1. 删除 pnpm 临时生成的 `pnpm-lock.yaml`。
2. 不继续执行 pnpm 安装。
3. 使用绑定 Node.js 逐项执行根 `package.json` 中 `check` 的原始命令：
   - Biome 格式与规则检查。
   - 固定依赖检查。
   - TypeScript 相对导入检查。
   - coding-agent shrinkwrap 检查。
   - coding-agent 安装锁检查。
   - TypeScript 全仓检查。
   - 浏览器冒烟检查。
4. 回退 Biome 对 19 个既有文件产生的无关格式改写。
5. 保留本次并发目录的格式结果。

### 验证结果

- Biome 检查通过。
- 固定依赖、导入规则、shrinkwrap、安装锁、浏览器冒烟检查通过。
- 并发专项测试 8 个文件通过，15 项测试通过，2 项按环境条件跳过。
- Controller 容量和配置解析测试共 5 项通过。
- 本次并发目录 TypeScript 错误数为 0。
- 全仓 TypeScript 仍存在仓库既有类型错误，本任务未修改无关模块。

## 11. 最终架构决策

本次问题处理形成以下固定决策：

1. 使用单个受信 Controller HTTP 门面管理多个隔离 Worker。
2. Controller 容量采用有界配置，本机固定为 4，代码缺省值为 1。
3. 不通过复制服务名绕开 Controller 身份校验。
4. 不关闭 Compose 配置哈希和 evaluator 哈希门禁。
5. 故障注入使用独立文件信号，不依赖日志到达时间。
6. PostgreSQL 短时中断使用网络隔离，保持原任务数据。
7. 每次真实重试使用新运行 ID，失败证据保持不可变。
8. `LOCALIZE` 完成即停止，不执行代码修改、REFINE 和测试。

## 12. 结论边界

本文证明 26 项真实任务在本机 4 Worker、2 模型并发配置下完成定位，并通过数据库短时中断、工作区隔离和结果一致性检查。

本文不证明：

- 企业环境 1,000 任务、200 并发的生产容量。
- 代码修复质量。
- 生产监控和告警完备性。
- 多租户配额和单仓库配额策略。
