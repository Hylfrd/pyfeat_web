$ErrorActionPreference = "Stop"

$root = "C:\web"
$taskName = "pyfeat-web"
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"
$runScript = Join-Path $root "run_server.cmd"
$logDir = Join-Path $root "logs"
$outLog = Join-Path $logDir "web.out.log"
$errLog = Join-Path $logDir "web.err.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (!(Test-Path $pythonExe)) {
    & (Join-Path $root "install_server_deps.bat")
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$actionArgs = "/c `"`"$runScript`" 1>>`"$outLog`" 2>>`"$errLog`"`""
$action = New-ScheduledTaskAction -Execute "C:\Windows\System32\cmd.exe" -Argument $actionArgs -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal | Out-Null
Get-ScheduledTask -TaskName $taskName
