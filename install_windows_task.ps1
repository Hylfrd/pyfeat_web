$ErrorActionPreference = "Stop"

$root = "C:\web"
$taskName = "pyfeat-web"
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"
$runScript = Join-Path $root "run_server.cmd"

if (!(Test-Path $pythonExe)) {
    & (Join-Path $root "install_server_deps.bat")
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "C:\Windows\System32\cmd.exe" -Argument "/c `"$runScript`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit 0

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName
