$ErrorActionPreference = "Stop"

$root = "C:\web"
$serviceName = "pyfeat-web"
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"
$taskName = "pyfeat-web"

cd $root

if (!(Test-Path $pythonExe)) {
    & (Join-Path $root "install_server_deps.bat")
} else {
    & $pythonExe -m pip install -r (Join-Path $root "requirements.txt") -i https://mirrors.aliyun.com/pypi/simple/
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (!$task) {
    & (Join-Path $root "install_windows_task.ps1")
}

$lines = netstat -ano | Select-String ":8020"
foreach ($line in $lines) {
    $parts = $line.ToString().Trim() -split "\s+"
    if ($parts.Length -ge 5 -and $parts[3] -eq "LISTENING") {
        $pidValue = [int]$parts[4]
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

& curl.exe --fail --silent --show-error --output NUL --max-time 20 "http://127.0.0.1:8020/"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Output "HTTP 200"
