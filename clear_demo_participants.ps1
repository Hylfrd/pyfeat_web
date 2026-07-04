param(
    [string]$Root = "C:\web",
    [string]$TaskName = "pyfeat-web",
    [switch]$Execute,
    [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

$expectedRoot = "C:\web"
$rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
$expectedPath = [System.IO.Path]::GetFullPath($expectedRoot).TrimEnd('\')

if ($rootPath -ne $expectedPath) {
    throw "Refusing to run outside $expectedRoot. Got: $rootPath"
}

$dataDir = Join-Path $rootPath "data"
$runScript = Join-Path $rootPath "run_server.cmd"

if (!(Test-Path $rootPath)) {
    throw "Root path does not exist: $rootPath"
}
if (!(Test-Path $runScript)) {
    throw "This does not look like the demo server root. Missing: $runScript"
}
if (!(Test-Path $dataDir)) {
    Write-Output "No data directory found: $dataDir"
    Write-Output "Nothing to clear."
    exit 0
}

function Assert-InDataDir {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $base = [System.IO.Path]::GetFullPath($dataDir).TrimEnd('\') + '\'
    if (!$full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to touch path outside data directory: $full"
    }
}

$targets = @(
    "experiment.db",
    "experiment.db-wal",
    "experiment.db-shm",
    "debrief.jsonl",
    "debug_events.jsonl",
    "debug_state.json",
    "videos",
    "debug_images"
) | ForEach-Object { Join-Path $dataDir $_ }

$existingTargets = @($targets | Where-Object { Test-Path $_ })

Write-Output "Demo participant data clear script"
Write-Output "Root: $rootPath"
Write-Output "Task: $TaskName"
Write-Output ""
Write-Output "Targets:"
if ($existingTargets.Count -eq 0) {
    Write-Output "  No known participant-data targets found."
} else {
    foreach ($target in $existingTargets) {
        Assert-InDataDir $target
        Write-Output "  $target"
    }
}

if (!$Execute) {
    Write-Output ""
    Write-Output "Dry run only. Nothing was deleted."
    Write-Output "To actually clear demo data, run:"
    Write-Output "  powershell -ExecutionPolicy Bypass -File C:\web\clear_demo_participants.ps1 -Execute"
    exit 0
}

if ($existingTargets.Count -eq 0) {
    Write-Output "Nothing to delete."
    exit 0
}

Write-Output ""
Write-Output "This will delete demo.hmcl-helper.cn participant data from $dataDir."
$confirmation = Read-Host "Type DELETE DEMO DATA to continue"
if ($confirmation -ne "DELETE DEMO DATA") {
    Write-Output "Confirmation did not match. Aborted."
    exit 2
}

Write-Output "Stopping scheduled task and local server process..."
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

$lines = netstat -ano | Select-String ":8020"
foreach ($line in $lines) {
    $parts = $line.ToString().Trim() -split "\s+"
    if ($parts.Length -ge 5 -and $parts[3] -eq "LISTENING") {
        $pidValue = [int]$parts[4]
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1

if (!$NoBackup) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupDir = Join-Path $dataDir ("backups\before-clear-" + $stamp)
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    foreach ($target in $existingTargets) {
        Assert-InDataDir $target
        $name = Split-Path $target -Leaf
        Copy-Item -LiteralPath $target -Destination (Join-Path $backupDir $name) -Recurse -Force
    }
    Write-Output "Backup written to: $backupDir"
} else {
    Write-Output "Backup skipped because -NoBackup was supplied."
}

Write-Output "Deleting participant data..."
foreach ($target in $existingTargets) {
    Assert-InDataDir $target
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Output "Deleted: $target"
}

Write-Output "Restarting scheduled task..."
Start-ScheduledTask -TaskName $TaskName

$healthy = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    & curl.exe --fail --silent --show-error --output NUL --max-time 2 "http://127.0.0.1:8020/"
    if ($LASTEXITCODE -eq 0) {
        $healthy = $true
        break
    }
}

if (!$healthy) {
    Write-Output "Data was cleared, but the web app did not become healthy on 127.0.0.1:8020."
    Write-Output "Check C:\web\logs\web.err.log on the server."
    exit 7
}

Write-Output "Done. Demo participant data has been cleared and the web app is healthy."
