param(
    [ValidateSet("inspect", "update-caddy")]
    [string]$Operation = "inspect",
    [string]$ExpectedSha256 = ""
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

if ($Operation -eq "inspect") { exit 0 }

$CaddyExe = "C:\caddy\caddy.exe"
$ConfigPath = "C:\caddy\Caddyfile"
$Candidate = "C:\web\runtime-payload\caddy.exe"
if ($caddy.ExecutablePath -ne $CaddyExe) { throw "Unexpected production Caddy executable path" }
if ($ExpectedSha256 -notmatch "^[a-fA-F0-9]{64}$") { throw "Candidate SHA256 is required" }
if ((Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash -ne $ExpectedSha256) {
    throw "Candidate SHA256 does not match the audited CI build"
}
$service = Get-CimInstance Win32_Service -Filter "Name = 'Caddy'"
if (!$service -or $service.ProcessId -ne $caddy.ProcessId -or $service.State -ne "Running") {
    throw "Caddy service does not own the running process"
}
$candidateInfo = (& $Candidate build-info | Out-String)
if ($LASTEXITCODE -ne 0 -or $candidateInfo -notmatch "(?m)^go\s+go1\.27\.3\s*$" -or
    $candidateInfo -notmatch "(?m)^dep\s+golang.org/x/net\s+v0\.60\.0\s") {
    throw "Candidate is not the expected Go 1.27.3 / x/net 0.60.0 build"
}
$candidateVersion = (& $Candidate version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $candidateVersion -notmatch "^v2\.11\.7(?:\s|$)") {
    throw "Candidate is not Caddy 2.11.7"
}
$oldModules = @(& $CaddyExe list-modules | Where-Object { $_ -match "^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$" })
if ($LASTEXITCODE -ne 0) { throw "Cannot read current Caddy module IDs" }
$newModules = @(& $Candidate list-modules | Where-Object { $_ -match "^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$" })
if ($LASTEXITCODE -ne 0) { throw "Cannot read candidate Caddy module IDs" }
$missing = @($oldModules | Where-Object { $_ -notin $newModules })
if ($missing.Count) { throw "Candidate is missing production modules: $($missing -join ', ')" }
Write-Output "Module compatibility: $($oldModules.Count) existing modules preserved; $($newModules.Count) candidate modules"

$BackupDir = Join-Path $EvidenceDir ("caddy-backup-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"))
New-Item -ItemType Directory -Path $BackupDir | Out-Null
Copy-Item -LiteralPath $CaddyExe -Destination (Join-Path $BackupDir "caddy.exe")
Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $BackupDir "Caddyfile")
Copy-Item -LiteralPath $modulesPath, $buildPath -Destination $BackupDir
$validationLog = Join-Path $BackupDir "candidate-validation.txt"
function Invoke-CaddyFile([string]$Exe, [string[]]$CommandArguments, [string]$OutputPath, [string]$ErrorPath) {
    $command = Start-Process -FilePath $Exe -ArgumentList $CommandArguments -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $OutputPath -RedirectStandardError $ErrorPath
    if ($command.ExitCode -ne 0) { throw "Caddy preflight failed; private log: $ErrorPath" }
}
Invoke-CaddyFile $Candidate @("validate", "--config", $ConfigPath, "--adapter", "caddyfile") $validationLog (Join-Path $BackupDir "candidate-validation-stderr.txt")
$configJsonPath = Join-Path $BackupDir "config-adapted.json"
Invoke-CaddyFile $CaddyExe @("adapt", "--config", $ConfigPath, "--adapter", "caddyfile") $configJsonPath (Join-Path $BackupDir "adapt-stderr.txt")
$config = Get-Content -LiteralPath $configJsonPath -Raw | ConvertFrom-Json
function Get-RouteHosts($routes) {
    foreach ($route in $routes) {
        foreach ($match in $route.match) { foreach ($site in $match.host) { $site } }
        foreach ($handler in $route.handle) { if ($handler.routes) { Get-RouteHosts $handler.routes } }
    }
}
$hosts = @($config.apps.http.servers.PSObject.Properties.Value | ForEach-Object {
    Get-RouteHosts $_.routes
} | Where-Object { $_ -match "^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$" } | Sort-Object -Unique)
if ("demo.hmcl-helper.cn" -notin $hosts) { throw "Expected PyFeat site is missing from Caddy config" }
function Get-SiteStatus([string]$Site) {
    $status = & curl.exe --silent --show-error --noproxy "*" --resolve "${Site}:443:127.0.0.1" --max-time 10 --output NUL --write-out "%{http_code}" "https://$Site/" 2> $null
    if ($LASTEXITCODE -ne 0) { return 0 }
    return [int]$status
}
$baseline = @{}
foreach ($site in $hosts) {
    $baseline[$site] = Get-SiteStatus $site
    Write-Output "Baseline $site HTTP $($baseline[$site])"
}
if ($baseline["demo.hmcl-helper.cn"] -ne 200) { throw "PyFeat must be healthy before proxy maintenance" }
Write-Output "Private rollback backup: $BackupDir"

$serviceStopped = $false
try {
    $serviceStopped = $true
    Stop-Service -Name Caddy
    (Get-Service -Name Caddy).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    Copy-Item -LiteralPath $Candidate -Destination $CaddyExe -Force
    Start-Service -Name Caddy
    (Get-Service -Name Caddy).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
    $updatedService = Get-CimInstance Win32_Service -Filter "Name = 'Caddy'"
    $updatedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($updatedService.ProcessId)"
    if (!$updatedProcess -or $updatedProcess.ExecutablePath -ne $CaddyExe) {
        throw "Caddy service did not start the expected executable"
    }
    foreach ($site in $hosts) {
        if ($baseline[$site] -eq 0) {
            Write-Output "Existing unavailable health target: $site"
            continue
        }
        $healthy = $false
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            $status = Get-SiteStatus $site
            if ($status -eq $baseline[$site]) {
                $healthy = $true
                break
            }
            Start-Sleep -Seconds 2
        }
        if (!$healthy) { throw "Post-update health failed for $site (HTTP $status, baseline $($baseline[$site]))" }
        Write-Output "Updated $site HTTP $status"
    }
    if ((Get-FileHash -LiteralPath $CaddyExe -Algorithm SHA256).Hash -ne $ExpectedSha256) {
        throw "Installed Caddy hash does not match the audited CI build"
    }
    & $CaddyExe version
    & $CaddyExe build-info | Select-String -Pattern "^go\s|caddyserver/caddy/v2\s|golang.org/x/net\s"
    Write-Output "Caddy security update verified"
} catch {
    $failure = $_
    if ($serviceStopped) {
        Stop-Service -Name Caddy -ErrorAction SilentlyContinue
        (Get-Service -Name Caddy).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
        Copy-Item -LiteralPath (Join-Path $BackupDir "caddy.exe") -Destination $CaddyExe -Force
        Start-Service -Name Caddy
        (Get-Service -Name Caddy).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
        Write-Output "Rollback PyFeat HTTP $(Get-SiteStatus 'demo.hmcl-helper.cn'); backup: $BackupDir"
    }
    throw $failure
}
