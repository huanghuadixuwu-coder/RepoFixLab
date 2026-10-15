# RepoFix 固定输入 Docker 基准

在 `docker` 分支使用 `manifest.json` 中的镜像、任务、补丁和资源配置运行。
每次执行使用新的输出目录。镜像与私有数据卷必须先恢复到冻结环境。
Windows PowerShell 从仓库根目录运行：

```powershell
docker run --rm --name repofixlab-wf1-baseline --network none `
  --cpus 1 --memory 512m --pids-limit 256 --read-only `
  --tmpfs /tmp:rw,exec,nosuid,size=256m `
  --mount "type=bind,source=$PWD\packages\repofixlab,target=/source,readonly" `
  --mount "type=bind,source=$PWD\artifacts\docker-wf1,target=/output" `
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock `
  --env PYTHONPATH=/source/controller/src --entrypoint python `
  sha256:25a2af725976fcef1360225f4ae4a6fe4a2d40ff7d93de2c74d6566bf468e986 `
  -m repofixlab_controller.runtime_benchmark `
  --manifest /source/configs/benchmarks/docker-v1/manifest.json `
  --output /output/baseline-new
```

追加 `--pilot` 可运行一个试验样本；正式基准按 manifest 执行 12 个样本。
冻结的 Controller 镜像提供 `m6-26-task-v1` 的只读任务锁和共享 DatasetLock。
每个样本的 preflight 校验源目录冻结的 candidate、base commit 和任务锁绑定。
Evaluator 内核 SHA256 为 `2383940496a01fbf7dcd36de1d7774e3a6e9a8a753f3ffa4b18260e4d8bc8517`；
恢复镜像内核和 skill 基线源文件的聚合哈希一致。旧 Dockerfile 环境变量保留了较早哈希；
本基准使用实际冻结内核，运行时仍执行完整哈希校验。

输入包括 Preact 4316 的历史成功补丁与 Axios 6539 的空补丁。
Worker 用固定 `repo_edit` 输入生成快照，逐字节核对补丁 SHA256，再执行冻结目录的第一个验证条目。
正式评分与制品身份在每个样本目录保留；空补丁评分为 unresolved 时仍计入已完成运行。

串行／并发按需模式中，每个任务创建全新 Worker 与 Evaluator；预热与复用模式见下文。
第 0 轮标为 first_pass，第 1、2 轮标为 repeated。
镜像已缓存，宿主页面缓存自然变化；这些条件衡量当前环境下的新建容器成本。
整批时间包括 Controller 内部初始化、所有任务准备、验证、归档、清理和采样收尾。
Docker CLI 创建 Controller 容器之前的启动成本属于宿主启动测量，当前报告单列计量边界。

`raw.ndjson` 保留带角色和父节点的单调时钟区间、精确容器生命周期、资源采样与全部任务结果。
阶段耗时按区间并集计算；整批吞吐使用实际整批墙钟时间。
预留资源按容器创建、启动、确认退出、停机及移除事件计算，包括短命 helper 和 Controller；实际 CPU、内存每 0.5 秒采样。
采样可能遗漏短暂峰值。零／未设置限制的未启动 kernel 初始化容器在生命周期证据中显式保留。
WF2 起，初始化器、seed、准备器、终结器和预热／重置工作统一纳入预算准入。

归档验证字节数、单文件哈希和制品集合哈希，落盘后才 ACK。失败样本保留异常类别和清理结果。
清理未通过时停止后续样本，保留完整失败批次。

将命令的输出目录改成已有目录，将 `--manifest` 指向该目录保存的 `manifest.json`，
追加 `--report-only` 可从原始记录重新生成报告；该操作不执行任务。
离线报告也可在不挂载 Docker socket 的 Controller 镜像中运行。

完整工作流和后续性能验收门槛见仓库 `docs/plans/repofixlab-runtime-iteration.md`。

## 并发与 Worker 预热池

追加 `--concurrency 2` 运行并发按需模式；同时追加 `--worker-pool` 运行 WF3 的一次性 Worker 池。
使用新的输出目录，例如 `artifacts/docker-wf3/worker-pool-new`，并相应调整 `/output` 挂载。
基准先对当前已知 cohort 的任务调用现有 preflight，等待这批预热结束，再并发执行。
预热发生在整批计时边界内。same 的重复环境合并为一个准备请求，另一个任务未命中时按需创建；
mixed 的两个环境分别预热。全部 Worker 使用一次后销毁，Evaluator 按需创建。

生产 Controller 的 `REPOFIXLAB_WORKER_POOL_CAPACITY` 默认为 `2`，可设为 `0` 运行按需模式或 `1` 限制池容量。
`REPOFIXLAB_WORKER_POOL_IDLE_SECONDS` 默认为 `300`，使用有限正数配置空闲寿命。
满池遇到新环境需求时，淘汰无任务兴趣的 ready 重复环境；已归还的一个 ready 容器只满足一个已知领取需求。
第二个兼容需求可淘汰无任务兴趣的 ready 不兼容环境，清理审计通过后补充；全部补充成本进入预热与整批时间。
已知任务队列可提前调用 `/internal/v1/runtime/preflight`，随后按原协议准备 Worker；
请求携带 attempt、operation、candidate 和 instance，环境和 Docker 配置从可信锁中派生。
现有 Node 调用链在各 attempt 的 preflight 阶段发起预热；队列整批提前 preflight 由本基准入口演示。

准备中和空闲 Worker 都预约角色的 CPU／内存。预热资源不足时跳过，领取未命中走有界按需准入；
正式评测准入前回收未领取的 Worker，并在准入等待期间暂停新增预热。
命中领取保留物理容器和卷的池归属标签，将资源预约原子转移至逻辑 attempt。
准备失败、任务取消、空闲过期和服务关闭均清理；清理未通过时保留预约、阻止分配，等待重试清理或重启恢复。
池命名空间保存在 journal 的 `worker-pool-namespace` 文件，恢复时使用同一 journal 数据目录。

`raw.ndjson` 增加 `worker_pool` 事件，记录环境键、物理资源归属、容器 ID、命中／未命中／合并、
准备成本及回收结果。`report.json` 提供命中率、各次准备耗时之和、预热阶段墙钟时间。
多个环境的准备耗时可重叠，整批吞吐始终使用整批墙钟时间。
报告的分组 `sample_wall_seconds` 表示样本活动区间；WF3 验收核对同时给出包含该组预热阶段的墙钟时间和吞吐。
`runtime-state.json` 记录关闭后的池、预约和领取映射；`worker-prepared.json` 与 journal 绑定各样本的唯一租约。

## Evaluator 预热池（WF4）

在 WF3 命令上追加 `--evaluator-pool`，使用新目录 `artifacts/docker-wf4/role-pools-new`。
Worker 清理与快照策略通过后，Controller 异步准备同一可信任务的 Evaluator 环境。
WF7 中，已知队列的可信 preflight 同时提出 Worker 和 Evaluator 环境需求。
Evaluator 准备、停机并核对完整基线树及空输入／证据后入池，停机预约为零。
初次就绪检查可能刷新 Git index，停机后使用可信镜像恢复并校验基线；后续领取严格校验恢复卷。
队列预热等待两角色准备完成，全部准备和校验成本计入预热与整批墙钟。
正式激活仍要求 Worker 清理和快照策略通过；领取再检查恢复卷、配置、内核和私有材料。
准备镜像、base 工作区、私有任务、评分内核和空输入／证据卷；PID 1 等待激活命令。
输入与私有卷以只读方式挂载，领取时写入冻结补丁，检查哈希，并原子发布任务与评测身份。
Evaluator 使用一次后在制品 ACK 阶段销毁。已用容器的重置与复用安排在 WF5。

生产 `REPOFIXLAB_EVALUATOR_POOL_CAPACITY` 默认 `1`，设为 `0` 使用原有按需路径；
`REPOFIXLAB_EVALUATOR_POOL_IDLE_SECONDS` 默认 `300`。
待命阶段预约 4 CPU／8 GiB，可与另一个 4 CPU／8 GiB Worker 共存；
WF7 将输入写入、角色执行和正式评分分别准入：确认待命容器停机后，输入写入器预约 2 CPU／4 GiB；
写入器移除后，Evaluator 预约 4 CPU／8 GiB 并启动；确认 Evaluator 退出后，评分终结器预约 2 CPU／4 GiB。
冷路径先写入并核对补丁，再一次启动角色；预热或重置的待命路径在停机状态写入输入后启动。
同一个 preparing 环境只供一个任务等待领取，其余需求按预算走按需创建。
领取绑定在 claiming 状态中执行，继续占池容量；Docker 校验期间释放池锁，让其他环境的请求推进。
扩容等待保留原预约，支持有界排队、超时与取消。持有资源的扩容在预算允许时优先完成，
随后释放资源，让按需队列推进。冷启动预算不足时回收计算资源仍被占用的未领取预热环境，
预算允许时继续保留可供后续任务领取的环境。

领取检查实际镜像、限制、安全配置、固定挂载、启动命令、base commit、内核、私有任务哈希及空状态。
准备失败、取消、过期、ACK、关闭和重启恢复使用同一物理归属清理；清理失败继续计费并阻止分配。
重启扫描同一 journal 命名空间下的两个角色池，包括配置关闭后的残留资源。
协议入口保持现有 preflight、Worker destroy 和 evaluation start。

`raw.ndjson` 增加 `evaluator_pool` 事件与 `queue.stage_expansion` 区间。
报告记录预热成本、命中率和 Evaluator 准备与其他 Worker 验证的实际交叠时间。
整批墙钟包含全部预热、扩容等待、评测与清理成本。
`worker-destroyed.json`、`evaluation-started.json` 和制品记录共同校验补丁、任务和 job 身份。

## 已用容器重置复用（WF5）

在两个角色池均开启时追加 `--reuse`，使用新输出目录，例如 `artifacts/docker-wf5/reuse-new`。
生产开关 `REPOFIXLAB_CONTAINER_REUSE` 默认 `true`，仅接受 `true`／`false`。
关闭任一角色池时同时设置该开关为 `false`；WF1–WF4 基准默认关闭复用。

Worker 完成快照后、Evaluator 制品归档并 ACK 后结束当前代次。
Controller 停止容器并确认退出，以冻结角色镜像的原始目录为只读基线。
已结束租约和未激活待命角色使用 0 秒停机宽限；实际退出核对通过后才调整预约或执行重置。
逐项读取可信基线和可写卷的完整内容与元数据，恢复有差异的工作树、Git、依赖、忽略文件和缓存，
删除额外条目、拆除任务创建的硬链接，再全树校验；清空 input／evidence。
字节与元数据均一致的文件保留原 inode，减少完整依赖树的重复写入。
树身份校验内容、类型、链接、权限、uid／gid 与扩展属性。
可信 reset helper 使用最多 2 CPU／4 GiB、PID 256、断网、只读根目录，
仅增加 CHOWN／FOWNER 以恢复原始文件归属和权限。

| 可变位置 | 重置与验证 |
| --- | --- |
| `/testbed` 工作树、Git、依赖和缓存 | 从准确镜像恢复全树，比较内容与元数据身份 |
| `/run/repofixlab/input`、`/run/repofixlab/evidence` | 清空独立卷，领取与激活时核对输入及结果身份 |
| `/tmp` helper、kernel、临时文件与缓存 | 停机清除 tmpfs，启动后检查空状态，再注入可信材料 |
| 子进程、`/dev`、`/dev/shm`、`/dev/mqueue` | 停机结束进程，重启重建临时挂载与私有 IPC；污染验证核对残留对象消失 |
| 根文件系统、私有材料与 Docker 管理的 `/etc` 文件 | 只读配置与准确镜像／私有任务身份校验 |

校验通过的原容器停机保留，不消耗 CPU／内存，继续占池容量并受 300 秒过期管理。
该期限覆盖当前 Axios 长验证期间的空闲窗口，仍由有限期限、容量、取消和关闭机制回收。
其物理标签保持原始池归属；清理响应的 `release_evidence` 随操作 journal 持久化后，才允许再次领取。
领取先扩展资源预约，再检查实际镜像、安全配置、启动命令与卷身份，启动同一个容器，
确认全新 tmpfs，重新注入 helper／kernel 并检查只读私有材料。
Worker 和 Evaluator 运行阶段均为 4 CPU／8 GiB；输入与评分 helper 各阶段为 2 CPU／4 GiB。
每次领取扫描可写卷的完整内容、类型、权限、归属、链接和扩展属性，
与上次可信重置证明的基线树身份比较，并复查准确镜像与容器配置。
Worker 在原容器启动后执行校验；Evaluator 在输入写入器中先核对恢复卷，再写补丁并启动角色。

每次领取递增 `generation`；已结束的 Worker／Evaluator 句柄和旧结果请求被拒绝。
重置或领取校验失败时隔离并销毁物理归属的容器与卷；清理失败保留预约并阻止继续分配。
池无容量时清理本次资源；未命中继续使用受控按需创建路径。
按同一 journal 数据目录重启可回收停机池资源；服务关闭同时回收两个池和活跃租约。

报告 `reset` 分别列出两个角色的成功／失败次数、总重置耗时及跨代次容器数量。
`raw.ndjson` 保留 reset、校验、stop／start、lease_started 和 returned 事件；
`worker-destroyed.json`、`artifacts-acknowledged.json` 与 journal 留存每份恢复证明。
停机容器计算资源为零，重置 helper 与重新启动后的角色限制计入生命周期峰值；
重启后的 CPU 计数按各次运行累加。预热、全卷恢复、再次校验、重启与失败替代成本均进入整批墙钟。
性能门槛沿用规格第 6 节，最终对照在 WF7 验收。

## 故障处置与恢复（WF6）

取消使用 `/internal/v1/runtime/attempts/{attempt_id}/abort`，携带该 attempt 的唯一 operation 与请求哈希。
Controller 唤醒排队请求，并停止该任务物理归属下正在执行的容器及 helper；
共享预热由剩余任务继续使用，最后一个兴趣取消后才中断准备。
Docker 创建与取消的竞态通过创建前后检查拦截。
清理审计通过后释放预约；清理失败继续保留资源计费并阻止分配。

重启时挂载原 journal 目录，由独占 owner 锁保护恢复过程。
Controller 先按持久化池命名空间清理未知状态资源，再恢复操作记录与 attempt 状态。
未完成操作持久化为 `controller_restarted`；旧 Worker 租约与 Evaluator job 均失效。
已完成操作的原请求返回持久化响应；改动 attempt 或输入后复用 operation 会被拒绝。
清理失败状态在下次启动重试，恢复成功后解除准入阻塞。
强杀控制器后，Docker daemon 尚未完成的创建请求可能稍后才出现在盘点中。
首次启动如仍有残留会拒绝启动；保留同一 journal 目录再次启动，重新盘点并清理，通过后再接收任务。
WF7 故障驱动器保存每次拒绝的物理状态，在最多四次启动内验证恢复，随后重复启动核对 journal 与产物字节不变。

日志最后一行的未完成写入会先保存为 `interrupted-tail-<sha256>.bin`，
再恢复校验通过的完整记录前缀；副本、请求哈希及历史记录保留用于核对。
完整记录的 JSON、哈希链或操作顺序损坏会拒绝启动，需要核对原始 journal 与取证副本。
Evaluator 的真实 OOM 在 job 状态中返回 `evaluator_oom`；终止任务后按相同归属审计清理。

产物先归档、核对集合哈希，再 ACK。ACK 的终态日志落盘后才发布重置容器。
ACK 前中断时保留归档文件，恢复会回收对应评测资源；ACK 已持久化时原请求重放返回相同响应。
归档目录与 artifact-index 一并保留，重复恢复不改写已发布产物。

Orchestrator 取得独占预算写租约后，将上次进程遗留的预约按未知用量规则一次性保守计费，
置 `reconciliation_required`，暂停新的 Provider 准入；重复启动不重复结算。
核对账本、attempt 用量与已归档结果后再恢复准入。

真实故障驱动器与证据位于 `artifacts/docker-wf6/`，使用冻结 Controller 镜像、只读源代码、
输出目录及 Docker socket，沿用上方的 1 CPU／512 MiB 控制容器参数。
运行 `python /output/fault-probe.py --output /output/faults-new`；输出目录须为新的目录。
驱动器在同一控制容器内 SIGKILL Controller 子进程并重建服务，覆盖阶段取消、
Worker／Evaluator cgroup OOM、执行／排队超时、重置中断和 ACK 持久化边界。
这是故障验收入口；四模式的完整性能对照使用上述 benchmark 入口，在 WF7 验收。

## 四模式对照（WF7）

沿用上方冻结镜像、挂载和资源参数，将输出根目录改为 `artifacts/docker-wf7`。
各模式使用新的输出目录、同一版源码、manifest 与 12 个样本。
`run-final.ps1` 先核对复用模式冻结门槛，再依次运行串行、并发按需与预热池模式；记录实际顺序。

| 模式 | 追加参数 | 输出目录示例 |
| --- | --- | --- |
| 串行按需 | `--concurrency 1` | `/output/sequential-1` |
| 并发按需 | `--concurrency 2` | `/output/concurrent-1` |
| 并发预热池 | `--concurrency 2 --worker-pool --evaluator-pool` | `/output/pools-1` |
| 并发重置复用 | `--concurrency 2 --worker-pool --evaluator-pool --reuse` | `/output/reuse-1` |

预热、重置、领取校验、启动、失败替代、归档与关闭均计入整批时间。
同／不同环境分组的吞吐同时计入该组预热活动区间。
11 项冻结性能门槛逐项核对；结果与资源通过后再更新 WF7 为 completed。
试跑、污染和故障注入使用独立目录，正式计时期间保持源码不变。

最终结果与 R1–R8 证据索引位于 `artifacts/docker-wf7/report.md` 和 `acceptance-audit.json`。
`run-faults.ps1 -Suffix <新编号>` 可独立复验最终源码的 24 项故障；运行失败保留输出目录，重新执行使用新编号。
