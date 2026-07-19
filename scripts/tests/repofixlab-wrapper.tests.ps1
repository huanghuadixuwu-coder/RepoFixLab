Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
$wrapper = Join-Path $repositoryRoot "scripts/repofixlab.ps1"
$powershell = (Get-Command powershell -ErrorAction Stop).Source

function Invoke-Wrapper {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = ($output | ForEach-Object { [string]$_ }) -join "`n"
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$help = Invoke-Wrapper @("--help")
Assert-True ($help.ExitCode -eq 0) "--help must return 0"
Assert-True ($help.Output.Contains("dataset prepare")) "--help must describe dataset prepare"
Assert-True ($help.Output.Contains("dataset self-check")) "--help must describe dataset self-check"
Assert-True ($help.Output.Contains("images lock-input")) "--help must describe images lock-input"
Assert-True ($help.Output.Contains("images prepare-axios")) "--help must describe images prepare-axios"
$wrapperSource = [IO.File]::ReadAllText($wrapper)
Assert-True ($wrapperSource.Contains('unsigned-bootstrap-image-provenance-candidate.json')) "wrapper must name the unsigned candidate explicitly"
Assert-True (-not $wrapperSource.Contains('lockSha256')) "host wrapper must not self-sign the unsigned candidate"
$axiosConfigSource = [IO.File]::ReadAllText((Join-Path $repositoryRoot "packages/repofixlab/task-images/axios-5892/v1.yaml"))
$workerDockerfileHash = (Get-FileHash -Algorithm SHA256 (Join-Path $repositoryRoot "packages/repofixlab/task-images/axios-5892/worker-sanitized.Dockerfile")).Hash.ToLowerInvariant()
$workerAuditHash = (Get-FileHash -Algorithm SHA256 (Join-Path $repositoryRoot "packages/repofixlab/task-images/axios-5892/audit-worker-image.sh")).Hash.ToLowerInvariant()
Assert-True ($workerDockerfileHash -ceq "9559993ba6fc3883c75da7571cc2d35047d0097270b244c5e26c1f386e62f415") "worker Dockerfile hash fixture drifted"
Assert-True ($workerAuditHash -ceq "9fe866d467e72600f057952539f72baca93871a62bd895dca02cd5f275ac8164") "worker root audit hash fixture drifted"
Assert-True ($axiosConfigSource.Contains("worker_dockerfile_sha256: $workerDockerfileHash")) "Axios config must freeze the worker Dockerfile hash"
Assert-True ($axiosConfigSource.Contains("worker_audit_sha256: $workerAuditHash")) "Axios config must freeze the worker root audit hash"
Assert-True (-not $wrapperSource.Contains("derived_local_image_id") -and -not $wrapperSource.Contains("derived_provenance_sha256")) "Axios operation result must not retain ambiguous derived fields"

$unknown = Invoke-Wrapper @("dataset", "prepare", "--unknown", "value")
Assert-True ($unknown.ExitCode -eq 2) "unknown options must return 2"
Assert-True ($unknown.Output.Contains("Unknown option")) "unknown options must explain the rejection"

$invalidGeneration = Invoke-Wrapper @("dataset", "prepare", "--generation-id", "../escape")
Assert-True ($invalidGeneration.ExitCode -eq 2) "invalid generation IDs must return 2 before Docker"

$invalidImageOption = Invoke-Wrapper @("images", "lock-input", "--unknown")
Assert-True ($invalidImageOption.ExitCode -eq 2) "images lock-input options must be rejected before Docker"

$invalidAxiosImageOption = Invoke-Wrapper @("images", "prepare-axios", "--unknown")
Assert-True ($invalidAxiosImageOption.ExitCode -eq 2) "images prepare-axios options must be rejected before Docker"

$invalidSelfCheckOption = Invoke-Wrapper @("dataset", "self-check", "--generation-id", "g-forbidden")
Assert-True ($invalidSelfCheckOption.ExitCode -eq 2) "dataset self-check must reject generation options before Docker"

$provenanceRoot = Join-Path $repositoryRoot "artifacts/provenance"
$provenanceBefore = @{}
if ([IO.Directory]::Exists($provenanceRoot)) {
    foreach ($directory in Get-ChildItem -LiteralPath $provenanceRoot -Directory) {
        $provenanceBefore[$directory.FullName] = $true
    }
}
$fakeDockerDirectory = Join-Path ([IO.Path]::GetTempPath()) "repofixlab-fake-docker-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($fakeDockerDirectory) | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $fakeDockerDirectory "docker.cmd"),
    "@echo off`r`nexit /b 23`r`n",
    (New-Object System.Text.UTF8Encoding($false))
)
$previousPath = $env:PATH
try {
    $env:PATH = "$fakeDockerDirectory;$previousPath"
    $failedImages = Invoke-Wrapper @("images", "lock-input")
}
finally {
    $env:PATH = $previousPath
    [IO.Directory]::Delete($fakeDockerDirectory, $true)
}
Assert-True ($failedImages.ExitCode -ne 0) "a Docker command failure must fail images lock-input"
Assert-True ($failedImages.Output.Contains("failed without creating a candidate")) "image collection failure must state that no candidate was created"
$newProvenanceDirectories = @(
    Get-ChildItem -LiteralPath $provenanceRoot -Directory |
        Where-Object { -not $provenanceBefore.ContainsKey($_.FullName) }
)
Assert-True ($newProvenanceDirectories.Count -eq 1) "failed images lock-input must create exactly one auditable operation directory"
$candidateFiles = @(Get-ChildItem -LiteralPath $newProvenanceDirectories[0].FullName -Recurse -File -Filter "*candidate*.json")
Assert-True ($candidateFiles.Count -eq 0) "failed images lock-input must not leave a provenance candidate"
$failedResult = Get-Content -Raw (Join-Path $newProvenanceDirectories[0].FullName "result.json") | ConvertFrom-Json
Assert-True ($failedResult.status -ceq "failed_without_candidate") "failed images lock-input must record a non-candidate result"

$provenanceBeforeLabelDrift = @{}
foreach ($directory in Get-ChildItem -LiteralPath $provenanceRoot -Directory) {
    $provenanceBeforeLabelDrift[$directory.FullName] = $true
}
$fakeDockerDirectory = Join-Path ([IO.Path]::GetTempPath()) "repofixlab-fake-docker-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($fakeDockerDirectory) | Out-Null
$fakeDockerScript = Join-Path $fakeDockerDirectory "fake-docker.ps1"
$fakeDockerLog = Join-Path $fakeDockerDirectory "commands.log"
$fakeDockerSource = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::AppendAllText($env:REPOFIX_FAKE_DOCKER_LOG, (($args -join " ") + "`n"), $utf8)
$command = $args -join " "
$controllerHash = "a" * 64
$orchestratorHash = "b" * 64
if ($command -ceq "compose -f compose.yaml config --format json") {
    $root = [IO.Path]::GetFullPath($env:REPOFIX_FAKE_REPOSITORY_ROOT)
    [ordered]@{
        name = "repofixlab"
        networks = [ordered]@{
            "provider-egress" = [ordered]@{ name = "repofixlab_provider-egress" }
            "repofix-control" = [ordered]@{ name = "repofixlab_repofix-control"; internal = $true }
        }
        services = [ordered]@{
            controller = [ordered]@{
                build = [ordered]@{
                    context = Join-Path $root "packages/repofixlab"
                    dockerfile = "docker/controller.Dockerfile"
                }
                networks = [ordered]@{ "repofix-control" = $null }
            }
            orchestrator = [ordered]@{
                build = [ordered]@{
                    context = $root
                    dockerfile = "packages/repofixlab/docker/orchestrator.Dockerfile"
                }
                networks = [ordered]@{ "repofix-control" = $null; "provider-egress" = $null }
            }
        }
    } | ConvertTo-Json -Depth 8
    exit 0
}
if ($command -ceq "compose -f compose.yaml config --hash controller") {
    [Console]::Out.WriteLine("controller $controllerHash")
    exit 0
}
if ($command -ceq "compose -f compose.yaml config --hash orchestrator") {
    [Console]::Out.WriteLine("orchestrator $orchestratorHash")
    exit 0
}
if (
    $command -ceq "compose -f compose.yaml build --build-arg REPOFIXLAB_COMPOSE_CONFIG_SHA256=$controllerHash controller" -or
    $command -ceq "compose -f compose.yaml build --build-arg REPOFIXLAB_COMPOSE_CONFIG_SHA256=$orchestratorHash orchestrator"
) {
    exit 0
}
if ($command -ceq "image inspect repofixlab-controller") {
    @([ordered]@{
        Id = "sha256:" + ("c" * 64)
        Os = "linux"
        Architecture = "amd64"
        RootFS = [ordered]@{ Layers = @("sha256:" + ("1" * 64)) }
        Config = [ordered]@{
            Labels = [ordered]@{ "io.repofixlab.compose-config-sha256" = ("d" * 64) }
        }
    }) | ConvertTo-Json -Depth 8
    exit 0
}
[Console]::Error.WriteLine("Unexpected fake Docker command: $command")
exit 91
'@
[IO.File]::WriteAllText($fakeDockerScript, $fakeDockerSource, (New-Object System.Text.UTF8Encoding($false)))
$fakeDockerCommand = @"
@echo off
"$powershell" -NoProfile -ExecutionPolicy Bypass -File "$fakeDockerScript" %*
exit /b %ERRORLEVEL%
"@
[IO.File]::WriteAllText(
    (Join-Path $fakeDockerDirectory "docker.cmd"),
    $fakeDockerCommand,
    (New-Object System.Text.UTF8Encoding($false))
)
$previousPath = $env:PATH
$previousFakeDockerLog = $env:REPOFIX_FAKE_DOCKER_LOG
$previousFakeRepositoryRoot = $env:REPOFIX_FAKE_REPOSITORY_ROOT
try {
    $env:PATH = "$fakeDockerDirectory;$previousPath"
    $env:REPOFIX_FAKE_DOCKER_LOG = $fakeDockerLog
    $env:REPOFIX_FAKE_REPOSITORY_ROOT = $repositoryRoot
    $labelDrift = Invoke-Wrapper @("images", "lock-input")
    $fakeDockerCommands = @([IO.File]::ReadAllLines($fakeDockerLog))
}
finally {
    $env:PATH = $previousPath
    $env:REPOFIX_FAKE_DOCKER_LOG = $previousFakeDockerLog
    $env:REPOFIX_FAKE_REPOSITORY_ROOT = $previousFakeRepositoryRoot
    [IO.Directory]::Delete($fakeDockerDirectory, $true)
}
Assert-True ($labelDrift.ExitCode -ne 0) "a final image Compose-hash label drift must fail images lock-input"
Assert-True ($labelDrift.Output.Contains("label does not match the pre-build hash")) "label drift must identify the provenance mismatch"
$newLabelDriftDirectories = @(
    Get-ChildItem -LiteralPath $provenanceRoot -Directory |
        Where-Object { -not $provenanceBeforeLabelDrift.ContainsKey($_.FullName) }
)
Assert-True ($newLabelDriftDirectories.Count -eq 1) "label drift must create exactly one auditable operation directory"
$labelDriftCandidates = @(Get-ChildItem -LiteralPath $newLabelDriftDirectories[0].FullName -Recurse -File -Filter "*candidate*.json")
Assert-True ($labelDriftCandidates.Count -eq 0) "label drift must not leave a provenance candidate"
$controllerHashCommand = "compose -f compose.yaml config --hash controller"
$orchestratorHashCommand = "compose -f compose.yaml config --hash orchestrator"
$controllerBuildCommand = "compose -f compose.yaml build --build-arg REPOFIXLAB_COMPOSE_CONFIG_SHA256=$("a" * 64) controller"
$orchestratorBuildCommand = "compose -f compose.yaml build --build-arg REPOFIXLAB_COMPOSE_CONFIG_SHA256=$("b" * 64) orchestrator"
$controllerHashIndex = [Array]::IndexOf($fakeDockerCommands, $controllerHashCommand)
$orchestratorHashIndex = [Array]::IndexOf($fakeDockerCommands, $orchestratorHashCommand)
$controllerBuildIndex = [Array]::IndexOf($fakeDockerCommands, $controllerBuildCommand)
$orchestratorBuildIndex = [Array]::IndexOf($fakeDockerCommands, $orchestratorBuildCommand)
Assert-True ($controllerHashIndex -ge 0 -and $controllerHashIndex -lt $controllerBuildIndex) "controller hash must be read before its exact build-arg build"
Assert-True ($orchestratorHashIndex -ge 0 -and $orchestratorHashIndex -lt $orchestratorBuildIndex) "orchestrator hash must be read before its exact build-arg build"

function Get-DirectorySnapshot {
    param([Parameter(Mandatory = $true)][string]$Root)

    $snapshot = @{}
    if ([IO.Directory]::Exists($Root)) {
        foreach ($directory in Get-ChildItem -LiteralPath $Root -Directory) {
            $snapshot[$directory.FullName] = $true
        }
    }
    return $snapshot
}

function Get-NewDirectories {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][hashtable]$Before
    )

    if (-not [IO.Directory]::Exists($Root)) {
        return @()
    }
    return @(
        Get-ChildItem -LiteralPath $Root -Directory |
            Where-Object { -not $Before.ContainsKey($_.FullName) }
    )
}

function Write-FakeAxiosImageFixtures {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $sourceId = "sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
    $sourceDigest = "swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
    $evaluatorId = "sha256:$('d' * 64)"
    $workerId = "sha256:$('e' * 64)"
    $sourceEnvironment = @(
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TZ=Etc/UTC",
        "CHROME_BIN=/usr/bin/google-chrome",
        "CHROME_PATH=/usr/bin/google-chrome"
    )
    $roleEnvironment = @($sourceEnvironment) + "HOME=/tmp/repofixlab-home"
    @([ordered]@{
        Id = $sourceId
        Os = "linux"
        Architecture = "amd64"
        RepoDigests = @($sourceDigest)
        RootFS = [ordered]@{ Layers = @("sha256:$('1' * 64)") }
        Config = [ordered]@{ Env = $sourceEnvironment; WorkingDir = "/testbed"; Cmd = @("/bin/bash") }
        Descriptor = [ordered]@{
            mediaType = "application/vnd.docker.distribution.manifest.v2+json"
            digest = "sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
            size = 2422
        }
    }) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory "source-inspect.json") -Encoding UTF8
    @([ordered]@{
        Id = $evaluatorId
        Os = "linux"
        Architecture = "amd64"
        RepoTags = @("repofixlab-axios-5892-sanitized:v1")
        RootFS = [ordered]@{ Layers = @("sha256:$('1' * 64)", "sha256:$('2' * 64)") }
        Config = [ordered]@{
            Env = $roleEnvironment
            WorkingDir = "/testbed"
            Cmd = @("/bin/bash")
            Labels = [ordered]@{
                "io.repofixlab.base-commit" = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
                "io.repofixlab.instance-id" = "axios__axios-5892"
                "io.repofixlab.provenance-sha256" = "e280b68d557aab18fb8bf87a0fff417b3efbf231a0dd7cda6e583dcf5ed4d4d6"
                "io.repofixlab.role-probe-sha256" = "f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775"
                "io.repofixlab.sanitizer-sha256" = "68ef77f59b38239a3863f9cb1669ecf2f3270d3148191a2bc7010f66e20712f6"
                "io.repofixlab.source-repository-digest" = $sourceDigest
            }
        }
    }) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory "evaluator-inspect.json") -Encoding UTF8
    @([ordered]@{
        Id = $workerId
        Os = "linux"
        Architecture = "amd64"
        RepoTags = @("repofixlab-axios-5892-worker-sanitized:v1")
        RootFS = [ordered]@{ Layers = @("sha256:$('1' * 64)", "sha256:$('3' * 64)") }
        Config = [ordered]@{
            Env = $roleEnvironment
            WorkingDir = "/testbed"
            Cmd = @("/bin/bash")
            Labels = [ordered]@{
                "io.repofixlab.base-commit" = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
                "io.repofixlab.instance-id" = "axios__axios-5892"
                "io.repofixlab.provenance-sha256" = "2753a0b780a86027745ce0f4655782b7ff91d0333c1e9836d027016a90224e2b"
                "io.repofixlab.role-probe-sha256" = "f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775"
                "io.repofixlab.sanitizer-sha256" = "68ef77f59b38239a3863f9cb1669ecf2f3270d3148191a2bc7010f66e20712f6"
                "io.repofixlab.source-repository-digest" = $sourceDigest
                "io.repofixlab.role" = "worker"
                "io.repofixlab.worker-history-profile" = "exact-base-shallow-single-commit-v1"
                "io.repofixlab.worker-dockerfile-sha256" = "9559993ba6fc3883c75da7571cc2d35047d0097270b244c5e26c1f386e62f415"
                "io.repofixlab.worker-audit-sha256" = "9fe866d467e72600f057952539f72baca93871a62bd895dca02cd5f275ac8164"
            }
        }
    }) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory "worker-inspect.json") -Encoding UTF8
}

$taskImageRoot = Join-Path $repositoryRoot "artifacts/task-images"
$activeTaskImageLock = Join-Path $taskImageRoot "active/official-image-source-lock.json"
$activeLockExisted = [IO.File]::Exists($activeTaskImageLock)
$activeLockBefore = if ($activeLockExisted) { [IO.File]::ReadAllBytes($activeTaskImageLock) } else { $null }
$fakeAxiosDirectory = Join-Path ([IO.Path]::GetTempPath()) "repofixlab-fake-axios-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($fakeAxiosDirectory) | Out-Null
Write-FakeAxiosImageFixtures $fakeAxiosDirectory
$fakeAxiosLog = Join-Path $fakeAxiosDirectory "commands.log"
$fakeAxiosVolumeState = Join-Path $fakeAxiosDirectory "volume.state"
$sourceId = "sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
$evaluatorId = "sha256:$('d' * 64)"
$workerId = "sha256:$('e' * 64)"
$fakeAxiosScript = Join-Path $fakeAxiosDirectory "fake-docker.ps1"
$fakeAxiosSource = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::AppendAllText($env:REPOFIX_FAKE_AXIOS_LOG, (($args -join " ") + "`n"), $utf8)
$command = $args -join " "
$sourceId = "sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
$sourceDigest = "swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
$evaluatorId = "sha256:$('d' * 64)"
$workerId = "sha256:$('e' * 64)"
$baseCommit = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
if ($command -ceq "pull --platform linux/amd64 $sourceDigest") {
    [Console]::Out.WriteLine("pulled exact digest")
    exit 0
}
if ($command -ceq "image inspect $sourceDigest") {
    [Console]::Out.Write([IO.File]::ReadAllText($env:REPOFIX_FAKE_AXIOS_SOURCE_INSPECT, $utf8))
    exit 0
}
if ($command -ceq "image inspect repofixlab-axios-5892-sanitized:v1") {
    [Console]::Out.Write([IO.File]::ReadAllText($env:REPOFIX_FAKE_AXIOS_EVALUATOR_INSPECT, $utf8))
    exit 0
}
if ($command -ceq "image inspect repofixlab-axios-5892-worker-sanitized:v1") {
    $inspection = [IO.File]::ReadAllText($env:REPOFIX_FAKE_AXIOS_WORKER_INSPECT, $utf8)
    if ($env:REPOFIX_FAKE_AXIOS_MODE -ceq "worker-hash-failure") {
        $values = @($inspection | ConvertFrom-Json)
        $values[0].Config.Labels.'io.repofixlab.worker-dockerfile-sha256' = "0" * 64
        $inspection = $values | ConvertTo-Json -Depth 8
    }
    [Console]::Out.Write($inspection)
    exit 0
}
if ($args.Count -gt 0 -and $args[0] -ceq "build") {
    if ($env:REPOFIX_FAKE_AXIOS_MODE -ceq "worker-build-failure" -and $args -contains "repofixlab-axios-5892-worker-sanitized:v1") {
        [Console]::Error.WriteLine("intentional worker build failure")
        exit 31
    }
    exit 0
}
if ($args.Count -gt 1 -and $args[0] -ceq "volume" -and $args[1] -ceq "create") {
    $volumeName = [string]$args[$args.Count - 1]
    [IO.File]::AppendAllText($env:REPOFIX_FAKE_AXIOS_VOLUME_STATE, "$volumeName`n", $utf8)
    [Console]::Out.WriteLine($volumeName)
    exit 0
}
if ($args.Count -gt 1 -and $args[0] -ceq "volume" -and $args[1] -ceq "rm") {
    if ($env:REPOFIX_FAKE_AXIOS_MODE -cne "cleanup-residue" -and [IO.File]::Exists($env:REPOFIX_FAKE_AXIOS_VOLUME_STATE)) {
        [IO.File]::Delete($env:REPOFIX_FAKE_AXIOS_VOLUME_STATE)
    }
    exit 0
}
if ($args.Count -gt 1 -and $args[0] -ceq "volume" -and $args[1] -ceq "ls") {
    if ($command.Contains("io.repofixlab.operation-id=") -and [IO.File]::Exists($env:REPOFIX_FAKE_AXIOS_VOLUME_STATE)) {
        [Console]::Out.WriteLine([IO.File]::ReadAllText($env:REPOFIX_FAKE_AXIOS_VOLUME_STATE, $utf8))
    }
    exit 0
}
if ($args.Count -gt 1 -and $args[0] -ceq "container" -and $args[1] -ceq "ls") {
    exit 0
}
if ($args.Count -gt 0 -and $args[0] -ceq "run") {
    $isSource = $args -contains $sourceId
    $isEvaluator = $args -contains $evaluatorId
    $isWorker = $args -contains $workerId
    if ($args -contains "/opt/repofixlab/audit-worker-image.sh") {
        if ($env:REPOFIX_FAKE_AXIOS_MODE -ceq "worker-audit-failure") {
            [Console]::Error.WriteLine("intentional worker root audit failure")
            exit 32
        }
        @(
            "head=$baseCommit",
            "tree=d37c27531ee7d744f25932ad0cb20ecabbf202ff",
            "refs=1",
            "reachable_commits=1",
            "shallow_boundary=$baseCommit",
            "base_parent_present=false",
            "remote_count=0",
            "reflog_entries=0",
            "unreachable_objects=0",
            "status=pass"
        ) | ForEach-Object { [Console]::Out.WriteLine($_) }
        exit 0
    }
    if ($args -contains "rev-parse") {
        [Console]::Out.WriteLine($baseCommit)
        exit 0
    }
    if ($args -contains "for-each-ref") {
        if ($isSource) {
            [Console]::Out.WriteLine("refs/heads/master")
            [Console]::Out.WriteLine("refs/remotes/origin/future")
        }
        elseif ($isEvaluator) {
            [Console]::Out.WriteLine("refs/heads/repofixlab-base")
        }
        exit 0
    }
    if ($args -contains "rev-list") {
        if ($isSource) { [Console]::Out.WriteLine("$('3' * 40)") }
        exit 0
    }
    if ($args -contains "--grep=5892") {
        if ($isSource) { [Console]::Out.WriteLine("$('4' * 40)") }
        exit 0
    }
    if ($args -contains "fsck") {
        if ($isSource) { [Console]::Out.WriteLine("unreachable commit $('5' * 40)") }
        exit 0
    }
    if ($args -contains "status") {
        exit 0
    }
    if ($args -contains "/opt/repofixlab/role-probe.mjs") {
        $roleArgument = @($args | Where-Object { $_.StartsWith("REPOFIX_ROLE=") })
        $role = $roleArgument[0].Substring("REPOFIX_ROLE=".Length)
        if ($env:REPOFIX_FAKE_AXIOS_MODE -ceq "worker-probe-failure" -and $role -ceq "worker") {
            [Console]::Error.WriteLine("intentional worker probe failure")
            exit 33
        }
        $nonceArgument = @($args | Where-Object { $_.StartsWith("REPOFIX_ACTIVE_PROBE_NONCE=") })
        $nonce = $nonceArgument[0].Substring("REPOFIX_ACTIVE_PROBE_NONCE=".Length)
        [ordered]@{
            schema_version = "v1"
            probe_type = "task_role_factory_active_probe"
            probe_sha256 = "f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775"
            nonce = $nonce
            observed_uid = 65532
            observed_gid = 65532
            observed_base_commit = $baseCommit
            writable_path_roundtrip = $true
            docker_socket_paths_present = @()
            sensitive_environment_names_present = @()
            errors = @()
        } | ConvertTo-Json -Compress
        exit 0
    }
    if ($args -contains "mocha") {
        if ($env:REPOFIX_FAKE_AXIOS_MODE -ceq "test-failure") {
            [Console]::Error.WriteLine("intentional locked-test failure")
            exit 37
        }
        [Console]::Out.WriteLine("ok 1 frozen Axios test")
        exit 0
    }
    if ($args -contains "cp" -or $args -contains "chown") {
        exit 0
    }
}
[Console]::Error.WriteLine("Unexpected fake Docker command: $command")
exit 91
'@
[IO.File]::WriteAllText($fakeAxiosScript, $fakeAxiosSource, (New-Object System.Text.UTF8Encoding($false)))
$fakeDockerCommand = @"
@echo off
"$powershell" -NoProfile -ExecutionPolicy Bypass -File "$fakeAxiosScript" %*
exit /b %ERRORLEVEL%
"@
[IO.File]::WriteAllText((Join-Path $fakeAxiosDirectory "docker.cmd"), $fakeDockerCommand, (New-Object System.Text.UTF8Encoding($false)))
$previousPath = $env:PATH
$previousFakeAxiosLog = $env:REPOFIX_FAKE_AXIOS_LOG
$previousFakeAxiosSourceInspect = $env:REPOFIX_FAKE_AXIOS_SOURCE_INSPECT
$previousFakeAxiosEvaluatorInspect = $env:REPOFIX_FAKE_AXIOS_EVALUATOR_INSPECT
$previousFakeAxiosWorkerInspect = $env:REPOFIX_FAKE_AXIOS_WORKER_INSPECT
$previousFakeAxiosVolumeState = $env:REPOFIX_FAKE_AXIOS_VOLUME_STATE
$previousFakeAxiosMode = $env:REPOFIX_FAKE_AXIOS_MODE
try {
    $env:PATH = "$fakeAxiosDirectory;$previousPath"
    $env:REPOFIX_FAKE_AXIOS_LOG = $fakeAxiosLog
    $env:REPOFIX_FAKE_AXIOS_SOURCE_INSPECT = Join-Path $fakeAxiosDirectory "source-inspect.json"
    $env:REPOFIX_FAKE_AXIOS_EVALUATOR_INSPECT = Join-Path $fakeAxiosDirectory "evaluator-inspect.json"
    $env:REPOFIX_FAKE_AXIOS_WORKER_INSPECT = Join-Path $fakeAxiosDirectory "worker-inspect.json"
    $env:REPOFIX_FAKE_AXIOS_VOLUME_STATE = $fakeAxiosVolumeState

    foreach ($mode in @(
        "worker-build-failure", "worker-hash-failure", "worker-audit-failure",
        "worker-probe-failure", "test-failure", "cleanup-residue"
    )) {
        [IO.File]::WriteAllText($fakeAxiosLog, "", (New-Object System.Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($fakeAxiosVolumeState)) {
            [IO.File]::Delete($fakeAxiosVolumeState)
        }
        $before = Get-DirectorySnapshot $taskImageRoot
        $env:REPOFIX_FAKE_AXIOS_MODE = $mode
        $result = Invoke-Wrapper @("images", "prepare-axios")
        Assert-True ($result.ExitCode -ne 0) "fake Axios pipeline must fail closed: $mode"
        $newDirectories = @(
            Get-NewDirectories $taskImageRoot $before |
                Where-Object { $_.Name -cne "active" -and -not $_.Name.StartsWith(".staging-") }
        )
        Assert-True ($newDirectories.Count -eq 1) "failed Axios pipeline must atomically publish one operation artifact: $mode"
        Assert-True (@(Get-ChildItem -LiteralPath $taskImageRoot -Directory | Where-Object { $_.Name.StartsWith(".staging-") }).Count -eq 0) "failed Axios pipeline left a staging artifact directory: $mode"
        $operationResult = Get-Content -Raw (Join-Path $newDirectories[0].FullName "result.json") | ConvertFrom-Json
        Assert-True ($operationResult.status -ceq "failed") "failed Axios pipeline must record failed status: $mode"
        Assert-True (-not [IO.File]::Exists((Join-Path $newDirectories[0].FullName "official-image-source-lock.json"))) "failed Axios pipeline published an operation lock: $mode"
        if ($activeLockExisted) {
            Assert-True ([IO.File]::Exists($activeTaskImageLock)) "failed Axios pipeline removed the active lock: $mode"
            Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$activeLockBefore, [byte[]][IO.File]::ReadAllBytes($activeTaskImageLock))) "failed Axios pipeline changed the active lock: $mode"
        }
        else {
            Assert-True (-not [IO.File]::Exists($activeTaskImageLock)) "failed Axios pipeline created an active lock: $mode"
        }
        $commands = @([IO.File]::ReadAllLines($fakeAxiosLog))
        $requestedTag = "swebench/sweb.eval.x86_64.axios_1776_axios-5892:latest"
        Assert-True (@($commands | Where-Object { $_.StartsWith("pull ") -and $_.Contains($requestedTag) }).Count -eq 0) "Axios pipeline must never pull the requested tag: $mode"
        Assert-True ($commands -contains "pull --platform linux/amd64 swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8") "Axios pipeline must pull the exact digest: $mode"
        $builds = @($commands | Where-Object { $_.StartsWith("build ") })
        Assert-True ($builds.Count -eq 2) "Axios pipeline must issue separate evaluator and worker builds: $mode"
        $evaluatorBuild = @($builds | Where-Object { $_.Contains("--tag repofixlab-axios-5892-sanitized:v1") })
        $workerBuild = @($builds | Where-Object { $_.Contains("--tag repofixlab-axios-5892-worker-sanitized:v1") })
        Assert-True ($evaluatorBuild.Count -eq 1 -and $workerBuild.Count -eq 1) "Axios pipeline must build one image per role: $mode"
        foreach ($build in $builds) {
            foreach ($fragment in @(
                "--no-cache --pull=false --network none", "--platform linux/amd64",
                "REPOFIXLAB_SANITIZER_SHA256=68ef77f59b38239a3863f9cb1669ecf2f3270d3148191a2bc7010f66e20712f6",
                "REPOFIXLAB_ROLE_PROBE_SHA256=f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775"
            )) {
                Assert-True ($build.Contains($fragment)) "Axios role build is missing frozen argument: $fragment ($mode)"
            }
        }
        foreach ($fragment in @(
            "REPOFIXLAB_IMAGE_PROVENANCE_SHA256=e280b68d557aab18fb8bf87a0fff417b3efbf231a0dd7cda6e583dcf5ed4d4d6"
        )) {
            Assert-True ($evaluatorBuild[0].Contains($fragment)) "Axios evaluator build is missing frozen argument: $fragment"
        }
        foreach ($fragment in @(
            "REPOFIXLAB_WORKER_DOCKERFILE_SHA256=9559993ba6fc3883c75da7571cc2d35047d0097270b244c5e26c1f386e62f415",
            "REPOFIXLAB_WORKER_AUDIT_SHA256=9fe866d467e72600f057952539f72baca93871a62bd895dca02cd5f275ac8164",
            "REPOFIXLAB_IMAGE_PROVENANCE_SHA256=2753a0b780a86027745ce0f4655782b7ff91d0333c1e9836d027016a90224e2b"
        )) {
            Assert-True ($workerBuild[0].Contains($fragment)) "Axios worker build is missing frozen argument: $fragment"
        }
        $pullIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line.StartsWith("pull ") })
        $sourceAuditIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line.Contains($sourceId) -and $line.Contains("rev-parse") })
        $evaluatorBuildIndex = [Array]::IndexOf($commands, $evaluatorBuild[0])
        $evaluatorAuditIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line.Contains($evaluatorId) -and $line.Contains("rev-parse") })
        $workerBuildIndex = [Array]::IndexOf($commands, $workerBuild[0])
        $workerInspectIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line -ceq "image inspect repofixlab-axios-5892-worker-sanitized:v1" })
        $workerAuditIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line.Contains("/opt/repofixlab/audit-worker-image.sh /testbed") })
        $testIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line.Contains("npx mocha test/unit/adapters/http.js -R tap -g compression") })
        $cleanupIndex = [Array]::FindIndex($commands, [Predicate[string]]{ param($line) $line.StartsWith("container ls --all --filter label=io.repofixlab.operation-id=") })
        Assert-True (
            $pullIndex -ge 0 -and $pullIndex -lt $sourceAuditIndex -and
            $sourceAuditIndex -lt $evaluatorBuildIndex -and $evaluatorBuildIndex -lt $evaluatorAuditIndex -and
            $evaluatorAuditIndex -lt $workerBuildIndex -and $workerBuildIndex -lt $cleanupIndex
        ) "Axios dual-role build/audit/cleanup ordering drifted: $mode"
        if ($mode -ceq "worker-build-failure") {
            Assert-True ($workerInspectIndex -lt 0 -and $workerAuditIndex -lt 0) "worker build failure must stop before worker inspect/audit"
        }
        elseif ($mode -ceq "worker-hash-failure") {
            Assert-True ($workerInspectIndex -ge 0 -and $workerInspectIndex -lt $cleanupIndex -and $workerAuditIndex -lt 0) "worker hash drift must stop before root audit"
        }
        else {
            Assert-True ($workerBuildIndex -lt $workerInspectIndex -and $workerInspectIndex -lt $workerAuditIndex -and $workerAuditIndex -lt $cleanupIndex) "worker root audit ordering drifted: $mode"
        }
        foreach ($auditCommand in @($commands | Where-Object { $_.Contains(" git -c safe.directory=/testbed ") })) {
            foreach ($fragment in @("--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true")) {
                Assert-True ($auditCommand.Contains($fragment)) "Axios Git audit is missing security option $fragment"
            }
        }
        if ($workerAuditIndex -ge 0) {
            foreach ($fragment in @($workerId, "--user 0:0", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true")) {
                Assert-True ($commands[$workerAuditIndex].Contains($fragment)) "Axios worker root audit is missing frozen input/security option: $fragment"
            }
        }
        $volumeCreateCommands = @($commands | Where-Object { $_.StartsWith("volume create ") })
        $shouldCreateVolumes = $mode -in @("worker-probe-failure", "test-failure", "cleanup-residue")
        Assert-True ($volumeCreateCommands.Count -eq $(if ($shouldCreateVolumes) { 2 } else { 0 })) "Axios validation volume creation count drifted: $mode"
        if ($shouldCreateVolumes) {
            Assert-True (@($volumeCreateCommands | Where-Object { $_.Contains("io.repofixlab.role=worker") }).Count -eq 1) "worker validation volume must have a unique role label: $mode"
            Assert-True (@($volumeCreateCommands | Where-Object { $_.Contains("io.repofixlab.role=evaluator") }).Count -eq 1) "evaluator validation volume must have a unique role label: $mode"
        }
        $runtimeCommands = @($commands | Where-Object { $_.Contains("role-probe.mjs") -or $_.Contains("npx mocha") })
        $expectedRuntimeCount = switch ($mode) {
            "worker-probe-failure" { 1 }
            "test-failure" { 3 }
            "cleanup-residue" { 3 }
            default { 0 }
        }
        Assert-True ($runtimeCommands.Count -eq $expectedRuntimeCount) "Axios role probe/test count drifted: $mode"
        foreach ($runtimeCommand in $runtimeCommands) {
            foreach ($fragment in @("--user 65532:65532", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--mount type=volume", "target=/testbed", "--tmpfs /tmp:")) {
                Assert-True ($runtimeCommand.Contains($fragment)) "Axios validation runtime is missing security option $fragment"
            }
        }
        foreach ($roleCommand in @($runtimeCommands | Where-Object { $_.Contains("role-probe.mjs") })) {
            Assert-True ($roleCommand.Contains("REPOFIX_EXPECTED_BASE_COMMIT=ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b")) "Axios role probe must bind the Controller-canonical base commit environment"
            Assert-True ($roleCommand.Contains("REPOFIX_EXPECTED_PROBE_SHA256=f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775")) "Axios role probe must bind the Controller-canonical probe SHA-256 environment"
            Assert-True (-not $roleCommand.Contains("REPOFIX_EXPECTED_HEAD_SHA")) "Axios role probe must not use the obsolete expected-head environment"
        }
        if ($expectedRuntimeCount -gt 0) {
            $workerProbe = @($runtimeCommands | Where-Object { $_.Contains("role-probe.mjs") -and $_.Contains("REPOFIX_ROLE=worker") })
            Assert-True ($workerProbe.Count -eq 1 -and $workerProbe[0].Contains($workerId)) "worker probe must run only on the worker image: $mode"
        }
        if ($mode -in @("test-failure", "cleanup-residue")) {
            $evaluatorProbe = @($runtimeCommands | Where-Object { $_.Contains("role-probe.mjs") -and $_.Contains("REPOFIX_ROLE=evaluator") })
            $lockedTest = @($runtimeCommands | Where-Object { $_.Contains("npx mocha") })
            Assert-True ($evaluatorProbe.Count -eq 1 -and $evaluatorProbe[0].Contains($evaluatorId)) "evaluator probe must run only on the evaluator image: $mode"
            Assert-True ($lockedTest.Count -eq 1 -and $lockedTest[0].Contains($evaluatorId) -and $lockedTest[0].Contains("io.repofixlab.role=evaluator")) "locked Axios baseline must run only on the evaluator image: $mode"
            Assert-True ($workerAuditIndex -lt [Array]::IndexOf($commands, $workerProbe[0]) -and [Array]::IndexOf($commands, $workerProbe[0]) -lt [Array]::IndexOf($commands, $evaluatorProbe[0]) -and [Array]::IndexOf($commands, $evaluatorProbe[0]) -lt $testIndex) "worker/evaluator probe/test ordering drifted: $mode"
        }
        if ($mode -ceq "cleanup-residue") {
            Assert-True ($result.Output.Contains("cleanup")) "cleanup residue must be reported as a hard failure"
        }
        else {
            Assert-True (-not [IO.File]::Exists($fakeAxiosVolumeState)) "failed Axios operation did not clean all role validation volumes: $mode"
        }
    }
}
finally {
    $env:PATH = $previousPath
    $env:REPOFIX_FAKE_AXIOS_LOG = $previousFakeAxiosLog
    $env:REPOFIX_FAKE_AXIOS_SOURCE_INSPECT = $previousFakeAxiosSourceInspect
    $env:REPOFIX_FAKE_AXIOS_EVALUATOR_INSPECT = $previousFakeAxiosEvaluatorInspect
    $env:REPOFIX_FAKE_AXIOS_WORKER_INSPECT = $previousFakeAxiosWorkerInspect
    $env:REPOFIX_FAKE_AXIOS_VOLUME_STATE = $previousFakeAxiosVolumeState
    $env:REPOFIX_FAKE_AXIOS_MODE = $previousFakeAxiosMode
    [IO.Directory]::Delete($fakeAxiosDirectory, $true)
}
if ($env:REPOFIX_WRAPPER_TEST_SCOPE -ceq "axios") {
    [Console]::Out.WriteLine("PASS RepoFixLab Axios task-image fake wrapper regression")
    exit 0
}

function Write-FakeDatasetSelfCheckFixtures {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [AllowEmptyString()][string]$Drift
    )

    $imageId = "sha256:$('a' * 64)"
    $volumes = @(
        [ordered]@{ type = "volume"; source = "dataset-source"; target = "/input"; read_only = $true; volume = [ordered]@{} },
        [ordered]@{ type = "volume"; source = "dataset-public"; target = "/data/public"; volume = [ordered]@{} },
        [ordered]@{ type = "volume"; source = "dataset-control"; target = "/data/control"; volume = [ordered]@{} },
        [ordered]@{ type = "volume"; source = "dataset-private"; target = "/data/private"; volume = [ordered]@{} }
    )
    $service = [ordered]@{
        profiles = @("dataset-prepare")
        user = "65532:65532"
        read_only = $true
        cap_drop = @("ALL")
        security_opt = @("no-new-privileges:true")
        pids_limit = 64
        mem_limit = "2147483648"
        cpus = 1
        networks = [ordered]@{ "dataset-egress" = $null }
        environment = [ordered]@{ REPOFIX_PREPARER_IMAGE_ID = "" }
        volumes = $volumes
    }
    switch ($Drift) {
        "profile" { $service.profiles = @("wrong-profile") }
        "user" { $service.user = "0:0" }
        "read-only" { $service.read_only = $false }
        "cap-drop" { $service.cap_drop = @("NET_RAW") }
        "nnp" { $service.security_opt = @("seccomp=unconfined") }
        "pids" { $service.pids_limit = 65 }
        "memory" { $service.mem_limit = "2147483649" }
        "cpus" { $service.cpus = 2 }
        "network" { $service.networks["provider-egress"] = $null }
        "model-key" { $service.environment["ZHIPU_API_KEY"] = "forbidden" }
        "image-env" { $service.environment.REPOFIX_PREPARER_IMAGE_ID = $imageId }
        "input-readonly" { $service.volumes[0].read_only = $false }
        "data-targets" { $service.volumes[3].target = "/data/other" }
        "host-bind" { $service.volumes[0].type = "bind"; $service.volumes[0].source = "C:\forbidden" }
        "socket-bind" {
            $service.volumes += [ordered]@{
                type = "bind"
                source = "/var/run/docker.sock"
                target = "/var/run/docker.sock"
            }
        }
        "cap-add" { $service["cap_add"] = @("SYS_ADMIN") }
        "privileged" { $service["privileged"] = $true }
        "devices" { $service["devices"] = @("/dev/null:/dev/null") }
    }
    $composeConfig = [ordered]@{
        name = "repofixlab"
        networks = [ordered]@{ "dataset-egress" = [ordered]@{ name = "repofixlab_dataset-egress" } }
        services = [ordered]@{ "dataset-preparer" = $service }
    }
    [IO.File]::WriteAllText(
        (Join-Path $Directory "compose-config.json"),
        ($composeConfig | ConvertTo-Json -Depth 10),
        (New-Object System.Text.UTF8Encoding($false))
    )

    $inspectId = if ($Drift -ceq "image-id") { "repofixlab-dataset-preparer:latest" } else { $imageId }
    $inspectOs = if ($Drift -ceq "platform") { "windows" } else { "linux" }
    $imageInspection = @([ordered]@{ Id = $inspectId; Os = $inspectOs; Architecture = "amd64" })
    [IO.File]::WriteAllText(
        (Join-Path $Directory "image-inspect.json"),
        ($imageInspection | ConvertTo-Json -Depth 4),
        (New-Object System.Text.UTF8Encoding($false))
    )

    $runtimeImageId = if ($Drift -ceq "runtime-image") { "sha256:$('b' * 64)" } else { $imageId }
    $runtimeUser = $Drift -cne "runtime-check"
    [object[]]$runtimeErrors = @()
    [object[]]$socketObservations = @()
    [object[]]$sensitiveObservations = @()
    if ($Drift -ceq "runtime-errors") {
        $runtimeErrors = @("forbidden")
    }
    if ($Drift -ceq "runtime-socket") {
        $socketObservations = @("/var/run/docker.sock")
    }
    if ($Drift -ceq "runtime-sensitive") {
        $sensitiveObservations = @("ZHIPU_API_KEY")
    }
    $selfCheckReport = [ordered]@{
        schema_version = "v1"
        report_type = "dataset_preparer_self_check"
        status = if ($Drift -ceq "runtime-status") { "fail" } else { "pass" }
        image_id = $runtimeImageId
        checks = [ordered]@{
            image_id_bound = $true
            runtime_user = $runtimeUser
            pyarrow_version = $true
            data_directories_exist = [ordered]@{ public = $true; control = $true; private = $true }
            docker_socket_absent = $true
            sensitive_environment_absent = $true
        }
        observations = [ordered]@{
            docker_socket_paths_present = $socketObservations
            sensitive_environment_names_present = $sensitiveObservations
        }
        errors = $runtimeErrors
        report_sha256 = "$('f' * 64)"
    }
    [IO.File]::WriteAllText(
        (Join-Path $Directory "self-check-report.json"),
        ($selfCheckReport | ConvertTo-Json -Depth 10),
        (New-Object System.Text.UTF8Encoding($false))
    )
    [IO.File]::WriteAllText(
        (Join-Path $Directory "volumes.txt"),
        "repofixlab-controller-work`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
}

$datasetPrepareRoot = Join-Path $repositoryRoot "artifacts/dataset-prepare"
$datasetSelfCheckRoot = Join-Path $repositoryRoot "artifacts/dataset-self-check"
$fakeSelfCheckDirectory = Join-Path ([IO.Path]::GetTempPath()) "repofixlab-fake-self-check-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($fakeSelfCheckDirectory) | Out-Null
$fakeSelfCheckDockerLog = Join-Path $fakeSelfCheckDirectory "commands.log"
$fakeSelfCheckMarker = Join-Path $fakeSelfCheckDirectory "after-run.marker"
$fakeSelfCheckDocker = @'
@echo off
echo %*>>"%REPOFIX_FAKE_DOCKER_LOG%"
if "%1"=="compose" (
  if "%4"=="run" (
    echo {}
    exit /b 0
  )
  if "%6"=="build" exit /b 0
  if "%6"=="config" (
    type "%REPOFIX_FAKE_COMPOSE_CONFIG%"
    exit /b 0
  )
)
if "%1"=="image" if "%2"=="inspect" (
  type "%REPOFIX_FAKE_IMAGE_INSPECT%"
  exit /b 0
)
if "%1"=="volume" if "%2"=="ls" (
  type "%REPOFIX_FAKE_VOLUMES%"
  if "%REPOFIX_FAKE_DRIFT%"=="volume-mutation" if exist "%REPOFIX_FAKE_AFTER_RUN%" echo forbidden-volume
  exit /b 0
)
if "%1"=="container" if "%2"=="ls" (
  if "%REPOFIX_FAKE_DRIFT%"=="container-residue" if exist "%REPOFIX_FAKE_AFTER_RUN%" echo forbidden-container
  exit /b 0
)
if "%1"=="run" (
  type nul>"%REPOFIX_FAKE_AFTER_RUN%"
  type "%REPOFIX_FAKE_SELF_CHECK_REPORT%"
  exit /b 0
)
echo Unexpected fake Docker command: %* 1>&2
exit /b 91
'@
[IO.File]::WriteAllText(
    (Join-Path $fakeSelfCheckDirectory "docker.cmd"),
    $fakeSelfCheckDocker,
    (New-Object System.Text.UTF8Encoding($false))
)

$previousPath = $env:PATH
$previousFakeDockerLog = $env:REPOFIX_FAKE_DOCKER_LOG
$previousFakeComposeConfig = $env:REPOFIX_FAKE_COMPOSE_CONFIG
$previousFakeImageInspect = $env:REPOFIX_FAKE_IMAGE_INSPECT
$previousFakeVolumes = $env:REPOFIX_FAKE_VOLUMES
$previousFakeAfterRun = $env:REPOFIX_FAKE_AFTER_RUN
$previousFakeSelfCheckReport = $env:REPOFIX_FAKE_SELF_CHECK_REPORT
$previousFakeDrift = $env:REPOFIX_FAKE_DRIFT
try {
    $env:PATH = "$fakeSelfCheckDirectory;$previousPath"
    $env:REPOFIX_FAKE_DOCKER_LOG = $fakeSelfCheckDockerLog
    $env:REPOFIX_FAKE_COMPOSE_CONFIG = Join-Path $fakeSelfCheckDirectory "compose-config.json"
    $env:REPOFIX_FAKE_IMAGE_INSPECT = Join-Path $fakeSelfCheckDirectory "image-inspect.json"
    $env:REPOFIX_FAKE_VOLUMES = Join-Path $fakeSelfCheckDirectory "volumes.txt"
    $env:REPOFIX_FAKE_AFTER_RUN = $fakeSelfCheckMarker
    $env:REPOFIX_FAKE_SELF_CHECK_REPORT = Join-Path $fakeSelfCheckDirectory "self-check-report.json"

    $invalidPrefixConfig = Join-Path $fakeSelfCheckDirectory "invalid-volume-prefix.yaml"
    $frozenConfigPath = Join-Path $repositoryRoot "packages/repofixlab/configs/dataset/v1.yaml"
    $invalidPrefixSource = [IO.File]::ReadAllText($frozenConfigPath).Replace(
        "volume_prefix: dataset",
        "volume_prefix: repofixlab-dataset"
    )
    [IO.File]::WriteAllText($invalidPrefixConfig, $invalidPrefixSource, (New-Object System.Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($fakeSelfCheckDockerLog, "", (New-Object System.Text.UTF8Encoding($false)))
    $prepareBeforePrefixDrift = Get-DirectorySnapshot $datasetPrepareRoot
    $selfCheckBeforePrefixDrift = Get-DirectorySnapshot $datasetSelfCheckRoot
    $prefixDrift = Invoke-Wrapper @("dataset", "prepare", "--config", $invalidPrefixConfig, "--generation-id", "g-prefix-drift")
    Assert-True ($prefixDrift.ExitCode -ne 0) "non-frozen volume_prefix must fail before Docker"
    Assert-True (@([IO.File]::ReadAllLines($fakeSelfCheckDockerLog)).Count -eq 0) "volume_prefix drift must not invoke Docker"
    Assert-True (@(Get-NewDirectories $datasetPrepareRoot $prepareBeforePrefixDrift).Count -eq 0) "volume_prefix drift must not allocate a prepare operation"
    Assert-True (@(Get-NewDirectories $datasetSelfCheckRoot $selfCheckBeforePrefixDrift).Count -eq 0) "volume_prefix drift must not allocate a self-check operation"

    Write-FakeDatasetSelfCheckFixtures $fakeSelfCheckDirectory ""
    [IO.File]::WriteAllText($fakeSelfCheckDockerLog, "", (New-Object System.Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($fakeSelfCheckMarker)) {
        [IO.File]::Delete($fakeSelfCheckMarker)
    }
    $selfCheckBefore = Get-DirectorySnapshot $datasetSelfCheckRoot
    $env:REPOFIX_FAKE_DRIFT = ""
    $fakeSelfCheck = Invoke-Wrapper @("dataset", "self-check")
    Assert-True ($fakeSelfCheck.ExitCode -eq 0) "valid fake Dataset Preparer self-check must pass"
    $newSelfCheckDirectories = @(Get-NewDirectories $datasetSelfCheckRoot $selfCheckBefore)
    Assert-True ($newSelfCheckDirectories.Count -eq 1) "dataset self-check must create one unique artifact directory"
    $selfCheckResult = Get-Content -Raw (Join-Path $newSelfCheckDirectories[0].FullName "result.json") | ConvertFrom-Json
    Assert-True ($selfCheckResult.status -ceq "pass") "dataset self-check must record a pass result"
    Assert-True (@(Get-ChildItem -LiteralPath $newSelfCheckDirectories[0].FullName -File -Filter "*.tmp").Count -eq 0) "dataset self-check must atomically finalize artifacts"
    $selfCheckCommands = @([IO.File]::ReadAllLines($fakeSelfCheckDockerLog))
    $doctorIndex = [Array]::FindIndex($selfCheckCommands, [Predicate[string]]{ param($line) $line.Contains("orchestrator doctor --profile bootstrap") })
    $buildIndex = [Array]::IndexOf($selfCheckCommands, "compose -f compose.yaml --profile dataset-prepare build dataset-preparer")
    $inspectIndex = [Array]::IndexOf($selfCheckCommands, "image inspect repofixlab-dataset-preparer")
    $configIndex = [Array]::IndexOf($selfCheckCommands, "compose -f compose.yaml --profile dataset-prepare config --format json")
    $runIndex = [Array]::FindIndex($selfCheckCommands, [Predicate[string]]{ param($line) $line.StartsWith("run --rm --name repofixlab-dataset-self-check-") })
    Assert-True ($doctorIndex -ge 0 -and $doctorIndex -lt $buildIndex -and $buildIndex -lt $inspectIndex -and $inspectIndex -lt $configIndex -and $configIndex -lt $runIndex) "self-check must run bootstrap, build, inspect, static plan, then runtime probe in order"
    $runtimeCommand = $selfCheckCommands[$runIndex]
    foreach ($requiredFragment in @(
        "--platform linux/amd64", "--network none", "--read-only", "--user 65532:65532",
        "--cap-drop ALL", "--security-opt no-new-privileges:true", "--pids-limit 64",
        "--memory 2147483648", "--cpus 1", "REPOFIX_PREPARER_IMAGE_ID=sha256:$('a' * 64)",
        "sha256:$('a' * 64) self-check"
    )) {
        Assert-True ($runtimeCommand.Contains($requiredFragment)) "runtime self-check is missing required Docker option: $requiredFragment"
    }
    Assert-True (-not $runtimeCommand.Contains("--mount") -and -not $runtimeCommand.Contains("--volume") -and -not $runtimeCommand.Contains(" -v ")) "runtime self-check must not mount files or volumes"

    Write-FakeDatasetSelfCheckFixtures $fakeSelfCheckDirectory ""
    [IO.File]::WriteAllText($fakeSelfCheckDockerLog, "", (New-Object System.Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($fakeSelfCheckMarker)) {
        [IO.File]::Delete($fakeSelfCheckMarker)
    }
    $env:REPOFIX_FAKE_DRIFT = "prepare-stop"
    $namingGenerationId = "g-naming-contract"
    $namingResult = Invoke-Wrapper @("dataset", "prepare", "--generation-id", $namingGenerationId)
    Assert-True ($namingResult.ExitCode -ne 0) "fake naming regression must stop at the fake Dataset Preparer"
    $namingCommands = @([IO.File]::ReadAllLines($fakeSelfCheckDockerLog))
    $prepareCommands = @($namingCommands | Where-Object { $_.Contains("--source-url") })
    Assert-True ($prepareCommands.Count -eq 1) "naming regression must reach exactly one fake prepare command"
    foreach ($expectedName in @(
        "--public-volume dataset-public-$namingGenerationId",
        "--control-volume dataset-control-$namingGenerationId",
        "--private-volume dataset-private-$namingGenerationId"
    )) {
        Assert-True ($prepareCommands[0].Contains($expectedName)) "prepare command is missing the frozen Python volume name: $expectedName"
    }
    foreach ($scope in @("public", "control", "private")) {
        Assert-True (-not $prepareCommands[0].Contains("--$scope-volume repofixlab-dataset-")) "prepare command must not use the rejected legacy $scope volume prefix"
    }
    Assert-True (@($namingCommands | Where-Object { $_.StartsWith("volume create ") }).Count -eq 0) "fake naming regression must not issue volume create"

    $drifts = @(
        "profile", "user", "read-only", "cap-drop", "nnp", "pids", "memory", "cpus", "network",
        "model-key", "image-env", "input-readonly", "data-targets", "host-bind", "socket-bind",
        "cap-add", "privileged", "devices", "platform", "image-id", "runtime-status", "runtime-image",
        "runtime-check", "runtime-errors", "runtime-socket", "runtime-sensitive", "volume-mutation", "container-residue"
    )
    foreach ($drift in $drifts) {
        Write-FakeDatasetSelfCheckFixtures $fakeSelfCheckDirectory $drift
        [IO.File]::WriteAllText($fakeSelfCheckDockerLog, "", (New-Object System.Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($fakeSelfCheckMarker)) {
            [IO.File]::Delete($fakeSelfCheckMarker)
        }
        $prepareBefore = Get-DirectorySnapshot $datasetPrepareRoot
        $selfCheckBefore = Get-DirectorySnapshot $datasetSelfCheckRoot
        $env:REPOFIX_FAKE_DRIFT = $drift
        $generationId = "g-drift-$($drift.Replace('_', '-'))"
        $driftResult = Invoke-Wrapper @("dataset", "prepare", "--generation-id", $generationId)
        Assert-True ($driftResult.ExitCode -ne 0) "Dataset Preparer drift must fail closed: $drift"
        $newPrepareDirectories = @(Get-NewDirectories $datasetPrepareRoot $prepareBefore)
        $newSelfCheckDirectories = @(Get-NewDirectories $datasetSelfCheckRoot $selfCheckBefore)
        Assert-True ($newPrepareDirectories.Count -eq 1 -and $newSelfCheckDirectories.Count -eq 1) "drift must create one prepare and one self-check audit directory: $drift"
        $prepareResult = Get-Content -Raw (Join-Path $newPrepareDirectories[0].FullName "result.json") | ConvertFrom-Json
        Assert-True ($prepareResult.status -ceq "dataset_self_check_no_go") "prepare must stop at the Dataset Preparer gate: $drift"
        $commands = @([IO.File]::ReadAllLines($fakeSelfCheckDockerLog))
        Assert-True (@($commands | Where-Object { $_.Contains("--source-url") }).Count -eq 0) "drift reached a dataset download command: $drift"
        Assert-True (@($commands | Where-Object { $_.StartsWith("volume create ") }).Count -eq 0) "drift created a dataset volume: $drift"
        $candidateFiles = @(
            Get-ChildItem -LiteralPath $newPrepareDirectories[0].FullName, $newSelfCheckDirectories[0].FullName -Recurse -File |
                Where-Object { $_.Name.Contains("candidate") -or $_.Name -ceq "dataset-lock.json" }
        )
        Assert-True ($candidateFiles.Count -eq 0) "drift created a candidate or DatasetLock: $drift"
    }
}
finally {
    $env:PATH = $previousPath
    $env:REPOFIX_FAKE_DOCKER_LOG = $previousFakeDockerLog
    $env:REPOFIX_FAKE_COMPOSE_CONFIG = $previousFakeComposeConfig
    $env:REPOFIX_FAKE_IMAGE_INSPECT = $previousFakeImageInspect
    $env:REPOFIX_FAKE_VOLUMES = $previousFakeVolumes
    $env:REPOFIX_FAKE_AFTER_RUN = $previousFakeAfterRun
    $env:REPOFIX_FAKE_SELF_CHECK_REPORT = $previousFakeSelfCheckReport
    $env:REPOFIX_FAKE_DRIFT = $previousFakeDrift
    [IO.Directory]::Delete($fakeSelfCheckDirectory, $true)
}

$docker = (Get-Command docker -ErrorAction Stop).Source
$memoryText = (& $docker info --format "{{.MemTotal}}" 2>$null | Select-Object -First 1)
if ($null -eq $memoryText) {
    throw "Docker must be available for the real bootstrap No-Go test"
}
$memoryBytes = [Int64]::Parse(([string]$memoryText).Trim())
if ($memoryBytes -ge 17179869184) {
    [Console]::Out.WriteLine("SKIP real No-Go path: Docker memory now meets the frozen 16 GiB threshold")
    [Console]::Out.WriteLine("PASS RepoFixLab wrapper help, parameter rejection, build-arg ordering, label-drift rejection, and failed provenance safety")
    exit 0
}

$generationId = "g-nogo-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$volumeNames = @(
    "dataset-public-$generationId",
    "dataset-control-$generationId",
    "dataset-private-$generationId"
)
$existingBefore = @(& $docker volume ls --format "{{.Name}}")
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list Docker volumes before the No-Go test"
}
foreach ($name in $volumeNames) {
    Assert-True ($existingBefore -notcontains $name) "No-Go test requires a fresh volume name: $name"
}

$noGo = Invoke-Wrapper @(
    "dataset", "prepare",
    "--config", "configs/dataset/v1.yaml",
    "--generation-id", $generationId
)
Assert-True ($noGo.ExitCode -ne 0) "current memory No-Go must stop dataset preparation"
Assert-True ($noGo.Output.Contains("stopped by bootstrap doctor")) "No-Go must identify the bootstrap stop"
$existingAfter = @(& $docker volume ls --format "{{.Name}}")
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list Docker volumes after the No-Go test"
}
foreach ($name in $volumeNames) {
    Assert-True ($existingAfter -notcontains $name) "bootstrap failure created forbidden dataset volume: $name"
}

[Console]::Out.WriteLine("PASS RepoFixLab wrapper help, parameter rejection, build-arg ordering, label-drift rejection, failed provenance safety, and real bootstrap zero-volume No-Go")
