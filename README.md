# PyFeat Web

FastAPI experiment web app for the PyFeat demo.

## Server

Files are deployed to `C:\web` on the Windows server.

First-time setup on the server:

```powershell
C:\web\install_server_deps.bat
C:\web\install_windows_task.ps1
```

Manual start:

```powershell
C:\web\start_server.bat
```

App restart:

```powershell
C:\web\deploy_restart.ps1
```

The app listens on `127.0.0.1:8020`. Caddy should reverse proxy `demo.hmcl-helper.cn` to this local port.
