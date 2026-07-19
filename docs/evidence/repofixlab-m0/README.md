# RepoFixLab M0 evidence pack

本目录是 `axios__axios-5892` M0 环境与评测基座的最小可审计证据包。它回答的是“任务数据、镜像、运行时、容器工厂和官方评测链是否被固定并通过门禁”，不宣称 RepoFix Agent、代码修复成功率、成本实验或大规模 SWE-bench 实验已经完成。

## 结论与证据链

最终 `smoke-doctor-report.json` 的状态为 `pass`。它将以下证据绑定为同一条链：

1. `bootstrap-doctor-report.json` 与 `bootstrap-image-provenance-lock.json`：Docker 资源、控制面安全配置和构建来源。
2. `dataset-lock.json`、`official-image-source-lock.json` 与 `official-harness-source-lock.json`：固定的 SWE-bench 数据、任务镜像和官方 Harness 来源。
3. `task-environment-candidate.json`、`task-role-factory-probe-report.json` 与 `pristine-runtime-lock.json`：待采用环境、真实 Worker/Evaluator 工厂探针和未适配官方运行时。
4. 八个 `harness-probe-*.json`：pristine 与 adapted 两条路径分别运行 base、no-op、malformed、gold。两条路径均在前三种场景得到 `resolved=false`，在 gold 场景得到 `resolved=true`。
5. `harness-equivalence-report.json`：两条 Harness 路径的四场景结果等价，状态为 `pass`。
6. `task-environment-lock.json`：仅在工厂、安全配置和 Harness 等价性全部通过后采用候选环境。
7. `smoke-doctor-report.json`：对上述文件及其跨证据绑定做最终复核。

## 来源

所有 JSON 都是下列最终 M0 产物的逐字节副本；发布过程未解析后重写 JSON。

| 本目录文件 | 仓库相对来源 |
| --- | --- |
| `bootstrap-doctor-report.json` | `artifacts/m0/bootstrap-doctor-final-20260718T192454140Z.json` |
| `bootstrap-image-provenance-lock.json` | `artifacts/locks/bootstrap-image-provenance-lock.v1.json` |
| `dataset-lock.json` | `artifacts/dataset-prepare/20260718T135934707Z-243342d1916a/dataset-lock.json` |
| `official-image-source-lock.json` | `artifacts/task-images/active/official-image-source-lock.json` |
| `official-harness-source-lock.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/official-harness-source-lock.json` |
| `task-environment-candidate.json` | `artifacts/task-environment-candidates/active-v2/axios-5892.candidate.json` |
| `task-role-factory-probe-report.json` | `artifacts/m0/factory-probe-final-20260718T192556208Z.json` |
| `pristine-runtime-lock.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/pristine-runtime-lock.json` |
| `task-environment-lock.json` | `artifacts/m0/environment-lock-publish-20260718T192840791Z/task-environment-lock.json` |
| `harness-equivalence-report.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/harness-equivalence.report.json` |
| `harness-probe-pristine-base.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/pristine/base.report.json` |
| `harness-probe-pristine-no-op.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/pristine/no_op.report.json` |
| `harness-probe-pristine-malformed.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/pristine/malformed.report.json` |
| `harness-probe-pristine-gold.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/pristine/gold.report.json` |
| `harness-probe-adapted-base.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/adapted/base.report.json` |
| `harness-probe-adapted-no-op.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/adapted/no_op.report.json` |
| `harness-probe-adapted-malformed.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/adapted/malformed.report.json` |
| `harness-probe-adapted-gold.json` | `artifacts/harness-equivalence/20260719T011345464Z-1ac3dc5e/reports/adapted/gold.report.json` |
| `smoke-doctor-report.json` | `artifacts/m0/smoke-doctor-publish-20260718T193053275Z/smoke-doctor-report.json` |

原始 `artifacts/`、容器日志、补丁输入和 Docker 临时辅助文件不进入本目录。发布前后均扫描了私钥标记、常见访问令牌、非空凭据值、Windows 盘符路径、用户 home 路径和 UNC 路径。

## 完整性验证

在本目录运行：

```sh
sha256sum -c SHA256SUMS
```

PowerShell 可使用：

```powershell
Get-Content SHA256SUMS | ForEach-Object {
    $expected, $name = $_ -split '  ', 2
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $name).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 mismatch: $name" }
}
```

`SHA256SUMS` 覆盖本目录全部 JSON 和本说明文件，不包含其自身。
