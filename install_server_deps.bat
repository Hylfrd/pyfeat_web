@echo off
setlocal

set "ROOT=C:\web"
set "PYTHON=py -3.13"
set "VENV=%ROOT%\.venv"
set "PIP=%VENV%\Scripts\python.exe"

cd /d "%ROOT%"

if not exist "%VENV%\Scripts\python.exe" (
  %PYTHON% -m venv "%VENV%"
)

"%PIP%" -m pip install --upgrade pip -i https://mirrors.aliyun.com/pypi/simple/
"%PIP%" -m pip install -r "%ROOT%\requirements.txt" -i https://mirrors.aliyun.com/pypi/simple/

pause
