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
    participant_html = STATIC_DIR / "participant.html"
    participant_assets = [
        participant_html,
        STATIC_DIR / "participant.css",
        STATIC_DIR / "participant.js",
    ]
    asset_version = int(max(path.stat().st_mtime for path in participant_assets))
    html = participant_html.read_text(encoding="utf-8").replace("__ASSET_VERSION__", str(asset_version))
    return HTMLResponse(html, headers=NO_STORE_HEADERS)


@router.get("/admin")
async def admin_page():
    """Serve experimenter dashboard."""
    admin_html = STATIC_DIR / "admin.html"
    admin_assets = [
        admin_html,
        STATIC_DIR / "admin.css",
        *STATIC_DIR.glob("admin_*.js"),
    ]
    asset_version = int(max(path.stat().st_mtime for path in admin_assets))
    html = admin_html.read_text(encoding="utf-8").replace("__ASSET_VERSION__", str(asset_version))
    return HTMLResponse(html, headers=NO_STORE_HEADERS)
