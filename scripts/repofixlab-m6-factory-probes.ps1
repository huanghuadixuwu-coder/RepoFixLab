[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Get-Sha256 {
	param([Parameter(Mandatory = $true)][string]$Path)
	return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-StrictJson {
	param([Parameter(Mandatory = $true)][string]$Path)
	if (-not [IO.File]::Exists($Path)) {
		throw "Required M6 factory input does not exist: $Path"
	}
	try {
		return [IO.File]::ReadAllText($Path, $utf8NoBom) | ConvertFrom-Json
	}
	catch {
		throw "Required M6 factory input is not valid JSON: $Path"
	}
}

function Write-NewJson {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][object]$Value
	)
	if ([IO.File]::Exists($Path)) {
		throw "M6 factory artifact path is already occupied: $Path"
	}
	[IO.File]::WriteAllText(
		$Path,
		($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine,
		$utf8NoBom
	)
}

function Get-InstancePrefix {
	param([Parameter(Mandatory = $true)][string]$InstanceId)
	$separator = $InstanceId.IndexOf("__", [StringComparison]::Ordinal)
	if ($InstanceId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$' -or $separator -lt 1 -or $separator -eq $InstanceId.Length - 2) {
		throw "Factory Candidate instance ID is malformed: $InstanceId"
	}
	$repository = $InstanceId.Substring(0, $separator)
	$task = $InstanceId.Substring($separator + 2)
	if ($task.StartsWith("$repository-", [StringComparison]::Ordinal)) {
		return $task
	}
	return "$repository-$task"
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$catalogPath = Join-Path $repositoryRoot "artifacts\m6-candidate-catalog\20260720T001518846Z-26-task-v1\candidate-catalog.json"
$catalog = Read-StrictJson $catalogPath
$candidates = [object[]]@($catalog.candidates)
if ($candidates.Count -ne 26) {
	throw "M6 factory requires exactly 26 sealed Candidates"
}
[Array]::Sort(
	$candidates,
	[System.Comparison[object]] {
		param($left, $right)
		return [string]::CompareOrdinal([string]$left.instance_id, [string]$right.instance_id)
	}
)
if (($candidates | Select-Object -ExpandProperty candidate_id | Select-Object -Unique).Count -ne 26) {
	throw "M6 factory Candidate IDs are not unique"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$operationRoot = Join-Path $repositoryRoot "artifacts\m6-factory-probes\$timestamp-26-task-v1"
$reportsRoot = Join-Path $operationRoot "reports"
[IO.Directory]::CreateDirectory($reportsRoot) | Out-Null
$docker = (Get-Command docker -ErrorAction Stop).Source
$clientCode = "import sys,urllib.request; payload=sys.stdin.buffer.read(); request=urllib.request.Request('http://127.0.0.1:8000/v1/factory/task-role-probes',data=payload,headers={'Content-Type':'application/json'},method='POST'); sys.stdout.buffer.write(urllib.request.urlopen(request,timeout=1800).read())"

$results = @()
foreach ($candidate in $candidates) {
	$instanceId = [string]$candidate.instance_id
	$prefix = Get-InstancePrefix $instanceId
	$candidateId = [string]$candidate.candidate_id
	$candidateSha256 = [string]$candidate.candidate_sha256
	if ($candidateId -notmatch '^task-environment-candidate-v1-.+' -or $candidateSha256 -notmatch '^[a-f0-9]{64}$') {
		throw "M6 factory Candidate identity is malformed: ${instanceId}"
	}
	$operationId = "m6:factory:${prefix}:$($candidateSha256.Substring(0, 16))"
	$payload = [ordered]@{
		operation_id = $operationId
		candidate_id = $candidateId
		instance_id = $instanceId
	} | ConvertTo-Json -Compress
	$response = $payload | & $docker compose -f compose.yaml exec -T controller python -c $clientCode 2>&1
	if ($LASTEXITCODE -ne 0) {
		throw "M6 factory Controller request failed for ${instanceId}: $response"
	}
	try {
		$report = ([string]$response | ConvertFrom-Json)
	}
	catch {
		throw "M6 factory Controller response is not valid JSON for $instanceId"
	}
	if (
		[string]$report.status -ne "pass" -or
		[string]$report.candidate_id -ne $candidateId -or
		[string]$report.candidate_sha256 -ne $candidateSha256 -or
		[string]$report.instance_id -ne $instanceId -or
		[string]$report.roles.worker.status -ne "pass" -or
		[string]$report.roles.evaluator.status -ne "pass" -or
		[string]$report.report_sha256 -notmatch '^[a-f0-9]{64}$'
	) {
		throw "M6 factory hard gates failed for $instanceId"
	}
	$reportPath = Join-Path $reportsRoot "$prefix.factory-report.json"
	Write-NewJson $reportPath $report
	$results += [ordered]@{
		instance_id = $instanceId
		candidate_id = $candidateId
		candidate_sha256 = $candidateSha256
		operation_id = $operationId
		report_path = "reports/$prefix.factory-report.json"
		report_file_sha256 = Get-Sha256 $reportPath
		report_sha256 = [string]$report.report_sha256
	}
}

Write-NewJson (Join-Path $operationRoot "factory-probe-catalog.json") ([ordered]@{
	schema_version = "v1"
	artifact_type = "m6_task_role_factory_probe_catalog"
	candidate_catalog_file_sha256 = Get-Sha256 $catalogPath
	candidate_count = 26
	factory_reports = $results
})

[Console]::Out.WriteLine("M6 Factory probe catalog created: $operationRoot\factory-probe-catalog.json")
