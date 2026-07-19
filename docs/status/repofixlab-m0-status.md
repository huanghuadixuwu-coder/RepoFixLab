# RepoFixLab M0 状态

更新时间：2026-07-19（Asia/Shanghai）

## 当前结论

RepoFixLab M0 为 **GO**。

本结论只表示 Axios `axios__axios-5892` 的容器化任务环境与评测基座已经形成一条可复核的正式证据链：固定数据、固定镜像、Controller 工厂探针、官方 Harness 等价性、TaskEnvironmentLock、Smoke Doctor、原子发布和残留审计均已通过。

M0 GO 不表示 RepoFix Agent 工作流、Pi agent loop 改造、M1、`formal` CLI profile 或大规模 SWE-bench 实验已经完成。当前仍未产生代码修复成功率、成本、时延或稳定性实验结论。

## 正式门禁结果

| 门禁 | 结果 | 规范证据 | 语义 SHA-256 | 文件 SHA-256 |
| --- | --- | --- | --- | --- |
| DatasetLock | PASS | `artifacts/dataset-prepare/20260718T135934707Z-243342d1916a/dataset-lock.json` | generation aggregate `e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55` | `003c0a34cd85c9254e651ab639a29171677f98e1bb06a8393b14d5893fdef95f` |
| Harness 等价性 | PASS，8/8 探针 | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/harness-equivalence.report.json` | `453ec69ef1cc22a8f040769124265c81655dc873766fa346d4468632e622c700` | `0bb2e8ef1b5842d575f0427ccc78629ffa2dfd20cdb074191037e1dadd91342b` |
| Bootstrap Doctor | PASS | `artifacts/m0/bootstrap-doctor-final-20260718T192454140Z.json` | `c4dc166165567ea90c296322194c63e54783f492b593ae8307eb2da614b184cb` | `99589d2887cdccc75be706afa11e1080ed4a6eaf9c6a33945574b4100b4d6309` |
| Worker/Evaluator Factory Probe | PASS | `artifacts/m0/factory-probe-final-20260718T192556208Z.json` | `f68e8d9ef4cb16b9a1b76c0e702fc5a7594887d8b3719a62bafb1c4d1076697b` | `024d37797ed3789fba0ba20ace84e61f0fb5ea2c7d01a451f9c2a8938b6ce65f` |
| TaskEnvironmentLock | PASS | `artifacts/m0/environment-lock-publish-20260718T192840791Z/task-environment-lock.json` | `e412c03204cb3ae4dfed277216bde5ebe182f5c0179e02e549835c1b6639bc1f` | `10cfec018b5aeb46de4cc15c8095c44ed20be52c30dbe4c6e1459b773da13e37` |
| Smoke Doctor | PASS | `artifacts/m0/smoke-doctor-publish-20260718T193053275Z/smoke-doctor-report.json` | `67f73dd0d1fcd3de1d44362f85c91d525e1226ab5e3acf01dd6e80c3b1f5bd01` | `d271d2f22aa07b5f25b72b3db414f55f5262ac5e960a4fe41f4019da5b6e89fe` |

Smoke Doctor 的全部检查组均为 `pass`，包括 Bootstrap 控制面、DatasetLock、OfficialImageSourceLock、TaskEnvironmentLock、Factory Probe、Controller 身份、PristineRuntimeLock、8 场景 Harness 矩阵、Harness 等价性和跨证据绑定。

## 镜像与运行时绑定

当前 active provenance：`artifacts/locks/bootstrap-image-provenance-lock.v1.json`

- provenance 语义 SHA-256：`56388f0a4c1ffebb5b0e8771da8451615b39b4e17a8623887a2060e77dff849a`
- provenance 文件 SHA-256：`1f281917342b97ebd57ef5575e1620277bbd7b09c823f75809437e3f05678138`
- Controller image ID：`sha256:bcd67a22931572794b5ef2c13439ec2ded77cab94372df249f0e8ae671e492f5`
- Orchestrator image ID：`sha256:411fc3d66fd3f0e154a3c162b97352cedfb1af9fe8055f1e0ee4cdeaba2de641`
- Controller container ID：`3e3be0faa306879a07dd602288f4d6336cc4617fe9c657ff7ae37d1f2ea05876`
- Controller 状态：`running`、`healthy`、`restart_count=0`

Controller 使用只读根文件系统、`cap_drop=ALL`、`no-new-privileges`、无宿主机 published port，并且只连接唯一的 internal control network。它的允许挂载严格为 Docker socket、Controller work volume、只读 candidate volume 和 `/tmp` tmpfs。

Docker Desktop 的 socket 来源只接受以下两个精确值之一，目标必须为 `/var/run/docker.sock` 且必须为读写挂载：

- `/var/run/docker.sock`
- `/run/host-services/docker.proxy.sock`

当前正式运行观测到 `/var/run/docker.sock`。任意其他来源、错误目标、只读 socket 或重复 socket 挂载都会被拒绝。Docker socket 等价于 Docker daemon root 权限，因此 Controller 是受信控制面；只读根文件系统和 capability 限制不被表述为对 daemon 权限的隔离。

## Worker 与 Evaluator 工厂事实

正式 operation ID：`factory-probe:axios-5892:20260718T192556208Z`。

- 执行顺序严格为长度 2 的 `worker`、`evaluator`；缺失、交换或额外角色均失败。
- Worker 使用 UID/GID `65532:65532`，Evaluator 使用 `0:0`。
- 两个角色均为 `network=none`、只读根文件系统、`cap_drop=ALL`、`no-new-privileges`、无设备、无 published port、无 Docker socket。
- 每个角色固定为 4 CPU、8 GiB memory、`pids_limit=512`，使用相互独立的临时任务卷。
- 两个主动探针均通过，未发现敏感环境变量或 Docker socket 路径。
- Worker 容器与卷清理通过后才创建 Evaluator；两者的残留容器、残留卷和清理错误均为 0。

## 验证结果

修复后的源码通过以下隔离验证：

- 固定 Node 基础镜像 `sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd` 执行 `npm ci --ignore-scripts`：330 packages，0 vulnerabilities。
- `network=none`、独立 `node_modules` 卷下执行根目录 `npm run check`：PASS。Biome 检查 802 个文件且没有修改；pinned dependencies、TypeScript imports、coding-agent shrinkwrap、install lock、`tsgo --noEmit` 和 browser smoke 全部通过。
- CI 中 `tsgo` 使用 `pids_limit=1024`，这是工具链所需的 CI 限制；生产 Worker/Evaluator 的 `pids_limit=512` 未改变。
- 12 个显式 RepoFixLab Vitest 文件：150/150 PASS。
- `test_container_factory.py` 与 `test_factory_service.py`：27/27 PASS。
- Harness pristine/adapted 的 base、no-op、malformed、gold：8/8 PASS。
- 最终 Smoke 输入审计：20 个可读普通文件、20 个不同 realpath、总计 157,033 bytes。

Docker Desktop 当前提供 12 CPU 和 20,972,773,376 bytes 内存，满足 Bootstrap Doctor 的 8 CPU、16 GiB 最低门槛。

## 证据副本与不可变发布协议

部分原始正式报告由 UID 1000 以 `0600` 创建。受限 root 容器已经移除 `DAC_OVERRIDE`，不能直接读取其他 UID 的 `0600` 文件。为避免放宽权限或修改原件，流水线使用受限 UID 1000 one-shot 容器创建逐字节证据副本，副本为普通文件、`0444`，并复核字节数与 SHA-256 完全一致。

本轮副本与收据：

- `artifacts/m0/bootstrap-doctor-final-20260718T192454140Z.evidence-copy-20260718T192739814Z.json`
- `artifacts/m0/factory-probe-final-20260718T192556208Z.evidence-copy-20260718T192739814Z.json`
- `artifacts/m0/bootstrap-image-provenance-lock.evidence-copy-20260718T192739814Z.json`
- `artifacts/m0/formal-evidence-copy-receipt-20260718T192739814Z.json`

TaskEnvironmentLock 使用 `artifacts/m0/environment-lock-evidence-manifest-final-replay-20260718T192739814Z.json`；Smoke 使用 `artifacts/m0/smoke-doctor-evidence-manifest-final-replay-20260718T192739814Z.json`。所有路径必须位于 artifacts 根目录内、不得经过符号链接、不得真实路径别名。

TaskEnvironmentLock 和 Smoke 的采用发布均执行同一协议：

1. UID 1000 创建唯一空目录，明确设置 owner `1000:1000`、mode `0707`。
2. 受限 root 容器原子发布唯一文件；TaskEnvironmentLock 为 `0644`，Smoke 报告为 `0600`。
3. 目录 owner 只通过 `lstat/stat` 核验唯一普通文件及 owner/mode，不读取 root `0600` 内容，然后把目录封存为 `0555`。
4. 受限 root 以只读挂载复核目录、唯一文件、JSON 状态、语义 hash 和文件 hash。

最终两个采用目录都为 owner `1000:1000`、mode `0555`，且各自只有一个普通文件。失败目录不会被改写或升级为采用结果。

## 失败尝试保留

失败证据按审计策略保留，未删除、未覆盖、未作为最终输入复用：

- Docker Desktop socket 来源不匹配尝试：`artifacts/locks/history/20260718T182756002Z-failed-controller-socket-9881f28810db/bootstrap-image-provenance-lock.v1.json`。
- 修复前 active provenance 已归档为 `artifacts/locks/history/20260718T192145563Z-failed-smoke-0e8eb85c5c27/bootstrap-image-provenance-lock.v1.json`；文件 SHA-256 为 `d3ca32c5f224556e1145e4f3a0309eb1ab92f9fbbd6617f4556ab42efcad7316`。
- 修复前 Smoke 报告：`artifacts/m0/smoke-doctor-publish-20260718T190717348Z/smoke-doctor-report.json`，状态 `fail`，语义 SHA-256 `57e3b6c4b276a66fb9df2db5921f650e9d63024befefe20c02b8285abcab7266`，文件 SHA-256 `648f1054c4061a27cb7f1407cf0d38c4fad03ef911ab0b56b3d091b3ae6cd05b`。唯一失败事实是相同执行顺序的展示字符串格式不一致；修复后改为严格数组结构比较并完整重建镜像和 provenance。
- 首个 environment-lock `0707` 发布尝试因 CLI 打开目录权限失败而保留在 `artifacts/m0/environment-lock-publish-20260718T185315393Z`，对应失败收据明确标记 `adopted=false`。

## 最终残留审计

正式 Smoke 之后的 Docker 审计结果：

- 临时 one-shot 容器：0
- `io.repofixlab.managed=true` 容器：0
- 本次 Factory operation 容器：0
- Bootstrap 临时容器：0
- Factory managed volumes：0
- 本次 Factory operation volumes：0
- Bootstrap probe volumes：0
- CI volumes：0
- Compose 容器：1，仅保留健康的 `repofixlab-controller-1`

数据生成卷、Controller work volume 和只读 candidate volume 是有意保留的正式输入或审计状态，不属于临时残留。

## M0 边界与下一阶段

M0 已完成的是环境与评测基座，不是代码修复 Agent 本身。下一阶段应在不破坏当前锁与评测边界的前提下实现 RepoFix Agent 的 `UNDERSTAND → LOCALIZE → PLAN → PATCH → CONTROLLED_VERIFY → REFINE → OFFICIAL_EVALUATE → REPORT` 工作流，然后进入 M1 纵向切片和小规模对照/消融实验。大规模 SWE-bench 运行只能在预算、任务采样、重复次数、失败分类和统计口径确定后启动。
