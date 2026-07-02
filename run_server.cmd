@echo off
setlocal

set "ROOT=C:\web"
set "PY=%ROOT%\.venv\Scripts\python.exe"
set "PYFEAT_API_URL=http://100.93.165.44:8055"
set "PYFEAT_API_TIMEOUT=10"

cd /d "%ROOT%"
"%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8020
