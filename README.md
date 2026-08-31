# RepoFix PLAN Post-Training

RepoFix 的实际修复效果受 PLAN 阶段输出质量限制。本项目面向 RepoFix 的 PLAN 阶段，通过 SFT 与 DPO，强化模型拆解任务、构造禁止发生的反例及识别非法状态转移的能力。

模型读取 Issue、UNDERSTAND/LOCALIZE 阶段产物与仓库证据，生成结构化 PLAN：

```text
Issue 目标
→ 验收义务
→ 不可接受反例
→ 可观察状态
→ 禁止状态转移
```

## 核心结果

Qwen3-4B 在同一份 50 条冻结测试集、同一套解码配置和判分规则下完成 Base、SFT、DPO 对比：

| 模型阶段 | protocol | task correctness | effective pass |
| --- | ---: | ---: | ---: |
| Base | 6%（3/50） | 2.75%（11/400） | 0%（0/50） |
| SFT | 74%（37/50） | 40.75%（163/400） | 14%（7/50） |
| SFT → DPO（β=0.1） | **86%（43/50）** | **51.50%（206/400）** | **32%（16/50）** |

`qwen3-4b-dpo-b01` 在 8 个对照对象中取得最高 `effective_pass`。相较 4B SFT，DPO 将 `protocol`、`task correctness`、`effective pass` 分别提升 **12、10.75、18 个百分点**。

## 项目亮点

- 完成 Qwen3-1.7B、Qwen3-4B 的 2 个 SFT run 与 4 个 DPO run，并统一评估 8 个 Base/SFT/DPO 对象。
- 从 2,228 条候选 Issue 中构建 410 条标准 PLAN 与 300 对 DPO 偏好数据，覆盖 C、Go、Java、JavaScript、TypeScript。
- 训练、验证、测试按仓库隔离，五种语言等量切分，任务清单由固定 SHA-256 规则确定性生成。
- Gold patch 与测试结果只供标签教师确认答案，不进入学生输入，实现标签侧证据隔离。
- 标准 PLAN 经 Schema 校验、独立语义审查与固定重生成门禁，DPO rejected PLAN 每条只包含一种目标缺陷。
- 50 条冻结测试任务均配备 8 项原子判分清单；两个独立 Judge 分别判分，分歧项由第三次隔离调用仲裁。
- 胜出模型完成 Adapter 合并、`Q4_K_M` GGUF 量化，并通过 5 条本机 llama.cpp PLAN Schema 冒烟验证。

## 训练目标

项目在 RepoFix 既有 PLAN 合同上强化两项语义能力：

### 验收反例

每个 Issue 核心目标形成独立 `acceptance_obligation`：

```text
target_behavior
→ counterexample
→ probe
→ expected_result
```

`counterexample` 描述修复后禁止继续出现的错误行为，与用于保护正常路径的 `preservation_invariant` 分离。

### 状态转移约束

`state_transition_checks` 将关键运行过程拆成可观察状态，并明确错误路径：

```text
states: 关键运行节点及其可观察条件
forbidden_transitions: 起点、终点、禁止原因
```

## 数据集

数据源固定为 `PrimeIntellect/Multi-SWE-RL-Verified` revision `80de95c62ac792c99dcfa8e26569bcd7d036bdc3`。

| 数据产物 | 训练 | 验证 | 冻结测试 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 标准 PLAN / SFT | 315 | 45 | 50 | 410 |
| DPO pair | 270 | 30 | 0 | 300 |

每种语言包含 63 条 SFT 训练、9 条 SFT 验证和 10 条冻结测试任务；DPO 每种语言包含 54 对训练与 6 对验证数据。每个 Issue 只生成一条标准 PLAN。

## 实验流程

```text
STAGE00 冻结实验配置
→ STAGE01 构建并审查数据
→ STAGE02 渲染数据与计算上下文
→ STAGE03 A100 40GB 最长样本预检
→ STAGE04 SFT
→ STAGE05 DPO
→ STAGE06 生成 400 条冻结测试输出
→ STAGE07 统一判分与模型选择
→ STAGE08 合并、量化与部署冒烟
→ STAGE09 报告归档
```

| 项目 | 配置 |
| --- | --- |
| Base Model | Qwen3-1.7B、Qwen3-4B |
| 训练框架 | LLaMA-Factory + LoRA |
| 训练设备 | NVIDIA A100-PCIE-40GB |
| 上下文长度 | 13,568 tokens，无训练样本截断 |
| 数据教师与判分 | DeepSeek V4 Flash 隔离调用 |
| SFT | 3 epochs，LoRA rank 16 |
| DPO | 1 epoch，β=0.1 / 0.3 |
| 随机种子 | 42 |

## 评估指标

| 指标 | 定义 |
| --- | --- |
| `protocol` | PLAN JSON 通过 Schema 的任务比例 |
| `task_correctness` | 通过的验收反例与状态转移原子项占比 |
| `effective_pass` | Schema 与该任务全部 8 项语义原子判分同时通过的任务比例 |

模型选择以 `effective_pass` 为第一排序键，训练 loss 与 DPO reward 只用于训练诊断。

## 项目结构

```text
docs/post_train/             任务设计、数据集设计、实验执行与 PLAN Schema
scripts/post_train/          数据构建、校验、训练编排、判分与报告脚本
configs/post_train/v1/       A100、LLaMA-Factory 与模型运行配置
artifacts/post_train/v1/     本地训练、评估、部署与报告产物
```

核心文档：

- [后训练设计](docs/post_train/design.md)
- [数据集设计](docs/post_train/dataset_design.md)
- [实验执行](docs/post_train/experiment_execution.md)
- [PLAN JSON Schema](docs/post_train/plan.schema.json)

## 技术栈

Qwen3 · SFT · DPO · LoRA · LLaMA-Factory · DeepSeek V4 Flash · Multi-SWE-RL-Verified · llama.cpp

## License

[MIT](LICENSE)
