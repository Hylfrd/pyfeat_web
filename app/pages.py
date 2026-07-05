from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

router = APIRouter()


@router.get("/")
async def participant_page():
    """Serve participant HTML."""
    return FileResponse(STATIC_DIR / "participant.html", headers=NO_STORE_HEADERS)


@router.get("/admin")
async def admin_page():
    """Serve experimenter dashboard."""
    admin_html = STATIC_DIR / "admin.html"
    asset_version = int(max(
        admin_html.stat().st_mtime,
        (STATIC_DIR / "admin.css").stat().st_mtime,
        (STATIC_DIR / "admin.js").stat().st_mtime,
    ))
    html = admin_html.read_text(encoding="utf-8").replace("__ASSET_VERSION__", str(asset_version))
    return HTMLResponse(html, headers=NO_STORE_HEADERS)
