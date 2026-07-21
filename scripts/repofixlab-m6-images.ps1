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
		throw "Required M6 input does not exist: $Path"
	}
	try {
		return [IO.File]::ReadAllText($Path, $utf8NoBom) | ConvertFrom-Json
	}
	catch {
		throw "Required M6 input is not valid JSON: $Path"
	}
}

function Write-NewJson {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][object]$Value
	)
	if ([IO.File]::Exists($Path)) {
		throw "M6 artifact path is already occupied: $Path"
	}
	[IO.File]::WriteAllText(
		$Path,
		($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine,
		$utf8NoBom
	)
}

function Invoke-CheckedDocker {
	param(
		[Parameter(Mandatory = $true)][string]$DockerPath,
		[Parameter(Mandatory = $true)][string[]]$Arguments,
		[Parameter(Mandatory = $true)][string]$Description
	)
	& $DockerPath @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "$Description failed with Docker exit code $LASTEXITCODE"
	}
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

function Assert-RoleImage {
	param(
		[Parameter(Mandatory = $true)][object]$Image,
		[Parameter(Mandatory = $true)][string]$ExpectedImageId,
		[Parameter(Mandatory = $true)][string]$InstanceId,
		[Parameter(Mandatory = $true)][string]$BaseCommit,
		[Parameter(Mandatory = $true)][string]$SourceDigest,
		[Parameter(Mandatory = $true)][string]$SanitizerSha256,
		[Parameter(Mandatory = $true)][string]$ProbeSha256,
		[Parameter(Mandatory = $true)][string]$ProvenanceSha256,
		[Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExpectedParentEvaluatorImageId,
		[Parameter(Mandatory = $true)][string]$Role
	)
	if (
		[string]$Image.Id -ne $ExpectedImageId -or
		[string]$Image.Os -ne "linux" -or
		[string]$Image.Architecture -ne "amd64"
	) {
		throw "M6 $Role image identity or platform drifted for $InstanceId"
	}
	$labels = $Image.Config.Labels
	$expected = [ordered]@{
		"io.repofixlab.instance-id" = $InstanceId
		"io.repofixlab.base-commit" = $BaseCommit
		"io.repofixlab.source-repository-digest" = $SourceDigest
		"io.repofixlab.sanitizer-sha256" = $SanitizerSha256
		"io.repofixlab.role-probe-sha256" = $ProbeSha256
		"io.repofixlab.provenance-sha256" = $ProvenanceSha256
	}
	if ($Role -eq "worker") {
		if ($ExpectedParentEvaluatorImageId -notmatch '^sha256:[a-f0-9]{64}$') {
			throw "M6 worker parent evaluator image ID is malformed for $InstanceId"
		}
		$expected["io.repofixlab.role"] = "worker"
		$expected["io.repofixlab.worker-history-profile"] = "exact-base-shallow-single-commit-v1"
		$expected["io.repofixlab.parent-evaluator-image-id"] = $ExpectedParentEvaluatorImageId
	}
	elseif ($ExpectedParentEvaluatorImageId -ne "") {
		throw "M6 evaluator image unexpectedly has a parent evaluator binding for $InstanceId"
	}
	foreach ($entry in $expected.GetEnumerator()) {
		if ($null -eq $labels -or [string]$labels.($entry.Key) -ne [string]$entry.Value) {
			throw "M6 $Role image label drifted for ${InstanceId}: $($entry.Key)"
		}
	}
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$docker = (Get-Command docker -ErrorAction Stop).Source
$datasetLockPath = Join-Path $repositoryRoot "artifacts\dataset-prepare\20260718T135934707Z-243342d1916a\dataset-lock.json"
$eligibilityPath = Join-Path $repositoryRoot "artifacts\m3-eligibility\20260720T193400Z-26-task-v1\eligibility-manifest.json"
$candidateImageLockPath = Join-Path $repositoryRoot "artifacts\m3-image-resolution\20260719T163100Z-192f9af8d5c1\official-image-source-lock.json"
$imageLockPath = Join-Path $repositoryRoot "artifacts\m3-eligible-image-resolution\20260720T193900Z-26-task-v1\official-image-source-lock.json"
$preflightRequestPath = Join-Path $repositoryRoot "artifacts\m3-preflight\20260720T000000Z-r3\request.json"
$preflightRecordPath = Join-Path $repositoryRoot "artifacts\m3-preflight-summary\20260720T000000Z-r3\controller-record.json"
$genericRoot = Join-Path $repositoryRoot "packages\repofixlab\task-images\generic"

$datasetLock = Read-StrictJson $datasetLockPath
$eligibility = Read-StrictJson $eligibilityPath
$candidateSourceLock = Read-StrictJson $candidateImageLockPath
$sourceLock = Read-StrictJson $imageLockPath
$preflightRequest = Read-StrictJson $preflightRequestPath
$preflightRecord = Read-StrictJson $preflightRecordPath

if (
	[string]$eligibility.eligible_task_count -ne "26" -or
	@($eligibility.eligible_instance_ids).Count -ne 26 -or
	[string]$eligibility.official_image_source_lock_id -ne [string]$candidateSourceLock.lock_id -or
	[string]$eligibility.official_image_source_lock_seal_sha256 -ne [string]$candidateSourceLock.seal_sha256 -or
	[string]$preflightRecord.operation_id -ne [string]$preflightRequest.operation_id -or
	[string]$preflightRequest.dataset_revision -ne [string]$sourceLock.dataset_revision
) {
	throw "M6 input locks and the exported M3 preflight record do not form the sealed evidence chain"
}

$selectedIds = @($eligibility.eligible_instance_ids | ForEach-Object { [string]$_ } | Sort-Object)
if (($selectedIds | Select-Object -Unique).Count -ne 26) {
	throw "M6 eligibility IDs are not a unique 26-task set"
}

$sourceImages = @{}
foreach ($image in @($sourceLock.images)) {
	$sourceImages[[string]$image.image_key] = $image
}
$candidateSourceImages = @{}
foreach ($image in @($candidateSourceLock.images)) {
	$candidateSourceImages[[string]$image.image_key] = $image
}
$requestTasks = @{}
foreach ($task in @($preflightRequest.tasks)) {
	$requestTasks[[string]$task.instance_id] = $task
}
$recordTasks = @{}
foreach ($task in @($preflightRecord.task_reports)) {
	$recordTasks[[string]$task.instance_id] = $task
}

$requiredFiles = @(
	"sanitize-git-history.sh",
	"audit-worker-image.sh",
	"role-probe.mjs",
	"sanitized.Dockerfile",
	"worker-sanitized.Dockerfile"
)
foreach ($file in $requiredFiles) {
	if (-not [IO.File]::Exists((Join-Path $genericRoot $file))) {
		throw "M6 generic image input is missing: $file"
	}
}
$sanitizerSha256 = Get-Sha256 (Join-Path $genericRoot "sanitize-git-history.sh")
$workerAuditSha256 = Get-Sha256 (Join-Path $genericRoot "audit-worker-image.sh")
$probeSha256 = Get-Sha256 (Join-Path $genericRoot "role-probe.mjs")
$evaluatorDockerfileSha256 = Get-Sha256 (Join-Path $genericRoot "sanitized.Dockerfile")
$workerDockerfileSha256 = Get-Sha256 (Join-Path $genericRoot "worker-sanitized.Dockerfile")

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$operationRoot = Join-Path $repositoryRoot "artifacts\m6-environment-images\$timestamp-26-task-v1"
[IO.Directory]::CreateDirectory((Join-Path $operationRoot "build-inputs")) | Out-Null

$materialized = @()
$preflightTasks = @()
foreach ($instanceId in $selectedIds) {
	$source = $sourceImages[$instanceId]
	$candidateSource = $candidateSourceImages[$instanceId]
	$task = $requestTasks[$instanceId]
	$record = $recordTasks[$instanceId]
	if ($null -eq $source -or $null -eq $candidateSource -or $null -eq $task -or $null -eq $record) {
		throw "M6 selected task is absent from a sealed M3 input: $instanceId"
	}
	if (
		[string]$record.passed -ne "True" -or
		[string]$task.source_image_id -ne [string]$source.local_image_id -or
		[string]$source.local_image_id -ne [string]$candidateSource.local_image_id -or
		[string]$source.repository_digest -ne [string]$candidateSource.repository_digest -or
		[string]$source.requested_reference -ne [string]$candidateSource.requested_reference
	) {
		throw "M6 selected task lacks a passing M3 source-image preflight: $instanceId"
	}
	$prefix = Get-InstancePrefix $instanceId
	$sourceDigest = [string]$source.repository_digest
	$baseCommit = [string]$task.base_commit
	$sourceInspection = Get-DockerImageInspection $docker $sourceDigest "M6 source image $instanceId"
	if (
		[string]$sourceInspection.Id -ne [string]$source.local_image_id -or
		[string]$sourceInspection.Os -ne "linux" -or
		[string]$sourceInspection.Architecture -ne "amd64"
	) {
		throw "M6 source image local identity drifted: $instanceId"
	}

	$roles = @(
		[ordered]@{ role = "evaluator"; dockerfile = "sanitized.Dockerfile"; dockerfile_sha256 = $evaluatorDockerfileSha256; tag = "repofixlab-m6-$prefix-evaluator:v1" },
		[ordered]@{ role = "worker"; dockerfile = "worker-sanitized.Dockerfile"; dockerfile_sha256 = $workerDockerfileSha256; tag = "repofixlab-m6-$prefix-worker:v1" }
	)
	$builtRoles = @{}
	foreach ($role in $roles) {
		$parentEvaluatorImageReference = $null
		$parentEvaluatorImageId = ""
		$buildSourceImage = $sourceDigest
		if ($role.role -eq "worker") {
			$parentEvaluator = $builtRoles["evaluator"]
			if ($null -eq $parentEvaluator) {
				throw "M6 worker image cannot be built before its evaluator image: $instanceId"
			}
			$parentEvaluatorImageReference = [string]$parentEvaluator.image_reference
			$parentEvaluatorImageId = [string]$parentEvaluator.local_image_id
			if ($parentEvaluatorImageId -notmatch '^sha256:[a-f0-9]{64}$') {
				throw "M6 evaluator image ID is malformed for $instanceId"
			}
			$buildSourceImage = $parentEvaluatorImageReference
		}
		$buildInput = [ordered]@{
			schema_version = "v1"
			artifact_type = "m6_task_role_image_build_input"
			role = $role.role
			instance_id = $instanceId
			base_commit = $baseCommit
			source_repository_digest = $sourceDigest
			source_image_id = [string]$source.local_image_id
			parent_evaluator_image_reference = $parentEvaluatorImageReference
			parent_evaluator_image_id = if ($parentEvaluatorImageId -eq "") { $null } else { $parentEvaluatorImageId }
			candidate_official_image_source_lock_id = [string]$candidateSourceLock.lock_id
			candidate_official_image_source_lock_seal_sha256 = [string]$candidateSourceLock.seal_sha256
			official_image_source_lock_id = [string]$sourceLock.lock_id
			official_image_source_lock_seal_sha256 = [string]$sourceLock.seal_sha256
			dataset_lock_id = [string]$datasetLock.lock_id
			dataset_lock_file_sha256 = Get-Sha256 $datasetLockPath
			dockerfile = "task-images/generic/$($role.dockerfile)"
			dockerfile_sha256 = [string]$role.dockerfile_sha256
			sanitizer_sha256 = $sanitizerSha256
			role_probe_sha256 = $probeSha256
			worker_audit_sha256 = if ($role.role -eq "worker") { $workerAuditSha256 } else { $null }
		}
		$buildInputPath = Join-Path $operationRoot "build-inputs\$prefix.$($role.role).json"
		Write-NewJson $buildInputPath $buildInput
		$provenanceSha256 = Get-Sha256 $buildInputPath
		$arguments = @(
			"build", "--network=none", "--platform", "linux/amd64",
			"--file", "packages/repofixlab/task-images/generic/$($role.dockerfile)",
			"--tag", [string]$role.tag,
			"--build-arg", "SOURCE_IMAGE=$buildSourceImage",
			"--build-arg", "INSTANCE_ID=$instanceId",
			"--build-arg", "BASE_COMMIT=$baseCommit",
			"--build-arg", "SOURCE_REPOSITORY_DIGEST=$sourceDigest",
			"--build-arg", "REPOFIXLAB_SANITIZER_SHA256=$sanitizerSha256",
			"--build-arg", "REPOFIXLAB_ROLE_PROBE_SHA256=$probeSha256",
			"--build-arg", "REPOFIXLAB_IMAGE_PROVENANCE_SHA256=$provenanceSha256"
		)
		if ($role.role -eq "worker") {
			$arguments += @(
				"--build-arg", "REPOFIXLAB_WORKER_DOCKERFILE_SHA256=$workerDockerfileSha256",
				"--build-arg", "REPOFIXLAB_WORKER_AUDIT_SHA256=$workerAuditSha256",
				"--build-arg", "REPOFIXLAB_EVALUATOR_IMAGE_ID=$($parentEvaluatorImageId.Substring(7))"
			)
		}
		$arguments += "packages/repofixlab"
		Invoke-CheckedDocker $docker $arguments "M6 $($role.role) image build for $instanceId"
		$inspection = Get-DockerImageInspection $docker ([string]$role.tag) "M6 $($role.role) image $instanceId"
		Assert-RoleImage $inspection ([string]$inspection.Id) $instanceId $baseCommit $sourceDigest $sanitizerSha256 $probeSha256 $provenanceSha256 $parentEvaluatorImageId ([string]$role.role)
		$builtRoles[[string]$role.role] = [ordered]@{
			image_reference = [string]$role.tag
			local_image_id = [string]$inspection.Id
			provenance_sha256 = $provenanceSha256
			build_input = "build-inputs\$prefix.$($role.role).json"
			build_input_sha256 = $provenanceSha256
		}
	}
	$materialized += [ordered]@{
		instance_id = $instanceId
		base_commit = $baseCommit
		source_image_id = [string]$source.local_image_id
		source_repository_digest = $sourceDigest
		worker = $builtRoles["worker"]
		evaluator = $builtRoles["evaluator"]
	}
	$preflightTasks += [ordered]@{
		instance_id = $instanceId
		base_commit = $baseCommit
		repo = [string]$task.repo
		private_task_sha256 = [string]$task.private_task_sha256
		source_image_id = [string]$source.local_image_id
		adapted_image_reference = [string]$builtRoles["evaluator"].image_reference
		adapted_image_id = [string]$builtRoles["evaluator"].local_image_id
	}
}

$sortedPreflightTasks = [object[]]@($preflightTasks)
[Array]::Sort(
	$sortedPreflightTasks,
	[System.Comparison[object]] {
		param($left, $right)
		return [string]::CompareOrdinal([string]$left.instance_id, [string]$right.instance_id)
	}
)
$sortedMaterialized = [object[]]@($materialized)
[Array]::Sort(
	$sortedMaterialized,
	[System.Comparison[object]] {
		param($left, $right)
		return [string]::CompareOrdinal([string]$left.instance_id, [string]$right.instance_id)
	}
)

$request = [ordered]@{
	schema_version = "v1"
	request_type = "m3_official_image_preflight"
	operation_id = "m6:environment-preflight:$timestamp"
	dataset_revision = [string]$sourceLock.dataset_revision
	private_volume = [string]$datasetLock.volumes.private
	tasks = $sortedPreflightTasks
}
Write-NewJson (Join-Path $operationRoot "preflight-request.json") $request
Write-NewJson (Join-Path $operationRoot "materialized-images.json") ([ordered]@{
	schema_version = "v1"
	artifact_type = "m6_materialized_task_images"
	eligibility_manifest_sha256 = [string]$eligibility.eligibility_sha256
	candidate_official_image_source_lock_id = [string]$candidateSourceLock.lock_id
	candidate_official_image_source_lock_seal_sha256 = [string]$candidateSourceLock.seal_sha256
	official_image_source_lock_id = [string]$sourceLock.lock_id
	official_image_source_lock_seal_sha256 = [string]$sourceLock.seal_sha256
	dataset_lock_id = [string]$datasetLock.lock_id
	dataset_lock_file_sha256 = Get-Sha256 $datasetLockPath
	generic_asset_sha256 = [ordered]@{
		sanitizer = $sanitizerSha256
		worker_audit = $workerAuditSha256
		role_probe = $probeSha256
		evaluator_dockerfile = $evaluatorDockerfileSha256
		worker_dockerfile = $workerDockerfileSha256
	}
	tasks = $sortedMaterialized
})

[Console]::Out.WriteLine("M6 generic Worker/Evaluator images materialized. Preflight request: $operationRoot\preflight-request.json")
