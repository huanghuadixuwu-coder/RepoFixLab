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
Assert-True ($help.Output.Contains("run m1")) "--help must describe the frozen M1 Docker entry point"
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

$invalidM1Config = Invoke-Wrapper @("run", "m1", "--config", "configs/experiments/v1.yaml")
Assert-True ($invalidM1Config.ExitCode -eq 2) "run m1 must reject a non-frozen experiment config before Docker"

$invalidM1Override = Invoke-Wrapper @("run", "m1", "--task", "axios__axios-4731")
Assert-True ($invalidM1Override.ExitCode -eq 2) "run m1 must reject task, volume, and model override options before Docker"

$previousZhipuApiKey = $env:ZHIPU_API_KEY
try {
    Remove-Item Env:ZHIPU_API_KEY -ErrorAction SilentlyContinue
    $missingM1Key = Invoke-Wrapper @("run", "m1")
    Assert-True ($missingM1Key.ExitCode -eq 2) "run m1 must reject a missing provider key before Docker"
    Assert-True ($missingM1Key.Output.Contains("non-empty host ZHIPU_API_KEY")) "missing M1 key rejection must name the host prerequisite"

    $env:ZHIPU_API_KEY = "   "
    $emptyM1Key = Invoke-Wrapper @("run", "m1")
    Assert-True ($emptyM1Key.ExitCode -eq 2) "run m1 must reject an empty provider key before Docker"
}
finally {
    $env:ZHIPU_API_KEY = $previousZhipuApiKey
}

function Get-M1HostRunSnapshot {
    param([Parameter(Mandatory = $true)][string]$Root)

    $snapshot = @{}
    if ([IO.Directory]::Exists($Root)) {
        foreach ($directory in Get-ChildItem -LiteralPath $Root -Directory) {
            $snapshot[$directory.FullName] = $true
        }
    }
    return $snapshot
}

function Get-NewM1HostRunDirectories {
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

$m1HostRunRoot = Join-Path $repositoryRoot "artifacts/m1-host-run"
$fakeM1Directory = Join-Path ([IO.Path]::GetTempPath()) "repofixlab-fake-m1-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($fakeM1Directory) | Out-Null
$fakeM1Log = Join-Path $fakeM1Directory "commands.log"
$fakeM1SecretPath = Join-Path $fakeM1Directory "observed-secret-path.txt"
$fakeM1Residue = Join-Path $fakeM1Directory "runner-residue.txt"
$fakeM1PermissionState = Join-Path $fakeM1Directory "public-permission.state"
$fakeM1Script = Join-Path $fakeM1Directory "fake-docker.ps1"
$fakeM1Source = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::AppendAllText($env:REPOFIX_FAKE_M1_LOG, (($args -join " ") + "`n"), $utf8)
if (-not [String]::IsNullOrEmpty($env:ZHIPU_API_KEY)) {
    [Console]::Error.WriteLine("M1 fake Docker inherited the forbidden plaintext host secret")
    exit 93
}
$secretPath = $env:REPOFIX_ZHIPU_SECRET_FILE
if ([String]::IsNullOrWhiteSpace($secretPath) -or -not [IO.Path]::IsPathRooted($secretPath) -or -not [IO.File]::Exists($secretPath)) {
    [Console]::Error.WriteLine("M1 file-backed secret is missing during Docker execution")
    exit 94
}
$secretHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $secretPath).Hash.ToLowerInvariant()
if ($secretHash -cne $env:REPOFIX_FAKE_M1_SECRET_SHA256) {
    [Console]::Error.WriteLine("M1 file-backed secret content drifted")
    exit 95
}
[IO.File]::WriteAllText($env:REPOFIX_FAKE_M1_SECRET_PATH, $secretPath, $utf8)
$command = $args -join " "
$controllerHash = "a" * 64
$orchestratorHash = "b" * 64
if ($command -ceq "compose -f compose.yaml --profile m1 --profile dataset-prepare config --format json") {
    $controller = [ordered]@{
        environment = [ordered]@{
            REPOFIXLAB_COMPOSE_PROJECT = "repofixlab"
            REPOFIXLAB_FACTORY_CANDIDATE_DIR = "/etc/repofixlab/candidates"
        }
        networks = [ordered]@{ "repofix-control" = $null }
        volumes = @(
            [ordered]@{ type = "bind"; source = "/var/run/docker.sock"; target = "/var/run/docker.sock" },
            [ordered]@{ type = "volume"; source = "controller-work-v2"; target = "/var/lib/repofix/controller" },
            [ordered]@{ type = "volume"; source = "controller-candidates-v1"; target = "/etc/repofixlab/candidates"; read_only = $true }
        )
    }
    if ($env:REPOFIX_FAKE_M1_MODE -ceq "controller-secret") {
        $controller.environment["ZHIPU_API_KEY"] = "forbidden"
        $controller["secrets"] = @([ordered]@{ source = "zhipu_api_key"; target = "/run/secrets/zhipu_api_key" })
    }
    $publicVolume = [ordered]@{
        type = "volume"
        source = "dataset-public"
        target = "/data/public"
        read_only = $true
    }
    if ($env:REPOFIX_FAKE_M1_MODE -ceq "public-writable") {
        $publicVolume.read_only = $false
    }
    [ordered]@{
        name = "repofixlab"
        networks = [ordered]@{
            "provider-egress" = [ordered]@{ name = "repofixlab_provider-egress" }
            "repofix-control" = [ordered]@{ name = "repofixlab_repofix-control"; internal = $true }
        }
        secrets = [ordered]@{
            zhipu_api_key = [ordered]@{ name = "repofixlab_zhipu_api_key"; file = $secretPath }
        }
        services = [ordered]@{
            controller = $controller
            orchestrator = [ordered]@{
                image = "repofixlab-orchestrator"
                environment = [ordered]@{
                    REPOFIX_ARTIFACTS_PATH = "/artifacts"
                    REPOFIX_CONTROLLER_URL = "http://controller:8000"
                }
                networks = [ordered]@{ "provider-egress" = $null; "repofix-control" = $null }
                volumes = @([ordered]@{ type = "bind"; source = "E:\pi\artifacts"; target = "/artifacts" })
            }
            "m1-runner" = [ordered]@{
                profiles = @("m1")
                image = "repofixlab-orchestrator"
                user = "node"
                read_only = $true
                cap_drop = @("ALL")
                security_opt = @("no-new-privileges:true")
                depends_on = [ordered]@{ controller = [ordered]@{ condition = "service_healthy"; required = $true } }
                environment = [ordered]@{
                    REPOFIX_ARTIFACTS_PATH = "/artifacts"
                    REPOFIX_CONTROLLER_URL = "http://controller:8000"
                    REPOFIX_DATASET_PUBLIC_PATH = "/data/public"
                    ZHIPU_API_KEY_FILE = "/run/secrets/zhipu_api_key"
                }
                networks = [ordered]@{ "provider-egress" = $null; "repofix-control" = $null }
                secrets = @([ordered]@{ source = "zhipu_api_key"; target = "/run/secrets/zhipu_api_key" })
                volumes = @(
                    [ordered]@{ type = "bind"; source = "E:\pi\artifacts"; target = "/artifacts" },
                    $publicVolume
                )
            }
        }
        volumes = [ordered]@{
            "controller-candidates-v1" = [ordered]@{ name = "repofixlab_controller-candidates-v1" }
            "controller-work-v2" = [ordered]@{ name = "repofixlab_controller-work-v2" }
            "dataset-public" = [ordered]@{ name = $env:REPOFIX_PUBLIC_VOLUME }
            "dataset-control" = [ordered]@{ name = $env:REPOFIX_CONTROL_VOLUME }
            "dataset-private" = [ordered]@{ name = $env:REPOFIX_PRIVATE_VOLUME }
        }
    } | ConvertTo-Json -Depth 12
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
if ($args.Count -eq 3 -and $args[0] -ceq "volume" -and $args[1] -ceq "inspect") {
    [Console]::Out.WriteLine("[]")
    exit 0
}
if ($args.Count -eq 4 -and $args[0] -ceq "image" -and $args[1] -ceq "inspect" -and $args[2] -ceq "--format={{.Id}}") {
    if ($args[3] -ceq "repofixlab-axios-5892-worker-sanitized:v1") {
        [Console]::Out.WriteLine("sha256:2ebfd777d35cc2126d4c072b9a47cae7efc05062d2b762f6b052de9dc2aa9457")
        exit 0
    }
    if ($args[3] -ceq "repofixlab-axios-5892-sanitized:v1") {
        [Console]::Out.WriteLine("sha256:1ec1230faa109d7d89c819740cc8f9daa6c80dade0e30e5a91834fa20feb54f1")
        exit 0
    }
}
if ($args.Count -eq 3 -and $args[0] -ceq "image" -and $args[1] -ceq "inspect") {
    $composeHash = if ($args[2] -ceq "repofixlab-controller") {
        $controllerHash
    }
    elseif ($args[2] -ceq "repofixlab-orchestrator") {
        $orchestratorHash
    }
    else {
        $null
    }
    if ($null -ne $composeHash) {
        @([ordered]@{
            Config = [ordered]@{
                Labels = [ordered]@{ "io.repofixlab.compose-config-sha256" = $composeHash }
            }
        }) | ConvertTo-Json -Depth 6
        exit 0
    }
}
$permissionScript = "/workspace/packages/repofixlab/docker/public-volume-permissions.mjs"
if ($args -contains $permissionScript) {
    $action = [string]$args[$args.Count - 1]
    if ($action -ceq "audit") {
        if (
            $env:REPOFIX_FAKE_M1_MODE -in @("legacy-normalize", "normalize-failure") -and
            -not [IO.File]::Exists($env:REPOFIX_FAKE_M1_PERMISSION_STATE)
        ) {
            [Console]::Error.WriteLine("intentional legacy public permission mode")
            exit 61
        }
        [ordered]@{
            schema_version = "v1"; status = "pass"; aggregate_sha256 = "e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55"
            action = "audit"; files = 47
        } | ConvertTo-Json -Compress
        exit 0
    }
    if ($action -ceq "normalize") {
        if ($env:REPOFIX_FAKE_M1_MODE -ceq "normalize-failure") {
            [Console]::Error.WriteLine("intentional public permission normalization failure")
            exit 62
        }
        [IO.File]::WriteAllText($env:REPOFIX_FAKE_M1_PERMISSION_STATE, "normalized", $utf8)
        [ordered]@{
            schema_version = "v1"; status = "pass"; aggregate_sha256 = "e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55"
            action = "normalize"; files = 47
        } | ConvertTo-Json -Compress
        exit 0
    }
}
$privatePermissionScript = "/workspace/packages/repofixlab/docker/private-volume-permissions.mjs"
if ($args -contains $privatePermissionScript) {
    $action = [string]$args[$args.Count - 1]
    if ($action -ceq "audit") {
        [ordered]@{
            schema_version = "v1"; status = "pass"; aggregate_sha256 = "e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55"
            action = "audit"; files = 47
        } | ConvertTo-Json -Compress
        exit 0
    }
    if ($action -ceq "normalize") {
        [ordered]@{
            schema_version = "v1"; status = "pass"; aggregate_sha256 = "e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55"
            action = "normalize"; files = 47
        } | ConvertTo-Json -Compress
        exit 0
    }
}
$cleanupPrefix = "container ls --all --quiet --filter label=com.docker.compose.project=repofixlab --filter label=com.docker.compose.service=m1-runner --filter label=com.docker.compose.oneoff=True --filter status="
if ($command.StartsWith($cleanupPrefix, [StringComparison]::Ordinal)) {
    $status = $command.Substring($cleanupPrefix.Length)
    if ($status -notin @("created", "exited", "dead")) {
        exit 96
    }
    if ($status -ceq "created" -and [IO.File]::Exists($env:REPOFIX_FAKE_M1_RESIDUE)) {
        [Console]::Out.WriteLine(([IO.File]::ReadAllText($env:REPOFIX_FAKE_M1_RESIDUE, $utf8)).Trim())
    }
    exit 0
}
if ($args.Count -eq 3 -and $args[0] -ceq "container" -and $args[1] -ceq "inspect") {
    @([ordered]@{
        Id = $args[2]
        State = [ordered]@{ Status = "created"; ExitCode = 125 }
        Config = [ordered]@{ Labels = [ordered]@{
            "com.docker.compose.project" = "repofixlab"
            "com.docker.compose.service" = "m1-runner"
            "com.docker.compose.oneoff" = "True"
        } }
    }) | ConvertTo-Json -Depth 8
    exit 0
}
if ($args.Count -eq 4 -and $args[0] -ceq "container" -and $args[1] -ceq "rm" -and $args[2] -ceq "--force") {
    $expectedId = ([IO.File]::ReadAllText($env:REPOFIX_FAKE_M1_RESIDUE, $utf8)).Trim()
    if ($args[3] -cne $expectedId) {
        exit 97
    }
    [IO.File]::Delete($env:REPOFIX_FAKE_M1_RESIDUE)
    [Console]::Out.WriteLine($expectedId)
    exit 0
}
if ($command -ceq "compose -f compose.yaml --profile m1 up -d --wait controller") {
    exit 0
}
if ($command -ceq "compose -f compose.yaml --profile m1 run --rm --no-deps --pull never m1-runner run --config configs/experiments/m1-axios.yaml") {
    if ($env:REPOFIX_FAKE_M1_MODE -in @("run-failure", "secret-create-failure")) {
        [IO.File]::WriteAllText($env:REPOFIX_FAKE_M1_RESIDUE, ("c" * 64), $utf8)
        if ($env:REPOFIX_FAKE_M1_MODE -ceq "secret-create-failure") {
            [Console]::Error.WriteLine("cannot create secret in read-only service m1-runner")
            exit 45
        }
        [Console]::Error.WriteLine("intentional M1 orchestrator failure")
        exit 47
    }
    [Console]::Out.WriteLine("M1 orchestrator completed")
    exit 0
}
[Console]::Error.WriteLine("Unexpected fake M1 Docker command: $command")
exit 91
'@
[IO.File]::WriteAllText($fakeM1Script, $fakeM1Source, (New-Object System.Text.UTF8Encoding($false)))
$fakeM1Command = @"
@echo off
"$powershell" -NoProfile -ExecutionPolicy Bypass -File "$fakeM1Script" %*
exit /b %ERRORLEVEL%
"@
[IO.File]::WriteAllText((Join-Path $fakeM1Directory "docker.cmd"), $fakeM1Command, (New-Object System.Text.UTF8Encoding($false)))

$previousPath = $env:PATH
$previousZhipuApiKey = $env:ZHIPU_API_KEY
$previousFakeM1Log = $env:REPOFIX_FAKE_M1_LOG
$previousFakeM1Mode = $env:REPOFIX_FAKE_M1_MODE
$previousFakeM1SecretSha256 = $env:REPOFIX_FAKE_M1_SECRET_SHA256
$previousFakeM1SecretPath = $env:REPOFIX_FAKE_M1_SECRET_PATH
$previousFakeM1Residue = $env:REPOFIX_FAKE_M1_RESIDUE
$previousFakeM1PermissionState = $env:REPOFIX_FAKE_M1_PERMISSION_STATE
$previousSecretFileEnvironment = $env:REPOFIX_ZHIPU_SECRET_FILE
try {
    $env:PATH = "$fakeM1Directory;$previousPath"
    $env:REPOFIX_FAKE_M1_LOG = $fakeM1Log
    $env:REPOFIX_FAKE_M1_SECRET_PATH = $fakeM1SecretPath
    $env:REPOFIX_FAKE_M1_RESIDUE = $fakeM1Residue
    $env:REPOFIX_FAKE_M1_PERMISSION_STATE = $fakeM1PermissionState
    $env:REPOFIX_ZHIPU_SECRET_FILE = "preserved-host-secret-file-setting"
    $secretSentinel = "repofixlab-m1-secret-sentinel-$([Guid]::NewGuid().ToString('N'))"
    $env:ZHIPU_API_KEY = $secretSentinel
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $secretDigest = $sha256.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($secretSentinel))
        $env:REPOFIX_FAKE_M1_SECRET_SHA256 = ([BitConverter]::ToString($secretDigest)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }

    foreach ($scenario in @(
        [pscustomobject]@{ Mode = ""; ExpectedExit = 0; ConfigOption = $true; LeavesResidue = $false },
        [pscustomobject]@{ Mode = "legacy-normalize"; ExpectedExit = 0; ConfigOption = $false; LeavesResidue = $false },
        [pscustomobject]@{ Mode = "run-failure"; ExpectedExit = 47; ConfigOption = $false; LeavesResidue = $true },
        [pscustomobject]@{ Mode = "secret-create-failure"; ExpectedExit = 45; ConfigOption = $false; LeavesResidue = $true }
    )) {
        [IO.File]::WriteAllText($fakeM1Log, "", (New-Object System.Text.UTF8Encoding($false)))
        Remove-Item -LiteralPath $fakeM1SecretPath, $fakeM1Residue, $fakeM1PermissionState -Force -ErrorAction SilentlyContinue
        $before = Get-M1HostRunSnapshot $m1HostRunRoot
        $env:REPOFIX_FAKE_M1_MODE = $scenario.Mode
        $arguments = @("run", "m1")
        if ($scenario.ConfigOption) {
            $arguments += @("--config", "configs/experiments/m1-axios.yaml")
        }
        $result = Invoke-Wrapper $arguments
        Assert-True ($result.ExitCode -eq $scenario.ExpectedExit) "run m1 must preserve the expected orchestrator result: $($scenario.Mode)"
        Assert-True (-not $result.Output.Contains($secretSentinel)) "run m1 output leaked the provider secret: $($scenario.Mode)"
        Assert-True ($env:ZHIPU_API_KEY -ceq $secretSentinel) "run m1 must not mutate the caller provider environment: $($scenario.Mode)"
        Assert-True ($env:REPOFIX_ZHIPU_SECRET_FILE -ceq "preserved-host-secret-file-setting") "run m1 must not mutate the caller secret-file environment: $($scenario.Mode)"
        Assert-True ([IO.File]::Exists($fakeM1SecretPath)) "fake Docker did not observe the file-backed secret: $($scenario.Mode)"
        $observedSecretPath = [IO.File]::ReadAllText($fakeM1SecretPath).Trim()
        $repositoryPrefix = "$($repositoryRoot.TrimEnd('\'))\"
        Assert-True (-not $observedSecretPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) "M1 secret file must be outside the workspace: $($scenario.Mode)"
        Assert-True (-not [IO.File]::Exists($observedSecretPath)) "M1 temporary secret file survived wrapper exit: $($scenario.Mode)"
        Assert-True (-not [IO.Directory]::Exists((Split-Path -Parent $observedSecretPath))) "M1 temporary secret directory survived wrapper exit: $($scenario.Mode)"
        Assert-True (-not [IO.File]::Exists($fakeM1Residue)) "M1 stopped one-off residue survived wrapper exit: $($scenario.Mode)"

        $newDirectories = @(Get-NewM1HostRunDirectories $m1HostRunRoot $before)
        Assert-True ($newDirectories.Count -eq 1) "run m1 must create one host audit directory: $($scenario.Mode)"
        $operationRoot = $newDirectories[0].FullName
        $commands = @([IO.File]::ReadAllLines($fakeM1Log))
        $commandText = $commands -join "`n"
        Assert-True (-not $commandText.Contains($secretSentinel)) "run m1 Docker argv leaked the provider secret: $($scenario.Mode)"
        Assert-True (-not $commandText.Contains("ZHIPU_API_KEY=")) "run m1 must not pass the provider secret through Docker argv: $($scenario.Mode)"
        $transcript = [IO.File]::ReadAllText((Join-Path $operationRoot "transcript.log"))
        Assert-True (-not $transcript.Contains($secretSentinel)) "run m1 transcript leaked the provider secret: $($scenario.Mode)"

        foreach ($volumeName in @(
            "dataset-public-g-20260718-135934-066a8f5b6f6b",
            "dataset-control-g-20260718-135934-066a8f5b6f6b",
            "dataset-private-g-20260718-135934-066a8f5b6f6b",
            "repofixlab_controller-candidates-v1"
        )) {
            Assert-True ($commands -contains "volume inspect $volumeName") "run m1 did not preflight the frozen volume: $volumeName"
        }
        $configIndex = [Array]::IndexOf($commands, "compose -f compose.yaml --profile m1 --profile dataset-prepare config --format json")
        $controllerHashIndex = [Array]::IndexOf($commands, "compose -f compose.yaml config --hash controller")
        $controllerBuildIndex = [Array]::IndexOf($commands, "compose -f compose.yaml build --build-arg REPOFIXLAB_COMPOSE_CONFIG_SHA256=$('a' * 64) controller")
        $orchestratorHashIndex = [Array]::IndexOf($commands, "compose -f compose.yaml config --hash orchestrator")
        $orchestratorBuildIndex = [Array]::IndexOf($commands, "compose -f compose.yaml build --build-arg REPOFIXLAB_COMPOSE_CONFIG_SHA256=$('b' * 64) orchestrator")
        $controllerUpIndex = [Array]::IndexOf($commands, "compose -f compose.yaml --profile m1 up -d --wait controller")
        $runnerCommand = "compose -f compose.yaml --profile m1 run --rm --no-deps --pull never m1-runner run --config configs/experiments/m1-axios.yaml"
        $runnerIndex = [Array]::IndexOf($commands, $runnerCommand)
        $permissionMount = "type=volume,source=dataset-public-g-20260718-135934-066a8f5b6f6b,target=/data/public"
        $privatePermissionMount = "type=volume,source=dataset-private-g-20260718-135934-066a8f5b6f6b,target=/data/private,readonly"
        $permissionPrefix = "run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 536870912 --memory-swap 536870912 --cpus 1"
        $permissionScript = "/workspace/packages/repofixlab/docker/public-volume-permissions.mjs"
        $privatePermissionScript = "/workspace/packages/repofixlab/docker/private-volume-permissions.mjs"
        $auditCommand = "$permissionPrefix --user 1000:1000 --mount $permissionMount,readonly --entrypoint node repofixlab-orchestrator $permissionScript audit"
        $normalizeCommand = "$permissionPrefix --user 65532:65532 --mount $permissionMount --entrypoint node repofixlab-orchestrator $permissionScript normalize"
        $privateAuditCommand = "$permissionPrefix --user 0:0 --mount $privatePermissionMount --entrypoint node repofixlab-orchestrator $privatePermissionScript audit"
        $auditIndices = @(
            for ($commandIndex = 0; $commandIndex -lt $commands.Count; $commandIndex++) {
                if ($commands[$commandIndex] -ceq $auditCommand) { $commandIndex }
            }
        )
        $normalizeIndices = @(
            for ($commandIndex = 0; $commandIndex -lt $commands.Count; $commandIndex++) {
                if ($commands[$commandIndex] -ceq $normalizeCommand) { $commandIndex }
            }
        )
        $orchestratorInspectIndex = [Array]::IndexOf($commands, "image inspect repofixlab-orchestrator")
        if ($scenario.Mode -ceq "legacy-normalize") {
            Assert-True ($auditIndices.Count -eq 2 -and $normalizeIndices.Count -eq 1) "legacy M1 volume must run audit, normalize, final audit exactly once"
            Assert-True ($orchestratorInspectIndex -lt $auditIndices[0] -and $auditIndices[0] -lt $normalizeIndices[0] -and $normalizeIndices[0] -lt $auditIndices[1] -and $auditIndices[1] -lt $controllerUpIndex) "legacy M1 permission migration order drifted"
        }
        else {
            Assert-True ($auditIndices.Count -eq 1 -and $normalizeIndices.Count -eq 0) "compliant M1 volume must receive one read-only audit and no write command"
            Assert-True ($orchestratorInspectIndex -lt $auditIndices[0] -and $auditIndices[0] -lt $controllerUpIndex) "compliant M1 permission audit order drifted"
        }
        $privateAuditIndices = @(
            for ($commandIndex = 0; $commandIndex -lt $commands.Count; $commandIndex++) {
                if ($commands[$commandIndex] -ceq $privateAuditCommand) { $commandIndex }
            }
        )
        Assert-True ($privateAuditIndices.Count -eq 1) "M1 private volume must receive one read-only evaluator audit"
        Assert-True ($auditIndices[$auditIndices.Count - 1] -lt $privateAuditIndices[0] -and $privateAuditIndices[0] -lt $controllerUpIndex) "M1 private permission audit order drifted"
        Assert-True (-not $auditCommand.Contains("dataset-control") -and -not $auditCommand.Contains("dataset-private")) "M1 audit must not mount control or private data"
        Assert-True (-not $normalizeCommand.Contains("dataset-control") -and -not $normalizeCommand.Contains("dataset-private")) "M1 normalization must not mount control or private data"
        Assert-True (
            $configIndex -ge 0 -and
            $configIndex -lt $controllerHashIndex -and $controllerHashIndex -lt $orchestratorHashIndex -and
            $orchestratorHashIndex -lt $controllerBuildIndex -and $controllerBuildIndex -lt $orchestratorBuildIndex -and
            $orchestratorBuildIndex -lt $controllerUpIndex -and $controllerUpIndex -lt $runnerIndex
        ) "run m1 Compose validation, provenance build, Controller health, and execution ordering drifted: $($scenario.Mode)"
        $cleanupCreatedCommand = "container ls --all --quiet --filter label=com.docker.compose.project=repofixlab --filter label=com.docker.compose.service=m1-runner --filter label=com.docker.compose.oneoff=True --filter status=created"
        $cleanupCreatedIndices = @(
            for ($commandIndex = 0; $commandIndex -lt $commands.Count; $commandIndex++) {
                if ($commands[$commandIndex] -ceq $cleanupCreatedCommand) {
                    $commandIndex
                }
            }
        )
        Assert-True ($cleanupCreatedIndices.Count -eq 2 -and $runnerIndex -lt $cleanupCreatedIndices[0] -and $cleanupCreatedIndices[0] -lt $cleanupCreatedIndices[1]) "run m1 must audit exact-label residue before and after cleanup: $($scenario.Mode)"
        foreach ($status in @("exited", "dead")) {
            $statusCommand = $cleanupCreatedCommand.Replace("status=created", "status=$status")
            Assert-True (@($commands | Where-Object { $_ -ceq $statusCommand }).Count -eq 2) "run m1 must audit $status one-off residue before and after cleanup: $($scenario.Mode)"
        }
        $inspectCommand = "container inspect $('c' * 64)"
        $removeCommand = "container rm --force $('c' * 64)"
        if ($scenario.LeavesResidue) {
            $inspectIndex = [Array]::IndexOf($commands, $inspectCommand)
            $removeIndex = [Array]::IndexOf($commands, $removeCommand)
            Assert-True ($cleanupCreatedIndices[0] -lt $inspectIndex -and $inspectIndex -lt $removeIndex -and $removeIndex -lt $cleanupCreatedIndices[1]) "M1 residue inspect/remove order drifted: $($scenario.Mode)"
        }
        else {
            Assert-True ($commands -notcontains $inspectCommand -and $commands -notcontains $removeCommand) "clean M1 run must not remove a container"
        }

        $composeConfig = [IO.File]::ReadAllText((Join-Path $operationRoot "compose-config.json")) | ConvertFrom-Json
        $runner = $composeConfig.services.'m1-runner'
        Assert-True ([string]$runner.environment.REPOFIX_DATASET_PUBLIC_PATH -ceq "/data/public") "m1-runner must receive the frozen public dataset path"
        Assert-True ([string]$runner.environment.ZHIPU_API_KEY_FILE -ceq "/run/secrets/zhipu_api_key") "m1-runner must receive only the provider secret file path"
        Assert-True ($null -eq $runner.environment.PSObject.Properties["ZHIPU_API_KEY"]) "m1-runner environment must not contain the provider secret value"
        $publicMount = @($runner.volumes | Where-Object { $_.target -ceq "/data/public" })
        Assert-True ($publicMount.Count -eq 1 -and [bool]$publicMount[0].read_only) "m1-runner public dataset mount must be read-only"
        Assert-True (@($runner.volumes | Where-Object { $_.target -in @("/data/control", "/data/private") }).Count -eq 0) "m1-runner must not mount control or private dataset volumes"
        Assert-True ([IO.Path]::GetFullPath([string]$composeConfig.secrets.zhipu_api_key.file) -ceq [IO.Path]::GetFullPath($observedSecretPath)) "M1 Compose secret must use the unique temporary file source"
        Assert-True ($null -eq $composeConfig.secrets.zhipu_api_key.PSObject.Properties["environment"]) "M1 Compose secret must not use an environment source"
        foreach ($serviceName in @("controller", "orchestrator")) {
            $service = $composeConfig.services.PSObject.Properties[$serviceName].Value
            Assert-True ($null -eq $service.PSObject.Properties["secrets"]) "$serviceName must not receive the provider secret"
            Assert-True ($null -eq $service.environment.PSObject.Properties["ZHIPU_API_KEY"] -and $null -eq $service.environment.PSObject.Properties["ZHIPU_API_KEY_FILE"]) "$serviceName provider environment boundary drifted"
        }

        $operationResult = [IO.File]::ReadAllText((Join-Path $operationRoot "result.json")) | ConvertFrom-Json
        Assert-True ([int]$operationResult.orchestrator_exit_code -eq $scenario.ExpectedExit) "run m1 result must preserve the orchestrator exit code: $($scenario.Mode)"
        $expectedMigration = if ($scenario.Mode -ceq "legacy-normalize") { "normalized" } else { "already_compliant" }
        Assert-True ($operationResult.public_volume_permission_migration_status -ceq $expectedMigration) "run m1 result must record the public permission migration status: $($scenario.Mode)"
        Assert-True ($operationResult.private_volume_permission_migration_status -ceq "already_compliant") "run m1 result must record the private permission audit status: $($scenario.Mode)"
        Assert-True ($transcript.Contains("public_volume_permission_migration_status=$expectedMigration")) "run m1 transcript must record the public permission migration status: $($scenario.Mode)"
        Assert-True ($transcript.Contains("private_volume_permission_migration_status=already_compliant")) "run m1 transcript must record the private permission audit status: $($scenario.Mode)"
        Assert-True ([IO.File]::Exists((Join-Path $operationRoot "public-volume-first-audit.stdout.log")) -and [IO.File]::Exists((Join-Path $operationRoot "public-volume-first-audit.stderr.log"))) "run m1 must retain first public permission audit output: $($scenario.Mode)"
        Assert-True ([IO.File]::Exists((Join-Path $operationRoot "private-volume-first-audit.stdout.log")) -and [IO.File]::Exists((Join-Path $operationRoot "private-volume-first-audit.stderr.log"))) "run m1 must retain private permission audit output: $($scenario.Mode)"
        if ($scenario.Mode -ceq "legacy-normalize") {
            Assert-True ([IO.File]::Exists((Join-Path $operationRoot "public-volume-normalize.stdout.log")) -and [IO.File]::Exists((Join-Path $operationRoot "public-volume-normalize.stderr.log"))) "legacy M1 migration must retain normalization output"
            Assert-True ([IO.File]::Exists((Join-Path $operationRoot "public-volume-final-audit.stdout.log")) -and [IO.File]::Exists((Join-Path $operationRoot "public-volume-final-audit.stderr.log"))) "legacy M1 migration must retain final audit output"
        }
        else {
            Assert-True (-not [IO.File]::Exists((Join-Path $operationRoot "public-volume-normalize.stdout.log"))) "compliant M1 volume must not have normalization output"
        }
        Assert-True ($operationResult.runner_cleanup_status -ceq "pass" -and $operationResult.secret_cleanup_status -ceq "pass") "run m1 must record successful runner and secret cleanup: $($scenario.Mode)"
        $cleanupEvidence = [IO.File]::ReadAllText((Join-Path $operationRoot "m1-runner-cleanup.json")) | ConvertFrom-Json
        $expectedResidueCount = if ($scenario.LeavesResidue) { 1 } else { 0 }
        Assert-True (@($cleanupEvidence.before_container_ids).Count -eq $expectedResidueCount -and @($cleanupEvidence.after_container_ids).Count -eq 0) "M1 cleanup evidence did not prove zero residue: $($scenario.Mode)"
    }

    [IO.File]::WriteAllText($fakeM1Log, "", (New-Object System.Text.UTF8Encoding($false)))
    Remove-Item -LiteralPath $fakeM1SecretPath, $fakeM1Residue, $fakeM1PermissionState -Force -ErrorAction SilentlyContinue
    $before = Get-M1HostRunSnapshot $m1HostRunRoot
    $env:REPOFIX_FAKE_M1_MODE = "normalize-failure"
    $normalizeFailure = Invoke-Wrapper @("run", "m1")
    Assert-True ($normalizeFailure.ExitCode -eq 1) "M1 public permission normalization failure must fail closed"
    $normalizeFailureCommands = @([IO.File]::ReadAllLines($fakeM1Log))
    $firstAuditIndex = [Array]::IndexOf($normalizeFailureCommands, $auditCommand)
    $normalizeIndex = [Array]::IndexOf($normalizeFailureCommands, $normalizeCommand)
    Assert-True ($firstAuditIndex -ge 0 -and $firstAuditIndex -lt $normalizeIndex) "M1 normalization failure must follow the first read-only audit"
    Assert-True (@($normalizeFailureCommands | Where-Object { $_ -ceq $auditCommand }).Count -eq 1) "M1 normalization failure must not run a final audit"
    Assert-True (-not ($normalizeFailureCommands -contains "compose -f compose.yaml --profile m1 up -d --wait controller")) "M1 normalization failure must stop before Controller startup"
    Assert-True (-not ($normalizeFailureCommands -contains $runnerCommand)) "M1 normalization failure must stop before paid model execution"
    $newDirectories = @(Get-NewM1HostRunDirectories $m1HostRunRoot $before)
    Assert-True ($newDirectories.Count -eq 1) "M1 normalization failure must retain one host audit directory"
    $normalizeFailureRoot = $newDirectories[0].FullName
    $normalizeFailureResult = [IO.File]::ReadAllText((Join-Path $normalizeFailureRoot "result.json")) | ConvertFrom-Json
    Assert-True ($normalizeFailureResult.status -ceq "failed" -and $normalizeFailureResult.public_volume_permission_migration_status -ceq "failed") "M1 normalization failure result must record failed migration status"
    Assert-True ($null -eq $normalizeFailureResult.PSObject.Properties["orchestrator_exit_code"]) "M1 normalization failure must not record a model-run exit code"
    Assert-True ([IO.File]::Exists((Join-Path $normalizeFailureRoot "public-volume-first-audit.stdout.log")) -and [IO.File]::Exists((Join-Path $normalizeFailureRoot "public-volume-first-audit.stderr.log"))) "M1 normalization failure must retain first audit output"
    Assert-True ([IO.File]::Exists((Join-Path $normalizeFailureRoot "public-volume-normalize.stdout.log")) -and [IO.File]::Exists((Join-Path $normalizeFailureRoot "public-volume-normalize.stderr.log"))) "M1 normalization failure must retain normalization output"
    Assert-True (-not [IO.File]::Exists((Join-Path $normalizeFailureRoot "public-volume-final-audit.stdout.log"))) "M1 normalization failure must not fabricate final audit output"
    $normalizeFailureTranscript = [IO.File]::ReadAllText((Join-Path $normalizeFailureRoot "transcript.log"))
    Assert-True ($normalizeFailureTranscript.Contains("public_volume_permission_migration_status=failed")) "M1 normalization failure transcript must record failed migration status"
    Assert-True (-not $normalizeFailureTranscript.Contains($secretSentinel) -and -not (($normalizeFailureCommands -join "`n").Contains($secretSentinel))) "M1 normalization failure leaked the provider secret"
    Assert-True (-not [IO.File]::Exists($fakeM1Residue)) "M1 normalization failure left runner residue"

    foreach ($boundaryDrift in @("controller-secret", "public-writable")) {
        [IO.File]::WriteAllText($fakeM1Log, "", (New-Object System.Text.UTF8Encoding($false)))
        Remove-Item -LiteralPath $fakeM1SecretPath, $fakeM1Residue -Force -ErrorAction SilentlyContinue
        $before = Get-M1HostRunSnapshot $m1HostRunRoot
        $env:REPOFIX_FAKE_M1_MODE = $boundaryDrift
        $result = Invoke-Wrapper @("run", "m1")
        Assert-True ($result.ExitCode -ne 0) "run m1 must reject Compose boundary drift: $boundaryDrift"
        $commands = @([IO.File]::ReadAllLines($fakeM1Log))
        Assert-True ($commands.Count -eq 7 -and $commands[0] -ceq "compose -f compose.yaml --profile m1 --profile dataset-prepare config --format json") "M1 boundary drift must run only config validation plus exact-label cleanup: $boundaryDrift"
        foreach ($cleanupCommand in $commands[1..6]) {
            Assert-True ($cleanupCommand.StartsWith("container ls --all --quiet --filter label=com.docker.compose.project=repofixlab --filter label=com.docker.compose.service=m1-runner --filter label=com.docker.compose.oneoff=True --filter status=", [StringComparison]::Ordinal)) "M1 boundary drift invoked a forbidden post-validation Docker command: $boundaryDrift"
        }
        Assert-True (-not [IO.File]::Exists($fakeM1Residue)) "M1 boundary drift left stopped runner residue: $boundaryDrift"
        $observedSecretPath = [IO.File]::ReadAllText($fakeM1SecretPath).Trim()
        Assert-True (-not [IO.File]::Exists($observedSecretPath) -and -not [IO.Directory]::Exists((Split-Path -Parent $observedSecretPath))) "M1 boundary drift left temporary secret material: $boundaryDrift"
        Assert-True (-not (($commands -join "`n").Contains($secretSentinel))) "M1 boundary drift argv leaked the provider secret: $boundaryDrift"
        $newDirectories = @(Get-NewM1HostRunDirectories $m1HostRunRoot $before)
        Assert-True ($newDirectories.Count -eq 1) "M1 boundary drift must retain one audit directory: $boundaryDrift"
    }
}
finally {
    $env:PATH = $previousPath
    $env:ZHIPU_API_KEY = $previousZhipuApiKey
    $env:REPOFIX_FAKE_M1_LOG = $previousFakeM1Log
    $env:REPOFIX_FAKE_M1_MODE = $previousFakeM1Mode
    $env:REPOFIX_FAKE_M1_SECRET_SHA256 = $previousFakeM1SecretSha256
    $env:REPOFIX_FAKE_M1_SECRET_PATH = $previousFakeM1SecretPath
    $env:REPOFIX_FAKE_M1_RESIDUE = $previousFakeM1Residue
    $env:REPOFIX_FAKE_M1_PERMISSION_STATE = $previousFakeM1PermissionState
    $env:REPOFIX_ZHIPU_SECRET_FILE = $previousSecretFileEnvironment
    [IO.Directory]::Delete($fakeM1Directory, $true)
}
if ($env:REPOFIX_WRAPPER_TEST_SCOPE -ceq "m1") {
    [Console]::Out.WriteLine("PASS RepoFixLab M1 Docker entry-point fake wrapper regression")
    exit 0
}

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
