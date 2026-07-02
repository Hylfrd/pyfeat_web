$ErrorActionPreference = "Stop"

$root = "C:\web"
$serviceName = "pyfeat-web"
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"

cd $root

if (!(Test-Path $pythonExe)) {
    & (Join-Path $root "install_server_deps.bat")
} else {
    & $pythonExe -m pip install -r (Join-Path $root "requirements.txt") -i https://mirrors.aliyun.com/pypi/simple/
}

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (!$service) {
    & (Join-Path $root "install_windows_service.ps1")
} else {
    Restart-Service -Name $serviceName -Force
    Get-Service -Name $serviceName
}
