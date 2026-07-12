from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
DIST_DIR = STATIC_DIR / "dist"
TEMP_TEST_FILE = Path("C:/Users/Administrator/Desktop/7.bin")
NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

router = APIRouter()


def _range_iter(path: Path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open("rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _range_file_response(path: Path, filename: str, range_header: str | None):
    if not path.exists() or not path.is_file():
        raise HTTPException(404, f"Test file not found: {path}")
    size = path.stat().st_size
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    if range_header and range_header.startswith("bytes="):
        spec = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
        start_text, _, end_text = spec.partition("-")
        try:
            if start_text:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
            else:
                suffix = int(end_text)
                start = max(0, size - suffix)
                end = size - 1
        except ValueError as exc:
            raise HTTPException(416, "Invalid range") from exc
        if start < 0 or end < start or start >= size:
            raise HTTPException(416, "Requested range not satisfiable")
        end = min(end, size - 1)
        headers.update({
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
            "Content-Disposition": f'attachment; filename="{filename}"',
        })
        return StreamingResponse(
            _range_iter(path, start, end),
            status_code=206,
            media_type="application/octet-stream",
            headers=headers,
        )
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=filename,
        headers=headers,
    )


@router.get("/")
async def participant_page():
    """Serve participant HTML."""
    participant_html = STATIC_DIR / "participant.html"
    participant_assets = [
        participant_html,
        DIST_DIR / "participant.css",
        DIST_DIR / "participant.js",
    ]
    asset_version = int(max(path.stat().st_mtime for path in participant_assets))
    html = participant_html.read_text(encoding="utf-8").replace("__ASSET_VERSION__", str(asset_version))
    return HTMLResponse(html, headers=NO_STORE_HEADERS)


@router.get("/test-7bin")
async def test_7bin_download(range_header: str | None = Header(None, alias="Range")):
    """Temporary public test download endpoint for server throughput checks."""
    return _range_file_response(TEMP_TEST_FILE, "7.bin", range_header)


@router.get("/admin")
async def admin_page():
    """Serve experimenter dashboard."""
    admin_html = STATIC_DIR / "admin.html"
    admin_assets = [
        admin_html,
        DIST_DIR / "admin.css",
        DIST_DIR / "admin.js",
    ]
    asset_version = int(max(path.stat().st_mtime for path in admin_assets))
    html = admin_html.read_text(encoding="utf-8").replace("__ASSET_VERSION__", str(asset_version))
    return HTMLResponse(html, headers=NO_STORE_HEADERS)
