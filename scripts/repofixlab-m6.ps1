[CmdletBinding()]
param(
    [string]$ResumeRun = "",
    [string]$SecretFile = "",
    [string]$ContinuationSourceReport = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactsRoot = Join-Path $repositoryRoot "artifacts"
$docker = (Get-Command docker -ErrorAction Stop).Source
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$primarySecret = Join-Path $env:LOCALAPPDATA "RepoFixLab\deepseek_v4_flash_api_key.txt"
$defaultPublicTaskVolume = "dataset-public-g-20260718-135934-066a8f5b6f6b"

if ([String]::IsNullOrWhiteSpace($SecretFile)) {
    $SecretFile = $primarySecret
}
$secretAbsolute = [IO.Path]::GetFullPath($SecretFile)
if (-not [IO.File]::Exists($secretAbsolute) -or (Get-Item -LiteralPath $secretAbsolute).Length -eq 0) {
    throw "M6 requires a non-empty provider secret file. Default: $primarySecret"
}

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & $docker compose -f compose.yaml --profile m6 @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose command failed with exit code $LASTEXITCODE"
    }
}

function Get-ComposeHash {
    param([Parameter(Mandatory = $true)][string]$Service)

    $hashOutput = (& $docker compose -f compose.yaml --profile m6 config --hash $Service).Trim()
    if ($LASTEXITCODE -ne 0 -or $hashOutput -notmatch "^$([regex]::Escape($Service))\s+([a-f0-9]{64})$") {
        throw "Cannot obtain a valid Compose configuration hash for $Service"
    }
    return $Matches[1]
}

function Wait-ControllerHealthy {
    param([int]$TimeoutSeconds = 90)

    $containerId = (& $docker compose -f compose.yaml --profile m6 ps --quiet controller).Trim()
    if ($LASTEXITCODE -ne 0 -or [String]::IsNullOrWhiteSpace($containerId)) {
        throw "M6 Controller container ID is unavailable after startup"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $health = (& $docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $containerId).Trim()
        if ($LASTEXITCODE -eq 0 -and $health -eq "healthy") {
            return
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "M6 Controller did not become healthy within $TimeoutSeconds seconds (last status: $health)"
}

$previousSecretFile = [Environment]::GetEnvironmentVariable("REPOFIX_DEEPSEEK_SECRET_FILE", "Process")
$previousPublicVolume = [Environment]::GetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", "Process")
$publicTaskVolume = $previousPublicVolume
if ([String]::IsNullOrWhiteSpace($publicTaskVolume)) {
    $publicTaskVolume = $defaultPublicTaskVolume
}
& $docker volume inspect $publicTaskVolume *> $null
if ($LASTEXITCODE -ne 0) {
    throw "M6 public task Docker volume is unavailable: $publicTaskVolume"
}
[Environment]::SetEnvironmentVariable("REPOFIX_DEEPSEEK_SECRET_FILE", $secretAbsolute, "Process")
[Environment]::SetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", $publicTaskVolume, "Process")
try {
    $controllerHash = Get-ComposeHash "controller"
    $orchestratorHash = Get-ComposeHash "orchestrator"
    Invoke-Compose @("build", "--build-arg", "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$controllerHash", "controller")
    Invoke-Compose @("build", "--build-arg", "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$orchestratorHash", "orchestrator")
    Invoke-Compose @("up", "--detach", "controller")
	Wait-ControllerHealthy

    # P0: same non-root m6-runner identity, no Provider request and no secret content read.
    Invoke-Compose @("run", "--rm", "--no-deps", "--entrypoint", "node", "m6-runner", "packages/repofixlab/docker/m6-p0-readiness.mjs")

    $instanceIds = @("axios__axios-5892", "mrdoob__three.js-26589", "preactjs__preact-4182")
    & (Join-Path $PSScriptRoot "repofixlab-m6-runtime-preflight.ps1") -InstanceIds $instanceIds -OperationPrefix "m6-v2-$timestamp"
    if ($LASTEXITCODE -ne 0) {
        throw "M6 P0 Controller runtime preflight failed"
    }

	if (-not [String]::IsNullOrWhiteSpace($ContinuationSourceReport)) {
		$sourceRelative = $ContinuationSourceReport.Replace("\", "/").TrimStart("/")
		if ($sourceRelative -notmatch '^m6-deepseek-flash-calibration/runs/m6-calibration-run-[A-Za-z0-9-]+/calibration-report\.json$') {
			throw "--source-report must name a sealed M6 DeepSeek Flash calibration report beneath artifacts"
		}
		if ([String]::IsNullOrWhiteSpace($ResumeRun)) {
			Invoke-Compose @("run", "--rm", "--no-deps", "m6-runner", "m6-continue", "--source-report", $sourceRelative)
		}
		else {
			$resumeRelative = $ResumeRun.Replace("\", "/").TrimStart("/")
			if ($resumeRelative -notmatch '^m6-deepseek-flash-continuation/runs/\.staging-m6-continuation-run-[A-Za-z0-9-]+$') {
				throw "--resume must name an M6 continuation staging run beneath artifacts"
			}
			Invoke-Compose @("run", "--rm", "--no-deps", "m6-runner", "m6-continue", "--source-report", $sourceRelative, "--resume", $resumeRelative)
		}
	}
    elseif ([String]::IsNullOrWhiteSpace($ResumeRun)) {
		$batchRelative = "m6-deepseek-flash-calibration-v3-input/$timestamp-v3/calibration-batch.json"
        Invoke-Compose @("run", "--rm", "--no-deps", "m6-runner", "m6-batch-create", "--input", "m3-final/20260720T193500Z-26-task-v1/split-manifest.json", "--output", $batchRelative)
        Invoke-Compose @("run", "--rm", "--no-deps", "m6-runner", "m6-run", "--input", $batchRelative)
    }
    else {
        $resumeRelative = $ResumeRun.Replace("\", "/").TrimStart("/")
		if ($resumeRelative -notmatch '^m6-deepseek-flash-calibration/runs/\.staging-m6-calibration-run-[A-Za-z0-9-]+$') {
            throw "--resume must name one M6 staging run beneath artifacts/m6-calibration/runs"
        }
        $batchRelative = "$resumeRelative/calibration-batch.json"
        Invoke-Compose @("run", "--rm", "--no-deps", "m6-runner", "m6-run", "--input", $batchRelative, "--resume", $resumeRelative)
    }
}
finally {
	[Environment]::SetEnvironmentVariable("REPOFIX_DEEPSEEK_SECRET_FILE", $previousSecretFile, "Process")
    [Environment]::SetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", $previousPublicVolume, "Process")
}
