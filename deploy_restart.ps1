$ErrorActionPreference = "Stop"

$root = "C:\web"
$serviceName = "pyfeat-web"
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"
$taskName = "pyfeat-web"
$runScript = Join-Path $root "run_server.cmd"
$logDir = Join-Path $root "logs"
$outLog = Join-Path $logDir "web.out.log"
$errLog = Join-Path $logDir "web.err.log"

cd $root
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (!(Test-Path $pythonExe)) {
    & (Join-Path $root "install_server_deps.bat")
} else {
    & $pythonExe -m pip install -r (Join-Path $root "requirements.txt") -i https://mirrors.aliyun.com/pypi/simple/
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (!$task) {
    & (Join-Path $root "install_windows_task.ps1")
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

$lines = netstat -ano | Select-String ":8020"
foreach ($line in $lines) {
    $parts = $line.ToString().Trim() -split "\s+"
    if ($parts.Length -ge 5 -and $parts[3] -eq "LISTENING") {
        $pidValue = [int]$parts[4]
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1
if (Test-Path $outLog) {
    Remove-Item $outLog -Force
}
if (Test-Path $errLog) {
    Remove-Item $errLog -Force
}

Start-Process `
    -FilePath "C:\Windows\System32\cmd.exe" `
    -ArgumentList @("/c", "`"$runScript`"") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    & curl.exe --fail --silent --show-error --output NUL --max-time 2 "http://127.0.0.1:8020/"
    if ($LASTEXITCODE -eq 0) {
        $healthy = $true
        break
    }
}

if (!$healthy) {
    Write-Output "Server failed to become healthy on 127.0.0.1:8020"
    Write-Output "Listening ports:"
    netstat -ano | Select-String ":8020" | Write-Output
    Write-Output "Scheduled task:"
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Format-List | Out-String | Write-Output
    Write-Output "stdout log:"
    if (Test-Path $outLog) {
        Get-Content $outLog -Tail 120 | Write-Output
    }
    Write-Output "stderr log:"
    if (Test-Path $errLog) {
        Get-Content $errLog -Tail 120 | Write-Output
    }
    exit 7
}

Write-Output "HTTP 200"
