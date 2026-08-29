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
$VerificationScript = Join-Path $Root "deployment_verify.py"
$AuditDir = "C:\Users\Administrator\Desktop\temp3"
$DeploymentRunId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PID"
$BeforeReport = Join-Path $AuditDir "pyfeat-db-$DeploymentRunId-before.json"
$AfterReport = Join-Path $AuditDir "pyfeat-db-$DeploymentRunId-after.json"
$Port = 8020
$PyFeatApiUrl = "http://100.93.165.44:8055"
$PyFeatApiTimeout = "10"
$StartedPid = $null

function Ensure-Directories {
    New-Item -ItemType Directory -Force -Path $Root, $LogDir, $AuditDir | Out-Null
}

function Install-Dependencies {
    Set-Location $Root
    if (!(Test-Path $PythonExe)) {
        & $PythonCommand $PythonVersion -m venv $Venv
    }
    & $PythonExe -m pip install --upgrade pip -i https://mirrors.aliyun.com/pypi/simple/
    & $PythonExe -m pip install -r (Join-Path $Root "requirements.txt") -i https://mirrors.aliyun.com/pypi/simple/
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

function Move-ExistingLogs {
    $logs = Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^web\.(out|err)\.log(\.\d+)?$' }
    foreach ($log in $logs) {
        $destination = Join-Path $AuditDir "$($log.Name).before-$DeploymentRunId"
        Move-Item -LiteralPath $log.FullName -Destination $destination
        Write-Output "Moved log to $destination"
    }
}

function Run-DatabaseVerification {
    param([Parameter(Mandatory = $true)][string]$Stage)

    $arguments = @(
        $VerificationScript,
        "--db", (Join-Path $Root "data\experiment.db"),
        "--output", $(if ($Stage -eq "before") { $BeforeReport } else { $AfterReport }),
        "--stage", $Stage
    )
    if ($Stage -eq "after") {
        $arguments += @("--baseline", $BeforeReport)
    }
    & $PythonExe @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Database verification failed at stage '$Stage'. ExitCode=$LASTEXITCODE"
    }
}

function Test-AppImport {
    Set-Location $Root
    $env:PYFEAT_API_URL = $PyFeatApiUrl
    $env:PYFEAT_API_TIMEOUT = $PyFeatApiTimeout
    & $PythonExe -c "import app.main"
    if ($LASTEXITCODE -ne 0) {
        throw "Application import verification failed. ExitCode=$LASTEXITCODE"
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
Install-Dependencies
Stop-App
Start-Sleep -Seconds 1
Run-DatabaseVerification -Stage "before"
Move-ExistingLogs
Test-AppImport
Run-DatabaseVerification -Stage "after"
Start-AppDetached
Register-AppTask
Wait-Healthy
