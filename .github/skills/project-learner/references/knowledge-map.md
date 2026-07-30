# RepoFixLab 学习知识地图

本地图用于选题导航。提出问题或给出答案前，必须读取对应的当前实现；路径是入口，不是事实替代品。表内以 `src/`、`controller/`、`evaluator/`、`dataset-preparer/`、`configs/` 或 `task-images/` 开头的路径，均相对于 `packages/repofixlab/`。

## D1 项目定位与证据口径（4）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D1.1 | RepoFixLab 解决的问题、目标与非目标 | `docs/designs/repofixlab.md` 第 1–5 节 |
| D1.2 | Pi、RepoFix Agent 与 RepoFixLab 平台的关系 | `docs/resume/repofixlab-next-session-code-audit-and-documentation.md`；`src/agent/pi-general.ts`；`src/agent/repofix.ts` |
| D1.3 | 文档、代码、冻结配置与运行制品的证据优先级 | 交接文档第 2–3 节；R2 执行契约 |
| D1.4 | 原始 Full、corrected Full 与最新替换视图的报告边界 | `docs/reports/repofixlab-experiment-summary.md`；R2 复盘 |

## D2 系统架构与信任边界（5）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D2.1 | Node Orchestrator 的模型、预算和状态所有权 | `src/cli/main.ts`；`src/runner/`；设计规格第 6 节 |
| D2.2 | Trusted Controller 的 Docker 所有权与窄 RPC | `controller/.../app.py`；`runtime_http.py`；`runtime_service.py` |
| D2.3 | Agent Worker 的无凭据、受限仓库执行环境 | `runtime_docker.py`；`runtime_worker_entry.py`；`task-images/generic/` |
| D2.4 | 独立 Evaluator 与 Worker 文件系统隔离 | `runtime_docker.py`；`evaluator/repofixlab_evaluator/runner.py` |
| D2.5 | Dataset Preparer、锁文件与 Artifact Store 的职责 | `dataset-preparer/`；`src/storage/artifact-store.ts`；设计规格第 8–9 节 |

## D3 RepoFix 阶段工作流（5）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D3.1 | UNDERSTAND 到 SELF_REVIEW 的阶段流转 | `src/agent/repofix.ts`；`src/agent/repofix-fsm.ts` |
| D3.2 | 阶段工具白名单与 `stage_complete` 独占批次 | `repofix-fsm.ts`；`src/sandbox/repo-tools.ts` |
| D3.3 | 阶段产物 schema、字段级诊断与 completion-only 恢复 | `repofix-fsm.ts`；`repofix.ts`；R2 执行契约 |
| D3.4 | 有界 handoff、审计视图与模型可见上下文分离 | `repofix.ts`；`repo-tools.ts` |
| D3.5 | P0、V0/V1/V2、V1/V2 快照、SELF_REVIEW 与 P1 不变量 | `src/runner/m4-dev-workflow.ts`；`src/m7/formal-runner.ts` |

## D4 Pi 会话与仓库工具桥接（4）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D4.1 | 隔离 Agent session、模型身份与 ResourceLoader | `src/runner/runtime-factory.ts`；`src/agent/pi-general.ts` |
| D4.2 | Pi hooks、`shouldStopAfterTurn` 与阶段控制 | `src/agent/repofix.ts`；`packages/agent/src/agent.ts` |
| D4.3 | repo 工具协议、分页与 12/48 KiB 模型可见预算 | `src/sandbox/protocol.ts`；`src/sandbox/repo-tools.ts`；`src/controller/client.ts` |
| D4.4 | Pi-general、Full 与消融配置的公平差异 | `src/agent/repofix-config.ts`；`configs/experiments/r2-v6.yaml` |

## D5 Controller 生命周期与 Docker 后端（5）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D5.1 | HTTP 请求到 attempt 生命周期服务的调用链 | `runtime_http.py`；`runtime_service.py`；`src/runner/controller-runtime.ts` |
| D5.2 | attempt/execution namespace、operation ID 与幂等重放 | `runtime_service.py`；`src/controller/client.ts`；R2 执行契约 |
| D5.3 | 路径、字段、argv、测试目录和 shell 拒绝策略 | `runtime_tools.py`；`src/sandbox/protocol.ts` |
| D5.4 | 容器标签、资源限制、残留审计与回收 | `runtime_docker.py`；`container_factory.py` |
| D5.5 | worker readiness probe 与 pre-Provider 失败 | `m4-dev-workflow.ts`；`runtime_tools.py`；`pre-provider-failure.ts` |

## D6 受控验证与语义证据（5）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D6.1 | Controller-owned verification catalog 与候选 ID | `runtime_tools.py`；`m4-dev-workflow.ts` |
| D6.2 | 独立 baseline/candidate clone 和补丁应用 | `runtime_tools.py` |
| D6.3 | `passed`、`test_failed`、`command_invalid`、`environment_failure`、`timed_out` | `src/contracts/v1.ts`；`runtime_tools.py` |
| D6.4 | `regression_pass`、`acceptance_proven` 与 `inconclusive` 的语义边界 | R2 复盘第 4.4–4.5 节 |
| D6.5 | Full 与 no-verification-feedback 的控制变量 | `repofix-config.ts`；R2 执行契约 |

## D7 跨语言契约、制品与恢复（5）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D7.1 | canonical JSON、hash 身份与 schema 生成 | `src/contracts/canonical-json.ts`；`schema-generator.ts` |
| D7.2 | run、attempt、snapshot、evaluation 契约 | `src/contracts/run-contracts.ts`；`src/contracts/v1.ts` |
| D7.3 | 原子制品发布、索引和不可变快照 | `src/storage/artifact-store.ts` |
| D7.4 | BatchState、quiescent checkpoint 与恢复条件 | `src/runner/batch-state.ts`；设计规格第 12 节 |
| D7.5 | Controller hash-chain journal 与重启恢复 | `runtime_journal.py`；`runtime_service.py` |

## D8 批处理、预算与指标（4）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D8.1 | CLI、M7、R2 batch 和 formal runner 的分派链 | `src/cli/main.ts`；`src/m7/batch-runner.ts`；`src/r2/batch-runner.ts` |
| D8.2 | GlobalBudgetLedger、TokenSupervisor、reservation 与结算 | `global-budget-ledger.ts`；`token-supervisor.ts`；`pricing.ts` |
| D8.3 | 唯一 termination reason、失败分类与 pre-Provider 记账 | `batch-runner.ts`；`pre-provider-failure.ts`；契约类型 |
| D8.4 | 任务级指标、统计口径与静态报告 | `metrics/experiment-metrics.ts`；`report/experiment-report.ts` |

## D9 Evaluator、数据与安全（4）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D9.1 | Agent patch 准入、test patch 策略与 official oracle | `evaluator/.../agent_patch.py`；`patches.py`；`official_oracle.py` |
| D9.2 | F2P、P2P、TAP 解析与 `resolved` 判定 | `runner.py`；`tap.py`；实验摘要 |
| D9.3 | DatasetLock、TaskEnvironmentLock、镜像来源锁与角色探针 | `src/contracts/task-environment-lock.ts`；`official-image-source-lock.ts`；`task-role-factory-probe.ts` |
| D9.4 | 威胁模型、148/42 拒绝证据和结论限制 | 设计规格第 8 节；交接文档第 3.3 节；`src/m7/security-audit.ts` |

## D10 实验、失败案例与工程实践（4）

| ID | 知识点 | 主要依据 |
| --- | --- | --- |
| D10.1 | 冻结配置、Full/消融/稳定性实验与公平性 | `configs/experiments/`；设计规格第 10–11 节 |
| D10.2 | 20/26、22/26、24/26 与 Pi 21/26 的可比较性 | 实验摘要；R2 复盘 |
| D10.3 | `preactjs__preact-3345`、`3567` 的语义未解决原因 | R2 复盘第 4.4–4.5 节 |
| D10.4 | 契约测试、Controller 测试、静态检查和安全调试路径 | `packages/repofixlab/test/`；`controller/tests/`；仓库 `AGENTS.md` |
