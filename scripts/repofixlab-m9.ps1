[CmdletBinding()]
param(
    [string]$SecretFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$docker = (Get-Command docker -ErrorAction Stop).Source
$defaultSecret = Join-Path $env:LOCALAPPDATA "RepoFixLab\deepseek_v4_flash_api_key.txt"
if ([String]::IsNullOrWhiteSpace($SecretFile)) { $SecretFile = $defaultSecret }
$secretAbsolute = [IO.Path]::GetFullPath($SecretFile)
if (-not [IO.File]::Exists($secretAbsolute) -or (Get-Item -LiteralPath $secretAbsolute).Length -eq 0) {
    throw "M9 requires a non-empty DeepSeek secret file. Default: $defaultSecret"
}

function Invoke-M9Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & $docker compose -f compose.yaml --profile m6 @Arguments
    if ($LASTEXITCODE -ne 0) { throw "M9 Docker Compose command failed with exit code $LASTEXITCODE" }
}

function Get-M9ComposeHash {
    param([Parameter(Mandatory = $true)][string]$Service)
    $line = (& $docker compose -f compose.yaml --profile m6 config --hash $Service).Trim()
    if ($LASTEXITCODE -ne 0 -or $line -notmatch "^$([regex]::Escape($Service))\s+([a-f0-9]{64})$") {
        throw "M9 cannot obtain a valid Compose hash for $Service"
    }
    return $Matches[1]
}

function Wait-M9Controller {
    $id = (& $docker compose -f compose.yaml --profile m6 ps --quiet controller).Trim()
    if ($LASTEXITCODE -ne 0 -or [String]::IsNullOrWhiteSpace($id)) { throw "M9 Controller container ID is unavailable" }
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $health = (& $docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $id).Trim()
        if ($LASTEXITCODE -eq 0 -and $health -eq "healthy") { return }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "M9 Controller did not become healthy within 90 seconds"
}

$previousSecret = [Environment]::GetEnvironmentVariable("REPOFIX_DEEPSEEK_SECRET_FILE", "Process")
$previousVolume = [Environment]::GetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", "Process")
$publicVolume = if ([String]::IsNullOrWhiteSpace($previousVolume)) { "dataset-public-g-20260718-135934-066a8f5b6f6b" } else { $previousVolume }
& $docker volume inspect $publicVolume *> $null
if ($LASTEXITCODE -ne 0) { throw "M9 public task Docker volume is unavailable: $publicVolume" }
[Environment]::SetEnvironmentVariable("REPOFIX_DEEPSEEK_SECRET_FILE", $secretAbsolute, "Process")
[Environment]::SetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", $publicVolume, "Process")
try {
    $controllerHash = Get-M9ComposeHash "controller"
    $orchestratorHash = Get-M9ComposeHash "orchestrator"
    Invoke-M9Compose @("build", "--build-arg", "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$controllerHash", "controller")
    Invoke-M9Compose @("build", "--build-arg", "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$orchestratorHash", "orchestrator")
    Invoke-M9Compose @("up", "--detach", "controller")
    Wait-M9Controller
    Invoke-M9Compose @("run", "--rm", "--no-deps", "--entrypoint", "node", "m6-runner", "packages/repofixlab/docker/m6-p0-readiness.mjs")
    Invoke-M9Compose @("run", "--rm", "--no-deps", "--entrypoint", "node", "m6-runner", "packages/repofixlab/docker/m7-input-bindings.mjs")
    Invoke-M9Compose @("run", "--rm", "--no-deps", "--entrypoint", "node", "m6-runner", "packages/repofixlab/docker/m9-run.mjs")
}
finally {
    [Environment]::SetEnvironmentVariable("REPOFIX_DEEPSEEK_SECRET_FILE", $previousSecret, "Process")
    [Environment]::SetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", $previousVolume, "Process")
}
