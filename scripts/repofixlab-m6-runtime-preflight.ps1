[CmdletBinding()]
param(
    [string]$CandidateCatalogPath = "artifacts/m6-candidate-catalog/20260720T001518846Z-26-task-v1/candidate-catalog.json",
    [string]$OperationPrefix = "m6-runtime-preflight-v2",
    [string[]]$InstanceIds = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-StrictJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($Path)) {
        throw "M6 runtime preflight input does not exist: $Path"
    }
    try {
        return [IO.File]::ReadAllText($Path, $utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "M6 runtime preflight input is not valid JSON: $Path"
    }
}

function Get-InstancePrefix {
    param([Parameter(Mandatory = $true)][string]$InstanceId)

    $separator = $InstanceId.IndexOf("__", [StringComparison]::Ordinal)
    if ($InstanceId -notmatch '^[a-z0-9][a-z0-9_.-]{0,199}__[a-z0-9][a-z0-9_.-]{0,199}$' -or $separator -lt 1) {
        throw "M6 runtime preflight instance ID is malformed: $InstanceId"
    }
    $repository = $InstanceId.Substring(0, $separator)
    $task = $InstanceId.Substring($separator + 2)
    if ($task.StartsWith("$repository-", [StringComparison]::Ordinal)) {
        return $task
    }
    return "$repository-$task"
}

function Write-NewJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    if ([IO.File]::Exists($Path)) {
        throw "M6 runtime preflight refuses to overwrite evidence: $Path"
    }
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 16) + "`n"), $utf8NoBom)
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$candidateCatalogAbsolute = Join-Path $repositoryRoot $CandidateCatalogPath
$catalog = Read-StrictJson -Path $candidateCatalogAbsolute
if ([string]$catalog.schema_version -ne "v1" -or [string]$catalog.artifact_type -ne "m6_task_environment_candidate_catalog") {
    throw "M6 runtime preflight candidate catalog contract drifted"
}
$allCandidates = [object[]]@($catalog.candidates | Sort-Object instance_id)
if ($allCandidates.Count -ne 26 -or ($allCandidates | Select-Object -ExpandProperty instance_id | Select-Object -Unique).Count -ne 26) {
    throw "M6 runtime preflight requires exactly 26 unique candidates"
}
$candidates = $allCandidates
if ($InstanceIds.Count -gt 0) {
    if (@($InstanceIds | Select-Object -Unique).Count -ne $InstanceIds.Count) {
        throw "M6 runtime preflight selected instance IDs must be unique"
    }
    $candidateById = @{}
    foreach ($candidate in $allCandidates) {
        $candidateById[[string]$candidate.instance_id] = $candidate
    }
    $selected = @()
    foreach ($instanceId in $InstanceIds | Sort-Object) {
        if ($candidateById.ContainsKey($instanceId)) {
            $selected += $candidateById[$instanceId]
        }
        else {
            throw "M6 runtime preflight selected instance ID is absent from the immutable candidate catalog: $instanceId"
        }
    }
    $candidates = [object[]]$selected
}
if ($OperationPrefix -notmatch '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$') {
    throw "M6 runtime preflight operation prefix is malformed"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$outputRoot = Join-Path $repositoryRoot "artifacts\m6-runtime-preflight\$timestamp-$($candidates.Count)-task-v2"
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$reportPath = Join-Path $outputRoot "runtime-preflight-catalog.json"

$reports = @()
foreach ($candidate in $candidates) {
    $instanceId = [string]$candidate.instance_id
    $candidateId = [string]$candidate.candidate_id
    $candidateSha256 = [string]$candidate.candidate_sha256
    if ($candidateId -notmatch '^task-environment-candidate-v1-' -or $candidateSha256 -notmatch '^[a-f0-9]{64}$') {
        throw "M6 runtime preflight candidate identity is malformed: $instanceId"
    }
    $prefix = Get-InstancePrefix -InstanceId $instanceId
    $request = [ordered]@{
        schema_version = "v1"
        request_type = "runtime_preflight"
        attempt_id = "$OperationPrefix-$($candidateSha256.Substring(0, 16))"
        operation_id = "${OperationPrefix}:$prefix"
        candidate_id = $candidateId
        instance_id = $instanceId
    }
    $responseRaw = ($request | ConvertTo-Json -Compress) | & docker compose exec -T controller python -m repofixlab_controller.m6_runtime_preflight_client
    if ($LASTEXITCODE -ne 0) {
        throw "M6 runtime preflight Controller request failed: $instanceId"
    }
    try {
        $response = ([string]$responseRaw | ConvertFrom-Json)
    }
    catch {
        throw "M6 runtime preflight Controller response is not JSON: $instanceId"
    }
    $manifest = $response.preflight.body.manifest
    if (
        [int]$response.preflight.status -ne 200 -or
        [string]$response.preflight.replay -ne "false" -or
        [string]$response.preflight.body.status -ne "ready" -or
        [string]$manifest.candidate_id -ne $candidateId -or
        [string]$manifest.instance_id -ne $instanceId -or
        [string]$manifest.candidate_sha256 -ne $candidateSha256 -or
        [string]$manifest.task_environment_lock_sha256 -notmatch '^[a-f0-9]{64}$' -or
        [string]$manifest.policy_sha256 -notmatch '^[a-f0-9]{64}$' -or
        [string]$manifest.base_commit -notmatch '^[a-f0-9]{40}$' -or
        [int]$response.prepare.status -ne 200 -or
        [string]$response.prepare.replay -ne "false" -or
        [string]$response.prepare.body.status -ne "prepared" -or
        [string]$response.prepare.body.lease_id -notmatch '^lease-[a-f0-9]{32}$' -or
        [int]$response.abort.status -ne 200 -or
        [string]$response.abort.replay -ne "false" -or
        [string]$response.abort.body.status -ne "aborted" -or
        $response.abort.body.cleanup.clean -ne $true
    ) {
        throw "M6 runtime preflight contract failed: $instanceId"
    }
    $reports += [ordered]@{
        instance_id = $instanceId
        candidate_id = $candidateId
        candidate_sha256 = $candidateSha256
        operation_id = [string]$request.operation_id
        attempt_id = [string]$request.attempt_id
        preflight = $response.preflight.body
        worker_prepare = $response.prepare.body
        worker_abort = $response.abort.body
    }
}

$output = [ordered]@{
    schema_version = "v1"
    artifact_type = "m6_runtime_preflight_catalog"
    generated_at = [DateTime]::UtcNow.ToString("o")
    candidate_catalog_path = $CandidateCatalogPath.Replace("\\", "/")
    candidate_catalog_file_sha256 = Get-Sha256 -Path $candidateCatalogAbsolute
    operation_prefix = $OperationPrefix
    selected_instance_ids = @($candidates | Select-Object -ExpandProperty instance_id)
    task_count = $reports.Count
    runtime_preflights = $reports
}
Write-NewJson -Path $reportPath -Value $output
[Console]::Out.WriteLine("M6 runtime preflight catalog created: $reportPath")
