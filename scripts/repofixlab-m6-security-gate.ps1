[CmdletBinding()]
param(
    [string]$CandidateCatalogPath = "artifacts/m6-candidate-catalog/20260720T001518846Z-26-task-v1/candidate-catalog.json",
    [string]$FactoryCatalogPath = "artifacts/m6-factory-probes/20260720T002522203Z-26-task-v1/factory-probe-catalog.json",
    [string]$M2SecurityAnchorPath = "artifacts/m2-security-probes/m2-security-87024ca4bec14432bb75c044d857fe82/security-probe-report.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-StrictJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not [IO.File]::Exists($Path)) {
        throw "$Label does not exist: $Path"
    }
    try {
        return [IO.File]::ReadAllText($Path, $utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "$Label is not valid JSON: $Path"
    }
}

function Assert-Gate {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-RepositoryRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $resolvedRoot = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([char[]]@('\', '/'))
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Security evidence path escapes the repository: $Path"
    }
    return $resolvedPath.Substring($resolvedRoot.Length + 1).Replace("\\", "/")
}

function Wait-ForController {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        & docker compose exec -T controller python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=1).read()" *> $null
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Controller did not become healthy during the M6 security gate"
}

function Assert-RoleReport {
    param(
        [Parameter(Mandatory = $true)][object]$Role,
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [Parameter(Mandatory = $true)][string]$BaseCommit
    )

    Assert-Gate -Condition ([string]$Role.status -ceq "pass") -Message "$InstanceId role factory report did not pass"
    Assert-Gate -Condition ([string]$Role.actual_image_id -ceq [string]$Role.expected_image_id) -Message "$InstanceId role image ID drifted"
    Assert-Gate -Condition ([string]$Role.actual_platform -ceq "linux/amd64") -Message "$InstanceId role platform drifted"
    Assert-Gate -Condition ([string]$Role.actual_provenance_sha256 -ceq [string]$Role.expected_provenance_sha256) -Message "$InstanceId role provenance drifted"
    $inspect = $Role.inspect
    Assert-Gate -Condition ([string]$inspect.network_mode -ceq "none") -Message "$InstanceId role network isolation drifted"
    Assert-Gate -Condition ($inspect.read_only_root_filesystem -eq $true) -Message "$InstanceId role root filesystem is writable"
    Assert-Gate -Condition ((@($inspect.cap_drop) -join ",") -ceq "ALL") -Message "$InstanceId role capability drop drifted"
    Assert-Gate -Condition (@($inspect.cap_add).Count -eq 0) -Message "$InstanceId role adds Linux capabilities"
    Assert-Gate -Condition ((@($inspect.security_opt) -join ",") -ceq "no-new-privileges:true") -Message "$InstanceId role no-new-privileges policy drifted"
    Assert-Gate -Condition ($inspect.privileged -eq $false) -Message "$InstanceId role is privileged"
    Assert-Gate -Condition ([int]$inspect.device_count -eq 0) -Message "$InstanceId role has a device attachment"
    Assert-Gate -Condition (@($inspect.published_ports).Count -eq 0) -Message "$InstanceId role exposes a host port"
    Assert-Gate -Condition (@($inspect.mounts | Where-Object { $_.type -ceq "bind" }).Count -eq 0) -Message "$InstanceId role has a host bind mount"
    Assert-Gate -Condition (@($inspect.docker_socket_paths_present).Count -eq 0) -Message "$InstanceId role can see a Docker socket"
    Assert-Gate -Condition (@($inspect.sensitive_environment_names_present).Count -eq 0) -Message "$InstanceId role has a sensitive environment variable"
    $active = $Role.active_probe
    Assert-Gate -Condition ([string]$active.status -ceq "pass") -Message "$InstanceId role active probe did not pass"
    Assert-Gate -Condition ([string]$active.observed_base_commit -ceq $BaseCommit) -Message "$InstanceId role active probe base commit drifted"
    Assert-Gate -Condition (@($active.docker_socket_paths_present).Count -eq 0) -Message "$InstanceId role active probe found a Docker socket"
    Assert-Gate -Condition (@($active.sensitive_environment_names_present).Count -eq 0) -Message "$InstanceId role active probe found a sensitive environment variable"
    Assert-Gate -Condition ($active.writable_path_roundtrip -eq $true) -Message "$InstanceId role cannot use its managed writable workspace"
    $cleanup = $Role.cleanup
    Assert-Gate -Condition ($cleanup.container_removed -eq $true) -Message "$InstanceId role cleanup did not remove its container"
    Assert-Gate -Condition (@($cleanup.residual_container_ids).Count -eq 0) -Message "$InstanceId role cleanup left a container"
    Assert-Gate -Condition (@($cleanup.residual_volume_names).Count -eq 0) -Message "$InstanceId role cleanup left a volume"
    Assert-Gate -Condition (@($cleanup.errors).Count -eq 0) -Message "$InstanceId role cleanup reported an error"
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$candidateCatalogAbsolute = Join-Path $repositoryRoot $CandidateCatalogPath
$factoryCatalogAbsolute = Join-Path $repositoryRoot $FactoryCatalogPath
$m2SecurityAnchorAbsolute = Join-Path $repositoryRoot $M2SecurityAnchorPath
$artifactsRoot = Join-Path $repositoryRoot "artifacts"
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$outputRoot = Join-Path $artifactsRoot "m6-security-gate\$timestamp-26-task-v1"
$reportPath = Join-Path $outputRoot "security-gate-report.json"
$rejectionPath = Join-Path $outputRoot "controller-rejection.json"

Assert-Gate -Condition (-not [IO.Directory]::Exists($outputRoot)) -Message "Refusing to overwrite M6 security gate evidence: $outputRoot"
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null

$errors = [Collections.Generic.List[string]]::new()
$checks = [ordered]@{}
$controllerRejection = $null
$candidateCount = 0
$factoryReportCount = 0
$workerImageIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$evaluatorImageIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

try {
    $candidateCatalog = Read-StrictJson -Path $candidateCatalogAbsolute -Label "M6 candidate catalog"
    $factoryCatalog = Read-StrictJson -Path $factoryCatalogAbsolute -Label "M6 factory catalog"
    $m2Anchor = Read-StrictJson -Path $m2SecurityAnchorAbsolute -Label "M2 security anchor"
    $candidates = [object[]]@($candidateCatalog.candidates)
    $factoryReports = [object[]]@($factoryCatalog.factory_reports)
    Assert-Gate -Condition ([string]$candidateCatalog.schema_version -ceq "v1") -Message "M6 candidate catalog schema drifted"
    Assert-Gate -Condition ([string]$candidateCatalog.artifact_type -ceq "m6_task_environment_candidate_catalog") -Message "M6 candidate catalog type drifted"
    Assert-Gate -Condition ($candidates.Count -eq 26) -Message "M6 candidate catalog must cover exactly 26 tasks"
    Assert-Gate -Condition ([string]$factoryCatalog.schema_version -ceq "v1") -Message "M6 factory catalog schema drifted"
    Assert-Gate -Condition ([string]$factoryCatalog.artifact_type -ceq "m6_task_role_factory_probe_catalog") -Message "M6 factory catalog type drifted"
    Assert-Gate -Condition ([int]$factoryCatalog.candidate_count -eq 26 -and $factoryReports.Count -eq 26) -Message "M6 factory catalog coverage drifted"
    Assert-Gate -Condition ([string]$factoryCatalog.candidate_catalog_file_sha256 -ceq (Get-Sha256 -Path $candidateCatalogAbsolute)) -Message "M6 factory catalog does not bind the exact candidate catalog"
    $candidateById = @{}
    foreach ($candidate in $candidates) {
        $candidateId = [string]$candidate.candidate_id
        $instanceId = [string]$candidate.instance_id
        Assert-Gate -Condition ($candidateId -match '^task-environment-candidate-v1-' -and $instanceId -match '^[a-z0-9][a-z0-9_.-]{0,199}__[a-z0-9][a-z0-9_.-]{0,199}$') -Message "M6 candidate identity is malformed"
        Assert-Gate -Condition ($null -eq $candidateById[$candidateId]) -Message "M6 candidate catalog has duplicate candidate IDs"
        $candidateById[$candidateId] = $candidate
    }
    Assert-Gate -Condition ([string]$m2Anchor.status -ceq "pass") -Message "The retained M2 security anchor is not a pass"
    Assert-Gate -Condition ($m2Anchor.host_canary.unchanged -eq $true) -Message "The retained M2 host canary was modified"
    foreach ($key in @(
        "canary_unchanged",
        "controller_rejects_arbitrary_host_controls",
        "factory_probe_passed",
        "worker_evaluator_no_host_binds",
        "worker_evaluator_no_socket_or_sensitive_environment",
        "worker_evaluator_cleanup_clean",
        "provider_credential_bound_to_m1_runner_file_only",
        "factory_probe_transcript_has_no_provider_credential_assignment"
    )) {
        Assert-Gate -Condition ($m2Anchor.checks.$key -eq $true) -Message "The retained M2 security anchor lacks $key"
    }

    $factoryRoot = Split-Path -Parent $factoryCatalogAbsolute
    $seenInstances = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $factoryReports) {
        $instanceId = [string]$entry.instance_id
        $candidateId = [string]$entry.candidate_id
        Assert-Gate -Condition ($seenInstances.Add($instanceId)) -Message "M6 factory catalog contains a duplicate instance"
        $candidate = $candidateById[$candidateId]
        Assert-Gate -Condition ($null -ne $candidate) -Message "M6 factory catalog references an unknown candidate"
        Assert-Gate -Condition ([string]$candidate.instance_id -ceq $instanceId -and [string]$candidate.candidate_sha256 -ceq [string]$entry.candidate_sha256) -Message "M6 factory candidate binding drifted"
        $relativeReportPath = [string]$entry.report_path
        Assert-Gate -Condition ($relativeReportPath -match '^reports/[A-Za-z0-9_.-]+\.factory-report\.json$') -Message "M6 factory report path is malformed"
        $reportPathAbsolute = Join-Path $factoryRoot $relativeReportPath
        Assert-Gate -Condition ([IO.Path]::GetFullPath($reportPathAbsolute).StartsWith([IO.Path]::GetFullPath($factoryRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) -Message "M6 factory report path escapes the catalog root"
        Assert-Gate -Condition ([IO.File]::Exists($reportPathAbsolute)) -Message "M6 factory report is missing"
        Assert-Gate -Condition ((Get-Sha256 -Path $reportPathAbsolute) -ceq [string]$entry.report_file_sha256) -Message "M6 factory report file hash drifted"
        $report = Read-StrictJson -Path $reportPathAbsolute -Label "M6 factory report"
        Assert-Gate -Condition ([string]$report.schema_version -ceq "v1" -and [string]$report.report_type -ceq "task_role_factory_probe") -Message "$instanceId factory report type drifted"
        Assert-Gate -Condition ([string]$report.status -ceq "pass" -and @($report.errors).Count -eq 0) -Message "$instanceId factory report did not pass"
        Assert-Gate -Condition ([string]$report.report_sha256 -ceq [string]$entry.report_sha256) -Message "$instanceId factory report seal drifted"
        Assert-Gate -Condition ([string]$report.operation_id -ceq [string]$entry.operation_id -and [string]$report.candidate_id -ceq $candidateId -and [string]$report.candidate_sha256 -ceq [string]$entry.candidate_sha256 -and [string]$report.instance_id -ceq $instanceId) -Message "$instanceId factory report binding drifted"
        Assert-Gate -Condition ((@($report.execution_order) -join ",") -ceq "worker,evaluator") -Message "$instanceId factory execution order drifted"
        Assert-Gate -Condition ([string]$report.controller_execution.compose_service -ceq "controller") -Message "$instanceId factory execution did not identify the Controller"
        Assert-Gate -Condition ($report.controller_execution.read_only_root_filesystem -eq $true) -Message "$instanceId Controller root filesystem is writable"
        Assert-Gate -Condition ((@($report.controller_execution.cap_drop) -join ",") -ceq "ALL") -Message "$instanceId Controller capability policy drifted"
        Assert-Gate -Condition ((@($report.controller_execution.security_opt) -join ",") -ceq "no-new-privileges:true") -Message "$instanceId Controller no-new-privileges policy drifted"
        Assert-Gate -Condition (@($report.controller_execution.published_ports).Count -eq 0) -Message "$instanceId Controller exposes a host port"
        Assert-Gate -Condition (@($report.controller_execution.networks).Count -eq 1 -and $report.controller_execution.networks[0].internal -eq $true) -Message "$instanceId Controller network topology drifted"
        Assert-RoleReport -Role $report.roles.worker -InstanceId $instanceId -BaseCommit ([string]$report.base_commit)
        Assert-RoleReport -Role $report.roles.evaluator -InstanceId $instanceId -BaseCommit ([string]$report.base_commit)
        [void]$workerImageIds.Add([string]$report.roles.worker.actual_image_id)
        [void]$evaluatorImageIds.Add([string]$report.roles.evaluator.actual_image_id)
    }
    Assert-Gate -Condition ($seenInstances.Count -eq 26) -Message "M6 factory reports do not cover all 26 candidates"

    & docker compose up -d --no-build controller | Out-Null
    Assert-Gate -Condition ($LASTEXITCODE -eq 0) -Message "Controller startup failed during M6 security gate"
    Wait-ForController
    $composeConfig = ((& docker compose --profile m1 --profile dataset-prepare config --format json) | Out-String | ConvertFrom-Json)
    foreach ($serviceName in @("controller", "orchestrator", "dataset-preparer")) {
        $service = $composeConfig.services.PSObject.Properties[$serviceName].Value
        Assert-Gate -Condition ($null -eq $service.PSObject.Properties["secrets"]) -Message "$serviceName receives a provider secret"
        Assert-Gate -Condition ($null -eq $service.environment.PSObject.Properties["ZHIPU_API_KEY"]) -Message "$serviceName receives a provider credential environment value"
        Assert-Gate -Condition ($null -eq $service.environment.PSObject.Properties["ZHIPU_API_KEY_FILE"]) -Message "$serviceName receives a provider credential file path"
    }
    $m1Runner = $composeConfig.services.PSObject.Properties["m1-runner"].Value
    Assert-Gate -Condition (@($m1Runner.secrets).Count -eq 1) -Message "M1 runner must receive exactly one file-backed provider secret"
    Assert-Gate -Condition ($null -eq $m1Runner.environment.PSObject.Properties["ZHIPU_API_KEY"]) -Message "M1 runner receives a provider credential environment value"
    Assert-Gate -Condition ($m1Runner.environment.ZHIPU_API_KEY_FILE -ceq "/run/secrets/zhipu_api_key") -Message "M1 runner does not use the fixed provider secret file path"

    $rejectionProbe = @'
import json
import sys
import urllib.error
import urllib.request

payload = json.dumps(
    {
        "operation_id": "m6-reject-host-controls",
        "candidate_id": "forbidden",
        "instance_id": "axios__axios-4731",
        "canary_path": "/artifacts/m6-security-gate/forbidden",
        "host_mount": "/forbidden",
    }
).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:8000/v1/factory/task-role-probes",
    data=payload,
    headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(request, timeout=5)
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "body": json.loads(error.read().decode("utf-8"))}, sort_keys=True))
    sys.exit(0 if error.code == 422 else 1)
raise SystemExit("unexpected Controller acceptance")
'@
    $rejectionOutput = @($rejectionProbe | & docker compose exec -T controller python -)
    Assert-Gate -Condition ($LASTEXITCODE -eq 0) -Message "Controller accepted or could not reject arbitrary host controls"
    $controllerRejection = ($rejectionOutput -join "`n") | ConvertFrom-Json
    [IO.File]::WriteAllText($rejectionPath, (($controllerRejection | ConvertTo-Json -Depth 8) + "`n"), $utf8NoBom)
    $rejectedFields = @($controllerRejection.body.detail | ForEach-Object { $_.loc[1] })
    Assert-Gate -Condition ($controllerRejection.status -eq 422 -and $rejectedFields -contains "host_mount" -and $rejectedFields -contains "canary_path") -Message "Controller hostile-control rejection drifted"

    $candidateCount = $candidates.Count
    $factoryReportCount = $factoryReports.Count
    $checks = [ordered]@{
        exact_26_candidate_coverage = $true
        exact_26_factory_report_coverage = $true
        all_worker_evaluator_roles_no_host_binds_socket_or_sensitive_environment = $true
        all_worker_evaluator_roles_network_none_read_only_no_new_privileges = $true
        all_worker_evaluator_roles_cleaned_up = $true
        controller_internal_only_and_rejects_host_control_fields = $true
        provider_credential_compose_isolation = $true
        retained_m2_host_canary_anchor_passed = $true
    }
}
catch {
    $errors.Add($_.Exception.Message)
}

$unsignedReport = [ordered]@{
    schema_version = "v1"
    report_type = "m6_security_gate"
    generated_at = [DateTime]::UtcNow.ToString("o")
    status = if ($errors.Count -eq 0) { "pass" } else { "fail" }
    scope = "M6 immutable 26-task candidate and role-factory security gate; no provider call and no task evaluation"
    candidate_catalog = [ordered]@{
        path = Get-RepositoryRelativePath -RepositoryRoot $repositoryRoot -Path $candidateCatalogAbsolute
        file_sha256 = Get-Sha256 -Path $candidateCatalogAbsolute
        candidate_count = $candidateCount
    }
    factory_catalog = [ordered]@{
        path = Get-RepositoryRelativePath -RepositoryRoot $repositoryRoot -Path $factoryCatalogAbsolute
        file_sha256 = Get-Sha256 -Path $factoryCatalogAbsolute
        factory_report_count = $factoryReportCount
        distinct_worker_image_count = $workerImageIds.Count
        distinct_evaluator_image_count = $evaluatorImageIds.Count
    }
    m2_security_anchor = [ordered]@{
        path = Get-RepositoryRelativePath -RepositoryRoot $repositoryRoot -Path $m2SecurityAnchorAbsolute
        file_sha256 = Get-Sha256 -Path $m2SecurityAnchorAbsolute
        scope = "Prior real Worker/Evaluator execution with a host canary and provider-secret policy; the M6 catalog supplies the separate 26-task role coverage."
    }
    controller_rejection = $controllerRejection
    checks = $checks
    errors = @($errors)
}
$reportBytes = $utf8NoBom.GetBytes(($unsignedReport | ConvertTo-Json -Depth 16 -Compress) + "`n")
$algorithm = [Security.Cryptography.SHA256]::Create()
try {
    $reportSha256 = ([BitConverter]::ToString($algorithm.ComputeHash($reportBytes))).Replace("-", "").ToLowerInvariant()
}
finally {
    $algorithm.Dispose()
}
$report = [ordered]@{}
foreach ($entry in $unsignedReport.GetEnumerator()) {
    $report[$entry.Key] = $entry.Value
}
$report.report_sha256 = $reportSha256
[IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 16) + "`n"), $utf8NoBom)

if ($errors.Count -gt 0) {
    [Console]::Error.WriteLine("M6 security gate failed. Evidence: $reportPath")
    exit 1
}

[Console]::Out.WriteLine("M6 security gate passed. Evidence: $reportPath")
