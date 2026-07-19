[CmdletBinding()]
param(
    [string]$CandidatePath = "task-environment-candidates/active-v2/axios-5892.candidate.json",
    [string]$OperationId = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-M2SecurityCheck {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-PathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd("\")
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must remain beneath $resolvedRoot"
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$artifactsRoot = Join-Path $repositoryRoot "artifacts"
$candidateAbsolutePath = Join-Path $artifactsRoot $CandidatePath
Assert-PathWithin -Root $artifactsRoot -Path $candidateAbsolutePath -Label "Candidate path"
Assert-M2SecurityCheck -Condition ([IO.File]::Exists($candidateAbsolutePath)) -Message "Candidate file does not exist: $candidateAbsolutePath"

if ([string]::IsNullOrWhiteSpace($OperationId)) {
    $OperationId = "m2-security-$([Guid]::NewGuid().ToString('N'))"
}
Assert-M2SecurityCheck -Condition ($OperationId -cmatch '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$') -Message "Operation ID is outside the Controller contract"

$relativeEvidenceRoot = "m2-security-probes/$OperationId"
$evidenceRoot = Join-Path $artifactsRoot (Join-Path "m2-security-probes" $OperationId)
Assert-PathWithin -Root $artifactsRoot -Path $evidenceRoot -Label "Evidence path"
Assert-M2SecurityCheck -Condition (-not [IO.Directory]::Exists($evidenceRoot)) -Message "Refusing to overwrite existing M2 security evidence: $evidenceRoot"
[IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null

$canaryPath = Join-Path $evidenceRoot "host-canary.bin"
$factoryReportRelativePath = "$relativeEvidenceRoot/factory-probe.json"
$factoryReportPath = Join-Path $evidenceRoot "factory-probe.json"
$rejectionPath = Join-Path $evidenceRoot "controller-rejection.json"
$reportPath = Join-Path $evidenceRoot "security-probe-report.json"
$transcriptPath = Join-Path $evidenceRoot "factory-probe.stdout.log"
$checks = [ordered]@{}
$errors = [System.Collections.Generic.List[string]]::new()
$canaryBeforeSha256 = $null
$canaryAfterSha256 = $null
$factoryReportSha256 = $null
$controllerRejection = $null

try {
    $canaryBytes = New-Object byte[] 64
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($canaryBytes)
    }
    finally {
        $random.Dispose()
    }
    [IO.File]::WriteAllBytes($canaryPath, $canaryBytes)
    $canaryBeforeSha256 = Get-Sha256 -Path $canaryPath

    & docker compose up -d --no-build controller | Out-Null
    Assert-M2SecurityCheck -Condition ($LASTEXITCODE -eq 0) -Message "Controller startup failed"

    $composeConfig = ((& docker compose --profile m1 --profile dataset-prepare config --format json) | Out-String | ConvertFrom-Json)
    foreach ($serviceName in @("controller", "orchestrator", "dataset-preparer")) {
        $service = $composeConfig.services.PSObject.Properties[$serviceName].Value
        Assert-M2SecurityCheck -Condition ($null -eq $service.PSObject.Properties["secrets"]) -Message "$serviceName receives a provider secret"
        Assert-M2SecurityCheck -Condition ($null -eq $service.environment.PSObject.Properties["ZHIPU_API_KEY"]) -Message "$serviceName receives a provider credential environment value"
        Assert-M2SecurityCheck -Condition ($null -eq $service.environment.PSObject.Properties["ZHIPU_API_KEY_FILE"]) -Message "$serviceName receives a provider credential file path"
    }
    $m1Runner = $composeConfig.services.PSObject.Properties["m1-runner"].Value
    Assert-M2SecurityCheck -Condition (@($m1Runner.secrets).Count -eq 1) -Message "M1 runner must receive exactly one file-backed provider secret"
    Assert-M2SecurityCheck -Condition ($null -eq $m1Runner.environment.PSObject.Properties["ZHIPU_API_KEY"]) -Message "M1 runner receives a provider credential environment value"
    Assert-M2SecurityCheck -Condition ($m1Runner.environment.ZHIPU_API_KEY_FILE -ceq "/run/secrets/zhipu_api_key") -Message "M1 runner does not use the fixed provider secret file path"

    $previousErrorActionPreference = $ErrorActionPreference
    $factoryExitCode = $null
    try {
        $ErrorActionPreference = "Continue"
        & docker compose run --rm --no-deps orchestrator factory-probe --candidate $CandidatePath --operation-id $OperationId --output $factoryReportRelativePath *> $transcriptPath
        $factoryExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Assert-M2SecurityCheck -Condition ($factoryExitCode -eq 0) -Message "Real task-role factory probe failed"
    Assert-M2SecurityCheck -Condition ([IO.File]::Exists($factoryReportPath)) -Message "Factory probe did not publish its report"
    Assert-M2SecurityCheck -Condition (-not ((Get-Content -LiteralPath $transcriptPath -Raw -Encoding utf8).Contains("ZHIPU_API_KEY="))) -Message "Factory probe transcript contains a provider credential assignment"

    $factoryReport = Get-Content -LiteralPath $factoryReportPath -Raw -Encoding utf8 | ConvertFrom-Json
    $factoryReportSha256 = Get-Sha256 -Path $factoryReportPath
    Assert-M2SecurityCheck -Condition ($factoryReport.status -ceq "pass") -Message "Factory probe did not pass"
    Assert-M2SecurityCheck -Condition (($factoryReport.execution_order -join ",") -ceq "worker,evaluator") -Message "Factory execution order drifted"
    Assert-M2SecurityCheck -Condition (@($factoryReport.errors).Count -eq 0) -Message "Factory report contains errors"
    Assert-M2SecurityCheck -Condition ($factoryReport.controller_execution.compose_service -ceq "controller") -Message "Factory report did not identify the trusted Controller"
    Assert-M2SecurityCheck -Condition ($factoryReport.controller_execution.read_only_root_filesystem -eq $true) -Message "Controller root filesystem is writable"
    Assert-M2SecurityCheck -Condition ((@($factoryReport.controller_execution.cap_drop) -join ",") -ceq "ALL") -Message "Controller capability policy drifted"
    Assert-M2SecurityCheck -Condition ((@($factoryReport.controller_execution.security_opt) -join ",") -ceq "no-new-privileges:true") -Message "Controller no-new-privileges policy drifted"

    foreach ($role in @($factoryReport.roles.worker, $factoryReport.roles.evaluator)) {
        Assert-M2SecurityCheck -Condition ($role.status -ceq "pass") -Message "$($role.role) factory probe did not pass"
        Assert-M2SecurityCheck -Condition ($role.inspect.network_mode -ceq "none") -Message "$($role.role) network isolation drifted"
        Assert-M2SecurityCheck -Condition ($role.inspect.read_only_root_filesystem -eq $true) -Message "$($role.role) root filesystem is writable"
        Assert-M2SecurityCheck -Condition ((@($role.inspect.cap_drop) -join ",") -ceq "ALL") -Message "$($role.role) capability policy drifted"
        Assert-M2SecurityCheck -Condition (@($role.inspect.cap_add).Count -eq 0) -Message "$($role.role) added capabilities"
        Assert-M2SecurityCheck -Condition ((@($role.inspect.security_opt) -join ",") -ceq "no-new-privileges:true") -Message "$($role.role) no-new-privileges policy drifted"
        Assert-M2SecurityCheck -Condition ($role.inspect.privileged -eq $false) -Message "$($role.role) is privileged"
        Assert-M2SecurityCheck -Condition (@($role.inspect.published_ports).Count -eq 0) -Message "$($role.role) exposes a host port"
        Assert-M2SecurityCheck -Condition (@($role.inspect.mounts | Where-Object { $_.type -ceq "bind" }).Count -eq 0) -Message "$($role.role) has a host bind mount"
        Assert-M2SecurityCheck -Condition (@($role.inspect.docker_socket_paths_present).Count -eq 0) -Message "$($role.role) can see a Docker socket"
        Assert-M2SecurityCheck -Condition (@($role.inspect.sensitive_environment_names_present).Count -eq 0) -Message "$($role.role) has sensitive environment names"
        Assert-M2SecurityCheck -Condition ($role.active_probe.status -ceq "pass") -Message "$($role.role) active probe did not pass"
        Assert-M2SecurityCheck -Condition (@($role.active_probe.docker_socket_paths_present).Count -eq 0) -Message "$($role.role) active probe found a Docker socket"
        Assert-M2SecurityCheck -Condition (@($role.active_probe.sensitive_environment_names_present).Count -eq 0) -Message "$($role.role) active probe found sensitive environment names"
        Assert-M2SecurityCheck -Condition ($role.active_probe.writable_path_roundtrip -eq $true) -Message "$($role.role) has no allowed writable workspace"
        Assert-M2SecurityCheck -Condition ($role.cleanup.container_removed -eq $true) -Message "$($role.role) cleanup did not remove its container"
        Assert-M2SecurityCheck -Condition (@($role.cleanup.residual_container_ids).Count -eq 0) -Message "$($role.role) cleanup left containers"
        Assert-M2SecurityCheck -Condition (@($role.cleanup.residual_volume_names).Count -eq 0) -Message "$($role.role) cleanup left volumes"
        Assert-M2SecurityCheck -Condition (@($role.cleanup.errors).Count -eq 0) -Message "$($role.role) cleanup reported errors"
    }

    $rejectionProbe = @'
import json
import sys
import urllib.error
import urllib.request

payload = json.dumps(
    {
        "operation_id": "m2-reject-host-controls",
        "candidate_id": "forbidden",
        "instance_id": "axios__axios-5892",
        "canary_path": "/artifacts/m2-security-probes/forbidden",
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
    Assert-M2SecurityCheck -Condition ($LASTEXITCODE -eq 0) -Message "Controller accepted or could not reject arbitrary host controls"
    $controllerRejection = ($rejectionOutput -join "`n") | ConvertFrom-Json
    [IO.File]::WriteAllText($rejectionPath, (($controllerRejection | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    Assert-M2SecurityCheck -Condition ($controllerRejection.status -eq 422) -Message "Controller did not return 422 for arbitrary host controls"
    $rejectedFields = @($controllerRejection.body.detail | ForEach-Object { $_.loc[1] })
    Assert-M2SecurityCheck -Condition ($rejectedFields -contains "host_mount") -Message "Controller did not reject host_mount"
    Assert-M2SecurityCheck -Condition ($rejectedFields -contains "canary_path") -Message "Controller did not reject canary_path"

    $canaryAfterSha256 = Get-Sha256 -Path $canaryPath
    Assert-M2SecurityCheck -Condition ($canaryBeforeSha256 -ceq $canaryAfterSha256) -Message "Host canary changed during Worker/Evaluator factory execution"

    $checks = [ordered]@{
        canary_unchanged = $true
        controller_rejects_arbitrary_host_controls = $true
        factory_probe_passed = $true
        worker_evaluator_no_host_binds = $true
        worker_evaluator_no_socket_or_sensitive_environment = $true
        worker_evaluator_cleanup_clean = $true
        provider_credential_bound_to_m1_runner_file_only = $true
        factory_probe_transcript_has_no_provider_credential_assignment = $true
    }
}
catch {
    $errors.Add($_.Exception.Message)
    if ([IO.File]::Exists($canaryPath)) {
        $canaryAfterSha256 = Get-Sha256 -Path $canaryPath
    }
}

$unsignedReport = [ordered]@{
    schema_version = "v1"
    report_type = "m2_security_probe"
    operation_id = $OperationId
    status = if ($errors.Count -eq 0) { "pass" } else { "fail" }
    generated_at = [DateTime]::UtcNow.ToString("o")
    candidate_path = $CandidatePath
    factory_probe = [ordered]@{
        path = $factoryReportRelativePath
        file_sha256 = $factoryReportSha256
    }
    host_canary = [ordered]@{
        path = "$relativeEvidenceRoot/host-canary.bin"
        before_sha256 = $canaryBeforeSha256
        after_sha256 = $canaryAfterSha256
        unchanged = ($null -ne $canaryBeforeSha256 -and $canaryBeforeSha256 -ceq $canaryAfterSha256)
    }
    controller_rejection = $controllerRejection
    checks = $checks
    errors = @($errors)
}
$reportBytes = [Text.UTF8Encoding]::new($false).GetBytes(($unsignedReport | ConvertTo-Json -Depth 12 -Compress) + "`n")
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try {
    $reportSha256 = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($reportBytes))).Replace("-", "").ToLowerInvariant()
}
finally {
    $hashAlgorithm.Dispose()
}
$report = [ordered]@{}
foreach ($entry in $unsignedReport.GetEnumerator()) {
    $report[$entry.Key] = $entry.Value
}
$report.report_sha256 = $reportSha256
[IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))

if ($errors.Count -gt 0) {
    [Console]::Error.WriteLine("M2 security probe failed. Evidence: $reportPath")
    exit 1
}

[Console]::Out.WriteLine("M2 security probe passed. Evidence: $reportPath")
