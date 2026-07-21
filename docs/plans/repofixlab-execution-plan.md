# RepoFixLab 执行计划

| 属性 | 值 |
| --- | --- |
| 状态 | 已确认，可进入实施 |
| 计划版本 | 1.3 |
| 日期 | 2026-07-20 |
| 对应设计 | docs/designs/repofixlab.md |
| 当前 Pi 基线 | 244f1deaf1ae0fc1a242d9df5cddf457cf3d36a7 |
| 首期周期 | 单人约 8—10 周，另含正式实验计算时间 |

## 1. 交付目标与完成定义

RepoFixLab 首期交付“代码修复智能体 + 可信评测基础设施”，不是 Pi 展示页，也不是只跑通一个成功样例的 Demo。

## 0. 协议修订 1.3：M3 官方预检后的评测池与 Dev 校准

本修订覆盖下文所有“43 个正式任务”“8/5/30”“130 个 run_id”“26M formal cap”“15 个消融任务”和“10 个稳定性任务”的旧表述。它们保留为修订前的计划历史，不得作为后续实现或结果报告的依据。

- 候选来源仍是已封存的 43 个 SWE-bench Multilingual JS/TS 任务，DatasetLock、43-image source lock、所有预检记录和 17 项拒绝记录均保留。
- M3 官方预检以 pristine/adapted 两种模式分别验证 base 未解决、gold resolved。预检实际通过 26/43；其余 17 项不进入评测池，原因和证据由预检摘要绑定，绝不静默删除。
- 正式评测池为这 26 项的资格清单，并以仓库分层的确定性 5 Dev / 4 Validation / 17 Test 划分冻结；Agent 与公开清单不读取 private spec、gold patch 或 control metadata 原值。
- 对应的正式矩阵更新为 34 次主对照、16 次两组消融、24 次稳定性追加，共 74 个预注册逻辑 run_id；正式 accounted admission cap 为 14.8M，项目计划准入池为 28.8M，provider actual hard line 仍为 50M。
- 预冻结校准保持 16 个逻辑 run：5 个 Dev 任务分别以两主配置各运行一次（10 个 run），再按公开固定 seed 在 Dev 的三个仓库中各选一个任务、以两主配置各追加一次（6 个 run）。这 3 个追加项是同一 Dev 任务的第二次独立校准运行，不是补样，不读取 Validation/Test，也不改变正式 74-run 矩阵。
- M6/M7 的所有 Go/No-Go、dry-run、ExperimentLock、报告固定分母与验收项均必须按本修订重算；冻结后不得补样、替换或恢复被拒绝任务。

首期采用双门交付：

1. **门 A：单任务纵向切片。** 一个 Dev 任务从冻结 manifest 进入通用代码智能体，产出候选补丁，在全新 Evaluator 中执行运行时隐藏测试，最终生成 result.json 和最小 report.html。
2. **门 B：完整实验交付。** 43 个 JavaScript/TypeScript 候选任务完成数据冻结，M3 官方预检合格的 26 个任务进入评测池；主对照、两组消融和稳定性实验共 74 个预注册逻辑运行；全部成功与失败进入可重建报告。

门 A 的真实模型可以修复失败。只要平台正确判定、记录并展示失败，纵向切片就成立。门 B 完成后才允许在简历中把项目描述为完整落地项目。

首期完成必须同时满足：

- 常规实验由一条 Docker Compose 命令运行，数据准备由一条只编排 Compose 的 PowerShell wrapper 运行；均无宿主 Node/Python 依赖；
- Agent 无法读取模型密钥、gold patch、运行时隐藏 test patch 或 Docker socket；
- Worker 与 Evaluator 不复用文件系统；
- 正式结果固定分母，不删除失败、超时和基础设施错误；
- 实验配置、数据 revision、镜像 digest、提示、工具 schema、代码版本和统计规则均已锁定；
- 报告可仅从已有制品离线重建；
- 至少三类失败具备轨迹级根因分析；
- 结果不论支持或拒绝 H1，均如实交付。

## 2. 已锁定的范围与决策

| 主题 | 首期决策 |
| --- | --- |
| 产品叙事 | 面向真实 GitHub Issue 的仓库级修复与可信评测；Pi 是运行底座，不是产品中心 |
| Agent Loop | 复用 Pi Agent loop，不修改 packages/agent/src/agent-loop.ts |
| 编排方式 | RepoFix 专用有限状态机；不建设通用 Plan/DAG 引擎 |
| RepoFix 流程 | UNDERSTAND → LOCALIZE → PLAN → IMPLEMENT → P0 → CONTROLLED_VERIFY → REFINE → SELF_REVIEW → P1 |
| 平台后处理 | P1 → OFFICIAL_EVALUATE → REPORT |
| 运行环境 | Docker Desktop、WSL2、Linux containers；宿主只要求 Docker Desktop |
| 控制拓扑 | Node Orchestrator + Trusted Harness Controller 双控制容器；另有一次性 Dataset Preparer |
| 数据 | SWE-bench Multilingual 全部 43 个 JavaScript/TypeScript 任务，8/5/30 划分 |
| 主对照 | pi-general 对 repofix-full，同模型、同预算、同任务环境 |
| 消融 | repofix-no-localize、repofix-no-verify-feedback，各 15 个相同 Test 任务 |
| 稳定性 | 预冻结 10 个 Test 任务；两主配置各运行 3 次，主实验第一次可复用 |
| 正式规模 | 34 次主对照 + 16 次消融 + 24 次稳定性追加 = 74 个逻辑 run_id |
| 模型 | 智谱标准 API 的 GLM-4.5-Air，不使用 Coding Plan endpoint |
| 预算 | Token 请求受硬准入；费用以人民币观测和报告，不设美元硬上限 |
| 总 Token | 计划准入池 28.8M，项目 actual 硬保护线 50M；正式 accounted admission cap 14.8M |
| 采用判定 | 正确性主轴 + Token/耗时工程约束 + 安全/可复现硬门禁；不计算综合总分 |
| 公开范围 | 公开源码、冻结清单、配置/schema、聚合报告和去敏样例；完整原始轨迹默认本地保存 |
| 并发 | 默认全局并发 1；通过双任务 soak 后只能以新配置版本升至 2 |

首期明确不做：

- 外部 Agent 横向排行榜；
- 多模型路由、多 Agent、通用 DAG；
- 在线多用户 SaaS、实时控制台和账号权限系统；
- Pi UI/TUI 重设计；
- 自动创建 PR 或直接写入生产仓库；
- 以 LLM Judge 代替官方测试；
- “零泄露”“绝对安全”“优于所有 Agent”等无法证明的结论。

## 3. 目标架构与接口契约

### 3.1 运行拓扑

~~~mermaid
flowchart TB
    H["Windows + Docker Desktop"] --> D["One-shot Dataset Preparer<br/>pinned revision / checksum verification"]
    H --> N["Node Orchestrator<br/>Pi SDK / GLM API / FSM / Budget / State"]
    N -->|"internal RPC; versioned JSON"| C["Trusted Harness Controller<br/>Python 3.11 / Docker socket / SWE-bench"]
    D --> PU["dataset-public<br/>named volume"]
    D --> PR["dataset-private<br/>named volume"]
    PU --> N
    PU --> C
    PR --> C
    C --> CW["controller-work<br/>persistent named volume"]
    C --> W["Sanitized Agent Worker<br/>no network / no socket / no secrets"]
    C --> E["Official Evaluator<br/>fresh container / adapted launch policy"]
    N --> A["Canonical Artifact Store<br/>JSON / JSONL / patch / HTML"]
    C -->|"structured events + raw artifact stream"| N
~~~

这是一个逻辑控制面、两个常驻服务和一个只在数据准备阶段运行的一次性服务：

- **Node Orchestrator**是实验状态、预算、重试和制品索引的唯一 owner。它持有 ZHIPU_API_KEY，运行 Pi SDK，但不挂 Docker socket。
- **Trusted Harness Controller**是唯一 Docker owner。它挂载 Docker socket，因此等价于 Docker daemon root 权限；不持有模型密钥，不做独立调度、预算或自动重试。
- **Dataset Preparer**只在 `dataset prepare` profile 中联网，从固定 revision 物化数据并校验哈希；它不持有模型密钥或 Docker socket，运行结束后退出。正式实验不启动该服务。
- **Agent Worker**只得到公开任务描述和净化后的 base tree；无网络、无 socket、无宿主目录、无 private evaluation spec。
- **Evaluator**只由 Controller 创建，使用全新文件系统和 evaluator-only 数据；绝不复用 Worker。上游 harness 固定以 root 执行 Evaluator，因此首期保留该兼容要求，但必须同时启用 capability、提权、网络和资源限制。
- Controller 不发布宿主端口，只在 Compose 内部网络接受 Orchestrator 请求。

Orchestrator 和 Controller 之间使用版本化 JSON Schema。任何未知字段、未知版本、未知 manifest ID、浮动镜像标签、任意宿主挂载、任意网络模式或任意 capability 请求均拒绝。Controller 只根据 allowlist 中的 manifest 和资源 profile 解析实际 Docker 参数。

挂载与秘密矩阵：

| 资源 | Orchestrator | Dataset Preparer | Controller | Worker | Evaluator |
| --- | --- | --- | --- | --- | --- |
| ZHIPU_API_KEY | 环境变量，只读 | 无 | 无 | 无 | 无 |
| Docker socket | 无 | 无 | 读写，唯一持有者 | 无 | 无 |
| host `E:/pi/artifacts` → container `/artifacts` | 读写，唯一规范化 writer | 无 | 无，结果走 RPC | 无 | 无 |
| dataset-public-`<generation>` → `/data/public` | 只读 | staging 期读写，封存后不再挂载 | 只读 | 无 | 无 |
| dataset-control-`<generation>` → `/data/control` | 只读 | staging 期读写，封存后不再挂载 | 只读 | 无 | 无 |
| dataset-private-`<generation>` → `/data/private` | 无 | staging 期读写，封存后不再挂载 | 运行期只读 | 无 | 仅注入当前任务所需文件 |
| controller-work → `/var/lib/repofix/controller` | 无 | 无 | 读写，保存 journal/job/lease/raw log | 无 | 无；Controller 以 copy-in/out 传任务文件 |
| task workspace/volume | 仅经 RPC | 无 | 管理 | 读写 `/workspace` | 不复用，重新创建 |
| 网络 | control + provider-egress | 仅准备期 dataset-egress | 仅 internal control | `network=none` | `network=none` |

Compose 使用 `internal=true` 的 `repofix-control` 网络连接 Orchestrator/Controller，并给 Orchestrator 单独附加 `provider-egress`。Dataset Preparer 只在一次性 profile 中附加 `dataset-egress`；Controller 不具备普通出站网络。`provider-egress`/`dataset-egress` 只是路由分区，不宣称为内核级域名白名单：两个可信服务使用普通 bridge 出站，目标 URL 由冻结配置约束，每次目的主机、响应状态和证书错误进入审计；Worker/Evaluator 的 `network=none` 和 Controller 的 internal-only 才是强制网络边界。准备阶段允许 Controller 根据固定 allowlist 请求 Docker daemon 构建或拉取镜像，解析后立即记录本地 content digest；formal profile 禁止 build/pull，并在缺少或不匹配固定 digest 时 fail closed。

`controller-work` 是 Docker managed persistent volume，用于 Controller 重启后的 operation journal、job、lease、原始 official log 和临时制品恢复。Controller 把带 SHA-256 的结果流给 Orchestrator；只有 Orchestrator 写入 canonical artifact、fsync ArtifactIndex 并回传 ACK 后，Controller 才能按 retention policy 清理对应 job。所有 Pi session、Run Store、GlobalBudgetLedger、ArtifactIndex 和 experiment owner lease 都位于 E 盘 artifacts；因此 `docker compose run --rm orchestrator` 被强杀后不会随容器删除。开发 profile 可把源码只读挂到 Orchestrator 以加快迭代；formal profile 必须运行记录 digest 的不可变 Orchestrator/Controller 镜像，不挂 live source。artifacts 是唯一正式可写 host bind mount，位于 E 盘；密钥文件、Docker socket 和 private spec 均不得进入该目录。

artifacts、Docker/cache 目录、private JSONL 和本地 .env 必须在首个代码变更中加入精确 .gitignore；只提交 .env.example，且其中不含真实 key。

### 3.2 Docker Compose 契约

计划新增：

~~~text
packages/repofixlab/
  package.json
  src/
    cli/
    contracts/
    provider/
    agent/
    runner/
    storage/
    metrics/
    report/
  controller/
    pyproject.toml
    uv.lock
    repofix_controller/
    patches/
      harness-security-v1.patch
  docker/
    orchestrator.Dockerfile
    controller.Dockerfile
    dataset-preparer.Dockerfile
    sanitizer/
  configs/
    dataset/
    experiments/
    model/
    pricing/
  schemas/
    v1/
  test/
compose.yaml
scripts/repofixlab.ps1
~~~

运行时命令均由 Docker Compose 执行。普通命令可直接调用：

~~~powershell
docker compose run --rm orchestrator repofixlab doctor --profile bootstrap
docker compose run --rm orchestrator repofixlab doctor --profile smoke
docker compose run --rm orchestrator repofixlab doctor --profile formal
docker compose run --rm orchestrator repofixlab probe --instance axios__axios-5892 --candidate gold
docker compose run --rm orchestrator repofixlab run --experiment configs/experiments/v1.yaml --dry-run
docker compose run --rm orchestrator repofixlab run --experiment configs/experiments/v1.yaml
docker compose run --rm orchestrator repofixlab resume --experiment <experiment-id>
docker compose run --rm orchestrator repofixlab report --experiment <experiment-id>
docker compose run --rm orchestrator repofixlab verify-artifacts --experiment <experiment-id>
~~~

数据准备需要唯一 writer 和后续 Controller 预检，因此用户执行一条 wrapper 命令：

~~~powershell
.\scripts\repofixlab.ps1 dataset prepare --config configs/dataset/v1.yaml
~~~

首次准备先对冻结配置和精确 generation-scoped 卷名执行纯静态校验；该门禁失败时不创建 operation/self-check 目录，也不调用 Docker。随后运行 `doctor --profile bootstrap`；命令只检查 daemon、架构、宿主/Docker 内部空间、CPU/内存、基础控制网络、准备所需基础镜像，以及此时真实存在的 Controller/Orchestrator，不依赖尚不存在的数据清单，也不要求 Dataset Preparer、Worker 或 Evaluator 预先常驻。bootstrap 通过后构建并 inspect 固定 Dataset Preparer image，先以无数据卷挂载的一次性容器输出严格 v1 `DatasetPreparerSelfCheckReport`，由外部验证 canonical hash、派生状态、image ID、固定数据集常量、Python/pyarrow、UID/GID、public/control/private 路径、无 socket 和无敏感环境；任一硬门失败都禁止下载和 prepare。自检通过后才以固定 Compose primitive 把固定 revision 写入带随机 staging ID 的 generation-scoped public/control/private named volumes，同时保留 create/inspect 与 mount 类型证据；校验 43 条记录、逐文件 SHA-256 和交叉引用后，最后写入 `READY`/`SEAL` 并发布 `DatasetLock`。失败的 staging generation 不可被消费。封存卷此后只读挂载，重复 prepare 必须创建新 generation，不能原地改写。sealed generation 禁止自动 GC；只有显式给出 generation ID 且反向扫描证明没有 manifest/ExperimentLock 引用时才允许维护性回收，并保留审计记录。

随后 Orchestrator 通过 Controller 的准备期 RPC 解析官方镜像来源并生成 `OfficialImageSourceLock`，再做安全适配和预检。Controller 把 TaskEnvironmentLock 持久化到 controller-work 并返回哈希，Orchestrator 将它与 DatasetLock、OfficialImageSourceLock 和 public manifest 合并后写入 canonical artifacts；Orchestrator 不读取 private spec。wrapper 不安装宿主运行时、不改变实验参数；任一步失败都不发布新 manifest。其余 PowerShell wrapper 子命令只封装上面的单次 Compose 调用。

实现依赖固定为：

- CLI 使用 Node 内建 `node:util.parseArgs`，不引入命令框架；
- YAML 使用仓库已有的精确版本 `yaml@2.9.0`；
- TypeScript schema/工具参数使用 `typebox@1.1.38`，并导出 JSON Schema；
- Controller 使用 FastAPI + Uvicorn，Python 侧用固定版本 jsonschema 校验同一份 schema；
- Orchestrator RPC 使用 Node 内建 `fetch`；
- 静态报告使用转义后的服务端 HTML 模板，不引入前端框架，也不修改 Pi 现有 UI/TUI；
- 所有新增直接依赖写精确版本并经 `npm install --ignore-scripts` / Python lock 审查。

### 3.3 Controller RPC

首期内部 API 固定为 v1：

| 操作 | 职责 |
| --- | --- |
| health / doctor | 返回 daemon、架构、CPU、内存、数据根、磁盘和 socket 状态 |
| resolve_official_images | 仅 bootstrap/prepare profile 可调用；从固定 dataset/harness revision 推导 allowlist image key/tag，一次性 pull/resolve，并封存 OfficialImageSourceLock |
| preflight_manifest | 只消费已封存 DatasetLock/OfficialImageSourceLock；准备 profile 可派生净化镜像，生成并持久化 TaskEnvironmentLock 后运行 pristine/adapted 探针 |
| prepare_worker | 从 manifest allowlist 创建净化 Worker，返回 lease_id |
| execute_tool | 在 lease 绑定的 /workspace 执行结构化工具请求 |
| snapshot_patch | 导出规范化 patch、tree hash 和 patch hash |
| destroy_worker | 销毁容器和专用 volume，返回残留审计 |
| evaluate | 幂等创建或重新关联全新 Evaluator job，返回 job_id |
| get_job / reconcile_operation / cancel_job | 查询持久 job/operation，按 Docker label 重建索引，或按 attempt 所有权幂等终止 |
| stream_job_artifacts | 向 Orchestrator 流式返回日志、官方 report 和校验和 |
| ack_job_artifacts | ArtifactIndex 已 fsync 后确认接收，允许 Controller 后续清理 |

所有写操作携带 attempt_id、operation_id 和请求哈希。相同 operation_id 重放必须返回相同结果或明确冲突，不可重复创建资源；所有容器/volume 都带 experiment_id、run_id、attempt_id、operation_id 标签，以便 Controller 重启后 reconciliation。Controller 不接受模型直接提供的 container ID、宿主路径、镜像名、mount、network、capability 或 Docker CLI 参数；`evaluate` 只接收 manifest ID、受限大小的 patch bytes 及其 SHA-256。`resolve_official_images` 只接受从固定 dataset/harness revision 机械推导的 allowlist key，不接受任意 URL；记录 registry repository@digest、local image ID、platform、解析时间和响应摘要。`preflight_manifest` 只接受 Dataset Preparer 发布且 SEAL/hash 验证通过的 DatasetLock 与已封存 OfficialImageSourceLock，不能接受 URL 或浮动 tag。

Controller 在 `controller-work` 内维护独立的持久 capacity semaphore。冻结容量为 1 时，第二个重任务请求在创建容器前返回 `resource_busy`，由 Orchestrator 排队；多个并行的 `docker compose run` 不能绕过。该 semaphore 与 GlobalBudgetLedger writer lease、experiment owner lease 是三个不同锁，未来容量 2 仍由单一 experiment owner 调度并共享同一预算 writer。owner/writer lease 均带 heartbeat、TTL 和单调 fencing token；接管前必须完成 reconciliation，旧 token 的后续写入一律拒绝。

### 3.4 共享数据类型

src/contracts 中的 TypeBox 定义是契约编写源，生成并提交 schemas/v1 JSON Schema 作为 TypeScript/Python 的跨语言传输契约；CI 必须验证重新生成后零 diff。核心类型如下：

| 类型 | 必需内容 |
| --- | --- |
| DatasetLock | dataset revision、generation ID、public/control/private volume 名、记录数、逐文件/总 SHA-256、READY/SEAL hash 和创建镜像 digest |
| DatasetTaskRecord | instance_id、repo、problem_statement、base_commit、语言/仓库元数据；Dataset Preparer 写入 public volume |
| SamplingMetadata | instance_id、repo、规范化 problem_statement UTF-8 bytes、gold changed-line count；Dataset Preparer 写入 control volume，只供冻结抽样，不进入 Agent manifest/prompt |
| PublicTaskManifest | DatasetTaskRecord + task_environment_lock_id、worker image digest、resource profile、split；明确不含 SamplingMetadata，Orchestrator 最终发布 |
| PrivateEvaluationSpec | test_patch、gold_patch、F2P/P2P、harness parameters；只存在 sealed private volume，不暴露给 Orchestrator/Agent |
| OfficialImageSourceLock | 固定 dataset/harness revision、image key、registry repository@digest、local image ID、platform、registry 响应摘要和封存 hash |
| TaskEnvironmentLock | source repository@digest/local ID、精确 worker/evaluator local image ID、platform、resource/fs profile、sanitizer/adapter hash、provenance binding、preflight/equivalence result |
| ExperimentSpec | 配置矩阵、任务集合、顺序 seed、预算、重试、统计协议、公开策略 |
| ExperimentLock | ExperimentSpec 的完全展开值、DatasetLock/OfficialImageSourceLock ID、全部代码/配置/镜像/数据/adapter patch 哈希和总哈希 |
| RunRecord | run_id、config_id、instance_id、replicate、固定预算、当前终态 |
| AttemptRecord | attempt_id、lease、heartbeat、阶段、累计 usage、基础设施结果 |
| RunEvent | 单调序号、时间、阶段、事件类型、参数摘要、结果摘要、hash chain |
| PatchSnapshot | P0/P1、base tree hash、patch hash、文件清单、策略检查 |
| EvaluationResult | official resolved、F2P/P2P、退出码、日志引用、失败原因 |
| ArtifactIndex | 每个制品的路径、大小、SHA-256、敏感级别和生成者 |

run_id 表示一个预注册逻辑样本；attempt_id 只表示基础设施尝试。重试不会增加正式样本，也不会重置 run 级 Token、耗时和费用账本。

### 3.5 Pi 接入边界

每个 task × config × replicate × attempt_id 创建一个新的 Pi session；同一 attempt 的多个 RepoFix 阶段复用该 session。基础设施重试产生新 attempt，必须创建新 session 和新 Worker，不能继承失败轨迹。同一 attempt 只允许从 quiescent committed checkpoint 恢复：session 文件、container/volume、阶段快照、trace offset、Token ledger offset 和 hash 全部一致，且不存在 in-flight provider/tool call 或未结 reservation。首个 assistant 尚未可靠落盘或存在未结 reservation 时，按整笔预留 charge，旧 attempt 标记 aborted，再创建新 attempt。

通过 createAgentSession 接入，并强制：

- noTools: builtin，并同时传入 tools: ALL_CUSTOM_TOOL_NAMES 形成不可扩大的 immutable allowlist；仅设置 noTools 不能构成安全上限；
- 显式 ResourceLoader，不加载 extensions、skills、prompt templates、themes、context files、仓库 AGENTS.md 或用户默认目录；
- SettingsManager.inMemory 和独立 SessionManager；Pi transcript 只保存对话，RepoFix Store 才是实验真相源；
- customTools 仅注册 repo_list、repo_read、repo_search、repo_edit、repo_exec、repo_diff、stage_complete，且每个工具声明 sequential execution；
- 工具 schema 不出现 container ID 或宿主路径，闭包只绑定 /workspace lease；
- session.agent.toolExecution 固定为 sequential；
- 每次 setActiveToolsByName 前将目标集合与 getAllTools 返回值逐项比对，未知工具立即失败；
- session 事件同步克隆进有界队列，prompt 结束后等待落盘；Controller 工具审计独立保存；
- 所有退出路径在 finally 中执行 session.dispose 和 destroy_worker。

阶段切换由 Runner 状态机控制。stage_complete 必须独占一个 assistant tool-call batch；包装公开的 beforeToolCall hook，在同一 batch 同时出现 stage_complete 与其他工具时阻止整批，避免“提交阶段同时继续改代码”。合法 stage_complete 返回 terminate=true；afterToolCall wrapper 保留 SDK 原 hook，并确保合法结束批次的结果都带 terminate。模型未按时结束时由时限、轮次、工具次数和 Token supervisor 终止。

stage_complete 参数是按阶段区分的 TypeBox union：

| 阶段 | 必需结构化产物 |
| --- | --- |
| UNDERSTAND | problem summary、expected behavior、constraints、acceptance evidence |
| LOCALIZE | candidate files/symbols、每项 evidence、排除项 |
| PLAN | 最小修改步骤、风险、拟运行的定向测试命令 |
| IMPLEMENT | 改动摘要；Runner 随后冻结 P0，不接受模型自报 patch |
| REFINE | 使用/未使用反馈的理由与修订摘要 |
| SELF_REVIEW | diff checklist、策略检查、遗留风险；Runner 随后冻结 P1 |

Runner 只在 schema、当前阶段和必需产物均合法时推进。CONTROLLED_VERIFY 不是模型工具：Runner 在 P0 后通过 Controller 执行 PLAN 中的一条受限定向测试，完整日志写制品；repofix-full 获得规范化、截断后的反馈，no-verify-feedback 只获得固定中性事件。pi-general 不使用 stage_complete 或 RepoFix 阶段门，以普通无工具最终回复结束。

自动 compaction/summary 若发生，也必须走同一 budgeted streamFn 并计入 run Token。普通 provider transport/session retry 全部关闭，基础设施重试权只属于 Orchestrator。Pi 的 context-overflow compact+continue 只有在 M6 已冻结的 provider probe 能把该拒绝证明为 `verified_not_billed` 时才是同 attempt 的唯一显式恢复例外：它不重置预算/轮次/时限，所有 summary 与继续调用完整计费，并记录 `context_overflow_recovery_count`。若 overflow 的 usage/计费状态不明，wrapper 在转发给 Pi 前把它映射为非 overflow 的 `provider_usage_unverified`，阻止 SDK 自动 continue，按 reservation charge并暂停全局准入对账；它不是可立即重试的基础设施错误。首期不修改 Agent loop；如果公开 SDK 行为不能满足某项门禁，先在 RepoFix 适配层解决，不能直接改循环算法。

RepoFix 适配层固定以下内部接口：

| 接口 | 职责 |
| --- | --- |
| FrozenModelSpec | provider/model/endpoint、上下文、请求输出上限、thinking、temperature、计价快照版本 |
| AttemptSessionFactory | 按 run_id + attempt_id 创建或严格校验后恢复 session |
| AttemptSession | setStage、prompt、abort、close；close 必须先 flush trace 再 dispose |
| ProviderBudgetGate | wrapStreamFn、组合最终 payload hook、reserve/settle usage |
| TraceQueue | 同步 enqueue、异步串行 flush、写失败暴露为基础设施故障 |
| AttemptAbortCoordinator | first-reason-wins，协调 provider abort、Docker exec kill、trace flush 和幂等清理 |

AuthStorage.inMemory + ModelRegistry.inMemory 在程序内注册 zhipu-standard；provider 配置显式包含 apiKey 环境变量引用。创建会话时必须把同一组 authStorage、modelRegistry 和从该 registry 找到的 model 一并传给 createAgentSession；只传 model 会使 SDK 内部认证查找失败。SettingsManager 使用 inMemory；SessionManager 使用 attempt 专属持久化目录，以支持严格的同 attempt 恢复。

### 3.6 智谱标准 API 配置

使用独立 provider 名 zhipu-standard，避免与 Pi 内置 Coding Plan provider 混淆：

| 字段 | 冻结值 |
| --- | --- |
| Base URL | https://open.bigmodel.cn/api/paas/v4 |
| API | openai-completions |
| Model ID | glm-4.5-air |
| Context window | 131072 |
| 单次最大输出 | 16384 |
| Thinking | enabled；Pi thinkingLevel 固定 high，服务端仅按开/关解释 |
| Temperature | 0.2 |
| API key | 仅从 Orchestrator 环境变量 ZHIPU_API_KEY 读取 |
| Provider auth 配置 | apiKey: "$ZHIPU_API_KEY" |
| Model 必填字段 | reasoning=true、input=["text"]、cost 输入/输出/cache 四项均为 0，仅作 Pi 非权威占位 |
| 兼容项 | supportsStore=false、supportsDeveloperRole=false、supportsReasoningEffort=false、maxTokensField=max_tokens、thinkingFormat=zai、supportsUsageInStreaming=true |

正式冻结前必须用标准 endpoint 完成文本、工具调用、流式 usage 和超时四项 smoke。若 GLM-4.5-Air 在冻结前不可用，项目停止在 M6 之前，建立新协议版本并重新完成 Dev/Validation；不得静默替换模型。

Pi 的静态美元 cost 字段不能表达智谱的人民币阶梯计价，因此不作为实验费用真相源，也不进入报告。RepoFix 保存包含输入长度、输出长度、缓存命中等区间的版本化 CNY PricingSnapshot，并依据 provider usage 计算观测费用；usage 不完整时按 reservation 计算明确标为 imputed upper-bound 的 CNY，不与实测费用混合。

### 3.7 Token 准入预算与项目硬保护线

`provider_actual_tokens` 固定为 provider 返回的 prompt_tokens + completion_tokens；如有 total_tokens，则必须与二者求和对账。cached_tokens 是 prompt_tokens 子集，reasoning_tokens 是 completion_tokens 子集，只分项记录，不重复相加。预算与效率主口径使用 `accounted_tokens`：usage 完整时等于 `provider_actual_tokens`，请求已发出但 usage 不完整时等于该请求的完整 reservation。报告同时公开 actual、reservation/imputed 数量和 usage completeness，不能把估算值伪装成 provider 实测值。

预算分配：

| 池 | 上限 | 用途 |
| --- | ---: | --- |
| 正式 Test | 14.8M | 74 个 run_id，每个 run 的 accounted admission cap 为 200k |
| Dev | 6M | 2.8M 迭代池 + 3.2M 预冻结校准批次 |
| Validation | 3M | 最多 3 个预登记候选，5 个任务只做一次最终选择 |
| 事故诊断储备 | 5M | 仅用于 Dev clone、无模型复现或经批准的故障诊断；不得替换正式结果 |
| 计划准入总池 | 28.8M | 常规请求的 accounted_tokens 不得超过 |
| 项目硬保护线 | 50M | 实验控制流量的 provider actual 上限；10M 只作结算安全缓冲，不转为常规额度 |

同一 run 的基础设施重试共享 200k accounted admission cap，未用 Token 不得转给其他正式任务。每个 run 同时受 50 模型轮次、100 工具调用和 30 分钟限制。200k/14.8M/28.8M 是可审计的准入上限，不宣称在没有供应商 tokenizer/framing 契约时是数学意义上的 actual hard cap。

所有 pool 跨 experiment_id 共用容器路径 `/artifacts/_control/global-budget.jsonl`，其 host bind 为 `E:/pi/artifacts/_control/global-budget.jsonl`。GlobalBudgetLedger 使用 budget_namespace=repofixlab-v1、带 fencing token 的单 writer 独占 lease、追加式 reservation/settlement 和可重放汇总；任何 experiment 启动前都同时检查 pool、28.8M 计划池和 50M 项目硬保护线，新 experiment_id 不能重置总账。

正式实验恰好保留预注册的 74 个逻辑结果；基础设施失败仍留在固定分母，除同一 run 的既定 attempt 策略外，不使用事故诊断储备替换、补样或选择性重跑。该储备只生成明确标为 diagnostic、与正式结论隔离的制品；配置级不公平、泄露或批次失效必须停止并建立新协议，完整 14.8M 正式批次重跑不在当前授权内。50M 保护线假设该 API key/资源包在实验期由 RepoFixLab 独占；若存在其他消费者，M6/M7 必须先导入 provider 账单差额再准入。

准入与硬保护通过 RepoFix 适配层实现：

1. 包装公开的 session.agent.streamFn，使主 Agent、自动 compaction 和 summary 的每次模型调用都进入同一个 Token ledger；
2. wrapper 保留原 streamFn，并向每次调用注入组合后的 onPayload：先调用 SDK 原 onPayload，再校验最终 payload 的 max_tokens=16384；冻结 `TokenAdmissionEstimator`，按 `reserved_input_tokens = ceil(pi_estimate_tokens(final_payload) × multiplier) + framing_margin` 估算完整 messages/tool schema，再令 `reservation = reserved_input_tokens + max_output_tokens`。multiplier/framing_margin 由 GLM smoke、Dev 与 Validation 的最大实测残差加安全余量确定并写入 experiment.lock；UTF-8 bytes 与 Pi 估算都只是估算输入，不被称为 tokenizer 上界；
3. 准入成功后先把 request_id、estimator version、reservation_open 追加并 fsync 到 WAL，再允许 HTTP；若 run、阶段或实验池余额不足，wrapper 不得 throw/reject，而要在 HTTP 前返回符合 StreamFn 契约的 error event stream，并携带机器可读 ledger reason=budget_exhausted；普通 turn 与 compaction 使用同一分类，不解析错误文本；
4. 调用 SDK 原 streamFn 本身必须位于 try/catch 中；auth、原 onPayload 或 transport 在返回 stream 前 reject 时，wrapper 转成契约内 `provider_preflight_failure` error stream。只有 transport 审计明确证明 HTTP 未发出才零 charge；请求状态不明则按完整 reservation 记账并暂停全局准入，等待账单对账；
5. wrapper 只负责流事件与预算事务：done 且 usage 完整时先验证 `actual_prompt_tokens <= reserved_input_tokens` 与 `provider_actual_tokens <= reservation`，再追加并 fsync settlement、释放差额并转发事件；任一不变量失败记为 `budget_protocol_invalid`，保留 actual、立即停止整个实验且禁止继续 Test。error/abort/unknown_usage 按完整 reservation charge；HTTP 已发出但 usage 不完整时同样暂停全局准入并对账。唯一例外是实验锁中已有 request-level 证据规则、且本次响应满足该规则的 `context_overflow_verified_not_billed`：记录零 actual 的拒绝事件并关闭 reservation，不暂停；wrapper 不 flush session、不执行工具、不写 attempt checkpoint；
6. 只有 `session.prompt()` 已完整返回（包括 done 后的 message_end、assistant 持久化和工具批次），且 Runner 把结果验收为 successful boundary（RepoFix 为合法独占 `stage_complete`，pi-general 为合法普通最终答复），才等待 SessionManager/TraceQueue、Controller operation 与阶段快照全部 flush，并在确认没有 in-flight operation/open reservation 后原子写入 checkpoint；未恢复的 budget_exhausted、provider error/abort、unknown usage、trace/ledger failure 禁止 checkpoint；
7. 只有 `context_overflow_verified_not_billed` 可触发 Pi 的同-attempt compact+continue；其 request ID、零 actual 证据和关闭记录先进入 ledger/hash。最终 continue 达到 successful boundary、后续调用全部结算且所有 offset 均 flush 后，才允许为该阶段提交 checkpoint；未验证 overflow 在转发前改写为非 overflow 错误，禁止自动 continue/checkpoint并进入全局对账；
8. Pi 普通 provider/session retry 关闭；budget_exhausted 只能由 Orchestrator 归类，不能被当作传输错误或 overflow 重试；
9. 冻结的单请求契约必须证明 context 131072 与 max output 16384 共同给出 `max_single_request_actual_tokens <= 147456`；若 provider smoke 无法验证该请求上界，M6 No-Go。在全局 provider 并发 1、独占 key、40M 停止准入、unknown usage 立即暂停的前提下，10M 缓冲远大于一个最大在途请求，使 50M 成为项目控制流量的硬保护线。

预冻结 Dev 校准批次固定为 5 个 Dev 任务 × pi-general/repofix-full = 10 个新 run，加上 3 个按固定 seed 从 Dev 三个仓库各选一个任务的第二次 pi-general/repofix-full 运行 = 6 个新 run，共 16 个逻辑 run，预留 3.2M。全部 GLM smoke、Dev 和 Validation 请求都必须满足 estimator 不变量；任一次低估即冻结失败。若校准批次至少 2 个以 budget_exhausted 结束，M6 同样失败；基础设施重试不增加分母，任何无法进入 Agent 终态的 run 也使整批失败，不能从 16 中剔除。此时只能调整估算器、总资源或正式预算并重新做校准与 Validation，不能减少任务、删失败或临时给个别 Test 任务加额度。

### 3.8 Worker 净化与 Evaluator 防假阳性

官方 Multilingual 实例镜像不能原样进入任何会执行候选代码的容器。准备阶段从固定 official digest 派生 sanitized worker：

1. 导出 base commit 对应工作树；
2. 删除原 .git；
3. 以固定 author、timestamp、timezone、uid/gid、文件顺序和 mtime 重新 git init，只创建一个 baseline commit；
4. 删除 remote、tag、reflog 和不可达对象；
5. 记录 source repository@digest/local image ID、sanitized worker local image ID、base tree hash 和 sanitizer version；
6. 正式运行 network=none。

Worker 净化门禁要求：只有一个 commit、无 remote、无 tag、无 reflog、无不可达未来对象，并且按 issue/PR 标识搜索不到未来修复提交。

Evaluator 也从相同 official source digest 派生，但不重写 base commit：detached checkout 原 base commit，删除其他 refs、remote、tag、reflog，再 prune 所有不可达对象。门禁要求 `HEAD == base_commit`、base commit/tree 不变、`git fsck --no-reflogs --unreachable` 无未来对象；记录 `(source repository@digest, source local image ID, sanitized evaluator local image ID, sanitizer hash, platform, fs profile)` provenance binding 和可达对象证明。formal 必须用 lock 中的精确 sanitized evaluator image ID 启动；缺失或绑定不符时失败，不能退回 official source、tag、build/pull 或现场重建。应用候选前后执行：

- candidate patch 路径策略；
- candidate patch 在 base tree 上 git apply --check；
- candidate 路径与 evaluator 管理路径及 test patch 路径冲突检查；
- 在应用 candidate 后再次检查 test patch 可应用；
- test patch 应用失败、测试未收集、全部跳过或 official/internal report 不一致时绝不判 resolved。

### 3.9 Harness Security Adapter

固定的 SWE-bench v4.1.0 并不直接满足本项目的容器门禁：该版本把 `DOCKER_USER` 固定为 root，在远端镜像缺失时会主动 pull，创建 Evaluator 时只传入基础参数和上游 `cap_add`，没有固定网络、capability drop、`no-new-privileges`、CPU、内存、PID 或只读路径限制。因此“调用 official harness”不能等同于“天然安全”。

首期在 Controller 镜像构建时，对固定 upstream commit 应用仓库内的 `harness-security-v1.patch`。构建必须先验证 upstream tree hash、执行 `git apply --check`，再记录 patch SHA-256 和最终 Controller image digest；任一值未写入 `version-lock.json` 时 M0 不通过。适配范围严格限制为镜像解析和 `build_container` 的创建参数：

1. `repository@sha256 + platform` 只用于对账 official source provenance；formal profile 从 TaskEnvironmentLock 读取精确 sanitized evaluator local image ID，用 Docker inspect 校验 image ID、platform、source-digest/sanitizer-hash/fs-profile labels 与 provenance binding，并直接按该 image ID 启动。缺镜像或任一值不符立即失败，禁止退回 source image、tag、隐式 build/pull 或 `latest`；
2. Evaluator 强制 `network_mode=none`、`cap_drop=ALL`、`security_opt=no-new-privileges`、冻结的 CPU/内存/PID/超时，以及版本化的只读根和可写路径 profile；任何上游 `cap_add` 请求默认拒绝；
3. Worker 固定非 root；Evaluator 为兼容上游 `DOCKER_USER=root` 可保留容器内 root，但仍受上述全部限制，且不能访问 socket、host bind、模型密钥或其他任务数据；
4. 不修改 patch 应用、测试脚本、F2P/P2P 收集、`grading`、`reporting` 或结果 parser。

安全适配不能靠“结果看起来合理”证明等价。M0 对 Axios 的 base/no-op/malformed/gold 同时运行 pristine pinned harness 与 adapted harness，要求官方判定和测试集合一致；M3 对全部 43 个任务的 base/gold 进行同样的逐任务对账。资源限制导致的超时、缺写路径或测试差异视为 profile 缺陷并阻止冻结，不能临时放宽某个正式 run。

## 4. 工作分解、依赖与退出门

### 4.1 总览

| 里程碑 | 周期 | 主要结果 | 依赖 |
| --- | ---: | --- | --- |
| M0 环境与契约 | 4—5 天 | bootstrap/smoke doctor、最小 Dataset Preparer、source/adapter/版本锁、Axios 双 harness 探针 | 无 |
| M1 纵向切片 | 5—7 天 | pi-general 单任务端到端 + 最小报告 | M0 |
| M2 安全与工具 | 4—5 天 | 净化 Worker/Evaluator、工具契约、角色化安全门禁 | M1 接口 |
| M3 数据与 Evaluator | 4—6 天 | 43 任务预检、8/5/30 冻结清单 | M1；开发可并行，正式退出依赖 M2 |
| M4 RepoFix 与消融 | 5—7 天 | RepoFix FSM、P0/P1、四配置、预算 | M1，集成依赖 M2/M3 |
| M5 Runner 与报告 | 5—7 天 | 批处理、恢复、指标、完整静态报告 | M2—M4 |
| M6 Dev/Validation/冻结 | 3—5 天 | experiment.lock 与正式 Go/No-Go | M2—M5 |
| M7 正式实验 | 4—8 天连续计算期 | 130 个不可变逻辑结果 | M6 |
| M8 分析与交付 | 3—5 天 | 最终报告、复现、演示、简历材料 | M7 |

关键路径：

~~~mermaid
flowchart LR
    M0 --> M1
    M1 --> M2
    M1 --> M3
    M1 --> M4
    M1 --> M5A["M5 storage/report skeleton"]
    M2 --> M5
    M3 --> M5
    M4 --> M5
    M5A --> M5
    M5 --> M6 --> M7 --> M8
~~~

M0、M1 必须顺序完成。M1 后可以按 sandbox、dataset/evaluator、agent、runner/report 四条目录边界并行；共享 schema、package.json、Compose 和正式配置只能由集成负责人修改。

### 4.2 M0：环境、版本和实验契约

任务：

- 启动 Docker Desktop Linux Engine，检查 linux/amd64；
- bootstrap doctor 通过 Orchestrator 对 artifacts bind 的 `statvfs` 检查 E 盘宿主可用字节，并由 Controller 用固定 digest 的一次性容器在 Docker managed named volume 上执行 `statvfs` 检查 Docker 内部可用字节；记录原始字节、Docker root、volume ID 和探针镜像 digest；
- 采用官方 120 GB 最低线，即两处都至少 120,000,000,000 bytes；建议清理到 150 GB；
- C 盘低于 20 GB 只产生宿主临时文件告警，不替代 E 盘/Docker 数据根硬门禁；
- 检查 Docker 可见 CPU 至少 8、内存至少 16 GiB；
- bootstrap 对真实常驻 Controller/Orchestrator 验证 socket ownership；Dataset Preparer 改在真实 prepare 生命周期验证，Worker/Evaluator 改在 smoke/formal 中由 Controller 真实任务工厂验证；
- 固定满足当前 Pi 依赖引擎要求的 Node 24 精确镜像 digest、Python 3.11 精确 patch/digest 和 Python lock；
- 固定 SWE-bench、数据集和首个实例；
- 建立最小一次性 Dataset Preparer，先输出严格自检报告并通过 image ID、固定数据集常量、Python/pyarrow、UID/GID、三类目录、无 Docker socket、无敏感环境和 canonical hash 硬门，再在 generation-scoped staging volumes 物化 Axios public/control/private 数据，验证 revision/逐文件 hash 后写 SEAL 并发布 DatasetLock；
- 通过准备期 `resolve_official_images` 机械解析 Axios source image，记录 repository@digest、local image ID、platform 和 registry 响应，封存 OfficialImageSourceLock；
- 固定 pristine upstream tree，编写只触及镜像解析/容器创建的 Harness Security Adapter，记录 patch SHA-256；
- 为 Axios 派生最小 sanitized evaluator，保留 base commit 并清除未来 Git 对象；
- 定义 v1 schema 和 130-run 预算矩阵；
- 使用 pristine 与 adapted 两个固定 Controller/Harness 镜像，对首个实例执行 base、no-op、malformed、gold 四个确定性探针；M1 再把 adapted 调用产品化为 RPC。

当前已知环境事实：本轮已启动 Docker Desktop，并通过真实 Compose 入口生成规范报告 `artifacts/m0/bootstrap-doctor-audited-v6.json`。这是首次 bootstrap `pass`：Linux/amd64、12 CPU、Docker `MemTotal=20,972,773,376` bytes，E 盘 `/artifacts` 可用 `210,370,609,152` bytes，固定 Alpine 探针在 Docker managed volume 内测得 `947,109,801,984` bytes；Controller socket=`read-write`、Orchestrator socket=`none`，Dataset Preparer、Worker、Evaluator 为 lifecycle=`deferred` 且容器观测为 `null`。报告语义/文件 SHA-256 分别为 `5234eae6291a0f808ca2db885efffa56354b90c5467c7d590ed3276117ab4c60` 与 `744869dc1662595bc9356cf5ac690b0b558ffe272eeb3b1c8a848f809eaf6d24`；外部锁语义/文件 SHA-256 分别为 `f51ddfb48d579d34e848f6bb5566f69140eebc606f564e9271c769838a4a5e5d` 与 `9dedf48ac209f58c318fd14ef8a2ebed11b316e0c2c1f9749eaa1476703fa466`。audited-v4 与 v5 分别发现 Compose config hash 和 deferred 生命周期建模问题，v6 验证修复；该锁只覆盖当时的源码与镜像快照。

首次真实 prepare `artifacts/dataset-prepare/20260718T135002385Z-7a40765a1650` 因跨组件旧前缀 `repofixlab-dataset` 与冻结卷名契约不一致而失败；当时先下载、后校验，三个旧 staging volume 已创建但没有 `DatasetLock`，按协议保留供审计。修复后，旧前缀在下载前静态拒绝，回归证明零 Docker 调用、零 prepare operation 目录、零 self-check 目录；Python 测试 21/21、完整 wrapper 回归 272.4 秒均通过。

真实 prepare `artifacts/dataset-prepare/20260718T135934707Z-243342d1916a` 随后成功发布 generation `g-20260718-135934-066a8f5b6f6b` 与 lock ID `dataset-v1-g-20260718-135934-066a8f5b6f6b-e451237925674fc6`，包含七个仓库的 43 个任务和 Axios。数据源 `SWE-bench/SWE-bench_Multilingual` revision=`2b7aced941b4873e9cad3e76abbae93f481d1beb`、bytes=`1,165,968`、SHA-256=`28b7f874e48496399077d276f9f2b163a077ddf0a70dc507c148d58da826baa9`；DatasetLock 文件 SHA-256=`003c0a34cd85c9254e651ab639a29171677f98e1bb06a8393b14d5893fdef95f`，generation aggregate SHA-256=`e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55`，preparer image=`sha256:57d210c30bd4d8cd4e72bfe360ac217cd5f2625523259a5b58342c8d28d9eb12`。self-check `artifacts/dataset-self-check/20260718T135934860Z-80314124d12e/self-check-report.json` 的语义/文件 SHA-256 为 `4e2976e37c9dc7832ce5f1c6930ef514c468ca7d38c8ce4c44f81d9354fa6741` 与 `85b1f6f30c8bd0bf37e34d29a5eff1f41259cc12c4d5f8d0cf693a0350f53db9`；独立只读 Python 全量 `verify_generation`、TypeScript schema/self-check verifier、三只成功封存卷 `attached=0` 复核均通过。

这些证据仍不能冒充 Axios smoke、OfficialImageSourceLock/TaskEnvironmentLock、Worker/Evaluator 真实工厂证据、harness 等价性或 formal doctor 通过，M0 整体仍为 No-Go。当前 Orchestrator provenance 镜像早于新增 Dataset Preparer/verifier/wrapper 源码，现有 audited-v6 外部锁不能表述为覆盖当前 HEAD；继续 M0 前必须重建相关镜像，重新生成、审计、替换 provenance lock 并复跑 bootstrap doctor。

已知固定点：

~~~text
SWE-bench tag: v4.1.0
SWE-bench commit: 726c5461e2ef52d83cf1ea2107870a8bb3328d57
Dataset: SWE-bench/SWE-bench_Multilingual
Dataset revision: 2b7aced941b4873e9cad3e76abbae93f481d1beb
First instance: axios__axios-5892
Base commit: ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b
Observed Axios image digest reference: sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8
~~~

上面的 Axios digest 只是本轮观察值，不是数据集自带的可信字段；M0 必须重新解析并由 OfficialImageSourceLock 封存后才能使用。数据集必须由一次性 Dataset Preparer 从固定 revision 物化为 generation-scoped public/control/private named volumes 并记录逐文件与总 SHA-256；SEAL 后任何服务不得以读写模式挂载，正式运行不得让 harness 读取浮动 HEAD 或 `latest`。Node/Python 基础镜像、Harness Security Adapter patch、source repository digest 和首个 sanitized evaluator local image ID/provenance binding 在 daemon 启动后写入 lock，未解析前 M0 不通过。

退出门：

- bootstrap doctor 在 dataset prepare 前通过，Axios 物化后 smoke doctor 通过；
- bootstrap 只以 Controller/Orchestrator 的真实 inspect 判定；Dataset Preparer 由 prepare 生命周期证据判定，Worker/Evaluator 由 smoke 的 Controller 工厂使用锁定真实任务镜像判定，不接受空替身或残留容器标签；
- bootstrap 资源项通过后才能进入 Axios 准备；完整 formal doctor 依赖 M2 的角色安全 profile 与 M3 的 43-task locks，只在 M6 前执行。若 E 盘余量不足，只阻止批量准备和正式实验，不阻止代码开发；
- DatasetLock 的 READY/SEAL、记录数、逐文件/总 hash 通过，封存 generation 未被任何 RW mount；OfficialImageSourceLock 的 repository@digest/local ID/platform 对账通过；
- 两个 `statvfs` 证据均存在且分别达到 120,000,000,000 bytes，Docker CPU/内存达到 8/16 GiB；
- no-op/base 未解决、malformed 为 patch_apply_error、gold 为 resolved；
- pristine 与 adapted harness 的四类官方判定、收集测试集合和 parser 输出一致；
- formal adapter 在 sanitized evaluator local image ID 缺失、provenance label 不符或请求 source/tag 回退时 fail closed，且 Docker pull 事件数为 0；
- 官方原始 report 能无损映射到内部 schema；
- 预算矩阵 fixture 能机械重算 130 个 run 和 26M 正式 accounted admission cap。

证据：doctor.json、版本/digest/adapter lock、两套四类探针日志、official equivalence diff、Docker event audit、官方 report、预算矩阵快照。

### 4.3 M1：第一条可展示纵向切片

任务：

- 建立 packages/repofixlab、Compose、CLI 和 v1 schema；
- 把 M0 的 Dataset Preparer 固化为 Compose profile/wrapper，并实现最小 Controller health、preflight、prepare_worker、execute_tool、snapshot、evaluate、job status/artifact ACK、destroy；
- 生成只覆盖 Axios 的最小 sanitized worker/evaluator；M2 再把两类 sanitizer 泛化并加入完整泄露门禁；
- 接入 pi-general 和智谱标准 API；
- 真实运行一次，导出 candidate.patch；
- 在全新 Evaluator 中执行 official harness；
- 生成 result.json、events.jsonl 和最小 report.html。

退出门：

- 一条 Compose 命令贯通 manifest → Agent → patch → Evaluator → report；
- 模型成功或失败都生成完整终态；
- Dataset Preparer/Controller/Worker/Evaluator 无模型 key；Worker 无 gold/test patch、socket、网络和宿主工作区；
- Worker 销毁后无任务残留；
- report 明确显示任务、补丁、官方结果、Token、耗时和失败原因。
- run --dry-run 能从配置精确重算 130 个 run 和 26M 正式 accounted admission cap。

这是第一个可演示版本，但不能作为完整项目成绩。

### 4.4 M2：安全、净化与工具等价

任务：

- 实现全部结构化 repo 工具及路径规范化；
- 所有工具按模型源码顺序串行执行；
- 防御绝对路径、.. 穿越、符号链接逃逸和超大输出；
- 为 Worker 加入 non-root、cap-drop=ALL、no-new-privileges、read-only root、network=none、PID/CPU/内存/超时；为 Evaluator 通过固定 Harness Security Adapter 加入除 non-root 外的同类角色化控制；
- 实现 deterministic sanitized worker、base-preserving sanitized evaluator 和两类未来 Git 对象审计；
- 实现凭据去敏、Controller 管理日志和容器残留审计；
- 把安全探针纳入 doctor formal profile；
- 为 Worker/Evaluator 增加 Controller 真实任务工厂探针，证据绑定 operation_id、container ID、实际 image ID、运行时 inspect 和功能结果，不以 Compose service label/name 发现或空 Alpine 容器代替；

退出门：

- 只有 Orchestrator 可读取模型 key，且日志中无明文；Dataset Preparer、Controller、Worker、Evaluator 的 key 探针均失败；
- Worker/Evaluator 无 host bind、无法读取 canary，允许工作流前后 host canary 哈希一致；Orchestrator 只能写 allowlist 中的容器 `/artifacts`（host `E:/pi/artifacts`），Controller RPC 拒绝任意 host mount/canary 请求；
- socket ownership、角色网络、资源、路径、日志和容器残留门禁全部通过；bootstrap、prepare、smoke/formal 分别消费对应生命周期证据，Controller 明确作为可信 socket 服务审计，不伪称为不可信沙箱；
- 每个拒绝测试都有合法操作正向对照，避免“全部拒绝”式假安全；
- 配置无关的工具契约固定参数、路径、退出码、截断和超时语义；
- 任一门禁失败都会阻止 Validation/Test。

### 4.5 M3：43 任务数据与官方 Evaluator

任务：

- 导入固定 revision 的 43 个 JS/TS 实例；
- 由一次性 Dataset Preparer 写 generation-scoped public/control/private staging volumes，完整校验后写 SEAL；Controller 运行期只读 sealed private volume，Orchestrator 永不读取 private spec；
- Dataset Preparer 从 gold patch 派生 control-only SamplingMetadata 原始整数；Orchestrator 只读这些整数，并在冻结 Test 内按已注册算法生成桶和完成抽样；原始值与桶均不得进入 PublicTaskManifest/Agent prompt；
- 按需构建/拉取环境缓存，不预缓存全部 43 个 instance image；
- 对每个任务执行 pristine/adapted base/gold 对账、镜像架构、禁网依赖和资源预检；
- 按仓库分层、固定 seed 生成 8 Dev / 5 Validation / 30 Test；
- 固定 15 个消融任务和 10 个稳定性任务；
- 实现 official report parser golden fixtures；
- 对 candidate/test patch 冲突和 test patch 应用失败建立回归测试。

退出门：

- 43 个任务都有明确、可审计的预检状态；
- 任务失败时暂停协议，不静默替换；
- manifest 引用已封存 DatasetLock/OfficialImageSourceLock/TaskEnvironmentLock，包含 revision、generation、base commit、source repository digest、worker/evaluator local image ID 和 SHA-256；
- 43 个任务的 adapted/pristine official 判定、测试集合以及内部 F2P/P2P 100% 对账；
- Agent 只得到 PublicTaskManifest。

M3 的数据导入、镜像盘点和 parser 开发可与 M2 并行；使用最终角色化 user、network、resource、read-only/writable-path 参数的 43 任务正式预检必须等待 M2 安全 profile 冻结，未完成时 M3 不得退出。Evaluator 的 upstream root 兼容例外必须显式存在于 lock，不能被写成“所有容器均 non-root”。

冻结 seed 与选择算法：

| 用途 | Seed | 规则 |
| --- | ---: | --- |
| 8/5/30 划分 | 20260718 | 先按 repo 分层，再按 SHA-256(UTF-8(seed + NUL + instance_id)) 升序，使用最大余数法满足全局配额 |
| 15 个消融任务 | 20260719 | 只在冻结的 30 个 Test 内，按 repo、issue-bytes tertile、gold-changed-lines tertile 做确定性比例抽样 |
| 10 个稳定性任务 | 20260720 | 使用同一预定义 strata 独立确定性抽样；允许与消融集合重合 |
| 正式交错顺序 | 20260721 | 稳定 hash 排 task 顺序，并在每个主对照 pair 内随机化先跑配置 |
| 统计 bootstrap | 20260722 | 以 repo 为 cluster 做 10,000 次配对 bootstrap |

SamplingMetadata 保存原始整数而不是预先分桶：`issue_bytes` 是 problem_statement 先把 CRLF/CR 规范化为 LF 后的 UTF-8 byte length；`gold_changed_lines` 由冻结版本的 unified-diff parser 统计所有 hunk body 的 added/deleted records 之和，file headers 不属于 hunk record，避免用字符串前缀误判。完成 8/5/30 划分后，仅在冻结的 30 个 Test 内分别按 `(metric asc, instance_id asc)` 排序，以 `bucket = floor(3 × zero_based_rank / 30)` 生成恰好 10/10/10 的等频 tertile；数值 ties 由 instance_id 唯一打破。15/10 抽样再按 repo×两类 tertile 分层、用最大余数法分 quota，并以对应 seed 的稳定 hash 打破抽样并列。脚本只读取 SamplingMetadata，不挂载 private volume、不读取 gold patch 本文或任何 Agent Test 结果；parser version、原始整数、桶、quota 和最终 manifest ID 在首次 Test 运行前写入 experiment.lock。

### 4.6 M4：RepoFix、基线、消融和预算

任务：

- 实现通用 SessionFactory 和隔离 ResourceLoader；
- 固化 pi-general 的提示、工具和 hash；
- 实现 RepoFix FSM、阶段工具白名单、P0/P1 不可变快照；
- 实现 no-localize 和 no-verify-feedback 配置开关，不复制工作流；
- no-verify-feedback 在 Refine 阶段关闭 repo_exec，只保留匹配的读/diff/edit机会；
- 实现 Token reservation ledger、轮次/工具/时限 supervisor；
- 用 faux provider 覆盖所有阶段和失败路径；
- 生成配置差异报告，证明除预注册工作流变量外其余条件一致。

退出门：

- 四配置在 Dev 上均可端到端执行；
- setActiveTools 未知名称 fail closed；
- P0、受控测试日志、自审记录和 P1 均可追溯；
- 预算不足时 provider 请求计数不增加；
- Pi Agent loop 源码无改动。

### 4.7 M5：批处理、恢复、指标和报告

任务：

- 实现 queued → preparing → running → agent_finished → evaluating → completed/failed；
- 实现 run/attempt、lease、heartbeat、孤儿恢复和幂等 operation；
- 状态迁移先追加事件，再原子替换当前状态；
- 实现跨 experiment 的 GlobalBudgetLedger、独占 lease、Token 准入和 pool 隔离；
- 实现 experiment owner lease 与独立 Controller capacity semaphore；第二个 Orchestrator 只能观察或收到 experiment_locked/resource_busy，不能并行创建任务；
- 把 Controller job/lease/raw log 持久化到 controller-work，并实现 checksum stream → ArtifactIndex fsync → ACK → 延迟 GC；
- 实现失败分类、F2P/P2P、成本、耗时、稳定性和安全指标；
- 生成自包含静态 HTML 与 JSON；
- 在 preparing、running、evaluating 三阶段做强杀恢复；
- 实现 ArtifactIndex 和全量校验和验证。

退出门：

- 三阶段强杀后，只有 session/container/stage/trace/ledger 全部匹配、checkpoint 已提交且没有 in-flight operation/open reservation 时才继续同 attempt；其他情况保留并 abort 旧 attempt，再新建 attempt；
- HTTP 已发出但 settlement 未落盘的 reservation 在恢复时全额 charge，原 provider 请求永不重放；
- Controller 重启后可从 controller-work 重新关联已提交 job；未收到 ArtifactIndex ACK 前不得清理 raw official report；
- 两个并行 CLI 的竞争测试证明冻结容量 1 时最多存在一个重任务容器，预算 writer 和容量锁互不冒充；
- completed 结果不可被 resume 覆盖；
- 所有旧 attempt 的 Token、耗时、费用和日志保留；
- 报告可在无网络、无模型调用条件下两次重建且 hash 一致；
- 5 个 Dev 任务和 3 个预注册重复 Dev 项可一键完成 16-run 校准批次。

首期使用 JSON/JSONL + 原子文件，不引入数据库。并发 1 下这比 SQLite/服务数据库更容易审计；若以后扩展多机，再迁移存储层。

### 4.8 M6：Dev、Validation 和正式冻结

任务：

- 只用 Dev 调整提示、工具说明、阶段和上下文策略；
- Validation 前最多登记 3 个候选及唯一选择规则；
- Validation 只执行一次；
- 固定 17 个 Test 主对照、两组各 8 个消融任务、6 个稳定性任务及其交错顺序；
- 固定模型请求参数、provider 重试、预算、资源、统计和采用判定；
- 运行全部 deterministic、security、recovery 和 report gates；
- 生成 experiment.lock 和总 SHA-256。

正式 Go/No-Go 条件：

- 零个开放 P0/P1 平台缺陷；
- GLM 标准 API smoke 全通过；
- formal doctor、43 任务预检和全部安全门禁通过；
- DatasetLock/OfficialImageSourceLock 与 26 个 TaskEnvironmentLock 全部 sealed 且 hash/platform/local image ID 对账，运行期无 sealed volume RW mount；
- TokenAdmissionEstimator 的 multiplier/margin/version 已冻结，全部校准请求满足 actual≤reservation，单请求 actual 上界 147456 可验证；
- context-overflow provider probe 已冻结 request-level `verified_not_billed` 判据并通过；若供应商不能提供该证据，实验锁必须冻结 `overflow_auto_recovery=false` 与非 overflow 映射测试；
- Controller capacity=1 的并发竞争、重启 reconciliation 和 experiment owner lease 测试通过；
- experiment.lock 完整列出 74 个 run_id；
- dry-run 精确输出 74、14.8M formal accounted cap、GlobalBudgetLedger actual/accounted/预留/剩余、28.8M/50M 门限、预计容器小时和 CNY 估算；
- 配置或代码 hash 不一致时 Test 命令拒绝启动；
- 16-run 预冻结 Dev 校准批次完整：5 个 Dev 任务两主配置各一次，加上 3 个按固定 seed 选出的 Dev 任务两主配置各追加一次；budget_exhausted 不超过 1 个，且 GlobalBudgetLedger 能证明累计量未越过任何 pool/总门限。

统计协议同时冻结为：Wilson 95% 单组区间、10,000 次 repo-cluster paired bootstrap、双侧 exact McNemar、逐仓库结果和 leave-one-repository-out；Test 后不得调整 seed、重采样单位或展示规则。

查看 Validation 后若继续改行为，必须提升协议版本并重新 Validation。

### 4.9 M7：74 个预注册逻辑运行

运行矩阵：

| 配置 | 主实验 | 稳定性新增 | 合计 |
| --- | ---: | ---: | ---: |
| pi-general | 17 | 12 | 29 |
| repofix-full | 17 | 12 | 29 |
| repofix-no-localize | 8 | 0 | 8 |
| repofix-no-verify-feedback | 8 | 0 | 8 |
| 总计 | 50 | 24 | 74 |

执行规则：

- 全局并发 1，official harness max_workers=1；
- Controller capacity semaphore=1 是硬门；额外 Orchestrator 请求排队或返回 resource_busy，不能创建第二个重任务；
- Agent 完成并销毁 Worker 后再启动 Evaluator，不重叠两个重容器阶段；
- 按固定 seed 在配置间交错运行，不能先跑完一组再跑另一组；
- 只对传输、限流、容器启动等预注册基础设施错误重试；
- Pi 普通 provider/session retry 与 Controller 自动重试均关闭；只有 verified-not-billed context overflow 可在同 attempt compact+continue，未验证 overflow 不自动恢复。基础设施重试由 Orchestrator 在无需全局对账或对账完成后创建新 attempt_id，最多 2 个，继续占用原 run 的 200k；
- 错误补丁、测试失败、预算耗尽和超时不重试；
- 不人工追加提示、改补丁、选择性重跑或用稳定性结果替换主实验第一次；
- 每个 run 进入不可变终态，所有失败保留。
- 每次启动/resume 前校验 GlobalBudgetLedger 独占 lease 并核对 provider 账单差额；达到 40M 停止常规运行，unknown usage 立即暂停对账，达到 50M 无条件拒绝请求。

升至并发 2 的条件是完成双任务 Dev soak，无 OOM、超时或明显资源节流，并生成新的版本化实验配置；正式运行中不得自动降/升并发。

退出门：130 个 run_id 全部进入终态，总正式 accounted_tokens 不超过 26M admission cap，ArtifactIndex 无缺失，official/internal 对账无差异。

### 4.10 M8：分析、演示和简历交付

任务：

- 计算 Resolved Rate、配对差值、Wilson 区间、仓库级 bootstrap、McNemar 和 leave-one-repository-out；
- 汇总 Token、CNY、耗时、稳定性、失败类型和安全门禁；
- 对至少三类失败做逐轨迹根因分析；
- 生成完整报告、README、复现手册、架构图、5—7 分钟演示脚本；
- 生成只填写真实数字的简历要点和面试问答；
- 发布可复现核心，原始敏感轨迹保留本地。

退出门：

- 最终报告可从原始制品离线重算；
- 所有轴独立呈现，无综合加权分；
- 结论与证据边界一致；
- 演示使用 Dev/Validation 任务或冻结制品，不现场调 Test；
- 简历不预写不存在的提升数字。

## 5. 正式评测与采用判定

### 5.1 主指标和效应

主指标：

~~~text
Resolved Rate = 同时通过全部 F2P 与 P2P 的任务数 / 30
Delta = Resolved Rate(repofix-full) - Resolved Rate(pi-general)
~~~

+10 个百分点，即 30 个任务净增加至少 3 个 resolved，定义为最小实际意义阈值。配对 95% 区间排除 0 才称为有统计支持。

固定同时报告：绝对成功数、F2P/P2P task pass、patch apply、配对四格、Token、CNY、P50/P90 延迟、失败类型和仓库敏感性。消融只作为 15 任务探索性归因，不包装成强显著性结论。

### 5.2 多轴分级

硬门禁任一失败，实验批次无效并拒绝采用工作流：

- 安全门禁不是 100%；
- 发现 gold/test patch/Git 未来对象泄露；
- official report 与内部结果不一致；
- 配置相关的不公平工具或基础设施差异；
- experiment.lock 被修改；
- 必需制品或审计事件不完整；
- 存在测试绕过或假阳性。

在硬门禁全部通过后，按下列顺序只命中第一个条件：

| 优先级 | 唯一主结论 |
| ---: | --- |
| 1 | Delta ≤ 0，或 P2P Regression Delta ≥ 2 个任务：不采用 RepoFix 工作流 |
| 2 | 0 < Delta < +10pp：无足够默认采用依据 |
| 3 | Delta ≥ +10pp，且 Accounted Token Ratio > 2.0 或 Latency Ratio > 2.0：点估计有实际意义但昂贵，只用于高价值 Issue |
| 4 | Delta ≥ +10pp、效率均 ≤ 2.0，但 P2P Regression Delta = 1：有收益但存在回归风险，只做选择性采用 |
| 5 | Delta ≥ +10pp、效率均 ≤ 2.0、P2P Regression Delta ≤ 0，但配对区间包含 0：有实际收益但统计证据不足 |
| 6 | Delta ≥ +10pp、效率均 ≤ 2.0、P2P Regression Delta ≤ 0，且配对区间排除 0：推荐默认采用 |

P2P Regression Delta = repofix-full 中至少一个 P2P 失败的任务数减去 pi-general 对应数量。Accounted Token Ratio 使用同一 30 任务固定分母下两配置的 `accounted_tokens` 总量比；报告另列 provider actual ratio、imputed reservation 数量和 usage completeness。Latency Ratio 使用同任务配对 wall-clock 比的中位数。每个主结论另附 statistical_support=yes/no、稳定性和可靠性诊断，不改变唯一分类。成功任务成本只作为补充，不能删除失败后再算“看起来便宜”的成本。

不论 RepoFix 工作流是否被采用，只要平台门禁、复现和报告成立，评测基础设施本身仍是有效交付。

## 6. 测试与质量门禁

| 层级 | 必测内容 | 常规环境 |
| --- | --- | --- |
| Schema/单元 | manifest、预算、路径、patch、状态迁移、失败分类、指标、hash | CI |
| Agent 契约 | faux provider、阶段门、工具白名单、budget、abort、provider/tool error | CI，不使用真实 key |
| Controller 契约 | v1 schema、allowlist、幂等 operation、reconcile、capacity semaphore、未知字段拒绝 | CI/fake Docker |
| Docker 工具 | 读搜改执、顺序、截断、超时、abort、路径/符号链接 | 本地/专用 CI |
| Harness Adapter | upstream/patch hash、formal 禁 pull、创建参数、pristine/adapted 判分等价 | 本地 Docker/专用 CI |
| 安全门禁 | 角色化 key/canary/host mount/socket/network/user、caps、PID/CPU/内存、残留 | 本地/专用 CI |
| 确定性 E2E | no-op、malformed、gold、隐藏测试冲突、净化 Git | 本地 Docker |
| 恢复 | preparing/running/evaluating 强杀、重复请求、完成态不可变 | 本地 Docker |
| 报告 | official parser golden、指标 golden、离线重建 hash | CI |
| 付费 Eval | GLM tool/usage smoke、Dev、一次 Validation | 手工受控，不进 CI |
| 正式 Benchmark | 只消费 experiment.lock | M7 |

代码修改后的仓库规则：

- 运行 npm run check，并处理全部 error/warning/info；
- 新增或修改 Vitest 文件时运行对应具体测试文件；
- coding-agent suite 使用 faux provider；
- 不运行真实 provider 的自动化 CI；
- 不运行完整 npm test 或 npm run build，除非用户明确要求；
- Python 测试在固定 Controller 容器中运行，宿主不安装 Python。

关键必须自动化的场景：

1. 余额不足时下一次 provider 请求未发生；
2. 普通 turn 与 compaction 都经过同一 budget gate；冻结 estimator 在 GLM 校准集上满足 `actual_prompt <= reserved_input`，故意低估 fixture 会产生 budget_protocol_invalid 并停止实验；
3. done+完整 usage 在 wrapper 内结算且不等待 message_end，只有 prompt/工具批次返回并完成 session/trace/stage flush 后才写 checkpoint；请求前拒绝以零 charge 关闭且 HTTP 计数不增加，error/abort/unknown usage 全额 charge 并关闭 reservation；
4. 原 streamFn 在返回 stream 前因 auth/onPayload/transport reject 时被转换为 provider_preflight_failure；明确未发 HTTP 为零 charge，发送状态不明则全额 charge 并暂停准入；主 turn 与 compaction 都覆盖；
5. verified-not-billed context overflow 的自动 compact+continue 留在同一 attempt，前后所有调用、轮次和耗时均入账；只有最终成功、全部 reservation 关闭并 flush 后才可 checkpoint。未验证 overflow 被映射为 provider_usage_unverified、全额 charge并暂停，不会触发 continue；budget_exhausted 同样不会触发；
6. setActiveTools 给出不存在工具时立即失败，内建 read/bash 不能被重新启用；
7. stage_complete 单独调用正常结束，与 read/edit 混合时整批在执行前被拒绝；
8. 两个 task/config/replicate/attempt 不串 session；新 attempt 不继承，首个 assistant 前崩溃不能原地恢复；
9. Worker 能读写 /workspace，但不能穿越路径、访问 key 或创建 sibling container；只有 Orchestrator 能读取 key，只有 Controller 能访问 socket；
10. candidate 与 hidden test patch 冲突时不能进入 resolved；
11. official report 和内部结果不一致时整个 run 失败；
12. 同一 operation_id 重放不创建第二个容器；
13. timeout/budget/cancel 并发触发时 first termination reason 固定，清理和 flush 幂等；
14. trace 写失败触发 infrastructure failure 和 abort，message_end/usage/tool start/end 不丢；
15. Orchestrator 崩溃后旧 attempt 消耗仍在 run 总账；open reservation 全额 charge，旧 provider 请求不重放；
16. Dataset Preparer 强杀不会发布未 SEAL generation；sealed volume 无 RW mount；experiment.lock 的 generation/hash 不匹配时 formal 启动失败；
17. OfficialImageSourceLock 只在准备期解析；formal adapter 只按锁定 sanitized evaluator local image ID 启动，ID/provenance 不符时不回退 source、不触发 pull；Axios 四探针及 43-task base/gold 与 pristine harness 对账；
18. Controller 在 artifact ACK 前崩溃后仍能从 controller-work 流出同一校验和制品，ACK 后 GC 幂等；
19. 两个 Orchestrator 同时请求时 capacity=1 只创建一个重任务；Controller 重启后 semaphore 可从 journal/labels 重建；
20. Docker 内部空间门禁来自固定探针容器对 named volume 的 statvfs，不把 `docker info` 或宿主空间当成替代值；
21. report 两次离线重建产生相同指标和 hash。

## 7. 风险、运行策略与最终制品

| 风险 | 当前处理 |
| --- | --- |
| E 盘余量接近最低线 | formal doctor 同查宿主与 Docker 内部；120 GB 硬门，150 GB 建议目标；按需缓存 |
| Docker socket 权限过大 | 仅 Controller 持有；内部窄 API、无宿主端口、manifest/resource allowlist |
| 上游 harness 默认 root、可隐式拉镜像且缺少资源/网络门禁 | 固定 security patch 仅改镜像解析/容器创建；formal fail closed；pristine/adapted 判分等价回归 |
| Controller 临时日志随重启丢失 | controller-work 持久卷；校验和流式交付；ArtifactIndex ACK 前禁止 GC |
| Multilingual 镜像含未来 Git 对象 | official digest 仅作 source；Worker 重建单提交，Evaluator 保留 base commit 但 prune 未来对象；两者均做审计 |
| hidden test patch 冲突假阳性 | 路径冲突、两次 apply check、失败硬拒绝、保留 official raw report |
| GLM 别名或价格变化 | 固定模型 ID、运行时间窗、响应元数据和计价表版本；不可用时新协议，不静默替换 |
| 模型服务端无不可变快照 | 明确写入局限；配置间交错运行，保存 fingerprint/headers 中可用标识 |
| 40M 计划池不足 | 16-run 预冻结校准中至少 2 个 budget_exhausted 即停止；不得靠删任务或缩正式样本解决 |
| 43 任务统计功效有限 | 报告绝对数、区间、配对表、逐仓库和 leave-one-out，不夸大显著性 |
| 报告开发挤占核心 | 先最小静态报告，M5 再完善；不建设通用前端 |

最终仓库交付：

- packages/repofixlab 源码与测试；
- compose.yaml、固定 Dockerfile、依赖锁和镜像 digest lock；
- 数据 manifest、split、experiment.lock、JSON Schema；
- 130 个逻辑 run 及全部 attempt 的本地不可变制品与校验和；
- 聚合 JSON、静态 HTML、失败案例和安全门禁报告；
- README、复现手册、威胁模型、实验协议和局限；
- 5—7 分钟演示脚本；
- 基于真实结果填写的简历要点与面试问答。

公开发布“可复现核心”：源码、配置、schema、冻结清单、聚合报告、去敏成功/失败样例。完整模型轨迹、原始日志和密钥相关信息默认不公开。

## 8. 实施顺序与当前状态

1. **已完成并留有规范证据**：启动 Docker Desktop，运行 bootstrap doctor，记录 daemon、E 盘内外空间、CPU、内存和 socket topology 事实。
2. **进行中**：已建立 repofixlab 包、Compose、v1 TypeBox schema、生成的 JSON Schema、Dataset Preparer 与 bootstrap 生命周期；smoke/formal doctor 生命周期仍待后续里程碑完成。
3. **已完成数据阶段**：把固定 revision 的 43-task 数据集写入 generation-scoped public/control/private staging volumes，校验 revision/hash 后写 READY/SEAL 并发布 DatasetLock；Axios 包含在该封存 generation 中。
4. **下一项，先刷新 provenance**：重建并审计覆盖当前源码的 Orchestrator/Controller 相关镜像和外部锁；随后固定 pristine Harness tree，准备期解析并封存 OfficialImageSourceLock，写最小 security patch，派生 Axios sanitized evaluator，并锁定 upstream/patch/Controller/evaluator image hash。
5. 用 pristine/adapted Harness 对跑 Axios base、no-op、malformed、gold，验证判分等价和 formal 禁 pull。
6. 实现最小 Trusted Controller、controller-work 恢复和唯一 socket ownership 测试。
7. 构建最小 Axios sanitized worker 并通过 Git 泄露审计。
8. 接入 zhipu-standard GLM tool/usage smoke 和最小 usage 记录。
9. 运行一次 pi-general，生成 candidate.patch 与 result.json。
10. 生成最小 report.html，完成门 A 评审后再泛化安全、预算和 RepoFix FSM。

这十项完成前，不并行开发完整报告、四配置或 43 任务缓存，避免在核心评测链路尚未被证明时扩大返工面。

## 9. 依据与上游约束

- SWE-bench 官方 Docker 建议要求 Windows 使用 Docker Desktop + WSL2，并给出 8 CPU、16 GB 内存和 120 GB 可用空间的保守建议：[Docker Setup](https://www.swebench.com/SWE-bench/guides/docker_setup/)。
- 正式评测使用官方 Python harness，而不是自建通过判定：[Harness Reference](https://www.swebench.com/SWE-bench/reference/harness/)。
- 固定 v4.1.0 源码显示 Evaluator 使用 `DOCKER_USER=root`，缺失远端镜像时会 pull，`build_container` 未设置本项目要求的网络和资源限制；因此采用只修改镜像解析/容器创建的固定适配补丁，并以判分等价测试约束范围：[constants](https://github.com/SWE-bench/SWE-bench/blob/726c5461e2ef52d83cf1ea2107870a8bb3328d57/swebench/harness/constants/__init__.py#L104-L106)、[docker_build.py](https://github.com/SWE-bench/SWE-bench/blob/726c5461e2ef52d83cf1ea2107870a8bb3328d57/swebench/harness/docker_build.py#L489-L520)。
- Windows 原生 Python harness 仍存在 resource 模块兼容问题，因此采用 Linux Controller 容器：[Issue #439](https://github.com/swe-bench/SWE-bench/issues/439)。
- Multilingual 非 Python 镜像可能保留未来 Git 对象，Worker 必须净化：[Issue #578](https://github.com/swe-bench/SWE-bench/issues/578)、[PR #581](https://github.com/swe-bench/SWE-bench/pull/581)。
- hidden test patch 冲突可能导致错误判定，Evaluator 必须增加前置门禁：[Issue #538](https://github.com/swe-bench/SWE-bench/issues/538)。
- 智谱官方 OpenAI 兼容文档确认标准 Base URL、`max_tokens`、thinking 和工具调用协议：[OpenAI API 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、[对话补全](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)。
- GLM-4.5-Air 官方资料给出 128K 上下文、96K 最大输出和 Agent/Function Call 能力；本项目主动把单次输出降至 16K：[GLM-4.5](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5)、[核心参数](https://docs.bigmodel.cn/cn/guide/start/concept-param)。
- CNY 费用只按正式冻结时保存的官方价格快照计算：[智谱产品价格](https://bigmodel.cn/pricing)。
