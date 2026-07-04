from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response


ROOT_DIR = Path(__file__).resolve().parent.parent
ADMIN_COOKIE = "admin_token"

router = APIRouter()


def _env_value(key: str) -> str:
    value = os.getenv(key)
    if value:
        return value.strip().strip('"').strip("'")
    env_path = ROOT_DIR / ".env"
    if not env_path.exists():
        return ""
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            name, item = raw.split("=", 1)
            if name.strip() == key:
                return item.strip().strip('"').strip("'")
    return ""


def _admin_token() -> str:
    return _env_value("TOKEN")


def _admin_allowed(request: Request) -> bool:
    token = _admin_token()
    sent = request.cookies.get(ADMIN_COOKIE, "")
    return bool(token) and secrets.compare_digest(sent, token)


def require_admin(request: Request):
    if not _admin_allowed(request):
        raise HTTPException(status_code=401, detail="Admin token required")


@router.get("/api/admin/auth")
async def admin_auth(_: None = Depends(require_admin)):
    return {"ok": True}


@router.post("/api/admin/login")
async def admin_login(request: Request, response: Response, token: str = Form(...)):
    expected = _admin_token()
    if not expected:
        raise HTTPException(status_code=503, detail="Admin token is not configured")
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid admin token")
    response.set_cookie(
        ADMIN_COOKIE,
        token,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
    )
    return {"ok": True}


@router.post("/api/admin/logout")
async def admin_logout(response: Response):
    response.delete_cookie(ADMIN_COOKIE)
    return {"ok": True}
