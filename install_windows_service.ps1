$ErrorActionPreference = "Stop"

$root = "C:\web"
$serviceName = "pyfeat-web"
$toolsDir = Join-Path $root "tools"
$nssmExe = Join-Path $toolsDir "nssm.exe"
$nssmZip = Join-Path $toolsDir "nssm.zip"
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"

if (!(Test-Path $pythonExe)) {
    & (Join-Path $root "install_server_deps.bat")
}

if (!(Test-Path $nssmExe)) {
    New-Item -ItemType Directory -Force $toolsDir | Out-Null
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
    $extractDir = Join-Path $toolsDir "nssm"
    if (Test-Path $extractDir) {
        Remove-Item $extractDir -Recurse -Force
    }
    Expand-Archive -Path $nssmZip -DestinationPath $extractDir -Force
    Copy-Item -Path (Join-Path $extractDir "nssm-2.24\win64\nssm.exe") -Destination $nssmExe -Force
}

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
    & $nssmExe remove $serviceName confirm
}

& $nssmExe install $serviceName "C:\Windows\System32\cmd.exe" "/c C:\web\run_server.cmd"
& $nssmExe set $serviceName AppDirectory $root
& $nssmExe set $serviceName DisplayName "PyFeat Web"
& $nssmExe set $serviceName Description "FastAPI server for demo.hmcl-helper.cn"
& $nssmExe set $serviceName Start SERVICE_AUTO_START
& $nssmExe set $serviceName AppStdout (Join-Path $root "pyfeat-web.out.log")
& $nssmExe set $serviceName AppStderr (Join-Path $root "pyfeat-web.err.log")

Start-Service -Name $serviceName
Get-Service -Name $serviceName
