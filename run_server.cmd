@echo off
setlocal

set "ROOT=C:\web"
set "PY=%ROOT%\.venv\Scripts\python.exe"
set "PYFEAT_API_URL=http://100.93.165.44:8055"
set "PYFEAT_API_TIMEOUT=10"
set "LOG_DIR=%ROOT%\logs"

cd /d "%ROOT%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
"%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8020 --ws-ping-interval 20 --ws-ping-timeout 180 >> "%LOG_DIR%\web.out.log" 2>> "%LOG_DIR%\web.err.log"
