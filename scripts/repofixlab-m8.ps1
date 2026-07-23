[CmdletBinding()]
param(
    [string]$ContinuationReport = "m7-v1.7.3/report/continuation-edf1bdde883e630d3fa184ba85cd1a74c9c9dff8a844db9a20d1ae37550eb542.json",
    [string]$SecurityAudit = "m7-v1.7.3/report/security-868e8b1c06f654673de5d3ba890ef06acda1726411faa8ec548416d58dad3f26.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactsRoot = Join-Path $repositoryRoot "artifacts"
$docker = (Get-Command docker -ErrorAction Stop).Source

function Resolve-M8ArtifactPath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ([String]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Name must be a non-empty path relative to artifacts"
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $artifactsRoot $RelativePath))
    $rootPrefix = $artifactsRoot.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($candidate)) {
        throw "$Name is unavailable beneath artifacts: $RelativePath"
    }
    return $candidate
}

function Get-M8ComposeHash {
    $line = (& $docker compose -f compose.yaml --profile m6 config --hash orchestrator).Trim()
    if ($LASTEXITCODE -ne 0 -or $line -notmatch "^orchestrator\s+([a-f0-9]{64})$") {
        throw "M8 cannot obtain a valid Orchestrator Compose hash"
    }
    return $Matches[1]
}

[void](Resolve-M8ArtifactPath -RelativePath $ContinuationReport -Name "ContinuationReport")
[void](Resolve-M8ArtifactPath -RelativePath $SecurityAudit -Name "SecurityAudit")

Push-Location $repositoryRoot
try {
    $orchestratorHash = Get-M8ComposeHash
    & $docker compose -f compose.yaml --profile m6 build --build-arg "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$orchestratorHash" orchestrator
    if ($LASTEXITCODE -ne 0) { throw "M8 Orchestrator image build failed with exit code $LASTEXITCODE" }
    & $docker compose -f compose.yaml --profile m6 run --rm --no-deps `
        -e "REPOFIX_M8_CONTINUATION_REPORT=$ContinuationReport" `
        -e "REPOFIX_M8_SECURITY_AUDIT=$SecurityAudit" `
        --entrypoint node orchestrator packages/repofixlab/docker/m8-analysis.mjs
    if ($LASTEXITCODE -ne 0) { throw "M8 offline analysis failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
