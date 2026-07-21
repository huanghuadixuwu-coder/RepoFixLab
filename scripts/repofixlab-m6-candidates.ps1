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
		throw "Required M6 candidate input does not exist: $Path"
	}
	try {
		return [IO.File]::ReadAllText($Path, $utf8NoBom) | ConvertFrom-Json
	}
	catch {
		throw "Required M6 candidate input is not valid JSON: $Path"
	}
}

function Write-NewJson {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][object]$Value
	)
	if ([IO.File]::Exists($Path)) {
		throw "M6 candidate artifact path is already occupied: $Path"
	}
	[IO.File]::WriteAllText(
		$Path,
		($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine,
		$utf8NoBom
	)
}

function Get-InstancePrefix {
	param([Parameter(Mandatory = $true)][string]$InstanceId)
	if ($InstanceId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$') {
		throw "Task instance ID is malformed: $InstanceId"
	}
	$separator = $InstanceId.IndexOf("__", [StringComparison]::Ordinal)
	if ($separator -lt 1 -or $separator -eq $InstanceId.Length - 2) {
		throw "Task instance ID is not repository-qualified: $InstanceId"
	}
	$repository = $InstanceId.Substring(0, $separator)
	$task = $InstanceId.Substring($separator + 2)
	if ($task.StartsWith("$repository-", [StringComparison]::Ordinal)) {
		return $task
	}
	return "$repository-$task"
}

function Get-DockerImageInspection {
	param(
		[Parameter(Mandatory = $true)][string]$DockerPath,
		[Parameter(Mandatory = $true)][string]$Reference,
		[Parameter(Mandatory = $true)][string]$Description
	)
	$raw = & $DockerPath image inspect $Reference | Out-String
	if ($LASTEXITCODE -ne 0) {
		throw "$Description cannot be inspected"
	}
	try {
		$value = $raw | ConvertFrom-Json
	}
	catch {
		throw "$Description inspection is not valid JSON"
	}
	$images = @($value)
	if ($images.Count -ne 1 -or $null -eq $images[0]) {
		throw "$Description inspection did not return exactly one image"
	}
	return $images[0]
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactsRoot = Join-Path $repositoryRoot "artifacts"
$docker = (Get-Command docker -ErrorAction Stop).Source
$datasetLockPath = Join-Path $repositoryRoot "artifacts\dataset-prepare\20260718T135934707Z-243342d1916a\dataset-lock.json"
$imageLockPath = Join-Path $repositoryRoot "artifacts\m3-eligible-image-resolution\20260720T193900Z-26-task-v1\official-image-source-lock.json"
$materializedPath = Join-Path $repositoryRoot "artifacts\m6-environment-images\20260719T234730636Z-26-task-v1\materialized-images.json"
$preflightRecordPath = Join-Path $repositoryRoot "artifacts\m6-environment-preflight\20260720T000238Z-26-task-v1\controller-record.json"
$probePath = Join-Path $repositoryRoot "packages\repofixlab\task-images\generic\role-probe.mjs"
$sanitizerPath = Join-Path $repositoryRoot "packages\repofixlab\task-images\generic\sanitize-git-history.sh"
$adapterPath = Join-Path $repositoryRoot "packages\repofixlab\evaluator\repofixlab_evaluator\m3_task_kernel.py"

$datasetLock = Read-StrictJson $datasetLockPath
$imageLock = Read-StrictJson $imageLockPath
$materialized = Read-StrictJson $materializedPath
$preflightRecord = Read-StrictJson $preflightRecordPath

if (
	[string]$datasetLock.lock_id -eq [string]$imageLock.lock_id -or
	@($materialized.tasks).Count -ne 26 -or
	@($preflightRecord.task_reports).Count -ne 26 -or
	[string]$preflightRecord.status -ne "completed" -or
	@($preflightRecord.task_reports | Where-Object { -not $_.passed }).Count -ne 0
) {
	throw "M6 Candidate inputs do not bind the sealed 26-task environment preflight"
}

$preflightById = @{}
foreach ($report in @($preflightRecord.task_reports)) {
	$preflightById[[string]$report.instance_id] = $report
}
$orderedTasks = [object[]]@($materialized.tasks)
[Array]::Sort(
	$orderedTasks,
	[System.Comparison[object]] {
		param($left, $right)
		return [string]::CompareOrdinal([string]$left.instance_id, [string]$right.instance_id)
	}
)
if (($orderedTasks | Select-Object -ExpandProperty instance_id | Select-Object -Unique).Count -ne 26) {
	throw "M6 materialized task identities are not unique"
}

$probeSha256 = Get-Sha256 $probePath
$sanitizerSha256 = Get-Sha256 $sanitizerPath
$adapterSha256 = Get-Sha256 $adapterPath
if ((@($probeSha256, $sanitizerSha256, $adapterSha256) | Select-Object -Unique).Count -ne 3) {
	throw "M6 candidate probe, sanitizer, and adapter hashes must be distinct"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$operationRoot = Join-Path $artifactsRoot "m6-candidate-catalog\$timestamp-26-task-v1"
$buildInputRoot = Join-Path $operationRoot "build-inputs"
$candidateRoot = Join-Path $operationRoot "candidates"
[IO.Directory]::CreateDirectory($buildInputRoot) | Out-Null
[IO.Directory]::CreateDirectory($candidateRoot) | Out-Null

$catalog = @()
foreach ($task in $orderedTasks) {
	$instanceId = [string]$task.instance_id
	$preflight = $preflightById[$instanceId]
	if ($null -eq $preflight -or [string]$preflight.passed -ne "True") {
		throw "M6 candidate task lacks a passing official preflight: $instanceId"
	}
	foreach ($roleName in @("worker", "evaluator")) {
		$role = $task.$roleName
		$image = Get-DockerImageInspection $docker ([string]$role.image_reference) "M6 $roleName image $instanceId"
		if (
			[string]$image.Id -ne [string]$role.local_image_id -or
			[string]$image.Os -ne "linux" -or
			[string]$image.Architecture -ne "amd64" -or
			[string]$image.Config.Labels.'io.repofixlab.provenance-sha256' -ne [string]$role.provenance_sha256
		) {
			throw "M6 $roleName image binding drifted before candidate creation: $instanceId"
		}
	}
	$prefix = Get-InstancePrefix $instanceId
	$buildInput = [ordered]@{
		instance_id = $instanceId
		base_commit = [string]$task.base_commit
		dataset_lock = [ordered]@{
			lock_id = [string]$datasetLock.lock_id
			lock_sha256 = Get-Sha256 $datasetLockPath
		}
		official_image_source_lock = [ordered]@{
			lock_id = [string]$imageLock.lock_id
			lock_sha256 = Get-Sha256 $imageLockPath
		}
		roles = [ordered]@{
			worker = [ordered]@{
				image = [ordered]@{
					local_image_id = [string]$task.worker.local_image_id
					provenance_sha256 = [string]$task.worker.provenance_sha256
				}
				runtime_user = [ordered]@{ uid = 65532; gid = 65532 }
				resource_profile = [ordered]@{
					nano_cpus = 4000000000
					memory_bytes = 8589934592
					memory_swap_bytes = 8589934592
					pids_limit = 512
					timeout_seconds = 1800
				}
				filesystem_profile = [ordered]@{
					writable_mounts = @(
						[ordered]@{ type = "volume"; destination = "/testbed"; read_write = $true },
						[ordered]@{ type = "tmpfs"; destination = "/tmp"; read_write = $true }
					)
				}
			}
			evaluator = [ordered]@{
				image = [ordered]@{
					local_image_id = [string]$task.evaluator.local_image_id
					provenance_sha256 = [string]$task.evaluator.provenance_sha256
				}
				runtime_user = [ordered]@{ uid = 0; gid = 0 }
				resource_profile = [ordered]@{
					nano_cpus = 4000000000
					memory_bytes = 8589934592
					memory_swap_bytes = 8589934592
					pids_limit = 512
					timeout_seconds = 300
				}
				filesystem_profile = [ordered]@{
					writable_mounts = @(
						[ordered]@{ type = "volume"; destination = "/testbed"; read_write = $true },
						[ordered]@{ type = "tmpfs"; destination = "/tmp"; read_write = $true }
					)
				}
			}
		}
		probe_sha256 = $probeSha256
		sanitizer_sha256 = $sanitizerSha256
		adapter_sha256 = $adapterSha256
		created_at = [DateTime]::UtcNow.ToString("o")
	}
	$buildInputRelative = "m6-candidate-catalog/$timestamp-26-task-v1/build-inputs/$prefix.json"
	$candidateRelative = "m6-candidate-catalog/$timestamp-26-task-v1/candidates/m6-$prefix.candidate.json"
	$buildInputPath = Join-Path $buildInputRoot "$prefix.json"
	$candidatePath = Join-Path $candidateRoot "m6-$prefix.candidate.json"
	Write-NewJson $buildInputPath $buildInput
	$candidateOutput = & $docker run --rm --network none -v "${artifactsRoot}:/artifacts" -e "REPOFIX_ARTIFACTS_PATH=/artifacts" --entrypoint node repofixlab-orchestrator:latest packages/repofixlab/dist/cli/main.js candidate-create --input $buildInputRelative --output $candidateRelative 2>&1
	if ($LASTEXITCODE -ne 0) {
		throw "M6 Candidate creation failed for ${instanceId}: $candidateOutput"
	}
	$candidate = Read-StrictJson $candidatePath
	if (
		[string]$candidate.instance_id -ne $instanceId -or
		[string]$candidate.base_commit -ne [string]$task.base_commit -or
		[string]$candidate.roles.worker.image.local_image_id -ne [string]$task.worker.local_image_id -or
		[string]$candidate.roles.evaluator.image.local_image_id -ne [string]$task.evaluator.local_image_id
	) {
		throw "M6 Candidate output drifted from its sealed image bindings: $instanceId"
	}
	$catalog += [ordered]@{
		instance_id = $instanceId
		candidate_id = [string]$candidate.candidate_id
		candidate_sha256 = [string]$candidate.candidate_sha256
		candidate_path = "candidates/m6-$prefix.candidate.json"
		candidate_file_sha256 = Get-Sha256 $candidatePath
	}
}

Write-NewJson (Join-Path $operationRoot "candidate-catalog.json") ([ordered]@{
	schema_version = "v1"
	artifact_type = "m6_task_environment_candidate_catalog"
	dataset_lock_id = [string]$datasetLock.lock_id
	dataset_lock_file_sha256 = Get-Sha256 $datasetLockPath
	official_image_source_lock_id = [string]$imageLock.lock_id
	official_image_source_lock_file_sha256 = Get-Sha256 $imageLockPath
	materialized_images_file_sha256 = Get-Sha256 $materializedPath
	official_environment_preflight_file_sha256 = Get-Sha256 $preflightRecordPath
	probe_sha256 = $probeSha256
	sanitizer_sha256 = $sanitizerSha256
	adapter_sha256 = $adapterSha256
	candidates = $catalog
})

[Console]::Out.WriteLine("M6 Candidate catalog created: $operationRoot\candidate-catalog.json")
