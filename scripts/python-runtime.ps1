$ErrorActionPreference = "Stop"
$Root = "C:\web"
$RuntimeDir = Join-Path $Root ".runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $RuntimeDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cannot restrict private Python runtime permissions" }

$Package = Join-Path $Root "runtime-payload\python.3.13.16.nupkg"
$PackageHash = "95fad176338f1d6a799e45946488063f4aa61764e6cff2f132ddeffbf7a04c34"
if ((Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash -ne $PackageHash) {
    throw "Official Python NuGet package hash mismatch"
}
$PrivatePython = Join-Path $RuntimeDir "python-3.13.16"
$PythonExe = Join-Path $PrivatePython "tools\python.exe"
if (!(Test-Path -LiteralPath $PrivatePython)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Package, $PrivatePython)
}
foreach ($file in @($PythonExe, (Join-Path $PrivatePython "tools\python313.dll"))) {
    $signature = Get-AuthenticodeSignature -FilePath $file
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Python Software Foundation") {
        throw "Official Python binary signature validation failed"
    }
}
$version = (& $PythonExe -I -c "import sys; print(sys.version.split()[0])" | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne "3.13.16") { throw "Private Python version mismatch" }
$VenvName = "venv-3.13.16"
$VenvDir = Join-Path $RuntimeDir $VenvName
$VenvExe = Join-Path $VenvDir "Scripts\python.exe"
if (!(Test-Path -LiteralPath $VenvExe)) {
    & $PythonExe -I -m venv --copies $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "Private Python virtual environment creation failed" }
}
& $VenvExe -I -m pip install --upgrade pip --index-url https://pypi.org/simple
if ($LASTEXITCODE -ne 0) { throw "Private Python pip upgrade failed" }
& $VenvExe -I -m pip install --require-hashes -r (Join-Path $Root "requirements.txt") --index-url https://pypi.org/simple
if ($LASTEXITCODE -ne 0) { throw "Private Python locked dependency installation failed" }
& $VenvExe -I -m pip check
if ($LASTEXITCODE -ne 0) { throw "Private Python dependency compatibility failed" }
& $VenvExe -I -c "import sys, ssl; assert sys.version_info[:3] == (3, 13, 16); assert sys.prefix != sys.base_prefix; print('Private Python:', sys.version); print('TLS library:', ssl.OPENSSL_VERSION); print('Private venv:', sys.prefix); print('Private base:', sys.base_prefix)"
if ($LASTEXITCODE -ne 0) { throw "Private Python isolation check failed" }

if (Get-NetTCPConnection -State Listen -LocalPort 18021 -ErrorAction SilentlyContinue) {
    throw "Private smoke-test port is already in use"
}
$smokeProcess = Start-Process -FilePath $VenvExe -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "18021") -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RuntimeDir "python-smoke.stdout.txt") -RedirectStandardError (Join-Path $RuntimeDir "python-smoke.stderr.txt")
function Test-SmokeAncestor([int]$ProcessId) {
    for ($depth = 0; $depth -lt 8; $depth++) {
        if ($ProcessId -eq $smokeProcess.Id) { return $true }
        $node = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
        if (!$node) { return $false }
        $ProcessId = $node.ParentProcessId
    }
    return $false
}
function Stop-SmokeChildren([int]$ParentId) {
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId")) {
        Stop-SmokeChildren $child.ProcessId
        if ($child.ExecutablePath -in @($VenvExe, $PythonExe) -and $child.CommandLine -like "*$VenvExe*") {
            Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}
try {
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($smokeProcess.HasExited) { throw "Private Python app exited; see private smoke logs" }
        & curl.exe --fail --silent --output NUL --max-time 2 http://127.0.0.1:18021/ 2> $null
        if ($LASTEXITCODE -eq 0) {
            $listener = Get-NetTCPConnection -State Listen -LocalPort 18021
            $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
            if (!(Test-SmokeAncestor $listener.OwningProcess) -or
                $listenerProcess.ExecutablePath -notin @($VenvExe, $PythonExe)) {
                throw "Private smoke listener process mismatch"
            }
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (!$healthy) { throw "Private Python application smoke failed" }
    Write-Output "Private Python 3.13.16 application smoke HTTP 200"
} finally {
    Stop-SmokeChildren $smokeProcess.Id
    if (!$smokeProcess.HasExited) { Stop-Process -Id $smokeProcess.Id -Force -ErrorAction SilentlyContinue }
}

$Selector = Join-Path $RuntimeDir "python-active.txt"
$BackupDir = Join-Path $RuntimeDir ("python-backup-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"))
New-Item -ItemType Directory -Path $BackupDir | Out-Null
$previousSelector = Test-Path -LiteralPath $Selector
if ($previousSelector) { Copy-Item -LiteralPath $Selector -Destination (Join-Path $BackupDir "python-active.txt") }
$switched = $false
$NextSelector = Join-Path $RuntimeDir "python-active.next"
try {
    [IO.File]::WriteAllText($NextSelector, $VenvName)
    $switched = $true
    Move-Item -LiteralPath $NextSelector -Destination $Selector -Force
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "deploy.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Private Python application switch failed" }
    $activeListener = Get-NetTCPConnection -State Listen -LocalPort 8020
    $activeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($activeListener.OwningProcess)"
    if (!$activeProcess -or $activeProcess.ExecutablePath -notin @($VenvExe, $PythonExe) -or
        $activeProcess.CommandLine -notlike "*$VenvExe*") {
        throw "Application did not start with the private Python executable"
    }
    & $VenvExe -I -c "import sys, ssl; print('Active app Python:', sys.version.split()[0]); print('Active app OpenSSL:', ssl.OPENSSL_VERSION)"
    Write-Output "Active app process: $($activeProcess.ProcessId); executable: $($activeProcess.ExecutablePath)"
    & (Join-Path $Root ".venv\Scripts\python.exe") --version
    Write-Output "Original Python environment retained at C:\web\.venv"
    Write-Output "Private Python security update verified; selector: $Selector; rollback: $BackupDir"
} catch {
    $failure = $_
    if ($switched) {
        if ($previousSelector) {
            Copy-Item -LiteralPath (Join-Path $BackupDir "python-active.txt") -Destination $NextSelector -Force
            Move-Item -LiteralPath $NextSelector -Destination $Selector -Force
        } else {
            Remove-Item -LiteralPath $Selector -ErrorAction SilentlyContinue
        }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "deploy.ps1")
        if ($LASTEXITCODE -ne 0) { throw "Private Python switch and rollback failed; backup: $BackupDir" }
        Write-Output "Previous Python application environment restored"
    }
    throw $failure
} finally {
    Remove-Item -LiteralPath $NextSelector -ErrorAction SilentlyContinue
}
