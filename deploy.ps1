param(
    [switch]$RunServer
)

$ErrorActionPreference = "Stop"

$Root = "C:\web"
$TaskName = "pyfeat-web"
$PythonCommand = "py"
$PythonVersion = "-3.13"
$Venv = Join-Path $Root ".venv"
$PythonExe = Join-Path $Venv "Scripts\python.exe"
$LogDir = Join-Path $Root "logs"
$OutLog = Join-Path $LogDir "web.out.log"
$ErrLog = Join-Path $LogDir "web.err.log"
$LogConfig = Join-Path $Root "logging.json"
$Port = 8020
$PyFeatApiUrl = "http://100.93.165.44:8055"
$PyFeatApiTimeout = "10"
$StartedPid = $null

function Ensure-Directories {
    New-Item -ItemType Directory -Force -Path $Root, $LogDir | Out-Null
}

function Install-Dependencies {
    Set-Location $Root
    if (!(Test-Path $PythonExe)) {
        & $PythonCommand $PythonVersion -m venv $Venv
        if ($LASTEXITCODE -ne 0) { throw "Failed to create Python virtual environment" }
    }
    & $PythonExe --version
    Write-Output "Python dependencies before upgrade:"
    & $PythonExe -m pip list --format=freeze
    & $PythonExe -m pip install --upgrade pip --index-url https://pypi.org/simple
    if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip" }
    & $PythonExe -m pip install --upgrade --require-hashes -r (Join-Path $Root "requirements.txt") --index-url https://pypi.org/simple
    if ($LASTEXITCODE -ne 0) { throw "Failed to install locked Python dependencies" }
    & $PythonExe -m pip check
    if ($LASTEXITCODE -ne 0) { throw "Python dependency compatibility check failed" }
    Write-Output "Python dependencies after upgrade:"
    & $PythonExe -m pip list --format=freeze
}

function Show-WebRuntime {
    $phpProcesses = @(Get-Process -Name php, php-cgi, php-fpm, frankenphp -ErrorAction SilentlyContinue)
    Write-Output "Running PHP/FrankenPHP processes: $($phpProcesses.Count)"
    $phpProcesses | Select-Object ProcessName, Id, Path | Format-Table | Out-String | Write-Output
    $caddyProcess = Get-Process -Name caddy -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($caddyProcess -and $caddyProcess.Path) {
        & $caddyProcess.Path version
        & $caddyProcess.Path build-info
        if ($LASTEXITCODE -ne 0) { throw "Failed to inspect running Caddy build information" }
        $phpModules = @(& $caddyProcess.Path list-modules | Select-String -Pattern "php")
        if ($LASTEXITCODE -ne 0) { throw "Failed to inspect running Caddy modules" }
        Write-Output "Caddy PHP modules: $($phpModules.Count)"
        $phpModules | Write-Output
    }
}

function Start-AppProcess {
    Ensure-Directories
    Set-Location $Root
    if (!(Test-Path $PythonExe)) {
        throw "Python executable not found: $PythonExe"
    }
    $env:PYFEAT_API_URL = $PyFeatApiUrl
    $env:PYFEAT_API_TIMEOUT = $PyFeatApiTimeout
    & $PythonExe -m uvicorn app.main:app --host 127.0.0.1 --port $Port --ws-ping-interval 20 --ws-ping-timeout 180 --log-config $LogConfig
}

function Start-AppDetached {
    Ensure-Directories
    Set-Location $Root
    if (!(Test-Path $PythonExe)) {
        throw "Python executable not found: $PythonExe"
    }

    $command = @(
        "cd /d $Root",
        "set PYFEAT_API_URL=$PyFeatApiUrl",
        "set PYFEAT_API_TIMEOUT=$PyFeatApiTimeout",
        "$PythonExe -m uvicorn app.main:app --host 127.0.0.1 --port $Port --ws-ping-interval 20 --ws-ping-timeout 180 --log-config $LogConfig"
    ) -join " && "
    $result = Invoke-CimMethod `
        -ClassName Win32_Process `
        -MethodName Create `
        -Arguments @{ CommandLine = "cmd.exe /d /c `"$command`"" }
    if ($result.ReturnValue -ne 0) {
        throw "Failed to start app process via WMI. ReturnValue=$($result.ReturnValue)"
    }
    $script:StartedPid = $result.ProcessId
    Write-Output "Started app process PID $($result.ProcessId)"
}

function Register-AppTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    $script = Join-Path $Root "deploy.ps1"
    $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -RunServer"
    $action = New-ScheduledTaskAction -Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $argument -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal | Out-Null
}

function Stop-App {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $lines = netstat -ano | Select-String ":$Port"
    foreach ($line in $lines) {
        $parts = $line.ToString().Trim() -split "\s+"
        if ($parts.Length -ge 5 -and $parts[3] -eq "LISTENING") {
            Stop-Process -Id ([int]$parts[4]) -Force -ErrorAction SilentlyContinue
        }
    }
}

function Wait-Healthy {
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        & curl.exe --fail --silent --show-error --output NUL --max-time 2 "http://127.0.0.1:$Port/"
        if ($LASTEXITCODE -eq 0) {
            Write-Output "HTTP 200"
            return
        }
    }

    Write-Output "Server failed to become healthy on 127.0.0.1:$Port"
    Write-Output "Listening ports:"
    netstat -ano | Select-String ":$Port" | Write-Output
    Write-Output "Scheduled task:"
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List | Out-String | Write-Output
    if ($script:StartedPid) {
        Write-Output "Started process:"
        Get-Process -Id $script:StartedPid -ErrorAction SilentlyContinue | Format-List | Out-String | Write-Output
    }
    Write-Output "stdout log:"
    if (Test-Path $OutLog) {
        Get-Content $OutLog -Tail 120 | Write-Output
    }
    Write-Output "stderr log:"
    if (Test-Path $ErrLog) {
        Get-Content $ErrLog -Tail 120 | Write-Output
    }
    exit 7
}

if ($RunServer) {
    Start-AppProcess
    exit $LASTEXITCODE
}

Ensure-Directories
Show-WebRuntime
Install-Dependencies
Stop-App
Start-Sleep -Seconds 1
Start-AppDetached
Register-AppTask
Wait-Healthy
