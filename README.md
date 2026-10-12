# RepoFix Docker 运行时迭代

`docker` 分支基于已经沉淀为 PLAN Skill 的 RepoFix，完成 WF0–WF7 的运行时迭代：有界并发、资源准入、Worker／Evaluator 预热池、已用容器重置复用，以及故障恢复。Worker 负责代码修改和验证，Evaluator 负责独立正式评分。

本轮保持 PLAN Skill、FSM、模型配置、补丁策略和 V0／V1／V2 验证语义。开发与测量基线为 `be8cb251b170801cfc5ceec431193d6ac5bb56be`，执行依据为[迭代规格与验收记录](docs/plans/repofixlab-runtime-iteration.md)。

## 当前结论

同版代码的固定批次对照中，**并发按需整批最快，为 840.29 秒**。该模式支持有界并发、分阶段资源准入和故障恢复，任务需要环境时新建容器，用完后销毁。

预热池提前准备和检查环境；重置复用减少重复创建角色容器，并降低领取时的准备延迟。本次二者的整批耗时分别为 926.53 秒和 896.61 秒。复用比并发按需慢 6.70%，采样累计 CPU 时间也更高。当前固定批次优先选择并发按需，预热和复用作为可配置的运行模式保留。

## 三种并发模式

| 模式 | 任务需要环境时 | 任务完成后 |
| --- | --- | --- |
| 并发按需 | 当场创建新容器并完成就绪检查 | 销毁容器和任务卷 |
| 并发预热池 | 领取提前准备好的环境，未命中时按需创建 | 使用一次后销毁 |
| 并发重置复用 | 领取预热或已重置并校验的兼容环境 | 停机、恢复、校验后放回池 |

三种模式共享有界并发、资源调度、日志与预算协调、取消和重启恢复。每个容器同时由一个有效租约持有；多个容器可以并行工作。池按角色、准确镜像、任务环境和安全配置匹配，领取时复查身份。

Controller 配置如下，修改后重启 Controller 生效：

| 模式 | `REPOFIXLAB_WORKER_POOL_CAPACITY` | `REPOFIXLAB_EVALUATOR_POOL_CAPACITY` | `REPOFIXLAB_CONTAINER_REUSE` |
| --- | ---: | ---: | --- |
| 并发按需 | `0` | `0` | `false` |
| 并发预热池 | `2` | `1` | `false` |
| 并发重置复用 | `2` | `1` | `true` |

当前代码默认配置为 Worker 池容量 `2`、Evaluator 池容量 `1`、复用开关 `true`。本次文档给出按需模式的实测优选结论，默认值沿用已交付配置。两类池默认空闲期限均为 `300` 秒；Node 批次默认最多同时推进两个任务。固定回放入口通过 `--concurrency`、`--worker-pool`、`--evaluator-pool` 和 `--reuse` 选择实验模式。

## 工作流

| 工作流 | 完成内容 |
| --- | --- |
| WF0 | 确认最终目标、skill 基线、验收要求及每次执行一个工作流的约定 |
| WF1 | 补充分段计时、资源观察和固定补丁回放，冻结样本、资源和性能门槛 |
| WF2 | 实现两个任务有界并行、任务内操作排序、资源准入与预算账本协调 |
| WF3 | 提前准备 Worker，加入就绪领取、容量、过期、取消和清理机制 |
| WF4 | 提前准备 Evaluator，在 Worker 清理通过后绑定精确补丁和评测身份 |
| WF5 | 两角色已用容器重置复用，验证 A → B → A 污染清除、旧租约拒绝及失败替代 |
| WF6 | 验证取消、超时、OOM、Controller 强杀／重启及产物 ACK 中断恢复 |
| WF7 | 优化阶段预约、恢复写入、领取锁竞争和重复初始化，完成四模式同版对照与最终验收 |

WF7 将输入准备、角色执行和正式评分分别准入，确认物理阶段结束后才调整预约。重置逐项比较内容和元数据，恢复差异、删除额外条目并拆除硬链接，再完整校验树身份。领取绑定移到池锁外执行，准备、校验和清理期间继续受容量与资源预算约束。

## 固定回放对照

每种模式执行同一 manifest 的 12 个样本：三轮同环境队列（Preact 4316 → Preact 4316）和混合环境队列（Preact 4316 → Axios 6539）。Preact 回放历史成功补丁，Axios 回放空补丁；每种模式的 9 个 Preact 成功结果和 3 个 Axios 未解决结果均与 WF1 一致。

总预算为 10 CPU／18 GiB，Controller 为 1 CPU／512 MiB，角色运行阶段为 4 CPU／8 GiB。镜像已缓存，宿主页面缓存自然变化。实际测量顺序为复用 → 串行按需 → 并发按需 → 预热池；各模式内的任务顺序和重复次数固定。整批时间包括初始化、预热、验证、重置、领取校验、归档、ACK 和关闭清理。

下表来自 WF7 同一份冻结源码。提交前另补充按需 Evaluator 的关闭清理归属登记，并通过回归和真实 Docker 定向验证；发布记录见规格 7.12，四模式性能数据保留原测量值。

| 模式 | 整批耗时（秒） | 完成任务／分钟 | 创建角色容器 | 创建全部容器 | 采样累计 CPU（秒） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 串行按需 | 1074.80 | 0.67 | 24 | 84 | — |
| 并发按需 | **840.29** | **0.86** | 24 | 84 | **542.76** |
| 并发预热池 | 926.53 | 0.78 | 24 | 90 | 577.67 |
| 并发重置复用 | 896.61 | 0.80 | **14** | **78** | 643.56 |

全部容器统计包含准备、重置和评分辅助容器。CPU／内存使用每 0.5 秒采样，短暂峰值可能未被采到；资源准入按冻结额度执行。

WF1 串行基线为 1136.30 秒。最终复用模式相对 WF1 耗时降低 21.09%，吞吐提高 26.73%，全部 11 项冻结性能门槛通过；这项历史对照同时包含并发、资源调度和公共运行时优化的贡献。同版四模式结果如上表。

| 最终复用模式 | Worker 准备 p50（秒） | Evaluator 准备 p50（秒） |
| --- | ---: | ---: |
| 同环境队列 | 1.46 | 7.37 |
| 混合环境队列 | 1.49 | 7.54 |

复用模式的 Worker 命中为 11／12，Evaluator 命中为 6／12。Worker 重置 12 次、累计 72.01 秒；Evaluator 重置 6 次、累计 35.04 秒，均已包含在整批耗时中。队列预热累计墙钟为 53.46 秒。本回放入口在派发前等待当前组预热完成，六组 Worker 验证均有实际执行重叠。

## 隔离、恢复与验收

- 四模式共 48 个样本评分一致，正常回放基础设施失败为 0。
- 两类角色分别在同一物理容器完成代次 1 → 2 → 3 的 A → B → A，验证工作树、Git、依赖、缓存、临时文件、输入／证据、进程和 IPC 污染清除。
- 重置失败销毁原容器和所属卷，由干净替代环境继续执行；旧租约、旧结果和不兼容环境请求被拒绝。
- WF7 冻结源码通过 24 个真实 Docker 故障场景，核对 300 条日志和 21 份评分文件；重复恢复保持产物字节不变。
- Controller 重启使用原 journal 命名空间清理未知状态资源。清理未完成时拒绝启动和新任务，后续启动继续清理。
- 并发模式预约峰值为 9 CPU／16.5 GiB，新增容器、卷和有效租约残留为零；原有 Docker 资源身份保持不变。
- 按需 Evaluator 启动后直接关闭服务，完整回收未 ACK 的评测容器、5 个所属卷和资源预约；真实 Docker 验证保留原有资源身份。
- WF7 验收的 131 项定向测试通过。提交前重新运行 96 项 Python、20 个修改过的 TypeScript 测试文件共 188 项测试、2 项仓库检查回归，合计 286 项通过；`npm run check` 通过。

## 运行与代码入口

运行前需恢复 manifest 对应的冻结镜像、任务锁和数据卷。完整命令、模式参数、生命周期和恢复步骤见[固定输入 Docker 基准说明](packages/repofixlab/configs/benchmarks/docker-v1/README.md)。本地测量目录 `artifacts/docker-wf7/` 保存逐任务制品、原始记录、报告、故障证据及验收索引。

| 入口 | 职责 |
| --- | --- |
| [batch-runner.ts](packages/repofixlab/src/runner/batch-runner.ts) | 有界批次调度及预算协调 |
| [runtime_service.py](packages/repofixlab/controller/src/repofixlab_controller/runtime_service.py) | 请求顺序、租约、日志、产物与恢复 |
| [runtime_admission.py](packages/repofixlab/controller/src/repofixlab_controller/runtime_admission.py) | CPU／内存准入、等待与取消 |
| [runtime_docker.py](packages/repofixlab/controller/src/repofixlab_controller/runtime_docker.py) | 角色容器准备、激活、重置与物理清理 |
| [runtime_worker_pool.py](packages/repofixlab/controller/src/repofixlab_controller/runtime_worker_pool.py) | Worker／Evaluator 共用的池生命周期协调 |
| [runtime_reset.py](packages/repofixlab/controller/src/repofixlab_controller/runtime_reset.py) | 工作区与输入／证据恢复和完整树校验 |
| [runtime_benchmark.py](packages/repofixlab/controller/src/repofixlab_controller/runtime_benchmark.py) | 固定补丁回放、计时、资源观察及离线报告 |

## PLAN Skill 基线

RepoFix 的 DPO 实验展示了 PLAN 阶段的四类关键痛点：长上下文中的证据绑定不稳定、候选范围容易扩张、状态转换方向容易判断错误，以及验证方案与缺陷触发路径容易错位。

本实验以 Skill 是更具性价比的增强方式为假设，将失败案例中的稳定规律蒸馏为仅在 PLAN 阶段生效的确定性流程，在不改变原有 PLAN Schema 和阶段协议的前提下，提高修复计划的完整性、证据质量与可执行性。

### 核心设计

- **证据绑定**：每个结论同时绑定路径、代码区域和真实行为。
- **因果收敛**：将 LOCALIZE 候选划分为必须修改、只读依赖和排除项，只保留必要改动。
- **状态校验**：以 `ALLOW` / `FORBID` 明确正常、异常和重入路径的状态转换方向。
- **验证对齐**：按触发条件、前置状态和可观察结果选择最贴近问题的验证候选。
- **协议兼容**：沿用 RepoFix 原有 PLAN Schema，并通过原生 `stage_complete` 完成阶段交接。

### 工作流程

```text
问题契约
  ↓
直接证据绑定
  ↓
候选因果分类
  ↓
最小完整修改计划
  ↓
状态转换与保持条件校验
  ↓
验证候选对齐
  ↓
PLAN 制品交接给 IMPLEMENT
```

### 实验效果

RepoFix 此前 26 个任务中已完成 24 个，剩余任务为 `preactjs__preact-3345` 和 `preactjs__preact-3567`。本实验选择 `preactjs__preact-3345`，通过 PLAN Skill 形成完整修复计划，并通过正式 SWE-bench 评测。

以 `preactjs__preact-3345` 为例，PLAN Skill 将修复目标明确为四项核心义务：

1. cleanup 抛错后继续执行剩余 cleanup。
2. child、sibling 和 DOM teardown 必须完成。
3. 同一 cleanup 错误只投递一次。
4. `currentComponent` 在异常路径中始终恢复。

最终补丁修改三个运行时文件：

- `hooks/src/index.js`
- `src/diff/children.js`
- `src/diff/index.js`

| 指标 | 结果 |
|---|---:|
| RepoFix 阶段 | 7/7 完成 |
| 最终验证 V2 | passed |
| 最终补丁文件 | 3 |
| 测试文件改动 | 0 |
| 正式 SWE-bench 评测 | resolved |

### 项目结构

```text
packages/repofixlab/skills/plan-robustness-v1/
├── README.md
├── SKILL.md
└── references/
    ├── evidence-and-scope.md
    ├── state-and-probe.md
    └── bad-case-patterns.md
```

[`SKILL.md`](packages/repofixlab/skills/plan-robustness-v1/SKILL.md) 定义 PLAN 阶段必须执行的主流程；[`references/`](packages/repofixlab/skills/plan-robustness-v1/references/) 承载证据、范围、状态转换、验证对齐与失败模式的细化规则，并与主文件共同组成固定、可校验的 Skill 指令包。
