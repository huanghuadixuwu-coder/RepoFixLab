# RepoFixLab M0 冻结输入

更新时间：2026-07-18

本文只记录已经核实、可进入实现的输入；`null` 表示尚未形成可信本地证据，不能被解释为通过。

## 上游版本

当前 Orchestrator 基础运行时固定为 Node `24.18.0` / linux-amd64，对应
`mirror.gcr.io/library/node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd`。
此前 Node 22.22.3 镜像会触发 `@earendil-works/gondolin@0.12.0` 的 `node >=23.6.0` 引擎告警，已停止使用。
Controller 运行依赖已冻结为 CPython 3.11/linux-amd64 的 23 个精确 wheel 版本，并为实际选择的每个 wheel
记录 SHA-256；构建使用 `--require-hashes --only-binary=:all: --no-deps` 并执行 `pip check`。

```yaml
harness:
  repository: https://github.com/SWE-bench/SWE-bench.git
  tag: v4.1.0
  commit: 726c5461e2ef52d83cf1ea2107870a8bb3328d57
  git_tree_sha1: f178530b37202c549b1b2b3300db2da90da648db
  package_version: 4.1.0

dataset:
  id: SWE-bench/SWE-bench_Multilingual
  revision: 2b7aced941b4873e9cad3e76abbae93f481d1beb
  split: test
  source_path: data/test-00000-of-00001.parquet
  source_size_bytes: 1165968
  source_sha256: 28b7f874e48496399077d276f9f2b163a077ddf0a70dc507c148d58da826baa9
  expected_total_rows: 300
```

固定 revision 的源文件必须先通过 size 与 SHA-256 校验，再进入 Dataset Preparer。上游 `run_evaluation` 没有 revision 参数，正式评测必须读取已经物化和封存的本地 evaluator-only JSONL，不能把数据集名称直接传给 harness 读取浮动 HEAD。

## 43 条 JS/TS 任务

原始数据没有 `language`、image 或 digest 字段，因此不能按不存在的 language 字段过滤。冻结 repo allowlist 与计数如下：

| repo | 数量 |
| --- | ---: |
| `babel/babel` | 5 |
| `vuejs/core` | 5 |
| `facebook/docusaurus` | 5 |
| `immutable-js/immutable-js` | 2 |
| `mrdoob/three.js` | 3 |
| `preactjs/preact` | 17 |
| `axios/axios` | 6 |
| 合计 | 43 |

Preparer 必须同时断言源记录数为 300、上述逐仓库计数、`instance_id` 唯一、子集总数 43，并确认每个 repo/version 能被固定 v4.1.0 的 JS/TS harness spec 解析。`hints_text` 不进入 public manifest 或 Agent prompt。

## Axios bootstrap 实例

```yaml
bootstrap_instance:
  instance_id: axios__axios-5892
  repo: axios/axios
  version: "5892"
  base_commit: ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b
  base_tree_git_sha1: d37c27531ee7d744f25932ad0cb20ecabbf202ff
  problem_statement_sha256: df4208f005bb1878bd03976f917781781c7cfb07dc9910521bba340f7bec9982
  gold_patch_sha256: ac0d497c471e5b17c9de2c6c86a00f99b1d742aa6eb3ad4e96a97bbf91311d9a
  test_patch_sha256: 6c72b7b060d546b8cb1fe44b75aa49a59e6e182496dd1cb7c9244e17a1117293
  fail_to_pass_count: 3
  pass_to_pass_count: 30
  test_command: "npx mocha test/unit/adapters/http.js -R tap -g 'compression'"
```

`axios__axios-5892` 是主动选择的 bootstrap 实例，不是数据集顺序中的首条 Axios 记录。

## 官方镜像来源

```yaml
prepare_only_tag_ref: swebench/sweb.eval.x86_64.axios_1776_axios-5892:latest
source_repository_digest: swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8
platform: linux/amd64
registry_size_bytes: 687752489
source_local_image_id: null
resolved_at: null
registry_response_sha256: null
```

registry tag API 只能作为准备期解析输入。当前本机尚无该镜像，必须在资源门禁通过后按 `repository@digest` 拉取，并 inspect 得到 local image ID 后才能封存 OfficialImageSourceLock。正式 profile 禁止重新解析 `latest`。

## 四探针语义

- `base`：不应用 candidate，但复用官方 eval script、parser 与 grading；上游 CLI 不能直接表达，需 Controller 专用 control。
- `no-op`：不能传空 patch，因为上游会过滤；使用可应用且不影响源码/测试的固定中性 patch。
- `malformed`：固定非法 diff；预期进入 official `error_ids`，内部只有看到精确 patch-apply-failed 证据才映射为 `patch_apply_error`。
- `gold`：从固定本地 evaluator-only JSONL 读取 gold patch。

预期值在 pristine/adapted 两边实测对账前都不是结果。对账必须覆盖 resolved、patch 状态、F2P/P2P 成败集合、parser 测试集合、错误类别与原始报告。

## 主要上游依据

- [SWE-bench v4.1.0](https://github.com/SWE-bench/SWE-bench/releases/tag/v4.1.0)
- [固定 TestSpec 镜像规则](https://github.com/SWE-bench/SWE-bench/blob/726c5461e2ef52d83cf1ea2107870a8bb3328d57/swebench/harness/test_spec/test_spec.py)
- [固定 run_evaluation](https://github.com/SWE-bench/SWE-bench/blob/726c5461e2ef52d83cf1ea2107870a8bb3328d57/swebench/harness/run_evaluation.py)
- [固定 JS/TS specs](https://github.com/SWE-bench/SWE-bench/blob/726c5461e2ef52d83cf1ea2107870a8bb3328d57/swebench/harness/constants/javascript.py)
- [SWE-bench Multilingual](https://www.swebench.com/multilingual.html)
