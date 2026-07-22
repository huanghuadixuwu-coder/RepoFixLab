# RepoFixLab M8 离线复现指南

## 前提

- 已存在完整的 M7 制品：`artifacts/m7-v1.7.2/`、`artifacts/m7-v1.7.3/` 和 `artifacts/m4-dev/`；
- Docker Desktop 正在运行 Linux containers；
- 不需要 Provider API Key，M8 不会发起模型请求。

## 一键重建

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repofixlab-m8.ps1
```

该入口会：

1. 验证指定 M7 continuation report 与 security audit 都位于 `artifacts/` 内；
2. 构建带 Compose 配置 hash 的 Orchestrator；
3. 仅挂载 `artifacts/`，在无 Controller、无 Worker、无 Evaluator、无 Provider 调用的容器中完成分析；
4. 在 `artifacts/m8/report/` 写入 hash 绑定的 JSON、Markdown 和 HTML。

若需对另一套已封存报告分析，可显式传入相对路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\repofixlab-m8.ps1 `
  -ContinuationReport 'm7-v1.7.3/report/continuation-<sha256>.json' `
  -SecurityAudit 'm7-v1.7.3/report/security-<sha256>.json'
```

路径必须位于 `artifacts/` 内，绝对路径和目录逃逸都会在 Docker 前拒绝。

## 验收

M8 成功时标准输出包含：

- `status: pass`；
- 74 条逻辑运行、71 条官方评测、48 条 official resolved；
- M8 JSON/Markdown/HTML 的路径与 SHA-256。

打开生成的 HTML 即可离线观看。应重点确认：

- 主成功率为 `48/74 = 64.86%`，而非仅官方已评测的 `48/71`；
- 比较表按 64-turn 与 128-turn 分层；
- 3 条无最终快照运行仍在失败和 Token 分母中；
- CNY 为 unavailable 时保持 unavailable；
- 安全审计为 0 policy violation、0 unblocked sandbox escape attempt。
