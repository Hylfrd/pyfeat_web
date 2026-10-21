param(
    [ValidateSet("inspect")]
    [string]$Operation = "inspect"
)

$ErrorActionPreference = "Stop"
$EvidenceDir = "C:\web\.runtime"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $EvidenceDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cannot restrict runtime evidence directory permissions" }

$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'caddy.exe'")
if ($processes.Count -ne 1) { throw "Expected one running Caddy process; found $($processes.Count)" }
$caddy = $processes[0]
Write-Output "Caddy executable: $($caddy.ExecutablePath)"
Write-Output "Caddy process ID: $($caddy.ProcessId)"
Write-Output "Caddy command: $($caddy.CommandLine)"
Get-CimInstance Win32_Service | Where-Object ProcessId -EQ $caddy.ProcessId |
    Select-Object Name, State, StartMode, StartName, PathName | Format-List | Out-String | Write-Output
Get-ScheduledTask | Where-Object {
    ($_.Actions | Out-String) -match "caddy"
} | Select-Object TaskName, TaskPath, State, Actions | Format-List | Out-String | Write-Output
Get-NetTCPConnection -State Listen | Where-Object OwningProcess -EQ $caddy.ProcessId |
    Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table | Out-String | Write-Output

$modulesPath = Join-Path $EvidenceDir "caddy-before-modules.txt"
$buildPath = Join-Path $EvidenceDir "caddy-before-build-info.txt"
& $caddy.ExecutablePath list-modules --packages --versions | Tee-Object -FilePath $modulesPath
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Caddy modules" }
& $caddy.ExecutablePath build-info | Tee-Object -FilePath $buildPath
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Caddy build information" }
Get-FileHash -LiteralPath $caddy.ExecutablePath -Algorithm SHA256 | Format-List | Out-String | Write-Output
Write-Output "Module evidence: $modulesPath"
Write-Output "Build evidence: $buildPath"
