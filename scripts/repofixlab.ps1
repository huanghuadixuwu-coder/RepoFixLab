Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:CliArguments = @($args)
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:TranscriptWriter = $null

function Repair-ProcessPathEnvironment {
    $processEnvironment = [Environment]::GetEnvironmentVariables("Process")
    $pathNames = @($processEnvironment.Keys | Where-Object {
        [String]::Equals([string]$_, "PATH", [StringComparison]::OrdinalIgnoreCase)
    })
    if ($pathNames.Count -le 1) {
        return
    }

    $pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
    if ([String]::IsNullOrWhiteSpace($pathValue)) {
        throw "Process environment contains duplicate PATH entries but no usable PATH value"
    }
    [Environment]::SetEnvironmentVariable("Path", $null, "Process")
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

Repair-ProcessPathEnvironment

function Show-Usage {
    [Console]::Out.WriteLine("RepoFixLab host orchestration")
    [Console]::Out.WriteLine("")
    [Console]::Out.WriteLine("Usage:")
    [Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 dataset prepare [--config <path>] [--generation-id <id>]")
    [Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 dataset self-check [--config <path>]")
    [Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 images lock-input")
    [Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 images prepare-axios")
    [Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 run m1 [--config configs/experiments/m1-axios.yaml]")
	[Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 run m6 [--resume <m6 staging run>] [--secret-file <path>]")
	[Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 run m6 continue --source-report <sealed calibration report> [--resume <continuation staging run>] [--secret-file <path>]")
	[Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 run m7 [--secret-file <path>]")
    [Console]::Out.WriteLine("  .\scripts\repofixlab.ps1 --help")
}

function Stop-ForUsage {
    param([Parameter(Mandatory = $true)][string]$Message)

    [Console]::Error.WriteLine($Message)
    Show-Usage
    exit 2
}

function Resolve-ConfigPath {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$RequestedPath
    )

    if ([IO.Path]::IsPathRooted($RequestedPath)) {
        return [IO.Path]::GetFullPath($RequestedPath)
    }

    $repositoryCandidate = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $RequestedPath))
    if ([IO.File]::Exists($repositoryCandidate)) {
        return $repositoryCandidate
    }

    return [IO.Path]::GetFullPath((Join-Path (Join-Path $RepositoryRoot "packages/repofixlab") $RequestedPath))
}

function Read-FrozenDatasetConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($Path)) {
        throw "Dataset config does not exist: $Path"
    }

    $values = @{}
    $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($Path, $script:Utf8NoBom)) {
        $lineNumber++
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed -notmatch '^([a-z][a-z0-9_]*)\s*:\s*(\S(?:.*\S)?)$') {
            throw "Dataset config line $lineNumber must use the flat 'key: value' form"
        }
        $key = $Matches[1]
        $value = $Matches[2]
        if ($values.ContainsKey($key)) {
            throw "Dataset config contains duplicate key: $key"
        }
        $values[$key] = $value
    }

    $expected = [ordered]@{
        schema_version = "v1"
        dataset_name = "SWE-bench/SWE-bench_Multilingual"
        dataset_revision = "2b7aced941b4873e9cad3e76abbae93f481d1beb"
        source_url = "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual/resolve/2b7aced941b4873e9cad3e76abbae93f481d1beb/data/test-00000-of-00001.parquet"
        source_sha256 = "28b7f874e48496399077d276f9f2b163a077ddf0a70dc507c148d58da826baa9"
        source_bytes = "1165968"
        expected_record_count = "43"
        required_instance_id = "axios__axios-5892"
        volume_prefix = "dataset"
        compose_project = "repofixlab"
        preparer_service = "dataset-preparer"
    }

    foreach ($key in $values.Keys) {
        if (-not $expected.Contains($key)) {
            throw "Dataset config contains unknown key: $key"
        }
    }
    foreach ($entry in $expected.GetEnumerator()) {
        if (-not $values.ContainsKey($entry.Key)) {
            throw "Dataset config is missing required key: $($entry.Key)"
        }
        if ($values[$entry.Key] -cne $entry.Value) {
            throw "Dataset config value for $($entry.Key) does not match the frozen v1 protocol"
        }
    }

    return $values
}

function Read-FrozenAxiosTaskImageConfig {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not [IO.File]::Exists($Path)) {
        throw "Axios task-image config does not exist: $Path"
    }
    $values = @{}
    $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($Path, $script:Utf8NoBom)) {
        $lineNumber++
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed -notmatch '^([a-z][a-z0-9_]*)\s*:\s*(\S(?:.*\S)?)$') {
            throw "Axios task-image config line $lineNumber must use the flat 'key: value' form"
        }
        $key = $Matches[1]
        if ($values.ContainsKey($key)) {
            throw "Axios task-image config contains duplicate key: $key"
        }
        $values[$key] = $Matches[2]
    }

    $expected = [ordered]@{
        schema_version = "v1"
        image_key = "axios__axios-5892"
        requested_reference = "swebench/sweb.eval.x86_64.axios_1776_axios-5892:latest"
        source_repository_digest = "swebench/sweb.eval.x86_64.axios_1776_axios-5892@sha256:c03e6388d3615d639ce642b94fe1b9b5d86246fcb4fce2f97fbb1840848c51c8"
        platform = "linux/amd64"
        dataset_revision = "2b7aced941b4873e9cad3e76abbae93f481d1beb"
        harness_revision = "726c5461e2ef52d83cf1ea2107870a8bb3328d57"
        base_commit = "ae003913a39f3bdf9bbbd8f71a1ed681fd044d8b"
        evaluator_dockerfile_path = "packages/repofixlab/task-images/axios-5892/sanitized.Dockerfile"
        evaluator_dockerfile_sha256 = "25598941a4d5ede0b443e2a6c443478ddd6deb0a49bea4f9a167dcafd5065ed7"
        evaluator_provenance_sha256 = "e280b68d557aab18fb8bf87a0fff417b3efbf231a0dd7cda6e583dcf5ed4d4d6"
        evaluator_image_reference = "repofixlab-axios-5892-sanitized:v1"
        worker_dockerfile_path = "packages/repofixlab/task-images/axios-5892/worker-sanitized.Dockerfile"
        worker_dockerfile_sha256 = "9559993ba6fc3883c75da7571cc2d35047d0097270b244c5e26c1f386e62f415"
        worker_audit_path = "packages/repofixlab/task-images/axios-5892/audit-worker-image.sh"
        worker_audit_sha256 = "9fe866d467e72600f057952539f72baca93871a62bd895dca02cd5f275ac8164"
        worker_provenance_sha256 = "2753a0b780a86027745ce0f4655782b7ff91d0333c1e9836d027016a90224e2b"
        worker_image_reference = "repofixlab-axios-5892-worker-sanitized:v1"
        sanitizer_path = "packages/repofixlab/task-images/axios-5892/sanitize-git-history.sh"
        sanitizer_sha256 = "68ef77f59b38239a3863f9cb1669ecf2f3270d3148191a2bc7010f66e20712f6"
        role_probe_path = "packages/repofixlab/task-images/axios-5892/role-probe.mjs"
        role_probe_sha256 = "f66942a1754e328c22677c2096fd3fe8523dff39e2bb4c403adcfb142d91b775"
        test_command = "npx mocha test/unit/adapters/http.js -R tap -g compression"
    }
    foreach ($key in $values.Keys) {
        if (-not $expected.Contains($key)) {
            throw "Axios task-image config contains unknown key: $key"
        }
    }
    foreach ($entry in $expected.GetEnumerator()) {
        if (-not $values.ContainsKey($entry.Key)) {
            throw "Axios task-image config is missing required key: $($entry.Key)"
        }
        if ($values[$entry.Key] -cne $entry.Value) {
            throw "Axios task-image config value for $($entry.Key) does not match the frozen v1 protocol"
        }
    }
    foreach ($pathKey in @(
        "evaluator_dockerfile_path", "worker_dockerfile_path", "worker_audit_path", "sanitizer_path", "role_probe_path"
    )) {
        $fullPath = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $values[$pathKey]))
        $rootPrefix = $RepositoryRoot.TrimEnd("\") + "\"
        if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($fullPath)) {
            throw "Axios task-image input path is missing or escapes the repository: $($values[$pathKey])"
        }
    }
    return $values
}

function New-OperationDirectory {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $root = Join-Path $RepositoryRoot "artifacts/dataset-prepare"
    [IO.Directory]::CreateDirectory($root) | Out-Null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
        $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 12)
        $candidate = Join-Path $root "$timestamp-$suffix"
        try {
            [IO.Directory]::CreateDirectory($candidate) | Out-Null
            $entries = [IO.Directory]::GetFileSystemEntries($candidate)
            if ($entries.Count -eq 0) {
                return $candidate
            }
        }
        catch [IO.IOException] {
        }
    }
    throw "Unable to allocate a unique dataset preparation artifact directory"
}

function New-ProvenanceOperationDirectory {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $root = Join-Path $RepositoryRoot "artifacts/provenance"
    [IO.Directory]::CreateDirectory($root) | Out-Null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
        $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 12)
        $candidate = Join-Path $root "$timestamp-$suffix"
        try {
            [IO.Directory]::CreateDirectory($candidate) | Out-Null
            $entries = [IO.Directory]::GetFileSystemEntries($candidate)
            if ($entries.Count -eq 0) {
                return $candidate
            }
        }
        catch [IO.IOException] {
        }
    }
    throw "Unable to allocate a unique provenance artifact directory"
}

function New-DatasetSelfCheckOperationDirectory {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $root = Join-Path $RepositoryRoot "artifacts/dataset-self-check"
    [IO.Directory]::CreateDirectory($root) | Out-Null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
        $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 12)
        $candidate = Join-Path $root "$timestamp-$suffix"
        try {
            [IO.Directory]::CreateDirectory($candidate) | Out-Null
            $entries = [IO.Directory]::GetFileSystemEntries($candidate)
            if ($entries.Count -eq 0) {
                return $candidate
            }
        }
        catch [IO.IOException] {
        }
    }
    throw "Unable to allocate a unique Dataset Preparer self-check artifact directory"
}

function New-M1RunOperationDirectory {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $root = Join-Path $RepositoryRoot "artifacts/m1-host-run"
    [IO.Directory]::CreateDirectory($root) | Out-Null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
        $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 12)
        $candidate = Join-Path $root "$timestamp-$suffix"
        try {
            [IO.Directory]::CreateDirectory($candidate) | Out-Null
            if ([IO.Directory]::GetFileSystemEntries($candidate).Count -eq 0) {
                return $candidate
            }
        }
        catch [IO.IOException] {
        }
    }
    throw "Unable to allocate a unique M1 host-run artifact directory"
}

function New-TaskImageOperationPaths {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $root = Join-Path $RepositoryRoot "artifacts/task-images"
    [IO.Directory]::CreateDirectory($root) | Out-Null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $operationId = "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
        $stagingPath = Join-Path $root ".staging-$operationId"
        $finalPath = Join-Path $root $operationId
        if ([IO.Directory]::Exists($finalPath) -or [IO.Directory]::Exists($stagingPath)) {
            continue
        }
        try {
            [IO.Directory]::CreateDirectory($stagingPath) | Out-Null
            return [pscustomobject]@{
                OperationId = $operationId
                StagingPath = $stagingPath
                FinalPath = $finalPath
                ActiveRoot = Join-Path $root "active"
                ActiveLockPath = Join-Path (Join-Path $root "active") "official-image-source-lock.json"
            }
        }
        catch [IO.IOException] {
        }
    }
    throw "Unable to allocate a unique task-image operation directory"
}

function Write-TranscriptLine {
    param([Parameter(Mandatory = $true)][string]$Message)

    if ($null -eq $script:TranscriptWriter) {
        throw "Transcript writer is not initialized"
    }
    $script:TranscriptWriter.WriteLine("$([DateTime]::UtcNow.ToString('o')) $Message")
    $script:TranscriptWriter.Flush()
}

function Invoke-DockerCommand {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StandardOutputPath,
        [Parameter(Mandatory = $true)][string]$StandardErrorPath,
        [switch]$EchoOutput
    )

    if ([IO.File]::Exists($StandardOutputPath) -or [IO.File]::Exists($StandardErrorPath)) {
        throw "Refusing to overwrite command output for $Label"
    }
    Write-TranscriptLine "$Label start: docker $($Arguments -join ' ')"
    $process = Start-Process `
        -FilePath $DockerPath `
        -ArgumentList $Arguments `
        -WorkingDirectory $RepositoryRoot `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $StandardOutputPath `
        -RedirectStandardError $StandardErrorPath
    Write-TranscriptLine "$Label exit: $($process.ExitCode)"

    if ($EchoOutput) {
        $stdout = [IO.File]::ReadAllText($StandardOutputPath, $script:Utf8NoBom)
        $stderr = [IO.File]::ReadAllText($StandardErrorPath, $script:Utf8NoBom)
        if ($stdout.Length -gt 0) {
            [Console]::Out.Write($stdout)
        }
        if ($stderr.Length -gt 0) {
            [Console]::Error.Write($stderr)
        }
    }
    return [int]$process.ExitCode
}

function Invoke-DockerCommandAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StandardOutputPath,
        [Parameter(Mandatory = $true)][string]$StandardErrorPath,
        [switch]$EchoOutput
    )

    if ([IO.File]::Exists($StandardOutputPath) -or [IO.File]::Exists($StandardErrorPath)) {
        throw "Refusing to overwrite atomic command output for $Label"
    }
    $token = [Guid]::NewGuid().ToString("N")
    $stagedOutputPath = "$StandardOutputPath.$token.tmp"
    $stagedErrorPath = "$StandardErrorPath.$token.tmp"
    try {
        $exitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label $Label `
            -Arguments $Arguments `
            -StandardOutputPath $stagedOutputPath `
            -StandardErrorPath $stagedErrorPath `
            -EchoOutput:$EchoOutput
    }
    finally {
        if ([IO.File]::Exists($stagedOutputPath)) {
            [IO.File]::Move($stagedOutputPath, $StandardOutputPath)
        }
        if ([IO.File]::Exists($stagedErrorPath)) {
            [IO.File]::Move($stagedErrorPath, $StandardErrorPath)
        }
    }
    return [int]$exitCode
}

function Write-UniqueJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $json = ($Value | ConvertTo-Json -Depth 8) + "`n"
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $writer = New-Object IO.StreamWriter($stream, $script:Utf8NoBom)
        try {
            $writer.Write($json)
            $writer.Flush()
            $stream.Flush($true)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Write-AtomicUniqueJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    if ([IO.File]::Exists($Path)) {
        throw "Refusing to overwrite JSON artifact: $Path"
    }
    $stagedPath = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    Write-UniqueJson $stagedPath $Value
    [IO.File]::Move($stagedPath, $Path)
}

function Get-Sha256ForText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($script:Utf8NoBom.GetBytes($Value))
        return ([BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-CanonicalJson {
    param([Parameter(Mandatory = $true)][object]$Value)

    return (($Value | ConvertTo-Json -Depth 16 -Compress) + "`n")
}

function Get-CanonicalJsonSha256 {
    param([Parameter(Mandatory = $true)][object]$Value)

    return Get-Sha256ForText (Get-CanonicalJson $Value)
}

function Convert-DockerIgnorePatternToRegex {
    param([Parameter(Mandatory = $true)][string]$Pattern)

    $normalized = $Pattern.Replace("\", "/").TrimStart("/").TrimEnd("/")
    if ($normalized.Length -eq 0) {
        throw "Docker ignore pattern must not be empty"
    }
    $hasSlash = $normalized.Contains("/")
    $builder = New-Object Text.StringBuilder
    for ($index = 0; $index -lt $normalized.Length; $index++) {
        $character = $normalized[$index]
        if ($character -eq "*") {
            if ($index + 1 -lt $normalized.Length -and $normalized[$index + 1] -eq "*") {
                $index++
                if ($index + 1 -lt $normalized.Length -and $normalized[$index + 1] -eq "/") {
                    $index++
                    [void]$builder.Append("(?:.*/)?")
                }
                else {
                    [void]$builder.Append(".*")
                }
            }
            else {
                [void]$builder.Append("[^/]*")
            }
        }
        elseif ($character -eq "?") {
            [void]$builder.Append("[^/]")
        }
        else {
            [void]$builder.Append([Regex]::Escape([string]$character))
        }
    }
    $prefix = "^"
    if (-not $hasSlash) {
        $prefix += "(?:^|.*/)"
    }
    return "$prefix$($builder.ToString())(?:/.*)?$"
}

function Read-DockerIgnoreRules {
    param([Parameter(Mandatory = $true)][string]$ContextPath)

    $ignorePath = Join-Path $ContextPath ".dockerignore"
    if (-not [IO.File]::Exists($ignorePath)) {
        return @()
    }
    $rules = @()
    foreach ($rawLine in [IO.File]::ReadAllLines($ignorePath, $script:Utf8NoBom)) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $negated = $line.StartsWith("!")
        if ($negated) {
            $line = $line.Substring(1)
        }
        $rules += [pscustomobject]@{
            Negated = $negated
            Regex = Convert-DockerIgnorePatternToRegex $line
        }
    }
    return $rules
}

function Test-DockerIgnoredPath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][object[]]$Rules
    )

    $normalized = $RelativePath.Replace("\", "/")
    $ignored = $false
    foreach ($rule in $Rules) {
        if ([Regex]::IsMatch($normalized, $rule.Regex, [Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
            $ignored = -not $rule.Negated
        }
    }
    return $ignored
}

function Get-ContextRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$ContextPath,
        [Parameter(Mandatory = $true)][string]$FullPath
    )

    $contextPrefix = $ContextPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $FullPath.StartsWith($contextPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build input escapes its Docker context: $FullPath"
    }
    return $FullPath.Substring($contextPrefix.Length).Replace("\", "/")
}

function Add-BuildInputDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$ContextPath,
        [Parameter(Mandatory = $true)][string]$DirectoryPath,
        [Parameter(Mandatory = $true)][object[]]$IgnoreRules,
        [Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$Files
    )

    foreach ($entry in Get-ChildItem -LiteralPath $DirectoryPath -Force) {
        $fullPath = [IO.Path]::GetFullPath($entry.FullName)
        $relativePath = Get-ContextRelativePath $ContextPath $fullPath
        if (Test-DockerIgnoredPath $relativePath $IgnoreRules) {
            continue
        }
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to hash a reparse-point build input: $relativePath"
        }
        if ($entry.PSIsContainer) {
            Add-BuildInputDirectory $ContextPath $fullPath $IgnoreRules $Files
        }
        else {
            [void]$Files.Add($fullPath)
        }
    }
}

function Get-BuildInputEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$ContextPath,
        [Parameter(Mandatory = $true)][string]$DockerfilePath
    )

    $context = [IO.Path]::GetFullPath($ContextPath)
    $dockerfile = [IO.Path]::GetFullPath($DockerfilePath)
    if (-not [IO.Directory]::Exists($context) -or -not [IO.File]::Exists($dockerfile)) {
        throw "Docker build context or Dockerfile is missing"
    }
    $ignoreRules = @(Read-DockerIgnoreRules $context)
    $files = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $copyInstructionCount = 0
    foreach ($rawLine in [IO.File]::ReadAllLines($dockerfile, $script:Utf8NoBom)) {
        $line = $rawLine.Trim()
        if ($line -notmatch '^(?i:COPY)\s+(.+)$') {
            continue
        }
        $copyInstructionCount++
        $copyValue = $Matches[1].Trim()
        if ($copyValue.StartsWith("--") -or $copyValue.StartsWith("[") -or $copyValue.Contains("`$") -or $copyValue.Contains("*")) {
            throw "Unsupported Dockerfile COPY syntax for deterministic build-input hashing: $line"
        }
        $parts = @($copyValue -split '\s+' | Where-Object { $_.Length -gt 0 })
        if ($parts.Count -lt 2) {
            throw "Dockerfile COPY must contain at least one source and one destination"
        }
        foreach ($source in $parts[0..($parts.Count - 2)]) {
            $sourcePath = [IO.Path]::GetFullPath((Join-Path $context $source))
            $relativePath = Get-ContextRelativePath $context $sourcePath
            if (Test-DockerIgnoredPath $relativePath $ignoreRules) {
                throw "Dockerfile COPY source is excluded by .dockerignore: $source"
            }
            if ([IO.File]::Exists($sourcePath)) {
                $item = Get-Item -LiteralPath $sourcePath -Force
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Refusing to hash a reparse-point build input: $relativePath"
                }
                [void]$files.Add($sourcePath)
            }
            elseif ([IO.Directory]::Exists($sourcePath)) {
                Add-BuildInputDirectory $context $sourcePath $ignoreRules $files
            }
            else {
                throw "Dockerfile COPY source does not exist: $source"
            }
        }
    }
    if ($copyInstructionCount -eq 0 -or $files.Count -eq 0) {
        throw "Dockerfile has no hashable COPY build inputs"
    }

    $ignorePath = Join-Path $context ".dockerignore"
    if ([IO.File]::Exists($ignorePath)) {
        [void]$files.Add([IO.Path]::GetFullPath($ignorePath))
    }
    $sortedFiles = [string[]]@($files)
    [Array]::Sort($sortedFiles, [StringComparer]::Ordinal)
    $manifest = @()
    $canonicalLines = New-Object 'Collections.Generic.List[string]'
    foreach ($file in $sortedFiles) {
        $relativePath = Get-ContextRelativePath $context $file
        $length = (Get-Item -LiteralPath $file).Length
        $sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifest += [ordered]@{
            path = $relativePath
            bytes = $length
            sha256 = $sha256
        }
        $canonicalLines.Add("$relativePath`0$length`0$sha256")
    }
    return [pscustomobject]@{
        Sha256 = Get-Sha256ForText (($canonicalLines -join "`n") + "`n")
        Manifest = $manifest
    }
}

function Read-SingleDockerInspection {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    try {
        $values = @([IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json)
    }
    catch {
        throw "$Description inspect output is not valid JSON"
    }
    if ($values.Count -ne 1) {
        throw "$Description inspect must return exactly one image"
    }
    return $values[0]
}

function Get-FixedBaseReference {
    param([Parameter(Mandatory = $true)][string]$DockerfilePath)

    $references = @()
    foreach ($rawLine in [IO.File]::ReadAllLines($DockerfilePath, $script:Utf8NoBom)) {
        if ($rawLine.Trim() -match '^(?i:FROM)\s+(?:--platform=\S+\s+)?([^\s]+)') {
            $references += $Matches[1]
        }
    }
    if ($references.Count -ne 1 -or $references[0] -notmatch '^([^\s@]+)@sha256:([a-f0-9]{64})$') {
        throw "Dockerfile must contain exactly one digest-pinned FROM instruction: $DockerfilePath"
    }
    return $references[0]
}

function Get-ComposeServiceHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Service
    )

    $line = [IO.File]::ReadAllText($Path, $script:Utf8NoBom).Trim()
    if ($line -notmatch "^$([Regex]::Escape($Service))\s+([a-f0-9]{64})$") {
        throw "Docker Compose returned an invalid config hash for $Service"
    }
    return $Matches[1]
}

function Get-ExpectedNetworks {
    param(
        [Parameter(Mandatory = $true)][object]$ComposeConfig,
        [Parameter(Mandatory = $true)][string]$Service
    )

    $serviceProperty = $ComposeConfig.services.PSObject.Properties[$Service]
    if ($null -eq $serviceProperty -or $null -eq $serviceProperty.Value.networks) {
        throw "Compose service $Service has no network configuration"
    }
    $networks = @()
    foreach ($networkProperty in $serviceProperty.Value.networks.PSObject.Properties) {
        $definitionProperty = $ComposeConfig.networks.PSObject.Properties[$networkProperty.Name]
        if ($null -eq $definitionProperty) {
            throw "Compose service $Service references an undefined network: $($networkProperty.Name)"
        }
        $internalProperty = $definitionProperty.Value.PSObject.Properties["internal"]
        $networks += [ordered]@{
            internal = ($null -ne $internalProperty -and [bool]$internalProperty.Value)
            logicalName = $networkProperty.Name
        }
    }
    if ($networks.Count -eq 0) {
        throw "Compose service $Service must lock at least one network"
    }
    return @($networks | Sort-Object logicalName)
}

function Get-AxiosRoleProvenancePayload {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Config,
        [Parameter(Mandatory = $true)][string]$SourceImageId,
        [Parameter(Mandatory = $true)][ValidateSet("worker", "evaluator")][string]$Role
    )

    $payload = [ordered]@{
        base_commit = $Config.base_commit
        dockerfile_sha256 = $Config["${Role}_dockerfile_sha256"]
        harness_revision = $Config.harness_revision
        instance_id = $Config.image_key
        role_probe_sha256 = $Config.role_probe_sha256
        sanitizer_sha256 = $Config.sanitizer_sha256
        schema_version = "v1"
        source_image_id = $SourceImageId
        source_repository_digest = $Config.source_repository_digest
    }
    if ($Role -ceq "worker") {
        $payload["worker_audit_sha256"] = $Config.worker_audit_sha256
    }
    return $payload
}

function Assert-AxiosTaskImageInputHashes {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][hashtable]$Config
    )

    foreach ($input in @(
        [pscustomobject]@{ PathKey = "evaluator_dockerfile_path"; HashKey = "evaluator_dockerfile_sha256" },
        [pscustomobject]@{ PathKey = "worker_dockerfile_path"; HashKey = "worker_dockerfile_sha256" },
        [pscustomobject]@{ PathKey = "worker_audit_path"; HashKey = "worker_audit_sha256" },
        [pscustomobject]@{ PathKey = "sanitizer_path"; HashKey = "sanitizer_sha256" },
        [pscustomobject]@{ PathKey = "role_probe_path"; HashKey = "role_probe_sha256" }
    )) {
        $path = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Config[$input.PathKey]))
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -cne $Config[$input.HashKey]) {
            throw "Axios task-image input hash drifted: $($Config[$input.PathKey])"
        }
    }
    foreach ($dockerfileKey in @("evaluator_dockerfile_path", "worker_dockerfile_path")) {
        $dockerfilePath = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Config[$dockerfileKey]))
        if ((Get-FixedBaseReference $dockerfilePath) -cne $Config.source_repository_digest) {
            throw "Axios role Dockerfile does not use the frozen source repository digest: $($Config[$dockerfileKey])"
        }
    }
}

function Assert-ExactStringSequence {
    param(
        [AllowEmptyCollection()][object[]]$Actual,
        [AllowEmptyCollection()][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $actualValues = @($Actual | ForEach-Object { [string]$_ })
    if ($actualValues.Count -ne $Expected.Count) {
        throw "$Description must contain the frozen ordered values"
    }
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if ($actualValues[$index] -cne $Expected[$index]) {
            throw "$Description must contain the frozen ordered values"
        }
    }
}

function Get-ImagePlatform {
    param([Parameter(Mandatory = $true)][object]$Image)

    return "$([string](Get-RequiredObjectProperty $Image 'Os' 'Image inspection'))/$([string](Get-RequiredObjectProperty $Image 'Architecture' 'Image inspection'))"
}

function Assert-AxiosSourceImageInspection {
    param(
        [Parameter(Mandatory = $true)][object]$Image,
        [Parameter(Mandatory = $true)][hashtable]$Config
    )

    $sourceImageId = [string](Get-RequiredObjectProperty $Image "Id" "Axios source image")
    if ($sourceImageId -notmatch '^sha256:[a-f0-9]{64}$') {
        throw "Axios source local image ID is not an exact SHA-256 ID"
    }
    if ((Get-ImagePlatform $Image) -cne $Config.platform) {
        throw "Axios source image platform must equal linux/amd64"
    }
    $sourceConfig = Get-RequiredObjectProperty $Image "Config" "Axios source image"
    Assert-ExactStringSequence @(Get-RequiredObjectProperty $sourceConfig "Env" "Axios source image config") @(
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TZ=Etc/UTC",
        "CHROME_BIN=/usr/bin/google-chrome",
        "CHROME_PATH=/usr/bin/google-chrome"
    ) "Axios source image environment"
    if (
        [string](Get-RequiredObjectProperty $sourceConfig "WorkingDir" "Axios source image config") -cne "/testbed" -or
        @(Get-RequiredObjectProperty $sourceConfig "Cmd" "Axios source image config").Count -ne 1 -or
        [string]$sourceConfig.Cmd[0] -cne "/bin/bash"
    ) {
        throw "Axios source image command or working directory drifted"
    }
    $repositoryDigests = @((Get-RequiredObjectProperty $Image "RepoDigests" "Axios source image") | ForEach-Object { [string]$_ })
    if ($repositoryDigests -notcontains $Config.source_repository_digest) {
        throw "Axios source image does not advertise the frozen repository digest"
    }
    $descriptor = Get-RequiredObjectProperty $Image "Descriptor" "Axios source image"
    $expectedDescriptorDigest = $Config.source_repository_digest.Substring($Config.source_repository_digest.IndexOf("@") + 1)
    $descriptorDigest = [string](Get-RequiredObjectProperty $descriptor "digest" "Axios source descriptor")
    $descriptorMediaType = [string](Get-RequiredObjectProperty $descriptor "mediaType" "Axios source descriptor")
    $descriptorSize = [Int64](Get-RequiredObjectProperty $descriptor "size" "Axios source descriptor")
    if ($descriptorDigest -cne $expectedDescriptorDigest -or $descriptorMediaType.Length -eq 0 -or $descriptorSize -lt 1) {
        throw "Axios source descriptor does not match the frozen repository digest"
    }
    return [ordered]@{
        descriptor_digest = $descriptorDigest
        descriptor_media_type = $descriptorMediaType
        descriptor_size = $descriptorSize
        repository_digest = $Config.source_repository_digest
        schema_version = "v1"
    }
}

function Get-RequiredAxiosImageLabel {
    param(
        [Parameter(Mandatory = $true)][object]$Image,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $config = Get-RequiredObjectProperty $Image "Config" "Axios role image"
    $labels = Get-RequiredObjectProperty $config "Labels" "Axios role image config"
    $property = $labels.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "Axios role image is missing required label: $Name"
    }
    return [string]$property.Value
}

function Assert-AxiosRoleImageInspection {
    param(
        [Parameter(Mandatory = $true)][object]$Image,
        [Parameter(Mandatory = $true)][object]$SourceImage,
        [Parameter(Mandatory = $true)][hashtable]$Config,
        [Parameter(Mandatory = $true)][ValidateSet("worker", "evaluator")][string]$Role
    )

    $roleImageId = [string](Get-RequiredObjectProperty $Image "Id" "Axios $Role image")
    if ($roleImageId -notmatch '^sha256:[a-f0-9]{64}$') {
        throw "Axios $Role local image ID is not an exact SHA-256 ID"
    }
    if ((Get-ImagePlatform $Image) -cne $Config.platform) {
        throw "Axios $Role image platform must equal linux/amd64"
    }
    $expectedLabels = [ordered]@{
        "io.repofixlab.base-commit" = $Config.base_commit
        "io.repofixlab.instance-id" = $Config.image_key
        "io.repofixlab.provenance-sha256" = $Config["${Role}_provenance_sha256"]
        "io.repofixlab.role-probe-sha256" = $Config.role_probe_sha256
        "io.repofixlab.sanitizer-sha256" = $Config.sanitizer_sha256
        "io.repofixlab.source-repository-digest" = $Config.source_repository_digest
    }
    if ($Role -ceq "worker") {
        $expectedLabels["io.repofixlab.role"] = "worker"
        $expectedLabels["io.repofixlab.worker-history-profile"] = "exact-base-shallow-single-commit-v1"
        $expectedLabels["io.repofixlab.worker-dockerfile-sha256"] = $Config.worker_dockerfile_sha256
        $expectedLabels["io.repofixlab.worker-audit-sha256"] = $Config.worker_audit_sha256
    }
    foreach ($entry in $expectedLabels.GetEnumerator()) {
        if ((Get-RequiredAxiosImageLabel $Image $entry.Key) -cne $entry.Value) {
            throw "Axios $Role image label drifted: $($entry.Key)"
        }
    }
    $roleConfig = Get-RequiredObjectProperty $Image "Config" "Axios $Role image"
    Assert-ExactStringSequence @(Get-RequiredObjectProperty $roleConfig "Env" "Axios $Role image config") @(
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TZ=Etc/UTC",
        "CHROME_BIN=/usr/bin/google-chrome",
        "CHROME_PATH=/usr/bin/google-chrome",
        "HOME=/tmp/repofixlab-home"
    ) "Axios $Role image environment"
    if (
        [string](Get-RequiredObjectProperty $roleConfig "WorkingDir" "Axios $Role image config") -cne "/testbed" -or
        @(Get-RequiredObjectProperty $roleConfig "Cmd" "Axios $Role image config").Count -ne 1 -or
        [string]$roleConfig.Cmd[0] -cne "/bin/bash"
    ) {
        throw "Axios $Role image command or working directory drifted"
    }
    $repositoryTags = @((Get-RequiredObjectProperty $Image "RepoTags" "Axios $Role image") | ForEach-Object { [string]$_ })
    if ($repositoryTags -notcontains $Config["${Role}_image_reference"]) {
        throw "Axios $Role image does not advertise its frozen local tag"
    }
    $sourceLayers = @((Get-RequiredObjectProperty (Get-RequiredObjectProperty $SourceImage "RootFS" "Axios source image") "Layers" "Axios source rootfs") | ForEach-Object { [string]$_ })
    $roleLayers = @((Get-RequiredObjectProperty (Get-RequiredObjectProperty $Image "RootFS" "Axios $Role image") "Layers" "Axios $Role rootfs") | ForEach-Object { [string]$_ })
    if ($sourceLayers.Count -eq 0 -or $roleLayers.Count -le $sourceLayers.Count) {
        throw "Axios $Role image rootfs does not extend the source image"
    }
    for ($index = 0; $index -lt $sourceLayers.Count; $index++) {
        if ($sourceLayers[$index] -cne $roleLayers[$index]) {
            throw "Axios $Role image rootfs does not preserve the source image prefix"
        }
    }
}

function Invoke-AxiosGitAuditCommand {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$ImageId,
        [Parameter(Mandatory = $true)][string]$ImageKind,
        [Parameter(Mandatory = $true)][string]$Metric,
        [Parameter(Mandatory = $true)][string[]]$CommandArguments,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[string]]$ContainerNames
    )

    $suffix = $OperationId.Substring($OperationId.Length - 12)
    $containerName = "repofixlab-axios-$ImageKind-$Metric-$suffix"
    $ContainerNames.Add($containerName)
    $arguments = @(
        "run", "--rm", "--name", $containerName,
        "--label", "io.repofixlab.operation=images-prepare-axios",
        "--label", "io.repofixlab.operation-id=$OperationId",
        "--platform", "linux/amd64",
        "--network", "none",
        "--read-only",
        "--user", "0:0",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "128",
        "--memory", "1073741824",
        "--memory-swap", "1073741824",
        "--cpus", "1",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=33554432",
        "--env", "HOME=/tmp/repofixlab-home",
        $ImageId
    ) + $CommandArguments
    $stdoutPath = Join-Path $OperationRoot "$ImageKind-audit-$Metric.stdout.log"
    $exitCode = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "$ImageKind-audit-$Metric" `
        -Arguments $arguments `
        -StandardOutputPath $stdoutPath `
        -StandardErrorPath (Join-Path $OperationRoot "$ImageKind-audit-$Metric.stderr.log")
    if ($exitCode -ne 0) {
        throw "Axios $ImageKind image Git audit command failed: $Metric"
    }
    return @([IO.File]::ReadAllLines($stdoutPath, $script:Utf8NoBom) | Where-Object { $_.Length -gt 0 })
}

function Invoke-AxiosImageGitAudit {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$ImageId,
        [Parameter(Mandatory = $true)][string]$ImageKind,
        [Parameter(Mandatory = $true)][string]$BaseCommit,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[string]]$ContainerNames
    )

    $gitPrefix = @("git", "-c", "safe.directory=/testbed", "-C", "/testbed")
    $head = @(Invoke-AxiosGitAuditCommand $DockerPath $RepositoryRoot $OperationRoot $OperationId $ImageId $ImageKind "head" ($gitPrefix + @("rev-parse", "HEAD")) $ContainerNames)
    $refs = @(Invoke-AxiosGitAuditCommand $DockerPath $RepositoryRoot $OperationRoot $OperationId $ImageId $ImageKind "refs" ($gitPrefix + @("for-each-ref", "--format=%(refname)")) $ContainerNames)
    $future = @(Invoke-AxiosGitAuditCommand $DockerPath $RepositoryRoot $OperationRoot $OperationId $ImageId $ImageKind "future" ($gitPrefix + @("rev-list", "HEAD..", "--all")) $ContainerNames)
    $issueHits = @(Invoke-AxiosGitAuditCommand $DockerPath $RepositoryRoot $OperationRoot $OperationId $ImageId $ImageKind "issue" ($gitPrefix + @("log", "--all", "--format=%H", "--grep=5892")) $ContainerNames)
    $unreachable = @(Invoke-AxiosGitAuditCommand $DockerPath $RepositoryRoot $OperationRoot $OperationId $ImageId $ImageKind "unreachable" ($gitPrefix + @("fsck", "--full", "--unreachable", "--no-reflogs")) $ContainerNames)
    $status = @(Invoke-AxiosGitAuditCommand $DockerPath $RepositoryRoot $OperationRoot $OperationId $ImageId $ImageKind "status" ($gitPrefix + @("status", "--porcelain")) $ContainerNames)
    if ($head.Count -ne 1 -or $head[0] -cne $BaseCommit) {
        throw "Axios $ImageKind image HEAD does not equal the frozen base commit"
    }
    return [ordered]@{
        future_commit_count = $future.Count
        head = $head[0]
        issue_hit_count = $issueHits.Count
        refs = $refs
        refs_count = $refs.Count
        status_entry_count = $status.Count
        unreachable_object_count = $unreachable.Count
    }
}

function Assert-AxiosEvaluatorGitAudit {
    param([Parameter(Mandatory = $true)][object]$Audit)

    if (
        [int]$Audit.refs_count -ne 1 -or
        @($Audit.refs).Count -ne 1 -or
        [string]$Audit.refs[0] -cne "refs/heads/repofixlab-base" -or
        [int]$Audit.future_commit_count -ne 0 -or
        [int]$Audit.issue_hit_count -ne 0 -or
        [int]$Audit.unreachable_object_count -ne 0 -or
        [int]$Audit.status_entry_count -ne 0
    ) {
        throw "Axios evaluator image failed the frozen Git leakage audit"
    }
}

function Invoke-AxiosWorkerRootAudit {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$ImageId,
        [Parameter(Mandatory = $true)][hashtable]$Config,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[string]]$ContainerNames
    )

    $suffix = $OperationId.Substring($OperationId.Length - 12)
    $containerName = "repofixlab-axios-worker-root-audit-$suffix"
    $ContainerNames.Add($containerName)
    $stdoutPath = Join-Path $OperationRoot "worker-root-audit.stdout.log"
    $exitCode = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "axios-worker-root-audit" `
        -Arguments @(
            "run", "--rm", "--name", $containerName,
            "--label", "io.repofixlab.operation=images-prepare-axios",
            "--label", "io.repofixlab.operation-id=$OperationId",
            "--label", "io.repofixlab.role=worker",
            "--platform", "linux/amd64",
            "--network", "none",
            "--read-only",
            "--user", "0:0",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true",
            "--pids-limit", "128",
            "--memory", "1073741824",
            "--memory-swap", "1073741824",
            "--cpus", "1",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=33554432",
            $ImageId,
            "/opt/repofixlab/audit-worker-image.sh", "/testbed"
        ) `
        -StandardOutputPath $stdoutPath `
        -StandardErrorPath (Join-Path $OperationRoot "worker-root-audit.stderr.log")
    if ($exitCode -ne 0) {
        throw "Axios worker root audit failed"
    }

    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($stdoutPath, $script:Utf8NoBom)) {
        if ($line -notmatch '^([a-z][a-z0-9_]*)=(\S+)$') {
            throw "Axios worker root audit output is malformed"
        }
        if ($values.ContainsKey($Matches[1])) {
            throw "Axios worker root audit output contains a duplicate key"
        }
        $values[$Matches[1]] = $Matches[2]
    }
    Assert-ExactStringSet @($values.Keys) @(
        "base_parent_present", "head", "reachable_commits", "reflog_entries", "refs", "remote_count",
        "shallow_boundary", "status", "tree", "unreachable_objects"
    ) "Axios worker root audit properties"
    if (
        $values.head -cne $Config.base_commit -or
        $values.tree -cne "d37c27531ee7d744f25932ad0cb20ecabbf202ff" -or
        $values.refs -cne "1" -or
        $values.reachable_commits -cne "1" -or
        $values.shallow_boundary -cne $Config.base_commit -or
        $values.base_parent_present -cne "false" -or
        $values.remote_count -cne "0" -or
        $values.reflog_entries -cne "0" -or
        $values.unreachable_objects -cne "0" -or
        $values.status -cne "pass"
    ) {
        throw "Axios worker root audit does not match the frozen shallow single-commit profile"
    }
    return [ordered]@{
        audit_script_sha256 = $Config.worker_audit_sha256
        base_parent_present = $false
        head = $values.head
        reachable_commit_count = 1
        reflog_entry_count = 0
        refs_count = 1
        remote_count = 0
        shallow_boundary = $values.shallow_boundary
        status = "pass"
        tree = $values.tree
        unreachable_object_count = 0
    }
}

function Get-OfficialImageSourceLockSemantics {
    param([Parameter(Mandatory = $true)][object]$Lock)

    $images = @($Lock.images)
    if ($images.Count -ne 1) {
        throw "OfficialImageSourceLock must contain exactly one Axios image"
    }
    $image = $images[0]
    return [ordered]@{
        dataset_revision = [string]$Lock.dataset_revision
        harness_revision = [string]$Lock.harness_revision
        images = @([ordered]@{
            image_key = [string]$image.image_key
            local_image_id = [string]$image.local_image_id
            platform = [string]$image.platform
            registry_response_sha256 = [string]$image.registry_response_sha256
            repository_digest = [string]$image.repository_digest
            requested_reference = [string]$image.requested_reference
        })
        lock_type = [string]$Lock.lock_type
        schema_version = [string]$Lock.schema_version
    }
}

function Assert-OfficialImageSourceLock {
    param(
        [Parameter(Mandatory = $true)][object]$Lock,
        [Parameter(Mandatory = $true)][hashtable]$Config
    )

    if ($Lock -is [Collections.IDictionary]) {
        $Lock = (($Lock | ConvertTo-Json -Depth 16 -Compress) | ConvertFrom-Json)
    }
    Assert-ExactStringSet @($Lock.PSObject.Properties.Name) @(
        "created_at", "dataset_revision", "harness_revision", "images", "lock_id", "lock_type", "schema_version", "seal_sha256"
    ) "OfficialImageSourceLock properties"
    $images = @($Lock.images)
    if ($images.Count -ne 1) {
        throw "OfficialImageSourceLock must contain exactly one image"
    }
    $image = $images[0]
    Assert-ExactStringSet @($image.PSObject.Properties.Name) @(
        "image_key", "local_image_id", "platform", "registry_response_sha256", "repository_digest", "requested_reference", "resolved_at"
    ) "OfficialImageSourceLock image properties"
    if (
        [string]$Lock.schema_version -cne "v1" -or
        [string]$Lock.lock_type -cne "official_image_source" -or
        [string]$Lock.dataset_revision -cne $Config.dataset_revision -or
        [string]$Lock.harness_revision -cne $Config.harness_revision -or
        [string]$image.image_key -cne $Config.image_key -or
        [string]$image.requested_reference -cne $Config.requested_reference -or
        [string]$image.repository_digest -cne $Config.source_repository_digest -or
        [string]$image.local_image_id -notmatch '^sha256:[a-f0-9]{64}$' -or
        [string]$image.platform -cne $Config.platform -or
        [string]$image.registry_response_sha256 -notmatch '^[a-f0-9]{64}$' -or
        [string]$Lock.lock_id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$' -or
        [string]$Lock.created_at -notmatch '^\d{4}-\d{2}-\d{2}T' -or
        [string]$image.resolved_at -notmatch '^\d{4}-\d{2}-\d{2}T'
    ) {
        throw "OfficialImageSourceLock does not match the frozen Axios v1 contract"
    }
    $semanticHash = Get-CanonicalJsonSha256 (Get-OfficialImageSourceLockSemantics $Lock)
    if ([string]$Lock.seal_sha256 -cne $semanticHash) {
        throw "OfficialImageSourceLock seal does not match its canonical semantics"
    }
    return $semanticHash
}

function Publish-ActiveOfficialImageSourceLock {
    param(
        [Parameter(Mandatory = $true)][string]$ActiveRoot,
        [Parameter(Mandatory = $true)][string]$ActiveLockPath,
        [Parameter(Mandatory = $true)][object]$Lock,
        [Parameter(Mandatory = $true)][hashtable]$Config
    )

    $expectedSemanticHash = Assert-OfficialImageSourceLock $Lock $Config
    [IO.Directory]::CreateDirectory($ActiveRoot) | Out-Null
    if ([IO.File]::Exists($ActiveLockPath)) {
        $existing = [IO.File]::ReadAllText($ActiveLockPath, $script:Utf8NoBom) | ConvertFrom-Json
        $existingSemanticHash = Assert-OfficialImageSourceLock $existing $Config
        if ($existingSemanticHash -cne $expectedSemanticHash) {
            throw "Active OfficialImageSourceLock semantic drift; refusing to overwrite"
        }
        return "idempotent"
    }
    $stagedPath = Join-Path $ActiveRoot ".official-image-source-lock.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        Write-UniqueJson $stagedPath $Lock
        try {
            [IO.File]::Move($stagedPath, $ActiveLockPath)
            return "created"
        }
        catch [IO.IOException] {
            if (-not [IO.File]::Exists($ActiveLockPath)) {
                throw
            }
            $existing = [IO.File]::ReadAllText($ActiveLockPath, $script:Utf8NoBom) | ConvertFrom-Json
            $existingSemanticHash = Assert-OfficialImageSourceLock $existing $Config
            if ($existingSemanticHash -cne $expectedSemanticHash) {
                throw "Concurrent OfficialImageSourceLock publication drifted; refusing to overwrite"
            }
            return "idempotent"
        }
    }
    finally {
        if ([IO.File]::Exists($stagedPath)) {
            [IO.File]::Delete($stagedPath)
        }
    }
}

function Invoke-AxiosValidationContainer {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$ImageId,
        [Parameter(Mandatory = $true)][string]$VolumeName,
        [Parameter(Mandatory = $true)][ValidateSet("worker", "evaluator")][string]$Role,
        [Parameter(Mandatory = $true)][string]$NamePart,
        [Parameter(Mandatory = $true)][string[]]$CommandArguments,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[string]]$ContainerNames,
        [hashtable]$Environment = @{}
    )

    $suffix = $OperationId.Substring($OperationId.Length - 12)
    $containerName = "repofixlab-axios-$Role-validation-$NamePart-$suffix"
    $ContainerNames.Add($containerName)
    $arguments = @(
        "run", "--rm", "--name", $containerName,
        "--label", "io.repofixlab.operation=images-prepare-axios",
        "--label", "io.repofixlab.operation-id=$OperationId",
        "--label", "io.repofixlab.role=$Role",
        "--platform", "linux/amd64",
        "--network", "none",
        "--read-only",
        "--user", "65532:65532",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "256",
        "--memory", "2147483648",
        "--memory-swap", "2147483648",
        "--cpus", "1",
        "--mount", "type=volume,source=$VolumeName,target=/testbed",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
        "--env", "HOME=/tmp/repofixlab-home"
    )
    foreach ($name in @($Environment.Keys | Sort-Object)) {
        $arguments += @("--env", "$name=$($Environment[$name])")
    }
    $arguments += @($ImageId)
    $arguments += $CommandArguments
    $stdoutPath = Join-Path $OperationRoot "$NamePart.stdout.log"
    $exitCode = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "axios-validation-$NamePart" `
        -Arguments $arguments `
        -StandardOutputPath $stdoutPath `
        -StandardErrorPath (Join-Path $OperationRoot "$NamePart.stderr.log")
    return [pscustomobject]@{ ExitCode = $exitCode; StandardOutputPath = $stdoutPath }
}

function Assert-AxiosRoleProbeOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Nonce,
        [Parameter(Mandatory = $true)][hashtable]$Config,
        [Parameter(Mandatory = $true)][ValidateSet("worker", "evaluator")][string]$Role
    )

    try {
        $report = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "Axios role probe output is not valid JSON"
    }
    Assert-ExactStringSet @($report.PSObject.Properties.Name) @(
        "docker_socket_paths_present", "errors", "nonce", "observed_base_commit", "observed_gid", "observed_uid",
        "probe_sha256", "probe_type", "schema_version", "sensitive_environment_names_present", "writable_path_roundtrip"
    ) "Axios role probe properties"
    if (
        [string]$report.schema_version -cne "v1" -or
        [string]$report.probe_type -cne "task_role_factory_active_probe" -or
        [string]$report.probe_sha256 -cne $Config.role_probe_sha256 -or
        [string]$report.nonce -cne $Nonce -or
        [int]$report.observed_uid -ne 65532 -or
        [int]$report.observed_gid -ne 65532 -or
        [string]$report.observed_base_commit -cne $Config.base_commit -or
        $report.writable_path_roundtrip -isnot [bool] -or
        -not [bool]$report.writable_path_roundtrip
    ) {
        throw "Axios $Role role probe identity or hard checks do not match the frozen runtime"
    }
    foreach ($name in @("docker_socket_paths_present", "sensitive_environment_names_present", "errors")) {
        $value = $report.PSObject.Properties[$name].Value
        if ($value -isnot [Array] -or @($value).Count -ne 0) {
            throw "Axios $Role role probe $name must be an empty array"
        }
    }
    return $report
}

function Invoke-AxiosTaskImageCleanup {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$OperationId
    )

    $filter = "label=io.repofixlab.operation-id=$OperationId"
    $containersPath = Join-Path $OperationRoot "cleanup-containers-before.txt"
    $containersExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "task-image-cleanup-container-list" `
        -Arguments @("container", "ls", "--all", "--filter", $filter, "--format", "{{.ID}}") `
        -StandardOutputPath $containersPath `
        -StandardErrorPath (Join-Path $OperationRoot "cleanup-containers-before.stderr.log")
    if ($containersExit -ne 0) {
        throw "Unable to enumerate temporary Axios task-image containers during cleanup"
    }
    $containerIds = @(Read-DockerNameSet $containersPath "Axios cleanup container list")
    if ($containerIds.Count -gt 0) {
        $removeExit = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "task-image-cleanup-container-remove" `
            -Arguments (@("container", "rm", "--force") + $containerIds) `
            -StandardOutputPath (Join-Path $OperationRoot "cleanup-container-remove.stdout.log") `
            -StandardErrorPath (Join-Path $OperationRoot "cleanup-container-remove.stderr.log")
        if ($removeExit -ne 0) {
            throw "Unable to remove temporary Axios task-image containers"
        }
    }

    $volumesPath = Join-Path $OperationRoot "cleanup-volumes-before.txt"
    $volumesExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "task-image-cleanup-volume-list" `
        -Arguments @("volume", "ls", "--filter", $filter, "--format", "{{.Name}}") `
        -StandardOutputPath $volumesPath `
        -StandardErrorPath (Join-Path $OperationRoot "cleanup-volumes-before.stderr.log")
    if ($volumesExit -ne 0) {
        throw "Unable to enumerate temporary Axios task-image volumes during cleanup"
    }
    $volumeNames = @(Read-DockerNameSet $volumesPath "Axios cleanup volume list")
    if ($volumeNames.Count -gt 0) {
        $removeExit = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "task-image-cleanup-volume-remove" `
            -Arguments (@("volume", "rm") + $volumeNames) `
            -StandardOutputPath (Join-Path $OperationRoot "cleanup-volume-remove.stdout.log") `
            -StandardErrorPath (Join-Path $OperationRoot "cleanup-volume-remove.stderr.log")
        if ($removeExit -ne 0) {
            throw "Unable to remove temporary Axios task-image volumes"
        }
    }

    foreach ($resource in @(
        [pscustomobject]@{ Kind = "container"; Format = "{{.ID}}" },
        [pscustomobject]@{ Kind = "volume"; Format = "{{.Name}}" }
    )) {
        $postPath = Join-Path $OperationRoot "cleanup-$($resource.Kind)s-after.txt"
        $postArguments = @($resource.Kind, "ls")
        if ($resource.Kind -ceq "container") {
            $postArguments += "--all"
        }
        $postArguments += @("--filter", $filter, "--format", $resource.Format)
        $postExit = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "task-image-cleanup-$($resource.Kind)-verify" `
            -Arguments $postArguments `
            -StandardOutputPath $postPath `
            -StandardErrorPath (Join-Path $OperationRoot "cleanup-$($resource.Kind)s-after.stderr.log")
        if ($postExit -ne 0 -or @(Read-DockerNameSet $postPath "Axios cleanup residual $($resource.Kind) list").Count -ne 0) {
            throw "Axios task-image cleanup left a temporary $($resource.Kind)"
        }
    }
}

function Invoke-ImagesPrepareAxios {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $configPath = Join-Path $RepositoryRoot "packages/repofixlab/task-images/axios-5892/v1.yaml"
    $config = Read-FrozenAxiosTaskImageConfig $RepositoryRoot $configPath
    Assert-AxiosTaskImageInputHashes $RepositoryRoot $config
    $paths = New-TaskImageOperationPaths $RepositoryRoot
    $operationRoot = $paths.StagingPath
    $operationId = $paths.OperationId
    $transcriptPath = Join-Path $operationRoot "transcript.log"
    $transcriptStream = New-Object IO.FileStream($transcriptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $script:TranscriptWriter = New-Object IO.StreamWriter($transcriptStream, $script:Utf8NoBom)
    $script:TranscriptWriter.AutoFlush = $true
    $dockerPath = $null
    $failureMessage = $null
    $containerNames = New-Object 'Collections.Generic.List[string]'
    $sourceImage = $null
    $sourceImageId = $null
    $evaluatorImage = $null
    $evaluatorImageId = $null
    $workerImage = $null
    $workerImageId = $null
    $evaluatorProvenancePayload = $null
    $workerProvenancePayload = $null
    $registryResponse = $null
    $sourceAudit = $null
    $evaluatorAudit = $null
    $workerAudit = $null
    $evaluatorRoleProbeReport = $null
    $workerRoleProbeReport = $null
    $testExitCode = $null
    try {
        Write-TranscriptLine "operation_id=$operationId"
        Write-TranscriptLine "config_sha256=$((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant())"
        Write-TranscriptLine "requested_reference_record_only=$($config.requested_reference)"
        Write-TranscriptLine "pull_reference=$($config.source_repository_digest)"
        Write-TranscriptLine "evaluator_provenance_sha256=$($config.evaluator_provenance_sha256)"
        Write-TranscriptLine "worker_provenance_sha256=$($config.worker_provenance_sha256)"
        $dockerPath = (Get-Command docker -ErrorAction Stop).Source

        $pullExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-source-pull-by-digest" `
            -Arguments @("pull", "--platform", "linux/amd64", $config.source_repository_digest) `
            -StandardOutputPath (Join-Path $operationRoot "source-pull.stdout.log") `
            -StandardErrorPath (Join-Path $operationRoot "source-pull.stderr.log") `
            -EchoOutput
        if ($pullExit -ne 0) {
            throw "Unable to pull the exact Axios source repository digest"
        }

        $sourceInspectPath = Join-Path $operationRoot "source-image-inspect.json"
        $sourceInspectExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-source-inspect" `
            -Arguments @("image", "inspect", $config.source_repository_digest) `
            -StandardOutputPath $sourceInspectPath `
            -StandardErrorPath (Join-Path $operationRoot "source-image-inspect.stderr.log")
        if ($sourceInspectExit -ne 0) {
            throw "Unable to inspect the exact Axios source image"
        }
        $sourceImage = Read-SingleDockerInspection $sourceInspectPath "Axios source image"
        $registryResponse = Assert-AxiosSourceImageInspection $sourceImage $config
        $sourceImageId = [string]$sourceImage.Id
        $evaluatorProvenancePayload = Get-AxiosRoleProvenancePayload $config $sourceImageId "evaluator"
        $workerProvenancePayload = Get-AxiosRoleProvenancePayload $config $sourceImageId "worker"
        if ((Get-CanonicalJsonSha256 $evaluatorProvenancePayload) -cne $config.evaluator_provenance_sha256) {
            throw "Axios evaluator canonical provenance hash does not match the frozen v1 value"
        }
        if ((Get-CanonicalJsonSha256 $workerProvenancePayload) -cne $config.worker_provenance_sha256) {
            throw "Axios worker canonical provenance hash does not match the frozen v1 value"
        }
        $registryResponseSha256 = Get-CanonicalJsonSha256 $registryResponse

        $sourceAudit = Invoke-AxiosImageGitAudit $dockerPath $RepositoryRoot $operationRoot $operationId $sourceImageId "source" $config.base_commit $containerNames

        $evaluatorBuildExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-evaluator-sanitized-build" `
            -Arguments @(
                "build", "--no-cache", "--pull=false", "--network", "none", "--platform", "linux/amd64",
                "--file", $config.evaluator_dockerfile_path,
                "--tag", $config.evaluator_image_reference,
                "--build-arg", "REPOFIXLAB_SANITIZER_SHA256=$($config.sanitizer_sha256)",
                "--build-arg", "REPOFIXLAB_ROLE_PROBE_SHA256=$($config.role_probe_sha256)",
                "--build-arg", "REPOFIXLAB_IMAGE_PROVENANCE_SHA256=$($config.evaluator_provenance_sha256)",
                "packages/repofixlab"
            ) `
            -StandardOutputPath (Join-Path $operationRoot "evaluator-build.stdout.log") `
            -StandardErrorPath (Join-Path $operationRoot "evaluator-build.stderr.log") `
            -EchoOutput
        if ($evaluatorBuildExit -ne 0) {
            throw "Axios evaluator sanitized image build failed"
        }

        $evaluatorInspectPath = Join-Path $operationRoot "evaluator-image-inspect.json"
        $evaluatorInspectExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-evaluator-inspect" `
            -Arguments @("image", "inspect", $config.evaluator_image_reference) `
            -StandardOutputPath $evaluatorInspectPath `
            -StandardErrorPath (Join-Path $operationRoot "evaluator-image-inspect.stderr.log")
        if ($evaluatorInspectExit -ne 0) {
            throw "Unable to inspect the Axios evaluator image"
        }
        $evaluatorImage = Read-SingleDockerInspection $evaluatorInspectPath "Axios evaluator image"
        Assert-AxiosRoleImageInspection $evaluatorImage $sourceImage $config "evaluator"
        $evaluatorImageId = [string]$evaluatorImage.Id
        $evaluatorAudit = Invoke-AxiosImageGitAudit $dockerPath $RepositoryRoot $operationRoot $operationId $evaluatorImageId "evaluator" $config.base_commit $containerNames
        Assert-AxiosEvaluatorGitAudit $evaluatorAudit

        $workerBuildExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-worker-sanitized-build" `
            -Arguments @(
                "build", "--no-cache", "--pull=false", "--network", "none", "--platform", "linux/amd64",
                "--file", $config.worker_dockerfile_path,
                "--tag", $config.worker_image_reference,
                "--build-arg", "REPOFIXLAB_SANITIZER_SHA256=$($config.sanitizer_sha256)",
                "--build-arg", "REPOFIXLAB_ROLE_PROBE_SHA256=$($config.role_probe_sha256)",
                "--build-arg", "REPOFIXLAB_WORKER_DOCKERFILE_SHA256=$($config.worker_dockerfile_sha256)",
                "--build-arg", "REPOFIXLAB_WORKER_AUDIT_SHA256=$($config.worker_audit_sha256)",
                "--build-arg", "REPOFIXLAB_IMAGE_PROVENANCE_SHA256=$($config.worker_provenance_sha256)",
                "packages/repofixlab"
            ) `
            -StandardOutputPath (Join-Path $operationRoot "worker-build.stdout.log") `
            -StandardErrorPath (Join-Path $operationRoot "worker-build.stderr.log") `
            -EchoOutput
        if ($workerBuildExit -ne 0) {
            throw "Axios worker sanitized image build failed"
        }

        $workerInspectPath = Join-Path $operationRoot "worker-image-inspect.json"
        $workerInspectExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-worker-inspect" `
            -Arguments @("image", "inspect", $config.worker_image_reference) `
            -StandardOutputPath $workerInspectPath `
            -StandardErrorPath (Join-Path $operationRoot "worker-image-inspect.stderr.log")
        if ($workerInspectExit -ne 0) {
            throw "Unable to inspect the Axios worker image"
        }
        $workerImage = Read-SingleDockerInspection $workerInspectPath "Axios worker image"
        Assert-AxiosRoleImageInspection $workerImage $sourceImage $config "worker"
        $workerImageId = [string]$workerImage.Id
        $workerAudit = Invoke-AxiosWorkerRootAudit $dockerPath $RepositoryRoot $operationRoot $operationId $workerImageId $config $containerNames

        $operationSuffix = $operationId.Substring($operationId.Length - 12)
        $validationRoles = @(
            [pscustomobject]@{
                Role = "worker"
                ImageId = $workerImageId
                VolumeName = "repofixlab-axios-worker-validation-$operationSuffix"
            },
            [pscustomobject]@{
                Role = "evaluator"
                ImageId = $evaluatorImageId
                VolumeName = "repofixlab-axios-evaluator-validation-$operationSuffix"
            }
        )
        $volumeListPath = Join-Path $operationRoot "validation-volumes-before.txt"
        $volumeListExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "axios-validation-volume-preflight" `
            -Arguments @("volume", "ls", "--format", "{{.Name}}") `
            -StandardOutputPath $volumeListPath `
            -StandardErrorPath (Join-Path $operationRoot "validation-volumes-before.stderr.log")
        if ($volumeListExit -ne 0) {
            throw "Unable to enumerate Axios validation volumes before creation"
        }
        $existingValidationVolumes = @(Read-DockerNameSet $volumeListPath "Axios validation volume preflight")
        foreach ($roleSpec in $validationRoles) {
            if ($existingValidationVolumes -contains $roleSpec.VolumeName) {
                throw "Axios $($roleSpec.Role) validation volume name is not fresh"
            }
            $volumeCreateExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "axios-$($roleSpec.Role)-validation-volume-create" `
                -Arguments @(
                    "volume", "create",
                    "--label", "io.repofixlab.operation=images-prepare-axios",
                    "--label", "io.repofixlab.operation-id=$operationId",
                    "--label", "io.repofixlab.role=$($roleSpec.Role)",
                    $roleSpec.VolumeName
                ) `
                -StandardOutputPath (Join-Path $operationRoot "$($roleSpec.Role)-validation-volume-create.stdout.log") `
                -StandardErrorPath (Join-Path $operationRoot "$($roleSpec.Role)-validation-volume-create.stderr.log")
            if ($volumeCreateExit -ne 0) {
                throw "Unable to create the independent Axios $($roleSpec.Role) validation volume"
            }

            foreach ($initialization in @(
                [pscustomobject]@{ Name = "seed"; Command = @("cp", "-a", "/testbed/.", "/repofix-volume/") },
                [pscustomobject]@{ Name = "chown"; Command = @("chown", "-R", "65532:65532", "/repofix-volume") }
            )) {
                $containerName = "repofixlab-axios-$($roleSpec.Role)-$($initialization.Name)-$operationSuffix"
                $containerNames.Add($containerName)
                $initializationSecurity = @("--cap-drop", "ALL")
                if ($initialization.Name -ceq "chown") {
                    $initializationSecurity += @("--cap-add", "CHOWN")
                }
                $initializeExit = Invoke-DockerCommand `
                    -DockerPath $dockerPath `
                    -RepositoryRoot $RepositoryRoot `
                    -Label "axios-$($roleSpec.Role)-validation-$($initialization.Name)" `
                    -Arguments (@(
                        "run", "--rm", "--name", $containerName,
                        "--label", "io.repofixlab.operation=images-prepare-axios",
                        "--label", "io.repofixlab.operation-id=$operationId",
                        "--label", "io.repofixlab.role=$($roleSpec.Role)",
                        "--platform", "linux/amd64", "--network", "none", "--read-only"
                    ) + $initializationSecurity + @(
                        "--security-opt", "no-new-privileges:true",
                        "--mount", "type=volume,source=$($roleSpec.VolumeName),target=/repofix-volume",
                        $roleSpec.ImageId
                    ) + $initialization.Command) `
                    -StandardOutputPath (Join-Path $operationRoot "$($roleSpec.Role)-validation-$($initialization.Name).stdout.log") `
                    -StandardErrorPath (Join-Path $operationRoot "$($roleSpec.Role)-validation-$($initialization.Name).stderr.log")
                if ($initializeExit -ne 0) {
                    throw "Axios $($roleSpec.Role) validation volume $($initialization.Name) failed"
                }
            }
        }

        foreach ($roleSpec in $validationRoles) {
            $nonce = [Guid]::NewGuid().ToString("N")
            $roleProbe = Invoke-AxiosValidationContainer `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -OperationRoot $operationRoot `
                -OperationId $operationId `
                -ImageId $roleSpec.ImageId `
                -VolumeName $roleSpec.VolumeName `
                -Role $roleSpec.Role `
                -NamePart "$($roleSpec.Role)-role-probe" `
                -CommandArguments @("node", "/opt/repofixlab/role-probe.mjs") `
                -ContainerNames $containerNames `
                -Environment @{
                    REPOFIX_ACTIVE_PROBE_NONCE = $nonce
                    REPOFIX_EXPECTED_BASE_COMMIT = $config.base_commit
                    REPOFIX_EXPECTED_PROBE_SHA256 = $config.role_probe_sha256
                    REPOFIX_ROLE = $roleSpec.Role
                }
            if ($roleProbe.ExitCode -ne 0) {
                throw "Axios $($roleSpec.Role) role probe failed"
            }
            $validatedProbe = Assert-AxiosRoleProbeOutput $roleProbe.StandardOutputPath $nonce $config $roleSpec.Role
            if ($roleSpec.Role -ceq "worker") {
                $workerRoleProbeReport = $validatedProbe
            }
            else {
                $evaluatorRoleProbeReport = $validatedProbe
            }
        }

        $test = Invoke-AxiosValidationContainer `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -OperationRoot $operationRoot `
            -OperationId $operationId `
            -ImageId $evaluatorImageId `
            -VolumeName $validationRoles[1].VolumeName `
            -Role "evaluator" `
            -NamePart "evaluator-locked-test" `
            -CommandArguments @("npx", "mocha", "test/unit/adapters/http.js", "-R", "tap", "-g", "compression") `
            -ContainerNames $containerNames
        $testExitCode = $test.ExitCode
        if ($testExitCode -ne 0) {
            throw "Frozen Axios test command failed with exit code $testExitCode"
        }
        foreach ($stabilityCheck in @(
            [pscustomobject]@{ Kind = "source"; Reference = $config.source_repository_digest; ExpectedId = $sourceImageId },
            [pscustomobject]@{ Kind = "evaluator"; Reference = $config.evaluator_image_reference; ExpectedId = $evaluatorImageId },
            [pscustomobject]@{ Kind = "worker"; Reference = $config.worker_image_reference; ExpectedId = $workerImageId }
        )) {
            $stabilityPath = Join-Path $operationRoot "$($stabilityCheck.Kind)-image-inspect-after.json"
            $stabilityExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "axios-$($stabilityCheck.Kind)-image-stability" `
                -Arguments @("image", "inspect", $stabilityCheck.Reference) `
                -StandardOutputPath $stabilityPath `
                -StandardErrorPath (Join-Path $operationRoot "$($stabilityCheck.Kind)-image-inspect-after.stderr.log")
            if ($stabilityExit -ne 0) {
                throw "Axios $($stabilityCheck.Kind) image reference changed during the operation"
            }
            $stableImage = Read-SingleDockerInspection $stabilityPath "Axios $($stabilityCheck.Kind) stable image"
            if ([string]$stableImage.Id -cne $stabilityCheck.ExpectedId) {
                throw "Axios $($stabilityCheck.Kind) image ID changed during the operation"
            }
            if ($stabilityCheck.Kind -ceq "source") {
                [void](Assert-AxiosSourceImageInspection $stableImage $config)
            }
            else {
                Assert-AxiosRoleImageInspection $stableImage $sourceImage $config $stabilityCheck.Kind
            }
        }
    }
    catch {
        $failureMessage = $_.Exception.Message
        if ($null -ne $script:TranscriptWriter) {
            Write-TranscriptLine "pipeline failure: $failureMessage"
        }
    }
    finally {
        if ($null -ne $dockerPath) {
            try {
                Invoke-AxiosTaskImageCleanup $dockerPath $RepositoryRoot $operationRoot $operationId
                Write-TranscriptLine "temporary container and volume cleanup verified"
            }
            catch {
                $cleanupMessage = $_.Exception.Message
                if ($null -eq $failureMessage) {
                    $failureMessage = $cleanupMessage
                }
                else {
                    $failureMessage = "$failureMessage; cleanup failure: $cleanupMessage"
                }
                Write-TranscriptLine "cleanup failure: $cleanupMessage"
            }
        }
    }

    if ($null -eq $failureMessage) {
        try {
            $resolvedAt = [DateTime]::UtcNow.ToString("o")
            $lock = [ordered]@{
                schema_version = "v1"
                lock_type = "official_image_source"
                lock_id = "pending"
                dataset_revision = $config.dataset_revision
                harness_revision = $config.harness_revision
                images = @([ordered]@{
                    image_key = $config.image_key
                    requested_reference = $config.requested_reference
                    repository_digest = $config.source_repository_digest
                    local_image_id = $sourceImageId
                    platform = $config.platform
                    registry_response_sha256 = $registryResponseSha256
                    resolved_at = $resolvedAt
                })
                seal_sha256 = "pending"
                created_at = $resolvedAt
            }
            $semanticHash = Get-CanonicalJsonSha256 (Get-OfficialImageSourceLockSemantics $lock)
            $lock.lock_id = "official-images-v1-axios-5892-$($semanticHash.Substring(0, 16))"
            $lock.seal_sha256 = $semanticHash
            [void](Assert-OfficialImageSourceLock $lock $config)

            Write-UniqueJson (Join-Path $operationRoot "registry-response.json") $registryResponse
            Write-UniqueJson (Join-Path $operationRoot "evaluator-provenance.json") ([ordered]@{
                schema_version = "v1"
                provenance_type = "sanitized_task_image"
                role = "evaluator"
                provenance_sha256 = $config.evaluator_provenance_sha256
                canonical_payload = $evaluatorProvenancePayload
            })
            Write-UniqueJson (Join-Path $operationRoot "worker-provenance.json") ([ordered]@{
                schema_version = "v1"
                provenance_type = "sanitized_task_image"
                role = "worker"
                provenance_sha256 = $config.worker_provenance_sha256
                canonical_payload = $workerProvenancePayload
            })
            Write-UniqueJson (Join-Path $operationRoot "source-audit.json") ([ordered]@{
                schema_version = "v1"
                audit_type = "axios_source_image"
                status = "pass"
                history = $sourceAudit
            })
            Write-UniqueJson (Join-Path $operationRoot "worker-audit.json") ([ordered]@{
                schema_version = "v1"
                audit_type = "axios_worker_task_image"
                status = "pass"
                history = $workerAudit
                role_probe = $workerRoleProbeReport
                probe_runtime = [ordered]@{
                    uid = 65532
                    gid = 65532
                    scope = "m0_image_preparation"
                }
                validation_volume = [ordered]@{
                    name = $validationRoles[0].VolumeName
                    role_label = "worker"
                    cleanup_verified = $true
                }
            })
            Write-UniqueJson (Join-Path $operationRoot "evaluator-audit.json") ([ordered]@{
                schema_version = "v1"
                audit_type = "axios_evaluator_task_image"
                status = "pass"
                history = $evaluatorAudit
                role_probe = $evaluatorRoleProbeReport
                probe_runtime = [ordered]@{
                    uid = 65532
                    gid = 65532
                    scope = "m0_image_preparation"
                    production_candidate_root_validation = "pending"
                }
                validation_volume = [ordered]@{
                    name = $validationRoles[1].VolumeName
                    role_label = "evaluator"
                    cleanup_verified = $true
                }
                locked_test = [ordered]@{ command = $config.test_command; exit_code = $testExitCode }
            })
            Write-UniqueJson (Join-Path $operationRoot "official-image-source-lock.json") $lock
            $activeMode = Publish-ActiveOfficialImageSourceLock $paths.ActiveRoot $paths.ActiveLockPath $lock $config
            Write-TranscriptLine "active_official_image_source_lock=$activeMode"
            Write-UniqueJson (Join-Path $operationRoot "result.json") ([ordered]@{
                schema_version = "v1"
                operation_type = "images_prepare_axios"
                status = "pass"
                source_local_image_id = $sourceImageId
                worker_local_image_id = $workerImageId
                evaluator_local_image_id = $evaluatorImageId
                worker_provenance_sha256 = $config.worker_provenance_sha256
                evaluator_provenance_sha256 = $config.evaluator_provenance_sha256
                worker_probe_runtime_user = "65532:65532"
                evaluator_probe_runtime_user = "65532:65532"
                evaluator_production_candidate_root_validation = "pending"
                official_image_source_lock_id = $lock.lock_id
                official_image_source_lock_semantic_sha256 = $semanticHash
                active_lock_publication = $activeMode
            })
        }
        catch {
            $failureMessage = $_.Exception.Message
            Write-TranscriptLine "publication failure: $failureMessage"
        }
    }
    if ($null -ne $failureMessage) {
        if (-not [IO.File]::Exists((Join-Path $operationRoot "result.json"))) {
            Write-UniqueJson (Join-Path $operationRoot "result.json") ([ordered]@{
                schema_version = "v1"
                operation_type = "images_prepare_axios"
                status = "failed"
                message = $failureMessage
            })
        }
    }
    $script:TranscriptWriter.Dispose()
    $script:TranscriptWriter = $null
    $transcriptStream.Dispose()
    try {
        [IO.Directory]::Move($paths.StagingPath, $paths.FinalPath)
    }
    catch {
        [Console]::Error.WriteLine("Unable to atomically publish task-image operation artifacts: $($_.Exception.Message)")
        return 1
    }
    if ($null -ne $failureMessage) {
        [Console]::Error.WriteLine("Axios task-image preparation failed: $failureMessage")
        [Console]::Error.WriteLine("Artifacts: $($paths.FinalPath)")
        return 1
    }
    [Console]::Out.WriteLine("Axios task image prepared and locked. Artifacts: $($paths.FinalPath)")
    return 0
}

function Invoke-ImagesLockInput {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $operationRoot = New-ProvenanceOperationDirectory $RepositoryRoot
    $operationId = Split-Path -Leaf $operationRoot
    $transcriptPath = Join-Path $operationRoot "transcript.log"
    $transcriptStream = New-Object IO.FileStream($transcriptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $script:TranscriptWriter = New-Object IO.StreamWriter($transcriptStream, $script:Utf8NoBom)
    $script:TranscriptWriter.AutoFlush = $true
    $previousDisableEnvFile = [Environment]::GetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "Process")
    [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "1", "Process")
    $candidatePath = Join-Path $operationRoot "unsigned-bootstrap-image-provenance-candidate.json"
    try {
        Write-TranscriptLine "operation_id=$operationId"
        Write-TranscriptLine "candidate_kind=unsigned_unverified_provenance_input"
        $dockerCommand = Get-Command docker -ErrorAction Stop
        $dockerPath = $dockerCommand.Source
        $composeFile = "compose.yaml"
        $composeConfigPath = Join-Path $operationRoot "compose-config.json"
        $configExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "compose-config" `
            -Arguments @("compose", "-f", $composeFile, "config", "--format", "json") `
            -StandardOutputPath $composeConfigPath `
            -StandardErrorPath (Join-Path $operationRoot "compose-config.stderr.log")
        if ($configExit -ne 0) {
            throw "Unable to read resolved Docker Compose configuration"
        }
        try {
            $composeConfig = [IO.File]::ReadAllText($composeConfigPath, $script:Utf8NoBom) | ConvertFrom-Json
        }
        catch {
            throw "Resolved Docker Compose configuration is not valid JSON"
        }
        $composeProject = [string]$composeConfig.name
        if ($composeProject -notmatch '^[a-z0-9][a-z0-9_-]*$') {
            throw "Resolved Docker Compose project name is invalid"
        }

        $composeHashes = [ordered]@{}
        foreach ($service in @("controller", "orchestrator")) {
            $composeHashPath = Join-Path $operationRoot "$service-compose-hash.txt"
            $composeHashExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "$service-compose-hash-before-build" `
                -Arguments @("compose", "-f", $composeFile, "config", "--hash", $service) `
                -StandardOutputPath $composeHashPath `
                -StandardErrorPath (Join-Path $operationRoot "$service-compose-hash.stderr.log")
            if ($composeHashExit -ne 0) {
                throw "Unable to read Docker Compose config hash for $service before build"
            }
            $composeHashes[$service] = Get-ComposeServiceHash $composeHashPath $service
            Write-TranscriptLine "$service compose config hash fixed before build: $($composeHashes[$service])"
        }
        foreach ($service in @("controller", "orchestrator")) {
            $buildExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "$service-image-build-with-compose-hash" `
                -Arguments @(
                    "compose", "-f", $composeFile, "build", "--build-arg",
                    "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$($composeHashes[$service])", $service
                ) `
                -StandardOutputPath (Join-Path $operationRoot "$service-build.stdout.log") `
                -StandardErrorPath (Join-Path $operationRoot "$service-build.stderr.log") `
                -EchoOutput
            if ($buildExit -ne 0) {
                throw "$service image build failed with exit code $buildExit"
            }
        }

        $candidateServices = [ordered]@{}
        $evidenceServices = [ordered]@{}
        foreach ($service in @("controller", "orchestrator")) {
            $serviceProperty = $composeConfig.services.PSObject.Properties[$service]
            if ($null -eq $serviceProperty -or $null -eq $serviceProperty.Value.build) {
                throw "Compose service $service has no build configuration"
            }
            $contextPath = [IO.Path]::GetFullPath([string]$serviceProperty.Value.build.context)
            $dockerfilePath = [IO.Path]::GetFullPath((Join-Path $contextPath ([string]$serviceProperty.Value.build.dockerfile)))
            $dockerfileSha256 = (Get-FileHash -LiteralPath $dockerfilePath -Algorithm SHA256).Hash.ToLowerInvariant()
            $buildInputs = Get-BuildInputEvidence $contextPath $dockerfilePath
            $manifestName = "$service-build-inputs.json"
            Write-UniqueJson (Join-Path $operationRoot $manifestName) ([ordered]@{
                schemaVersion = "repofixlab.build-input-manifest.v1"
                service = $service
                buildInputsSha256 = $buildInputs.Sha256
                files = $buildInputs.Manifest
            })
            $composeConfigSha256 = [string]$composeHashes[$service]

            $finalImageReference = "$composeProject-$service"
            $finalInspectPath = Join-Path $operationRoot "$service-final-image-inspect.json"
            $finalInspectExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "$service-final-image-inspect" `
                -Arguments @("image", "inspect", $finalImageReference) `
                -StandardOutputPath $finalInspectPath `
                -StandardErrorPath (Join-Path $operationRoot "$service-final-image-inspect.stderr.log")
            if ($finalInspectExit -ne 0) {
                throw "Unable to inspect final image for $service"
            }
            $finalImage = Read-SingleDockerInspection $finalInspectPath "$service final image"
            $finalImageId = [string]$finalImage.Id
            $finalPlatform = "$($finalImage.Os)/$($finalImage.Architecture)"
            $finalRootfs = @($finalImage.RootFS.Layers | ForEach-Object { [string]$_ })
            if ($finalImageId -notmatch '^sha256:[a-f0-9]{64}$' -or $finalPlatform -cne "linux/amd64" -or $finalRootfs.Count -eq 0) {
                throw "$service final image inspection is incomplete or not linux/amd64"
            }
            $labelsProperty = $finalImage.Config.PSObject.Properties["Labels"]
            $composeHashLabel = $null
            if ($null -ne $labelsProperty -and $null -ne $labelsProperty.Value) {
                $composeHashLabelProperty = $labelsProperty.Value.PSObject.Properties["io.repofixlab.compose-config-sha256"]
                if ($null -ne $composeHashLabelProperty) {
                    $composeHashLabel = [string]$composeHashLabelProperty.Value
                }
            }
            if ($composeHashLabel -cne $composeConfigSha256) {
                throw "$service final image Compose config label does not match the pre-build hash"
            }

            $baseReference = Get-FixedBaseReference $dockerfilePath
            $baseInspectPath = Join-Path $operationRoot "$service-base-image-inspect.json"
            $baseInspectExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "$service-base-image-inspect" `
                -Arguments @("image", "inspect", $baseReference) `
                -StandardOutputPath $baseInspectPath `
                -StandardErrorPath (Join-Path $operationRoot "$service-base-image-inspect.stderr.log")
            if ($baseInspectExit -ne 0) {
                throw "Unable to inspect digest-pinned base image for $service"
            }
            $baseImage = Read-SingleDockerInspection $baseInspectPath "$service base image"
            $baseImageId = [string]$baseImage.Id
            $basePlatform = "$($baseImage.Os)/$($baseImage.Architecture)"
            $baseRootfs = @($baseImage.RootFS.Layers | ForEach-Object { [string]$_ })
            $repositoryDigests = @($baseImage.RepoDigests | ForEach-Object { [string]$_ })
            $baseDigest = $baseReference.Substring($baseReference.IndexOf("@") + 1)
            $repositoryBeforeDigest = $baseReference.Substring(0, $baseReference.IndexOf("@"))
            $lastSlash = $repositoryBeforeDigest.LastIndexOf("/")
            $lastColon = $repositoryBeforeDigest.LastIndexOf(":")
            if ($lastColon -gt $lastSlash) {
                $repositoryBeforeDigest = $repositoryBeforeDigest.Substring(0, $lastColon)
            }
            $expectedRepositoryDigest = "$repositoryBeforeDigest@$baseDigest"
            if ($baseImageId -notmatch '^sha256:[a-f0-9]{64}$' -or $basePlatform -cne "linux/amd64" -or $baseRootfs.Count -eq 0) {
                throw "$service base image inspection is incomplete or not linux/amd64"
            }
            if ($repositoryDigests -notcontains $expectedRepositoryDigest) {
                throw "$service base image does not advertise the Dockerfile repository digest"
            }
            if ($finalRootfs.Count -lt $baseRootfs.Count) {
                throw "$service final image rootfs is shorter than its fixed base image"
            }
            for ($layerIndex = 0; $layerIndex -lt $baseRootfs.Count; $layerIndex++) {
                if ($finalRootfs[$layerIndex] -cne $baseRootfs[$layerIndex]) {
                    throw "$service final image rootfs does not extend its fixed base image"
                }
            }

            $expectedNetworks = @(Get-ExpectedNetworks $composeConfig $service)
            $candidateServices[$service] = [ordered]@{
                baseRepositoryDigest = $expectedRepositoryDigest
                buildInputsSha256 = $buildInputs.Sha256
                composeConfigSha256 = $composeConfigSha256
                dockerfileSha256 = $dockerfileSha256
                expectedBaseImageId = $baseImageId
                expectedImageId = $finalImageId
                expectedNetworks = $expectedNetworks
                platform = "linux/amd64"
            }
            $evidenceServices[$service] = [ordered]@{
                finalImage = [ordered]@{
                    reference = $finalImageReference
                    imageId = $finalImageId
                    platform = $finalPlatform
                    rootfsLayers = $finalRootfs
                    composeConfigSha256Label = $composeHashLabel
                }
                baseImage = [ordered]@{
                    reference = $baseReference
                    imageId = $baseImageId
                    repositoryDigest = $expectedRepositoryDigest
                    repositoryDigests = $repositoryDigests
                    platform = $basePlatform
                    rootfsLayers = $baseRootfs
                }
                composeConfigSha256 = $composeConfigSha256
                dockerfile = [ordered]@{
                    path = $dockerfilePath.Substring($RepositoryRoot.TrimEnd("\").Length + 1).Replace("\", "/")
                    sha256 = $dockerfileSha256
                }
                buildInputsSha256 = $buildInputs.Sha256
                buildInputManifest = $manifestName
                expectedNetworks = $expectedNetworks
            }
        }

        Write-UniqueJson (Join-Path $operationRoot "docker-image-observations.json") ([ordered]@{
            schemaVersion = "repofixlab.bootstrap-image-provenance-observation.v1"
            capturedAt = [DateTime]::UtcNow.ToString("o")
            composeProject = $composeProject
            services = $evidenceServices
        })
        Write-TranscriptLine "all source observations collected; writing unsigned candidate as final operation"
        $candidate = [ordered]@{
            schemaVersion = "repofixlab.bootstrap-image-provenance-lock.v1"
            lockType = "bootstrap_image_provenance"
            lockId = "bootstrap-images-$operationId"
            composeProject = $composeProject
            createdAt = [DateTime]::UtcNow.ToString("o")
            services = $candidateServices
        }
        $candidateStagingPath = Join-Path $operationRoot ".unsigned-bootstrap-image-provenance-candidate.tmp.json"
        Write-UniqueJson $candidateStagingPath $candidate
        [Console]::Out.WriteLine("Finalizing an unsigned, unapproved provenance candidate. Artifacts: $operationRoot")
        [IO.File]::Move($candidateStagingPath, $candidatePath)
        return 0
    }
    catch {
        $message = $_.Exception.Message
        $candidateStagingPath = Join-Path $operationRoot ".unsigned-bootstrap-image-provenance-candidate.tmp.json"
        if ([IO.File]::Exists($candidateStagingPath)) {
            [IO.File]::Delete($candidateStagingPath)
        }
        if ($null -ne $script:TranscriptWriter) {
            Write-TranscriptLine "failure before candidate creation: $message"
        }
        if ([IO.File]::Exists($candidatePath)) {
            throw "Invariant violation: failed provenance collection left a candidate file"
        }
        $resultPath = Join-Path $operationRoot "result.json"
        if (-not [IO.File]::Exists($resultPath)) {
            Write-UniqueJson $resultPath ([ordered]@{
                schemaVersion = "repofixlab.host-operation-result.v1"
                operationType = "images_lock_input"
                status = "failed_without_candidate"
                message = $message
            })
        }
        [Console]::Error.WriteLine("Image lock-input collection failed without creating a candidate: $message")
        [Console]::Error.WriteLine("Artifacts: $operationRoot")
        return 1
    }
    finally {
        try {
            [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", $previousDisableEnvFile, "Process")
        }
        catch {
        }
        try {
            if ($null -ne $script:TranscriptWriter) {
                $script:TranscriptWriter.Dispose()
                $script:TranscriptWriter = $null
            }
            $transcriptStream.Dispose()
        }
        catch {
        }
    }
}

function Get-RequiredObjectProperty {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "$Description is missing required property: $Name"
    }
    return $property.Value
}

function Assert-ExactStringSet {
    param(
        [AllowEmptyCollection()][object[]]$Actual,
        [AllowEmptyCollection()][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $actualValues = @($Actual | ForEach-Object { [string]$_ } | Sort-Object)
    $expectedValues = @($Expected | Sort-Object)
    if ($actualValues.Count -ne $expectedValues.Count) {
        throw "$Description must contain exactly: $($expectedValues -join ', ')"
    }
    for ($index = 0; $index -lt $expectedValues.Count; $index++) {
        if ($actualValues[$index] -cne $expectedValues[$index]) {
            throw "$Description must contain exactly: $($expectedValues -join ', ')"
        }
    }
}

function New-M1ProviderSecretFile {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$SecretValue
    )

    if ($SecretValue.Length -gt 4096 -or $SecretValue.Trim() -cne $SecretValue) {
        throw "ZHIPU_API_KEY must be at most 4096 characters and contain no leading or trailing whitespace"
    }
    foreach ($character in $SecretValue.ToCharArray()) {
        if ([char]::IsControl($character)) {
            throw "ZHIPU_API_KEY must not contain control characters"
        }
    }

    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $repositoryPath = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $secretDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot "repofixlab-m1-secret-$([Guid]::NewGuid().ToString('N'))"))
    $repositoryPrefix = "$repositoryPath$([IO.Path]::DirectorySeparatorChar)"
    if (
        $secretDirectory.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [String]::Equals($secretDirectory, $repositoryPath, [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "The host temporary directory resolves inside the RepoFixLab workspace"
    }

    [IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
    $secretPath = Join-Path $secretDirectory "zhipu_api_key"
    try {
        $secretBytes = $script:Utf8NoBom.GetBytes($SecretValue)
        $stream = New-Object IO.FileStream($secretPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stream.Write($secretBytes, 0, $secretBytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        return [pscustomobject]@{
            Directory = $secretDirectory
            Path = $secretPath
            Bytes = $secretBytes.Length
        }
    }
    catch {
        if ([IO.Directory]::Exists($secretDirectory)) {
            [IO.Directory]::Delete($secretDirectory, $true)
        }
        throw
    }
}

function Remove-M1ProviderSecretFile {
    param([Parameter(Mandatory = $true)][object]$SecretFile)

    $path = [string]$SecretFile.Path
    if ([IO.File]::Exists($path)) {
        try {
            $length = [IO.FileInfo]::new($path).Length
            $stream = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $zeros = New-Object byte[] 4096
                while ($length -gt 0) {
                    $count = [Math]::Min([Int64]$zeros.Length, $length)
                    $stream.Write($zeros, 0, [int]$count)
                    $length -= $count
                }
                $stream.Flush($true)
            }
            finally {
                $stream.Dispose()
            }
        }
        finally {
            [IO.File]::Delete($path)
        }
    }
    $directory = [string]$SecretFile.Directory
    if ([IO.Directory]::Exists($directory)) {
        [IO.Directory]::Delete($directory, $false)
    }
}

function Invoke-M1RunnerResidueCleanup {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot
    )

    $filters = @(
        "label=com.docker.compose.project=repofixlab",
        "label=com.docker.compose.service=m1-runner",
        "label=com.docker.compose.oneoff=True"
    )
    $beforeIds = @()
    $listExitCodes = [ordered]@{}
    foreach ($status in @("created", "exited", "dead")) {
        $outputPath = Join-Path $OperationRoot "m1-runner-residue-before-$status.txt"
        $arguments = @("container", "ls", "--all", "--quiet")
        foreach ($filter in $filters) {
            $arguments += @("--filter", $filter)
        }
        $arguments += @("--filter", "status=$status")
        $exitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-runner-residue-before-$status" `
            -Arguments $arguments `
            -StandardOutputPath $outputPath `
            -StandardErrorPath (Join-Path $OperationRoot "m1-runner-residue-before-$status.stderr.log")
        $listExitCodes[$status] = $exitCode
        if ($exitCode -ne 0) {
            throw "Unable to audit stopped M1 runner containers with status $status"
        }
        foreach ($line in [IO.File]::ReadAllLines($outputPath, $script:Utf8NoBom)) {
            $id = $line.Trim()
            if ($id.Length -eq 0) {
                continue
            }
            if ($id -notmatch '^[0-9a-f]{12,64}$') {
                throw "Docker returned an invalid M1 runner container ID"
            }
            if ($beforeIds -notcontains $id) {
                $beforeIds += $id
            }
        }
    }

    $inspectExitCode = $null
    $removeExitCode = $null
    if ($beforeIds.Count -gt 0) {
        $inspectExitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-runner-residue-inspect" `
            -Arguments (@("container", "inspect") + $beforeIds) `
            -StandardOutputPath (Join-Path $OperationRoot "m1-runner-residue-inspect.json") `
            -StandardErrorPath (Join-Path $OperationRoot "m1-runner-residue-inspect.stderr.log")
        if ($inspectExitCode -ne 0) {
            throw "Unable to inspect stopped M1 runner container residue"
        }
        $removeExitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-runner-residue-remove" `
            -Arguments (@("container", "rm", "--force") + $beforeIds) `
            -StandardOutputPath (Join-Path $OperationRoot "m1-runner-residue-remove.stdout.log") `
            -StandardErrorPath (Join-Path $OperationRoot "m1-runner-residue-remove.stderr.log")
        if ($removeExitCode -ne 0) {
            throw "Unable to remove stopped M1 runner container residue"
        }
    }

    $afterIds = @()
    foreach ($status in @("created", "exited", "dead")) {
        $outputPath = Join-Path $OperationRoot "m1-runner-residue-after-$status.txt"
        $arguments = @("container", "ls", "--all", "--quiet")
        foreach ($filter in $filters) {
            $arguments += @("--filter", $filter)
        }
        $arguments += @("--filter", "status=$status")
        $exitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-runner-residue-after-$status" `
            -Arguments $arguments `
            -StandardOutputPath $outputPath `
            -StandardErrorPath (Join-Path $OperationRoot "m1-runner-residue-after-$status.stderr.log")
        if ($exitCode -ne 0) {
            throw "Unable to verify M1 runner cleanup for status $status"
        }
        foreach ($line in [IO.File]::ReadAllLines($outputPath, $script:Utf8NoBom)) {
            $id = $line.Trim()
            if ($id.Length -gt 0) {
                $afterIds += $id
            }
        }
    }
    Write-AtomicUniqueJson (Join-Path $OperationRoot "m1-runner-cleanup.json") ([ordered]@{
        schema_version = "v1"
        compose_project = "repofixlab"
        compose_service = "m1-runner"
        compose_oneoff = "True"
        stopped_statuses = @("created", "exited", "dead")
        before_container_ids = $beforeIds
        list_exit_codes = $listExitCodes
        inspect_exit_code = $inspectExitCode
        remove_exit_code = $removeExitCode
        after_container_ids = $afterIds
    })
    if ($afterIds.Count -gt 0) {
        throw "Stopped M1 runner containers remain after exact-label cleanup"
    }
    Write-TranscriptLine "M1 stopped one-off runner residue verified at zero"
}
function Assert-M1ComposePlan {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$PublicVolume,
        [Parameter(Mandatory = $true)][string]$ControlVolume,
        [Parameter(Mandatory = $true)][string]$PrivateVolume,
        [Parameter(Mandatory = $true)][string]$SecretFile
    )

    try {
        $composeConfig = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "Resolved M1 Docker Compose configuration is not valid JSON"
    }
    if ([string](Get-RequiredObjectProperty $composeConfig "name" "M1 Compose config") -cne "repofixlab") {
        throw "M1 Compose project must equal repofixlab"
    }

    $services = Get-RequiredObjectProperty $composeConfig "services" "M1 Compose config"
    $runnerProperty = $services.PSObject.Properties["m1-runner"]
    if ($null -eq $runnerProperty) {
        throw "M1 Compose config does not contain m1-runner"
    }
    $runner = $runnerProperty.Value
    Assert-ExactStringSet @(Get-RequiredObjectProperty $runner "profiles" "m1-runner") @("m1") "m1-runner profiles"
    if ([string](Get-RequiredObjectProperty $runner "image" "m1-runner") -cne "repofixlab-orchestrator") {
        throw "m1-runner must reuse the fixed repofixlab-orchestrator image"
    }
    if ($null -ne $runner.PSObject.Properties["build"]) {
        throw "m1-runner must not define an independent image build"
    }
    if ([string](Get-RequiredObjectProperty $runner "user" "m1-runner") -cne "node") {
        throw "m1-runner must use the non-root node user"
    }
    if ((Get-RequiredObjectProperty $runner "read_only" "m1-runner") -isnot [bool] -or -not [bool]$runner.read_only) {
        throw "m1-runner root filesystem must be read-only"
    }
    Assert-ExactStringSet @(Get-RequiredObjectProperty $runner "cap_drop" "m1-runner") @("ALL") "m1-runner cap_drop"
    Assert-ExactStringSet @(Get-RequiredObjectProperty $runner "security_opt" "m1-runner") @("no-new-privileges:true") "m1-runner security_opt"
    Assert-ExactStringSet @((Get-RequiredObjectProperty $runner "networks" "m1-runner").PSObject.Properties.Name) @(
        "provider-egress", "repofix-control"
    ) "m1-runner networks"

    $environment = Get-RequiredObjectProperty $runner "environment" "m1-runner"
    Assert-ExactStringSet @($environment.PSObject.Properties.Name) @(
        "REPOFIX_ARTIFACTS_PATH", "REPOFIX_CONTROLLER_URL", "REPOFIX_DATASET_PUBLIC_PATH", "ZHIPU_API_KEY_FILE"
    ) "m1-runner environment"
    $expectedEnvironment = [ordered]@{
        REPOFIX_ARTIFACTS_PATH = "/artifacts"
        REPOFIX_CONTROLLER_URL = "http://controller:8000"
        REPOFIX_DATASET_PUBLIC_PATH = "/data/public"
        ZHIPU_API_KEY_FILE = "/run/secrets/zhipu_api_key"
    }
    foreach ($entry in $expectedEnvironment.GetEnumerator()) {
        if ([string]$environment.PSObject.Properties[$entry.Key].Value -cne $entry.Value) {
            throw "m1-runner environment drifted: $($entry.Key)"
        }
    }

    $runnerSecrets = @(Get-RequiredObjectProperty $runner "secrets" "m1-runner")
    if (
        $runnerSecrets.Count -ne 1 -or
        [string](Get-RequiredObjectProperty $runnerSecrets[0] "source" "m1-runner secret") -cne "zhipu_api_key" -or
        [string](Get-RequiredObjectProperty $runnerSecrets[0] "target" "m1-runner secret") -cne "/run/secrets/zhipu_api_key"
    ) {
        throw "m1-runner must mount only the zhipu_api_key Compose secret at the frozen path"
    }

    $runnerVolumes = @(Get-RequiredObjectProperty $runner "volumes" "m1-runner")
    if ($runnerVolumes.Count -ne 2) {
        throw "m1-runner must mount exactly artifacts and the frozen public dataset volume"
    }
    $seenTargets = @{}
    foreach ($volume in $runnerVolumes) {
        $target = [string](Get-RequiredObjectProperty $volume "target" "m1-runner volume")
        if ($seenTargets.ContainsKey($target)) {
            throw "m1-runner contains a duplicate volume target: $target"
        }
        if ($target -ceq "/artifacts") {
            if ([string](Get-RequiredObjectProperty $volume "type" "m1-runner artifacts volume") -cne "bind") {
                throw "m1-runner artifacts storage must be a host bind"
            }
            $readOnlyProperty = $volume.PSObject.Properties["read_only"]
            if ($null -ne $readOnlyProperty -and [bool]$readOnlyProperty.Value) {
                throw "m1-runner artifacts storage must be writable"
            }
        }
        elseif ($target -ceq "/data/public") {
            if (
                [string](Get-RequiredObjectProperty $volume "type" "m1-runner public volume") -cne "volume" -or
                [string](Get-RequiredObjectProperty $volume "source" "m1-runner public volume") -cne "dataset-public" -or
                $null -eq $volume.PSObject.Properties["read_only"] -or
                -not [bool]$volume.read_only
            ) {
                throw "m1-runner public dataset volume must be the logical dataset-public volume mounted read-only"
            }
        }
        else {
            throw "m1-runner contains a forbidden volume target: $target"
        }
        $seenTargets[$target] = $true
    }
    Assert-ExactStringSet @($seenTargets.Keys) @("/artifacts", "/data/public") "m1-runner volume targets"

    $dependsOn = Get-RequiredObjectProperty $runner "depends_on" "m1-runner"
    Assert-ExactStringSet @($dependsOn.PSObject.Properties.Name) @("controller") "m1-runner dependencies"
    if ([string](Get-RequiredObjectProperty $dependsOn.controller "condition" "m1-runner controller dependency") -cne "service_healthy") {
        throw "m1-runner must depend on a healthy Controller"
    }

    foreach ($serviceName in @("controller", "orchestrator")) {
        $serviceProperty = $services.PSObject.Properties[$serviceName]
        if ($null -eq $serviceProperty) {
            throw "M1 Compose config is missing $serviceName"
        }
        $service = $serviceProperty.Value
        $secretProperty = $service.PSObject.Properties["secrets"]
        if ($null -ne $secretProperty -and @($secretProperty.Value).Count -gt 0) {
            throw "$serviceName must not receive the provider secret"
        }
        $serviceEnvironmentProperty = $service.PSObject.Properties["environment"]
        if ($null -ne $serviceEnvironmentProperty) {
            foreach ($name in @($serviceEnvironmentProperty.Value.PSObject.Properties.Name)) {
                if ($name -like "*ZHIPU*" -or $name -like "*API_KEY*") {
                    throw "$serviceName must not receive provider credentials"
                }
            }
        }
        $serviceVolumesProperty = $service.PSObject.Properties["volumes"]
        if ($null -ne $serviceVolumesProperty) {
            foreach ($volume in @($serviceVolumesProperty.Value)) {
                if ([string]$volume.target -ceq "/data/public") {
                    throw "$serviceName must not receive the M1 public dataset mount"
                }
            }
        }
    }
    Assert-ExactStringSet @($services.controller.networks.PSObject.Properties.Name) @("repofix-control") "Controller networks"

    $secrets = Get-RequiredObjectProperty $composeConfig "secrets" "M1 Compose config"
    Assert-ExactStringSet @($secrets.PSObject.Properties.Name) @("zhipu_api_key") "M1 Compose secrets"
    $secretDefinition = $secrets.zhipu_api_key
    if ($null -ne $secretDefinition.PSObject.Properties["environment"]) {
        throw "zhipu_api_key must not use an environment-backed Compose secret"
    }
    $resolvedSecretFile = [IO.Path]::GetFullPath([string](Get-RequiredObjectProperty $secretDefinition "file" "zhipu_api_key secret"))
    if (-not [String]::Equals($resolvedSecretFile, [IO.Path]::GetFullPath($SecretFile), [StringComparison]::OrdinalIgnoreCase)) {
        throw "zhipu_api_key must use the unique host temporary secret file"
    }

    $volumes = Get-RequiredObjectProperty $composeConfig "volumes" "M1 Compose config"
    $expectedVolumeNames = [ordered]@{
        "controller-candidates-v1" = "repofixlab_controller-candidates-v1"
        "dataset-public" = $PublicVolume
        "dataset-control" = $ControlVolume
        "dataset-private" = $PrivateVolume
    }
    foreach ($entry in $expectedVolumeNames.GetEnumerator()) {
        $definition = $volumes.PSObject.Properties[$entry.Key]
        if ($null -eq $definition -or [string](Get-RequiredObjectProperty $definition.Value "name" "M1 volume $($entry.Key)") -cne $entry.Value) {
            throw "M1 Compose volume name drifted: $($entry.Key)"
        }
    }
}

function Invoke-M1PrerequisiteChecks {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$PublicVolume,
        [Parameter(Mandatory = $true)][string]$ControlVolume,
        [Parameter(Mandatory = $true)][string]$PrivateVolume
    )

    $volumeChecks = @(
        [pscustomobject]@{ Key = "public"; Name = $PublicVolume; Hint = ".\scripts\repofixlab.ps1 dataset prepare" },
        [pscustomobject]@{ Key = "control"; Name = $ControlVolume; Hint = ".\scripts\repofixlab.ps1 dataset prepare" },
        [pscustomobject]@{ Key = "private"; Name = $PrivateVolume; Hint = ".\scripts\repofixlab.ps1 dataset prepare" },
        [pscustomobject]@{ Key = "controller-candidates"; Name = "repofixlab_controller-candidates-v1"; Hint = "restore the approved M0 Controller candidate volume; do not create an empty replacement" }
    )
    foreach ($volume in $volumeChecks) {
        $exitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-$($volume.Key)-volume-preflight" `
            -Arguments @("volume", "inspect", $volume.Name) `
            -StandardOutputPath (Join-Path $OperationRoot "$($volume.Key)-volume-inspect.json") `
            -StandardErrorPath (Join-Path $OperationRoot "$($volume.Key)-volume-inspect.stderr.log")
        if ($exitCode -ne 0) {
            throw "Required M1 Docker volume is missing: $($volume.Name). Prerequisite: $($volume.Hint)"
        }
    }

    $imageChecks = @(
        [pscustomobject]@{
            Key = "worker"
            Reference = "repofixlab-axios-5892-worker-sanitized:v1"
            ExpectedId = "sha256:2ebfd777d35cc2126d4c072b9a47cae7efc05062d2b762f6b052de9dc2aa9457"
        },
        [pscustomobject]@{
            Key = "evaluator"
            Reference = "repofixlab-axios-5892-sanitized:v1"
            ExpectedId = "sha256:1ec1230faa109d7d89c819740cc8f9daa6c80dade0e30e5a91834fa20feb54f1"
        }
    )
    foreach ($image in $imageChecks) {
        $inspectPath = Join-Path $OperationRoot "$($image.Key)-image-id.txt"
        $exitCode = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-$($image.Key)-image-preflight" `
            -Arguments @("image", "inspect", "--format={{.Id}}", $image.Reference) `
            -StandardOutputPath $inspectPath `
            -StandardErrorPath (Join-Path $OperationRoot "$($image.Key)-image-inspect.stderr.log")
        if ($exitCode -ne 0) {
            throw "Required M1 $($image.Key) image is missing: $($image.Reference). Run: .\scripts\repofixlab.ps1 images prepare-axios"
        }
        if ([IO.File]::ReadAllText($inspectPath, $script:Utf8NoBom).Trim() -cne $image.ExpectedId) {
            throw "Required M1 $($image.Key) image ID drifted for $($image.Reference). Run: .\scripts\repofixlab.ps1 images prepare-axios"
        }
    }
}

function Invoke-M1BootstrapImageBuilds {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot
    )

    $composeHashes = [ordered]@{}
    foreach ($service in @("controller", "orchestrator")) {
        $hashPath = Join-Path $OperationRoot "$service-compose-hash.txt"
        $hashExit = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-$service-compose-hash-before-build" `
            -Arguments @("compose", "-f", "compose.yaml", "config", "--hash", $service) `
            -StandardOutputPath $hashPath `
            -StandardErrorPath (Join-Path $OperationRoot "$service-compose-hash.stderr.log")
        if ($hashExit -ne 0) {
            throw "Unable to read Docker Compose config hash for $service before M1 build"
        }
        $composeHashes[$service] = Get-ComposeServiceHash $hashPath $service
        Write-TranscriptLine "$service compose config hash fixed before M1 build: $($composeHashes[$service])"
    }

    foreach ($service in @("controller", "orchestrator")) {
        $buildExit = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-$service-image-build-with-compose-hash" `
            -Arguments @(
                "compose", "-f", "compose.yaml", "build", "--build-arg",
                "REPOFIXLAB_COMPOSE_CONFIG_SHA256=$($composeHashes[$service])", $service
            ) `
            -StandardOutputPath (Join-Path $OperationRoot "$service-build.stdout.log") `
            -StandardErrorPath (Join-Path $OperationRoot "$service-build.stderr.log") `
            -EchoOutput
        if ($buildExit -ne 0) {
            throw "$service image build failed with exit code $buildExit"
        }

        $imageReference = "repofixlab-$service"
        $labelPath = Join-Path $OperationRoot "$service-image-inspect.json"
        $labelExit = Invoke-DockerCommand `
            -DockerPath $DockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "m1-$service-compose-hash-label" `
            -Arguments @("image", "inspect", $imageReference) `
            -StandardOutputPath $labelPath `
            -StandardErrorPath (Join-Path $OperationRoot "$service-compose-hash-label.stderr.log")
        if ($labelExit -ne 0) {
            throw "Unable to inspect the built $service image"
        }
        $builtImage = Read-SingleDockerInspection $labelPath "$service built image"
        $labels = Get-RequiredObjectProperty (Get-RequiredObjectProperty $builtImage "Config" "$service built image") "Labels" "$service built image config"
        $composeHashLabel = $labels.PSObject.Properties["io.repofixlab.compose-config-sha256"]
        if ($null -eq $composeHashLabel -or [string]$composeHashLabel.Value -cne $composeHashes[$service]) {
            throw "$service built image does not carry the pre-build Compose config hash"
        }
    }
}

function Assert-M1PublicVolumePermissionReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet("audit", "normalize")][string]$ExpectedAction
    )

    try {
        $report = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "M1 public volume permission $ExpectedAction output is not valid JSON"
    }
    Assert-ExactStringSet @($report.PSObject.Properties.Name) @(
        "action", "aggregate_sha256", "files", "schema_version", "status"
    ) "M1 public volume permission $ExpectedAction report properties"
    if (
        [string]$report.schema_version -cne "v1" -or
        [string]$report.status -cne "pass" -or
        [string]$report.action -cne $ExpectedAction -or
        [string]$report.aggregate_sha256 -cne "e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55" -or
        [int]$report.files -ne 47
    ) {
        throw "M1 public volume permission $ExpectedAction report differs from the frozen public generation contract"
    }
    return $report
}

function Invoke-M1PublicVolumePermissionGate {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$PublicVolume
    )

    $permissionScript = "/workspace/packages/repofixlab/docker/public-volume-permissions.mjs"
    $commonArguments = @(
        "run", "--rm",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "64",
        "--memory", "536870912",
        "--memory-swap", "536870912",
        "--cpus", "1"
    )
    $firstAuditExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "m1-public-volume-first-audit" `
        -Arguments ($commonArguments + @(
            "--user", "1000:1000",
            "--mount", "type=volume,source=$PublicVolume,target=/data/public,readonly",
            "--entrypoint", "node",
            "repofixlab-orchestrator", $permissionScript, "audit"
        )) `
        -StandardOutputPath (Join-Path $OperationRoot "public-volume-first-audit.stdout.log") `
        -StandardErrorPath (Join-Path $OperationRoot "public-volume-first-audit.stderr.log")
    if ($firstAuditExit -eq 0) {
        [void](Assert-M1PublicVolumePermissionReport `
            -Path (Join-Path $OperationRoot "public-volume-first-audit.stdout.log") `
            -ExpectedAction "audit")
        return [pscustomobject]@{
            Status = "already_compliant"
            FirstAuditExitCode = 0
            NormalizeExitCode = $null
            FinalAuditExitCode = $null
        }
    }

    Write-TranscriptLine "M1 public volume first read-only audit failed; attempting owner-only permission normalization"
    $normalizeExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "m1-public-volume-normalize" `
        -Arguments ($commonArguments + @(
            "--user", "65532:65532",
            "--mount", "type=volume,source=$PublicVolume,target=/data/public",
            "--entrypoint", "node",
            "repofixlab-orchestrator", $permissionScript, "normalize"
        )) `
        -StandardOutputPath (Join-Path $OperationRoot "public-volume-normalize.stdout.log") `
        -StandardErrorPath (Join-Path $OperationRoot "public-volume-normalize.stderr.log")
    if ($normalizeExit -ne 0) {
        throw "M1 public volume permission normalization failed with exit code $normalizeExit"
    }
    [void](Assert-M1PublicVolumePermissionReport `
        -Path (Join-Path $OperationRoot "public-volume-normalize.stdout.log") `
        -ExpectedAction "normalize")

    $finalAuditExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "m1-public-volume-final-audit" `
        -Arguments ($commonArguments + @(
            "--user", "1000:1000",
            "--mount", "type=volume,source=$PublicVolume,target=/data/public,readonly",
            "--entrypoint", "node",
            "repofixlab-orchestrator", $permissionScript, "audit"
        )) `
        -StandardOutputPath (Join-Path $OperationRoot "public-volume-final-audit.stdout.log") `
        -StandardErrorPath (Join-Path $OperationRoot "public-volume-final-audit.stderr.log")
    if ($finalAuditExit -ne 0) {
        throw "M1 public volume final read-only permission audit failed with exit code $finalAuditExit"
    }
    [void](Assert-M1PublicVolumePermissionReport `
        -Path (Join-Path $OperationRoot "public-volume-final-audit.stdout.log") `
        -ExpectedAction "audit")
    return [pscustomobject]@{
        Status = "normalized"
        FirstAuditExitCode = $firstAuditExit
        NormalizeExitCode = 0
        FinalAuditExitCode = 0
    }
}

function Assert-M1PrivateVolumePermissionReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet("audit", "normalize")][string]$ExpectedAction
    )

    try {
        $report = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "M1 private volume permission $ExpectedAction output is not valid JSON"
    }
    Assert-ExactStringSet @($report.PSObject.Properties.Name) @(
        "action", "aggregate_sha256", "files", "schema_version", "status"
    ) "M1 private volume permission $ExpectedAction report properties"
    if (
        [string]$report.schema_version -cne "v1" -or
        [string]$report.status -cne "pass" -or
        [string]$report.action -cne $ExpectedAction -or
        [string]$report.aggregate_sha256 -cne "e451237925674fc683c100af9bec4d68db88d529e8d5638d3649841369a34f55" -or
        [int]$report.files -ne 47
    ) {
        throw "M1 private volume permission $ExpectedAction report differs from the frozen private generation contract"
    }
    return $report
}

function Invoke-M1PrivateVolumePermissionGate {
    param(
        [Parameter(Mandatory = $true)][string]$DockerPath,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$OperationRoot,
        [Parameter(Mandatory = $true)][string]$PrivateVolume
    )

    $permissionScript = "/workspace/packages/repofixlab/docker/private-volume-permissions.mjs"
    $commonArguments = @(
        "run", "--rm",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "64",
        "--memory", "536870912",
        "--memory-swap", "536870912",
        "--cpus", "1"
    )
    $firstAuditExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "m1-private-volume-first-audit" `
        -Arguments ($commonArguments + @(
            "--user", "0:0",
            "--mount", "type=volume,source=$PrivateVolume,target=/data/private,readonly",
            "--entrypoint", "node",
            "repofixlab-orchestrator", $permissionScript, "audit"
        )) `
        -StandardOutputPath (Join-Path $OperationRoot "private-volume-first-audit.stdout.log") `
        -StandardErrorPath (Join-Path $OperationRoot "private-volume-first-audit.stderr.log")
    if ($firstAuditExit -eq 0) {
        [void](Assert-M1PrivateVolumePermissionReport `
            -Path (Join-Path $OperationRoot "private-volume-first-audit.stdout.log") `
            -ExpectedAction "audit")
        return [pscustomobject]@{
            Status = "already_compliant"
            FirstAuditExitCode = 0
            NormalizeExitCode = $null
            FinalAuditExitCode = $null
        }
    }

    Write-TranscriptLine "M1 private volume first read-only evaluator audit failed; attempting producer-owned permission normalization"
    $normalizeExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "m1-private-volume-normalize" `
        -Arguments ($commonArguments + @(
            "--user", "65532:65532",
            "--mount", "type=volume,source=$PrivateVolume,target=/data/private",
            "--entrypoint", "node",
            "repofixlab-orchestrator", $permissionScript, "normalize"
        )) `
        -StandardOutputPath (Join-Path $OperationRoot "private-volume-normalize.stdout.log") `
        -StandardErrorPath (Join-Path $OperationRoot "private-volume-normalize.stderr.log")
    if ($normalizeExit -ne 0) {
        throw "M1 private volume permission normalization failed with exit code $normalizeExit"
    }
    [void](Assert-M1PrivateVolumePermissionReport `
        -Path (Join-Path $OperationRoot "private-volume-normalize.stdout.log") `
        -ExpectedAction "normalize")

    $finalAuditExit = Invoke-DockerCommand `
        -DockerPath $DockerPath `
        -RepositoryRoot $RepositoryRoot `
        -Label "m1-private-volume-final-audit" `
        -Arguments ($commonArguments + @(
            "--user", "0:0",
            "--mount", "type=volume,source=$PrivateVolume,target=/data/private,readonly",
            "--entrypoint", "node",
            "repofixlab-orchestrator", $permissionScript, "audit"
        )) `
        -StandardOutputPath (Join-Path $OperationRoot "private-volume-final-audit.stdout.log") `
        -StandardErrorPath (Join-Path $OperationRoot "private-volume-final-audit.stderr.log")
    if ($finalAuditExit -ne 0) {
        throw "M1 private volume final read-only evaluator permission audit failed with exit code $finalAuditExit"
    }
    [void](Assert-M1PrivateVolumePermissionReport `
        -Path (Join-Path $OperationRoot "private-volume-final-audit.stdout.log") `
        -ExpectedAction "audit")
    return [pscustomobject]@{
        Status = "normalized"
        FirstAuditExitCode = $firstAuditExit
        NormalizeExitCode = 0
        FinalAuditExitCode = 0
    }
}

function Invoke-M1Run {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $apiKey = [Environment]::GetEnvironmentVariable("ZHIPU_API_KEY", "Process")
    if ([String]::IsNullOrWhiteSpace($apiKey)) {
        [Console]::Error.WriteLine("run m1 requires a non-empty host ZHIPU_API_KEY environment variable")
        return 2
    }
    if ($apiKey.Length -gt 4096 -or $apiKey.Trim() -cne $apiKey) {
        [Console]::Error.WriteLine("run m1 requires ZHIPU_API_KEY without surrounding whitespace and at most 4096 characters")
        return 2
    }
    foreach ($character in $apiKey.ToCharArray()) {
        if ([char]::IsControl($character)) {
            [Console]::Error.WriteLine("run m1 requires ZHIPU_API_KEY without control characters")
            return 2
        }
    }

    $publicVolume = "dataset-public-g-20260718-135934-066a8f5b6f6b"
    $controlVolume = "dataset-control-g-20260718-135934-066a8f5b6f6b"
    $privateVolume = "dataset-private-g-20260718-135934-066a8f5b6f6b"
    $operationRoot = New-M1RunOperationDirectory $RepositoryRoot
    $operationId = Split-Path -Leaf $operationRoot
    $transcriptPath = Join-Path $operationRoot "transcript.log"
    $transcriptStream = New-Object IO.FileStream($transcriptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $parentTranscriptWriter = $script:TranscriptWriter
    $script:TranscriptWriter = New-Object IO.StreamWriter($transcriptStream, $script:Utf8NoBom)
    $script:TranscriptWriter.AutoFlush = $true

    $environmentNames = @(
        "COMPOSE_DISABLE_ENV_FILE", "REPOFIX_PUBLIC_VOLUME", "REPOFIX_CONTROL_VOLUME",
        "REPOFIX_PRIVATE_VOLUME", "REPOFIX_ZHIPU_SECRET_FILE", "ZHIPU_API_KEY"
    )
    $previousEnvironment = @{}
    foreach ($name in $environmentNames) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "1", "Process")
    [Environment]::SetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", $publicVolume, "Process")
    [Environment]::SetEnvironmentVariable("REPOFIX_CONTROL_VOLUME", $controlVolume, "Process")
    [Environment]::SetEnvironmentVariable("REPOFIX_PRIVATE_VOLUME", $privateVolume, "Process")

    $secretFile = $null
    $dockerPath = $null
    $runExit = $null
    $failureMessage = $null
    $runnerCleanupStatus = "not_attempted"
    $secretCleanupStatus = "not_attempted"
    $publicVolumePermissionMigrationStatus = "not_attempted"
    $privateVolumePermissionMigrationStatus = "not_attempted"
    try {
        try {
            $secretFile = New-M1ProviderSecretFile $RepositoryRoot $apiKey
            [Environment]::SetEnvironmentVariable("REPOFIX_ZHIPU_SECRET_FILE", [string]$secretFile.Path, "Process")
            [Environment]::SetEnvironmentVariable("ZHIPU_API_KEY", $null, "Process")
            Remove-Variable apiKey

            Write-TranscriptLine "operation_id=$operationId"
            Write-TranscriptLine "config=configs/experiments/m1-axios.yaml"
            Write-TranscriptLine "public_volume=$publicVolume"
            Write-TranscriptLine "control_volume=$controlVolume"
            Write-TranscriptLine "private_volume=$privateVolume"
            Write-TranscriptLine "provider_secret_source=unique_host_temporary_file"

            $dockerPath = (Get-Command docker -ErrorAction Stop).Source
            $composeConfigPath = Join-Path $operationRoot "compose-config.json"
            $configExit = Invoke-DockerCommandAtomic `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "m1-compose-config" `
                -Arguments @(
                    "compose", "-f", "compose.yaml", "--profile", "m1", "--profile", "dataset-prepare", "config", "--format", "json"
                ) `
                -StandardOutputPath $composeConfigPath `
                -StandardErrorPath (Join-Path $operationRoot "compose-config.stderr.log")
            if ($configExit -ne 0) {
                throw "Unable to read the resolved M1 Docker Compose configuration"
            }
            Assert-M1ComposePlan $composeConfigPath $publicVolume $controlVolume $privateVolume ([string]$secretFile.Path)
            Write-TranscriptLine "M1 file-backed secret, environment, volume, and network boundaries verified"

            Invoke-M1PrerequisiteChecks $dockerPath $RepositoryRoot $operationRoot $publicVolume $controlVolume $privateVolume
            Write-TranscriptLine "M1 frozen data volumes, Controller candidate volume, and task images verified"
            Invoke-M1BootstrapImageBuilds $dockerPath $RepositoryRoot $operationRoot
            $publicVolumePermissionMigrationStatus = "in_progress"
            $publicVolumePermissionGate = Invoke-M1PublicVolumePermissionGate `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -OperationRoot $operationRoot `
                -PublicVolume $publicVolume
            $publicVolumePermissionMigrationStatus = [string]$publicVolumePermissionGate.Status
            Write-TranscriptLine "public_volume_permission_migration_status=$publicVolumePermissionMigrationStatus"
            $privateVolumePermissionMigrationStatus = "in_progress"
            $privateVolumePermissionGate = Invoke-M1PrivateVolumePermissionGate `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -OperationRoot $operationRoot `
                -PrivateVolume $privateVolume
            $privateVolumePermissionMigrationStatus = [string]$privateVolumePermissionGate.Status
            Write-TranscriptLine "private_volume_permission_migration_status=$privateVolumePermissionMigrationStatus"

            $controllerExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "m1-controller-up-and-wait" `
                -Arguments @("compose", "-f", "compose.yaml", "--profile", "m1", "up", "-d", "--wait", "controller") `
                -StandardOutputPath (Join-Path $operationRoot "controller-up.stdout.log") `
                -StandardErrorPath (Join-Path $operationRoot "controller-up.stderr.log") `
                -EchoOutput
            if ($controllerExit -ne 0) {
                throw "Controller failed to become healthy before M1 run (exit code $controllerExit)"
            }

            $runExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "m1-orchestrator-run" `
                -Arguments @(
                    "compose", "-f", "compose.yaml", "--profile", "m1", "run", "--rm", "--no-deps", "--pull", "never",
                    "m1-runner", "run", "--config", "configs/experiments/m1-axios.yaml"
                ) `
                -StandardOutputPath (Join-Path $operationRoot "orchestrator.stdout.log") `
                -StandardErrorPath (Join-Path $operationRoot "orchestrator.stderr.log") `
                -EchoOutput
        }
        catch {
            $failureMessage = $_.Exception.Message
            if ($publicVolumePermissionMigrationStatus -ceq "in_progress") {
                $publicVolumePermissionMigrationStatus = "failed"
                Write-TranscriptLine "public_volume_permission_migration_status=failed"
            }
            if ($privateVolumePermissionMigrationStatus -ceq "in_progress") {
                $privateVolumePermissionMigrationStatus = "failed"
                Write-TranscriptLine "private_volume_permission_migration_status=failed"
            }
            Write-TranscriptLine "failure: $failureMessage"
        }

        if ($null -ne $dockerPath) {
            try {
                Invoke-M1RunnerResidueCleanup $dockerPath $RepositoryRoot $operationRoot
                $runnerCleanupStatus = "pass"
            }
            catch {
                $runnerCleanupStatus = "failed"
                $cleanupMessage = $_.Exception.Message
                Write-TranscriptLine "M1 runner residue cleanup failure: $cleanupMessage"
                if ($null -eq $failureMessage) {
                    $failureMessage = $cleanupMessage
                }
                else {
                    $failureMessage = "$failureMessage; runner cleanup: $cleanupMessage"
                }
            }
        }

        if ($null -ne $secretFile) {
            try {
                Remove-M1ProviderSecretFile $secretFile
                $secretFile = $null
                $secretCleanupStatus = "pass"
            }
            catch {
                $secretCleanupStatus = "failed"
                $secretMessage = $_.Exception.Message
                Write-TranscriptLine "M1 temporary provider secret cleanup failed"
                if ($null -eq $failureMessage) {
                    $failureMessage = "Temporary provider secret cleanup failed: $secretMessage"
                }
                else {
                    $failureMessage = "$failureMessage; temporary provider secret cleanup failed: $secretMessage"
                }
            }
        }

        $operationStatus = if ($null -eq $failureMessage -and $null -ne $runExit -and $runExit -eq 0) { "pass" } else { "failed" }
        $result = [ordered]@{
            schema_version = "v1"
            operation_type = "m1_host_run"
            status = $operationStatus
            config = "configs/experiments/m1-axios.yaml"
            public_volume_permission_migration_status = $publicVolumePermissionMigrationStatus
            private_volume_permission_migration_status = $privateVolumePermissionMigrationStatus
            runner_cleanup_status = $runnerCleanupStatus
            secret_cleanup_status = $secretCleanupStatus
        }
        if ($null -ne $runExit) {
            $result["orchestrator_exit_code"] = $runExit
        }
        if ($null -ne $failureMessage) {
            $result["message"] = $failureMessage
        }
        Write-AtomicUniqueJson (Join-Path $operationRoot "result.json") $result

        if ($null -ne $failureMessage) {
            [Console]::Error.WriteLine("M1 host run failed: $failureMessage")
            [Console]::Error.WriteLine("Artifacts: $operationRoot")
            return 1
        }
        if ($runExit -ne 0) {
            [Console]::Error.WriteLine("M1 orchestrator failed with exit code $runExit. Artifacts: $operationRoot")
            return $runExit
        }
        [Console]::Out.WriteLine("M1 run completed. Artifacts: $operationRoot")
        return 0
    }
    finally {
        if ($null -ne $secretFile) {
            try {
                Remove-M1ProviderSecretFile $secretFile
            }
            catch {
                [Console]::Error.WriteLine("M1 emergency temporary provider secret cleanup failed")
            }
        }
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
        }
        if ($null -ne $script:TranscriptWriter) {
            $script:TranscriptWriter.Dispose()
        }
        $script:TranscriptWriter = $parentTranscriptWriter
        $transcriptStream.Dispose()
    }
}
function Assert-DatasetPreparerComposePlan {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Config
    )

    try {
        $composeConfig = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "Resolved Docker Compose configuration is not valid JSON"
    }
    if ([string](Get-RequiredObjectProperty $composeConfig "name" "Compose config") -cne $Config.compose_project) {
        throw "Compose project does not match the frozen Dataset Preparer config"
    }
    $services = Get-RequiredObjectProperty $composeConfig "services" "Compose config"
    $serviceProperty = $services.PSObject.Properties[$Config.preparer_service]
    if ($null -eq $serviceProperty) {
        throw "Compose config does not contain the Dataset Preparer service"
    }
    $service = $serviceProperty.Value

    Assert-ExactStringSet @(Get-RequiredObjectProperty $service "profiles" "Dataset Preparer service") @("dataset-prepare") "Dataset Preparer profiles"
    if ([string](Get-RequiredObjectProperty $service "user" "Dataset Preparer service") -cne "65532:65532") {
        throw "Dataset Preparer user must equal 65532:65532"
    }
    if ((Get-RequiredObjectProperty $service "read_only" "Dataset Preparer service") -isnot [bool] -or -not [bool]$service.read_only) {
        throw "Dataset Preparer root filesystem must be read-only"
    }
    Assert-ExactStringSet @(Get-RequiredObjectProperty $service "cap_drop" "Dataset Preparer service") @("ALL") "Dataset Preparer cap_drop"
    Assert-ExactStringSet @(Get-RequiredObjectProperty $service "security_opt" "Dataset Preparer service") @("no-new-privileges:true") "Dataset Preparer security_opt"
    if ([Int64](Get-RequiredObjectProperty $service "pids_limit" "Dataset Preparer service") -ne 64) {
        throw "Dataset Preparer pids_limit must equal 64"
    }
    if ([Int64](Get-RequiredObjectProperty $service "mem_limit" "Dataset Preparer service") -ne 2147483648) {
        throw "Dataset Preparer mem_limit must equal 2 GiB"
    }
    if ([decimal](Get-RequiredObjectProperty $service "cpus" "Dataset Preparer service") -ne [decimal]1) {
        throw "Dataset Preparer cpus must equal 1"
    }

    $networks = Get-RequiredObjectProperty $service "networks" "Dataset Preparer service"
    Assert-ExactStringSet @($networks.PSObject.Properties.Name) @("dataset-egress") "Dataset Preparer networks"
    $networkDefinitions = Get-RequiredObjectProperty $composeConfig "networks" "Compose config"
    if ($null -eq $networkDefinitions.PSObject.Properties["dataset-egress"]) {
        throw "Dataset Preparer references an undefined dataset-egress network"
    }

    $environment = Get-RequiredObjectProperty $service "environment" "Dataset Preparer service"
    Assert-ExactStringSet @($environment.PSObject.Properties.Name) @("REPOFIX_PREPARER_IMAGE_ID") "Dataset Preparer environment"
    if ([string]$environment.REPOFIX_PREPARER_IMAGE_ID -cne "") {
        throw "Dataset Preparer Compose plan must not pre-bind an unverified image ID"
    }

    foreach ($forbiddenPropertyName in @("cap_add", "devices")) {
        $forbiddenProperty = $service.PSObject.Properties[$forbiddenPropertyName]
        if ($null -ne $forbiddenProperty -and @($forbiddenProperty.Value).Count -gt 0) {
            throw "Dataset Preparer service must not define $forbiddenPropertyName"
        }
    }
    $privilegedProperty = $service.PSObject.Properties["privileged"]
    if ($null -ne $privilegedProperty -and [bool]$privilegedProperty.Value) {
        throw "Dataset Preparer service must not be privileged"
    }

    $volumes = @(Get-RequiredObjectProperty $service "volumes" "Dataset Preparer service")
    if ($volumes.Count -ne 4) {
        throw "Dataset Preparer must define exactly /input and three data target volumes"
    }
    $expectedVolumes = [ordered]@{
        "/input" = [ordered]@{ source = "dataset-source"; readOnly = $true }
        "/data/public" = [ordered]@{ source = "dataset-public"; readOnly = $false }
        "/data/control" = [ordered]@{ source = "dataset-control"; readOnly = $false }
        "/data/private" = [ordered]@{ source = "dataset-private"; readOnly = $false }
    }
    $seenTargets = @{}
    foreach ($volume in $volumes) {
        $target = [string](Get-RequiredObjectProperty $volume "target" "Dataset Preparer volume")
        if (-not $expectedVolumes.Contains($target) -or $seenTargets.ContainsKey($target)) {
            throw "Dataset Preparer contains an unexpected or duplicate volume target: $target"
        }
        if ([string](Get-RequiredObjectProperty $volume "type" "Dataset Preparer volume") -cne "volume") {
            throw "Dataset Preparer volumes must not use host binds"
        }
        $expectedVolume = $expectedVolumes[$target]
        if ([string](Get-RequiredObjectProperty $volume "source" "Dataset Preparer volume") -cne $expectedVolume.source) {
            throw "Dataset Preparer volume source drifted for $target"
        }
        $readOnlyProperty = $volume.PSObject.Properties["read_only"]
        $readOnly = $null -ne $readOnlyProperty -and [bool]$readOnlyProperty.Value
        if ($readOnly -ne $expectedVolume.readOnly) {
            throw "Dataset Preparer volume read-only policy drifted for $target"
        }
        $seenTargets[$target] = $true
    }
    Assert-ExactStringSet @($seenTargets.Keys) @($expectedVolumes.Keys) "Dataset Preparer volume targets"
}

function Assert-AllChecksTrue {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ($Value -is [bool]) {
        if (-not $Value) {
            throw "Dataset Preparer self-check reported false at $Path"
        }
        return
    }
    $properties = @($Value.PSObject.Properties)
    if ($properties.Count -eq 0) {
        throw "Dataset Preparer self-check contains a non-boolean leaf at $Path"
    }
    foreach ($property in $properties) {
        Assert-AllChecksTrue $property.Value "$Path.$($property.Name)"
    }
}

function Assert-DatasetPreparerSelfCheckReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ImageId
    )

    try {
        $report = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "Dataset Preparer self-check output is not valid JSON"
    }
    if (
        [string](Get-RequiredObjectProperty $report "schema_version" "Dataset Preparer self-check report") -cne "v1" -or
        [string](Get-RequiredObjectProperty $report "report_type" "Dataset Preparer self-check report") -cne "dataset_preparer_self_check" -or
        [string](Get-RequiredObjectProperty $report "status" "Dataset Preparer self-check report") -cne "pass" -or
        [string](Get-RequiredObjectProperty $report "image_id" "Dataset Preparer self-check report") -cne $ImageId
    ) {
        throw "Dataset Preparer self-check identity or status does not match the host gate"
    }
    $reportSha256 = [string](Get-RequiredObjectProperty $report "report_sha256" "Dataset Preparer self-check report")
    if ($reportSha256 -notmatch '^[a-f0-9]{64}$') {
        throw "Dataset Preparer self-check report_sha256 is invalid"
    }
    $errorsProperty = $report.PSObject.Properties["errors"]
    if ($null -eq $errorsProperty) {
        throw "Dataset Preparer self-check report is missing required property: errors"
    }
    $errors = $errorsProperty.Value
    if ($errors -isnot [Array] -or @($errors).Count -ne 0) {
        throw "Dataset Preparer self-check errors must be an empty array"
    }
    $checks = Get-RequiredObjectProperty $report "checks" "Dataset Preparer self-check report"
    Assert-AllChecksTrue $checks "checks"
    $observations = Get-RequiredObjectProperty $report "observations" "Dataset Preparer self-check report"
    Assert-ExactStringSet @($observations.PSObject.Properties.Name) @(
        "docker_socket_paths_present",
        "sensitive_environment_names_present"
    ) "Dataset Preparer self-check observations"
    foreach ($observationName in @("docker_socket_paths_present", "sensitive_environment_names_present")) {
        $observationProperty = $observations.PSObject.Properties[$observationName]
        if ($null -eq $observationProperty) {
            throw "Dataset Preparer self-check observations is missing required property: $observationName"
        }
        $observation = $observationProperty.Value
        if ($observation -isnot [Array] -or @($observation).Count -ne 0) {
            throw "Dataset Preparer self-check observation $observationName must be an empty array"
        }
    }
    return $report
}

function Read-DockerNameSet {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $values = @([IO.File]::ReadAllLines($Path, $script:Utf8NoBom) | Where-Object { $_.Length -gt 0 })
    if (@($values | Select-Object -Unique).Count -ne $values.Count) {
        throw "$Description contains duplicate names"
    }
    return @($values | Sort-Object)
}

function Assert-StringSetsEqual {
    param(
        [AllowEmptyCollection()][string[]]$Before,
        [AllowEmptyCollection()][string[]]$After,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if ($Before.Count -ne $After.Count) {
        throw "$Description changed during Dataset Preparer self-check"
    }
    for ($index = 0; $index -lt $Before.Count; $index++) {
        if ($Before[$index] -cne $After[$index]) {
            throw "$Description changed during Dataset Preparer self-check"
        }
    }
}

function Invoke-DatasetSelfCheck {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $config = Read-FrozenDatasetConfig $ConfigPath
    $operationRoot = New-DatasetSelfCheckOperationDirectory $RepositoryRoot
    $operationId = Split-Path -Leaf $operationRoot
    $transcriptPath = Join-Path $operationRoot "transcript.log"
    $transcriptStream = New-Object IO.FileStream($transcriptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $parentTranscriptWriter = $script:TranscriptWriter
    $script:TranscriptWriter = New-Object IO.StreamWriter($transcriptStream, $script:Utf8NoBom)
    $script:TranscriptWriter.AutoFlush = $true
    $previousDisableEnvFile = [Environment]::GetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "Process")
    [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "1", "Process")
    $imageId = $null
    try {
        Write-TranscriptLine "operation_id=$operationId"
        Write-TranscriptLine "config=$ConfigPath"
        Write-TranscriptLine "config_sha256=$((Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant())"

        $dockerCommand = Get-Command docker -ErrorAction Stop
        $dockerPath = $dockerCommand.Source
        $composeFile = "compose.yaml"
        $doctorRelativePath = "dataset-self-check/$operationId/bootstrap-doctor.json"
        $doctorName = "repofixlab-bootstrap-doctor-$($operationId.Substring($operationId.Length - 12))"
        $doctorExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "bootstrap-doctor" `
            -Arguments @("compose", "-f", $composeFile, "run", "--rm", "--name", $doctorName, "orchestrator", "doctor", "--profile", "bootstrap", "--output", $doctorRelativePath) `
            -StandardOutputPath (Join-Path $operationRoot "bootstrap-doctor.stdout.json") `
            -StandardErrorPath (Join-Path $operationRoot "bootstrap-doctor.stderr.log") `
            -EchoOutput
        if ($doctorExit -ne 0) {
            Write-AtomicUniqueJson (Join-Path $operationRoot "result.json") ([ordered]@{
                schema_version = "v1"
                operation_type = "dataset_self_check"
                status = "bootstrap_no_go"
                bootstrap_exit_code = $doctorExit
            })
            [Console]::Error.WriteLine("Dataset Preparer self-check stopped by bootstrap doctor. Artifacts: $operationRoot")
            return [pscustomobject]@{ ExitCode = $doctorExit; OperationRoot = $operationRoot; ImageId = $null }
        }

        $buildExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "dataset-preparer-build" `
            -Arguments @("compose", "-f", $composeFile, "--profile", "dataset-prepare", "build", $config.preparer_service) `
            -StandardOutputPath (Join-Path $operationRoot "dataset-preparer-build.stdout.log") `
            -StandardErrorPath (Join-Path $operationRoot "dataset-preparer-build.stderr.log") `
            -EchoOutput
        if ($buildExit -ne 0) {
            throw "Dataset Preparer image build failed with exit code $buildExit"
        }

        $imageReference = "$($config.compose_project)-$($config.preparer_service)"
        $inspectPath = Join-Path $operationRoot "dataset-preparer-image-inspect.json"
        $inspectExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "dataset-preparer-image-inspect" `
            -Arguments @("image", "inspect", $imageReference) `
            -StandardOutputPath $inspectPath `
            -StandardErrorPath (Join-Path $operationRoot "dataset-preparer-image-inspect.stderr.log")
        if ($inspectExit -ne 0) {
            throw "Unable to inspect the built Dataset Preparer image"
        }
        $image = Read-SingleDockerInspection $inspectPath "Dataset Preparer image"
        $imageId = [string]$image.Id
        if ($imageId -notmatch '^sha256:[a-f0-9]{64}$' -or "$($image.Os)/$($image.Architecture)" -cne "linux/amd64") {
            throw "Dataset Preparer image must have an immutable ID and linux/amd64 platform"
        }
        Write-TranscriptLine "dataset_preparer_image_id=$imageId"

        $composeConfigPath = Join-Path $operationRoot "compose-config.json"
        $composeConfigExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "dataset-preparer-compose-config" `
            -Arguments @("compose", "-f", $composeFile, "--profile", "dataset-prepare", "config", "--format", "json") `
            -StandardOutputPath $composeConfigPath `
            -StandardErrorPath (Join-Path $operationRoot "compose-config.stderr.log")
        if ($composeConfigExit -ne 0) {
            throw "Unable to read the Dataset Preparer Compose plan"
        }
        Assert-DatasetPreparerComposePlan $composeConfigPath $config

        $volumesBeforePath = Join-Path $operationRoot "docker-volumes-before.txt"
        $volumesBeforeExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "self-check-volumes-before" `
            -Arguments @("volume", "ls", "--format", "{{.Name}}") `
            -StandardOutputPath $volumesBeforePath `
            -StandardErrorPath (Join-Path $operationRoot "docker-volumes-before.stderr.log")
        if ($volumesBeforeExit -ne 0) {
            throw "Unable to capture Docker volumes before Dataset Preparer self-check"
        }
        $volumesBefore = @(Read-DockerNameSet $volumesBeforePath "Docker volume list before self-check")

        $containerFilter = "label=io.repofixlab.operation-id=$operationId"
        $containersBeforePath = Join-Path $operationRoot "self-check-containers-before.txt"
        $containersBeforeExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "self-check-containers-before" `
            -Arguments @("container", "ls", "--all", "--filter", $containerFilter, "--format", "{{.ID}}") `
            -StandardOutputPath $containersBeforePath `
            -StandardErrorPath (Join-Path $operationRoot "self-check-containers-before.stderr.log")
        if ($containersBeforeExit -ne 0 -or @(Read-DockerNameSet $containersBeforePath "Self-check container list before run").Count -ne 0) {
            throw "Dataset Preparer self-check operation ID already owns a container"
        }

        $probeName = "repofixlab-dataset-self-check-$($operationId.Substring($operationId.Length - 12))"
        $selfCheckReportPath = Join-Path $operationRoot "self-check-report.json"
        $selfCheckExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "dataset-preparer-self-check-run" `
            -Arguments @(
                "run", "--rm", "--name", $probeName,
                "--label", "io.repofixlab.operation=dataset-self-check",
                "--label", "io.repofixlab.operation-id=$operationId",
                "--platform", "linux/amd64",
                "--network", "none",
                "--read-only",
                "--user", "65532:65532",
                "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges:true",
                "--pids-limit", "64",
                "--memory", "2147483648",
                "--cpus", "1",
                "--env", "REPOFIX_PREPARER_IMAGE_ID=$imageId",
                $imageId,
                "self-check"
            ) `
            -StandardOutputPath $selfCheckReportPath `
            -StandardErrorPath (Join-Path $operationRoot "self-check.stderr.log")

        $volumesAfterPath = Join-Path $operationRoot "docker-volumes-after.txt"
        $volumesAfterExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "self-check-volumes-after" `
            -Arguments @("volume", "ls", "--format", "{{.Name}}") `
            -StandardOutputPath $volumesAfterPath `
            -StandardErrorPath (Join-Path $operationRoot "docker-volumes-after.stderr.log")
        if ($volumesAfterExit -ne 0) {
            throw "Unable to capture Docker volumes after Dataset Preparer self-check"
        }
        $volumesAfter = @(Read-DockerNameSet $volumesAfterPath "Docker volume list after self-check")
        Assert-StringSetsEqual $volumesBefore $volumesAfter "Docker volume set"

        $containersAfterPath = Join-Path $operationRoot "self-check-containers-after.txt"
        $containersAfterExit = Invoke-DockerCommandAtomic `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "self-check-containers-after" `
            -Arguments @("container", "ls", "--all", "--filter", $containerFilter, "--format", "{{.ID}}") `
            -StandardOutputPath $containersAfterPath `
            -StandardErrorPath (Join-Path $operationRoot "self-check-containers-after.stderr.log")
        if ($containersAfterExit -ne 0 -or @(Read-DockerNameSet $containersAfterPath "Self-check container list after run").Count -ne 0) {
            throw "Dataset Preparer self-check left a container behind"
        }
        if ($selfCheckExit -ne 0) {
            throw "Dataset Preparer in-container self-check failed with exit code $selfCheckExit"
        }
        $selfCheckReport = Assert-DatasetPreparerSelfCheckReport $selfCheckReportPath $imageId

        Write-AtomicUniqueJson (Join-Path $operationRoot "result.json") ([ordered]@{
            schema_version = "v1"
            operation_type = "dataset_self_check"
            status = "pass"
            dataset_preparer_image_id = $imageId
            platform = "linux/amd64"
            self_check_report = "self-check-report.json"
            report_sha256 = [string]$selfCheckReport.report_sha256
        })
        Write-TranscriptLine "Dataset Preparer self-check completed without volumes or residual containers"
        [Console]::Out.WriteLine("Dataset Preparer self-check passed. Artifacts: $operationRoot")
        return [pscustomobject]@{ ExitCode = 0; OperationRoot = $operationRoot; ImageId = $imageId }
    }
    catch {
        $message = $_.Exception.Message
        if ($null -ne $script:TranscriptWriter) {
            Write-TranscriptLine "failure: $message"
        }
        $resultPath = Join-Path $operationRoot "result.json"
        if (-not [IO.File]::Exists($resultPath)) {
            Write-AtomicUniqueJson $resultPath ([ordered]@{
                schema_version = "v1"
                operation_type = "dataset_self_check"
                status = "failed"
                dataset_preparer_image_id = $imageId
                message = $message
            })
        }
        [Console]::Error.WriteLine("Dataset Preparer self-check failed: $message")
        [Console]::Error.WriteLine("Artifacts: $operationRoot")
        return [pscustomobject]@{ ExitCode = 1; OperationRoot = $operationRoot; ImageId = $imageId }
    }
    finally {
        [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", $previousDisableEnvFile, "Process")
        if ($null -ne $script:TranscriptWriter) {
            $script:TranscriptWriter.Dispose()
        }
        $script:TranscriptWriter = $parentTranscriptWriter
        $transcriptStream.Dispose()
    }
}

function Assert-GeneratedVolumeNames {
    param(
        [Parameter(Mandatory = $true)][string]$GenerationId,
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    if ($GenerationId -notmatch '^[a-z0-9][a-z0-9-]{7,63}$') {
        throw "Generation ID must contain 8-64 lowercase alphanumeric or hyphen characters"
    }
    if ($Prefix -cne "dataset") {
        throw "Dataset volume prefix must equal the frozen Python contract: dataset"
    }
    if (($Names | Select-Object -Unique).Count -ne 3) {
        throw "Dataset public, control, and private volume names must be distinct"
    }
    $expectedNames = @(
        "dataset-public-$GenerationId",
        "dataset-control-$GenerationId",
        "dataset-private-$GenerationId"
    )
    for ($index = 0; $index -lt $Names.Count; $index++) {
        $name = $Names[$index]
        if ($name.Length -gt 128 -or $name -notmatch '^[a-z0-9][a-z0-9.-]+$') {
            throw "Invalid Docker volume name: $name"
        }
        if ($name -cne $expectedNames[$index]) {
            throw "Dataset volume name does not match the frozen Python contract: $name"
        }
    }
}

function Assert-ProposedDatasetLock {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$Config,
        [Parameter(Mandatory = $true)][string]$GenerationId,
        [Parameter(Mandatory = $true)][string]$PublicVolume,
        [Parameter(Mandatory = $true)][string]$ControlVolume,
        [Parameter(Mandatory = $true)][string]$PrivateVolume,
        [Parameter(Mandatory = $true)][string]$ImageId
    )

    if ((Get-Item -LiteralPath $Path).Length -gt 32MB) {
        throw "Proposed DatasetLock exceeds the wrapper size limit"
    }
    try {
        $lock = [IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json
    }
    catch {
        throw "Dataset Preparer stdout is not a single valid JSON document: $($_.Exception.Message)"
    }
    if (
        $lock.schema_version -cne "v1" -or
        $lock.lock_type -cne "dataset" -or
        $lock.dataset.name -cne $Config.dataset_name -or
        $lock.dataset.revision -cne $Config.dataset_revision -or
        $lock.generation_id -cne $GenerationId -or
        $lock.volumes.public -cne $PublicVolume -or
        $lock.volumes.control -cne $ControlVolume -or
        $lock.volumes.private -cne $PrivateVolume -or
        [int]$lock.record_count -ne [int]$Config.expected_record_count -or
        $lock.created_by_image_id -cne $ImageId
    ) {
        throw "Proposed DatasetLock does not match the frozen wrapper inputs"
    }
}

function Invoke-DatasetPrepare {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [AllowEmptyString()][string]$RequestedGenerationId
    )

    $config = Read-FrozenDatasetConfig $ConfigPath
    $generationId = $RequestedGenerationId
    if ([String]::IsNullOrWhiteSpace($generationId)) {
        $generationId = "g-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
    }
    if ($generationId -notmatch '^[a-z0-9][a-z0-9-]{7,63}$') {
        Stop-ForUsage "Invalid --generation-id: $generationId"
    }

    $operationRoot = New-OperationDirectory $RepositoryRoot
    $operationId = Split-Path -Leaf $operationRoot
    $transcriptPath = Join-Path $operationRoot "transcript.log"
    $transcriptStream = New-Object IO.FileStream($transcriptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $script:TranscriptWriter = New-Object IO.StreamWriter($transcriptStream, $script:Utf8NoBom)
    $script:TranscriptWriter.AutoFlush = $true

    $previousDisableEnvFile = [Environment]::GetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "Process")
    [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", "1", "Process")
    try {
        Write-TranscriptLine "operation_id=$operationId"
        Write-TranscriptLine "config=$ConfigPath"
        Write-TranscriptLine "config_sha256=$((Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant())"
        Write-TranscriptLine "generation_id=$generationId"

        $selfCheck = Invoke-DatasetSelfCheck $RepositoryRoot $ConfigPath
        Write-TranscriptLine "dataset_self_check_artifacts=$($selfCheck.OperationRoot)"
        if ($selfCheck.ExitCode -ne 0) {
            Write-TranscriptLine "Dataset Preparer self-check No-Go; stopping before dataset volume creation or download"
            Write-UniqueJson (Join-Path $operationRoot "result.json") ([ordered]@{
                schema_version = "v1"
                operation_type = "dataset_prepare"
                status = "dataset_self_check_no_go"
                generation_id = $generationId
                dataset_self_check_exit_code = $selfCheck.ExitCode
                dataset_self_check_artifacts = $selfCheck.OperationRoot
            })
            [Console]::Error.WriteLine("Dataset preparation stopped by Dataset Preparer self-check. Artifacts: $operationRoot")
            return $selfCheck.ExitCode
        }
        $imageId = [string]$selfCheck.ImageId
        Write-TranscriptLine "dataset_preparer_image_id=$imageId"

        $dockerCommand = Get-Command docker -ErrorAction Stop
        $dockerPath = $dockerCommand.Source
        $composeFile = "compose.yaml"
        $imageReference = "$($config.compose_project)-$($config.preparer_service)"

        $publicVolume = "$($config.volume_prefix)-public-$generationId"
        $controlVolume = "$($config.volume_prefix)-control-$generationId"
        $privateVolume = "$($config.volume_prefix)-private-$generationId"
        $volumeNames = @($publicVolume, $controlVolume, $privateVolume)
        Assert-GeneratedVolumeNames $generationId $config.volume_prefix $volumeNames

        $volumeListPath = Join-Path $operationRoot "docker-volumes-before.txt"
        $volumeListExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "volume-preflight" `
            -Arguments @("volume", "ls", "--format", "{{.Name}}") `
            -StandardOutputPath $volumeListPath `
            -StandardErrorPath (Join-Path $operationRoot "docker-volumes-before.stderr.log")
        if ($volumeListExit -ne 0) {
            throw "Unable to list existing Docker volumes"
        }
        $existingVolumeNames = @([IO.File]::ReadAllLines($volumeListPath, $script:Utf8NoBom))
        foreach ($name in $volumeNames) {
            if ($existingVolumeNames -contains $name) {
                throw "Refusing to reuse existing dataset generation volume: $name"
            }
        }

        $environmentNames = @(
            "REPOFIX_PREPARER_IMAGE_ID",
            "REPOFIX_PUBLIC_VOLUME",
            "REPOFIX_CONTROL_VOLUME",
            "REPOFIX_PRIVATE_VOLUME"
        )
        $previousEnvironment = @{}
        foreach ($name in $environmentNames) {
            $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        }
        [Environment]::SetEnvironmentVariable("REPOFIX_PREPARER_IMAGE_ID", $imageId, "Process")
        [Environment]::SetEnvironmentVariable("REPOFIX_PUBLIC_VOLUME", $publicVolume, "Process")
        [Environment]::SetEnvironmentVariable("REPOFIX_CONTROL_VOLUME", $controlVolume, "Process")
        [Environment]::SetEnvironmentVariable("REPOFIX_PRIVATE_VOLUME", $privateVolume, "Process")
        try {
            $preparerName = "repofixlab-dataset-preparer-$($operationId.Substring($operationId.Length - 12))"
            $preparerExit = Invoke-DockerCommand `
                -DockerPath $dockerPath `
                -RepositoryRoot $RepositoryRoot `
                -Label "dataset-preparer-run" `
                -Arguments @(
                    "compose", "-f", $composeFile, "--profile", "dataset-prepare", "run", "--rm", "--no-deps", "--pull", "never",
                    "--name", $preparerName, $config.preparer_service,
                    "prepare",
                    "--source-url", $config.source_url,
                    "--source-sha256", $config.source_sha256,
                    "--generation-id", $generationId,
                    "--public-volume", $publicVolume,
                    "--control-volume", $controlVolume,
                    "--private-volume", $privateVolume
                ) `
                -StandardOutputPath (Join-Path $operationRoot "dataset-lock.json") `
                -StandardErrorPath (Join-Path $operationRoot "dataset-preparer.stderr.log") `
                -EchoOutput
        }
        finally {
            foreach ($name in $environmentNames) {
                [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
            }
        }
        if ($preparerExit -ne 0) {
            throw "Dataset Preparer failed with exit code $preparerExit; staging volumes were retained"
        }

        Assert-ProposedDatasetLock `
            -Path (Join-Path $operationRoot "dataset-lock.json") `
            -Config $config `
            -GenerationId $generationId `
            -PublicVolume $publicVolume `
            -ControlVolume $controlVolume `
            -PrivateVolume $privateVolume `
            -ImageId $imageId

        $postInspectPath = Join-Path $operationRoot "dataset-preparer-image-id-after.txt"
        $postInspectExit = Invoke-DockerCommand `
            -DockerPath $dockerPath `
            -RepositoryRoot $RepositoryRoot `
            -Label "dataset-preparer-image-post-inspect" `
            -Arguments @("image", "inspect", "--format={{.Id}}", $imageReference) `
            -StandardOutputPath $postInspectPath `
            -StandardErrorPath (Join-Path $operationRoot "dataset-preparer-image-post-inspect.stderr.log")
        if ($postInspectExit -ne 0 -or [IO.File]::ReadAllText($postInspectPath, $script:Utf8NoBom).Trim() -cne $imageId) {
            throw "Dataset Preparer image reference changed during preparation"
        }

        Write-UniqueJson (Join-Path $operationRoot "result.json") ([ordered]@{
            schema_version = "v1"
            operation_type = "dataset_prepare"
            status = "prepared"
            generation_id = $generationId
            public_volume = $publicVolume
            control_volume = $controlVolume
            private_volume = $privateVolume
            dataset_preparer_image_id = $imageId
            dataset_lock = "dataset-lock.json"
        })
        Write-TranscriptLine "dataset preparation completed; sealed/staging volumes retained"
        [Console]::Out.WriteLine("Dataset generation prepared. Artifacts: $operationRoot")
        return 0
    }
    catch {
        $message = $_.Exception.Message
        if ($null -ne $script:TranscriptWriter) {
            Write-TranscriptLine "failure: $message"
        }
        $resultPath = Join-Path $operationRoot "result.json"
        if (-not [IO.File]::Exists($resultPath)) {
            Write-UniqueJson $resultPath ([ordered]@{
                schema_version = "v1"
                operation_type = "dataset_prepare"
                status = "failed"
                generation_id = $generationId
                message = $message
            })
        }
        [Console]::Error.WriteLine("Dataset preparation failed: $message")
        [Console]::Error.WriteLine("Artifacts: $operationRoot")
        return 1
    }
    finally {
        [Environment]::SetEnvironmentVariable("COMPOSE_DISABLE_ENV_FILE", $previousDisableEnvFile, "Process")
        if ($null -ne $script:TranscriptWriter) {
            $script:TranscriptWriter.Dispose()
            $script:TranscriptWriter = $null
        }
        $transcriptStream.Dispose()
    }
}

if ($script:CliArguments.Count -eq 1 -and $script:CliArguments[0] -in @("--help", "-h", "help")) {
    Show-Usage
    exit 0
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ($script:CliArguments.Count -ge 2 -and $script:CliArguments[0] -ceq "run" -and $script:CliArguments[1] -ceq "m1") {
    if ($script:CliArguments.Count -eq 2) {
        $m1Config = "configs/experiments/m1-axios.yaml"
    }
    elseif (
        $script:CliArguments.Count -eq 4 -and
        $script:CliArguments[2] -ceq "--config" -and
        $script:CliArguments[3] -ceq "configs/experiments/m1-axios.yaml"
    ) {
        $m1Config = $script:CliArguments[3]
    }
    else {
        Stop-ForUsage "run m1 accepts only the frozen --config configs/experiments/m1-axios.yaml option or no options"
    }
    if ($m1Config -cne "configs/experiments/m1-axios.yaml") {
        Stop-ForUsage "run m1 config must equal configs/experiments/m1-axios.yaml"
    }
    $exitCode = Invoke-M1Run $repositoryRoot
    exit $exitCode
}
if ($script:CliArguments.Count -ge 2 -and $script:CliArguments[0] -ceq "run" -and $script:CliArguments[1] -ceq "m6") {
	$m6Script = Join-Path $PSScriptRoot "repofixlab-m6.ps1"
	$m6Arguments = @($script:CliArguments | Select-Object -Skip 2)
	if ($m6Arguments.Count -ge 1 -and $m6Arguments[0] -ceq "continue") {
		$continuationArguments = @($m6Arguments | Select-Object -Skip 1)
		if ($continuationArguments.Count -eq 2 -and $continuationArguments[0] -ceq "--source-report") {
			& $m6Script -ContinuationSourceReport $continuationArguments[1]
		}
		elseif ($continuationArguments.Count -eq 4 -and $continuationArguments[0] -ceq "--source-report" -and $continuationArguments[2] -ceq "--resume") {
			& $m6Script -ContinuationSourceReport $continuationArguments[1] -ResumeRun $continuationArguments[3]
		}
		elseif ($continuationArguments.Count -eq 4 -and $continuationArguments[0] -ceq "--source-report" -and $continuationArguments[2] -ceq "--secret-file") {
			& $m6Script -ContinuationSourceReport $continuationArguments[1] -SecretFile $continuationArguments[3]
		}
		elseif ($continuationArguments.Count -eq 6 -and $continuationArguments[0] -ceq "--source-report" -and $continuationArguments[2] -ceq "--resume" -and $continuationArguments[4] -ceq "--secret-file") {
			& $m6Script -ContinuationSourceReport $continuationArguments[1] -ResumeRun $continuationArguments[3] -SecretFile $continuationArguments[5]
		}
		else {
			Stop-ForUsage "run m6 continue requires --source-report <sealed calibration report>, with optional --resume and --secret-file"
		}
	}
	elseif ($m6Arguments.Count -eq 0) {
		& $m6Script
	}
	elseif ($m6Arguments.Count -eq 2 -and $m6Arguments[0] -ceq "--resume") {
		& $m6Script -ResumeRun $m6Arguments[1]
	}
	elseif ($m6Arguments.Count -eq 2 -and $m6Arguments[0] -ceq "--secret-file") {
		& $m6Script -SecretFile $m6Arguments[1]
	}
	elseif ($m6Arguments.Count -eq 4 -and $m6Arguments[0] -ceq "--resume" -and $m6Arguments[2] -ceq "--secret-file") {
		& $m6Script -ResumeRun $m6Arguments[1] -SecretFile $m6Arguments[3]
	}
	else {
		Stop-ForUsage "run m6 accepts --resume <m6 staging run>, --secret-file <path>, or continue --source-report <sealed calibration report>"
	}
	exit $LASTEXITCODE
}
if ($script:CliArguments.Count -ge 2 -and $script:CliArguments[0] -ceq "run" -and $script:CliArguments[1] -ceq "m7") {
	$m7Script = Join-Path $PSScriptRoot "repofixlab-m7.ps1"
	$m7Arguments = @($script:CliArguments | Select-Object -Skip 2)
	if ($m7Arguments.Count -eq 0) { & $m7Script }
	elseif ($m7Arguments.Count -eq 2 -and $m7Arguments[0] -ceq "--secret-file") { & $m7Script -SecretFile $m7Arguments[1] }
	else { Stop-ForUsage "run m7 accepts only an optional --secret-file <path>" }
	exit $LASTEXITCODE
}
if ($script:CliArguments.Count -ge 2 -and $script:CliArguments[0] -ceq "images" -and $script:CliArguments[1] -ceq "lock-input") {
    if ($script:CliArguments.Count -ne 2) {
        Stop-ForUsage "images lock-input does not accept options"
    }
    $exitCode = Invoke-ImagesLockInput $repositoryRoot
    exit $exitCode
}
if ($script:CliArguments.Count -ge 2 -and $script:CliArguments[0] -ceq "images" -and $script:CliArguments[1] -ceq "prepare-axios") {
    if ($script:CliArguments.Count -ne 2) {
        Stop-ForUsage "images prepare-axios does not accept options"
    }
    $exitCode = Invoke-ImagesPrepareAxios $repositoryRoot
    exit $exitCode
}
if ($script:CliArguments.Count -ge 2 -and $script:CliArguments[0] -ceq "dataset" -and $script:CliArguments[1] -ceq "self-check") {
    $selfCheckConfigRequest = "configs/dataset/v1.yaml"
    $selfCheckSeenConfig = $false
    for ($index = 2; $index -lt $script:CliArguments.Count; $index++) {
        $option = $script:CliArguments[$index]
        if ($option -cne "--config") {
            Stop-ForUsage "Unknown dataset self-check option: $option"
        }
        if ($selfCheckSeenConfig) {
            Stop-ForUsage "Duplicate option: --config"
        }
        if ($index + 1 -ge $script:CliArguments.Count) {
            Stop-ForUsage "Missing value for --config"
        }
        $selfCheckSeenConfig = $true
        $index++
        $selfCheckConfigRequest = $script:CliArguments[$index]
        if ([String]::IsNullOrWhiteSpace($selfCheckConfigRequest) -or $selfCheckConfigRequest.StartsWith("--")) {
            Stop-ForUsage "Invalid value for --config"
        }
    }
    $resolvedSelfCheckConfigPath = Resolve-ConfigPath $repositoryRoot $selfCheckConfigRequest
    $selfCheckResult = Invoke-DatasetSelfCheck $repositoryRoot $resolvedSelfCheckConfigPath
    exit $selfCheckResult.ExitCode
}
if ($script:CliArguments.Count -lt 2 -or $script:CliArguments[0] -cne "dataset" -or $script:CliArguments[1] -cne "prepare") {
    Stop-ForUsage "Expected command: run m1, run m6, run m7, dataset prepare, dataset self-check, images lock-input, or images prepare-axios"
}

$configRequest = "configs/dataset/v1.yaml"
$generationRequest = ""
$seenOptions = @{}
for ($index = 2; $index -lt $script:CliArguments.Count; $index++) {
    $option = $script:CliArguments[$index]
    if ($option -notin @("--config", "--generation-id")) {
        Stop-ForUsage "Unknown option: $option"
    }
    if ($seenOptions.ContainsKey($option)) {
        Stop-ForUsage "Duplicate option: $option"
    }
    if ($index + 1 -ge $script:CliArguments.Count) {
        Stop-ForUsage "Missing value for $option"
    }
    $seenOptions[$option] = $true
    $index++
    $value = $script:CliArguments[$index]
    if ([String]::IsNullOrWhiteSpace($value) -or $value.StartsWith("--")) {
        Stop-ForUsage "Invalid value for $option"
    }
    if ($option -ceq "--config") {
        $configRequest = $value
    }
    else {
        $generationRequest = $value
    }
}

$resolvedConfigPath = Resolve-ConfigPath $repositoryRoot $configRequest
$exitCode = Invoke-DatasetPrepare $repositoryRoot $resolvedConfigPath $generationRequest
exit $exitCode
