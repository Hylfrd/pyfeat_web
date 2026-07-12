from __future__ import annotations

import base64
import json
import os
import re
import secrets
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

import httpx
from fastapi import HTTPException

from .ai_client import (
    WRITING_API_KEY, WRITING_BASE_URL, WRITING_MODEL,
    EVALUATOR_API_KEY, EVALUATOR_BASE_URL, EVALUATOR_MODEL,
)
from .expression import PYFEAT_API_URL

ROOT_DIR = Path(__file__).resolve().parent.parent
DEBUG_LOG_PATH = ROOT_DIR / "data" / "debug_events.jsonl"
DEBUG_STATE_PATH = ROOT_DIR / "data" / "debug_state.json"
DEBUG_IMAGE_DIR = ROOT_DIR / "data" / "debug_images"
DEBUG_LINE_CHUNK_BYTES = 64 * 1024
DEBUG_MAX_SCAN_LINES = 5000
debug_events = deque(maxlen=300)
debug_lock = threading.Lock()

STRATEGY_TRIGGER_KEYS = (
    "_au4_present",
    "_au4_rising",
    "_input_shrinking",
    "_sustained_present",
    "_idle_with_au1",
    "_au4_slope",
    "_au4_dropping",
)

def _frame_bytes(image_base64: str) -> int:
    value = image_base64.split(",", 1)[-1]
    padding = value.count("=")
    return max(0, int(len(value) * 3 / 4) - padding)

def _debug_image(image_base64: str) -> Optional[str]:
    if not image_base64:
        return None
    try:
        header, payload = image_base64.split(",", 1) if "," in image_base64 else ("", image_base64)
        ext = "jpg"
        if "png" in header.lower():
            ext = "png"
        elif "webp" in header.lower():
            ext = "webp"
        image_bytes = base64.b64decode(payload)
        DEBUG_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{int(time.time() * 1000)}-{secrets.token_hex(4)}.{ext}"
        (DEBUG_IMAGE_DIR / filename).write_bytes(image_bytes)
        return f"/api/admin/debug-image/{filename}"
    except Exception:
        return None

def _debug_image_cache() -> dict:
    if not DEBUG_IMAGE_DIR.exists():
        return {"count": 0, "bytes": 0, "kb": 0.0}
    files = [p for p in DEBUG_IMAGE_DIR.iterdir() if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    return {
        "count": len(files),
        "bytes": total,
        "kb": round(total / 1024, 1),
    }

def _clear_debug_images() -> int:
    if not DEBUG_IMAGE_DIR.exists():
        return 0
    deleted = 0
    for path in DEBUG_IMAGE_DIR.iterdir():
        if path.is_file():
            try:
                path.unlink()
                deleted += 1
            except OSError:
                pass
    return deleted

async def _ai_status(provider: str) -> dict:
    if provider == "deepseek":
        api_key = WRITING_API_KEY
        base_url = WRITING_BASE_URL.rstrip("/")
        model = WRITING_MODEL
        body = {
            "model": model,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "thinking": {"type": "disabled"},
        }
    elif provider == "evaluator":
        api_key = EVALUATOR_API_KEY
        base_url = EVALUATOR_BASE_URL.rstrip("/")
        model = EVALUATOR_MODEL
        body = {
            "model": model,
            "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
            "thinking": {"type": "disabled"},
        }
    else:
        raise HTTPException(404, "Unknown AI provider")

    if not api_key:
        return {
            "ok": False,
            "provider": provider,
            "model": model,
            "base_url": base_url,
            "error": "missing_api_key",
        }

    started = time.perf_counter()
    url = f"{base_url}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        content = ""
        if isinstance(data, dict):
            choices = data.get("choices") or []
            if choices:
                content = ((choices[0].get("message") or {}).get("content") or "")[:500]
        if not response.is_success:
            return {
                "ok": False,
                "provider": provider,
                "model": model,
                "base_url": base_url,
                "status_code": response.status_code,
                "elapsed_ms": elapsed_ms,
                "body": response.text[:1000],
            }
        return {
            "ok": True,
            "provider": provider,
            "model": model,
            "base_url": base_url,
            "elapsed_ms": elapsed_ms,
            "content": content,
            "usage": data.get("usage") if isinstance(data, dict) else None,
        }
    except Exception as exc:
        payload = _api_error_payload(exc)
        payload.update({
            "provider": provider,
            "model": model,
            "base_url": base_url,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        })
        return payload

def _read_debug_state() -> dict:
    if not DEBUG_STATE_PATH.exists():
        return {}
    try:
        with open(DEBUG_STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}

def _write_debug_state(enabled: bool):
    DEBUG_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DEBUG_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({"enabled": enabled}, f)

debug_mode = bool(_read_debug_state().get("enabled", False))

def _pyfeat_base_url() -> str:
    value = PYFEAT_API_URL.rstrip("/")
    if value.endswith("/detect"):
        return value[:-7]
    return value

async def _pyfeat_health() -> dict:
    started = time.perf_counter()
    url = _pyfeat_base_url() + "/health"
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(url)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else response.text
        return {
            "ok": response.is_success,
            "url": url,
            "status_code": response.status_code,
            "elapsed_ms": elapsed_ms,
            "body": body,
        }
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        return {
            "ok": False,
            "url": url,
            "elapsed_ms": elapsed_ms,
            "error": str(exc),
        }

def _push_debug(event: dict) -> dict:
    DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with debug_lock:
        with open(DEBUG_LOG_PATH, "ab") as f:
            f.seek(0, os.SEEK_END)
            event_id = f.tell()
            now = time.time()
            payload = {
                "id": event_id,
                "epoch": now,
                "ts": time.strftime("%H:%M:%S", time.localtime(now)),
                **event,
            }
            line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
            f.write(line)
    debug_events.append(payload)
    return payload

def _debug_event_summary(event: dict) -> dict:
    return {
        key: value
        for key, value in event.items()
        if key not in ("api_response", "image")
    } | {
        "has_api_response": "api_response" in event,
        "has_image": bool(event.get("image")),
    }

def _debug_event_matches(event: dict, participant_id: str = "", session_id: str = "", kind: str = "", q: str = "") -> bool:
    participant_id = participant_id.strip().lower()
    session_id = session_id.strip().lstrip("#").lower()
    kind = kind.strip()
    if participant_id and participant_id not in str(event.get("participant_id", "")).lower():
        return False
    if session_id and session_id not in str(event.get("session_id", "")).lower():
        return False
    if kind and event.get("kind") != kind:
        return False
    if q and q not in json.dumps(event, ensure_ascii=False).lower():
        return False
    return True

def _iter_debug_log_reverse(before: Optional[int] = None):
    if not DEBUG_LOG_PATH.exists():
        return

    file_size = DEBUG_LOG_PATH.stat().st_size
    end = file_size if before is None else max(0, min(before, file_size))
    pos = end
    buffer = b""

    with open(DEBUG_LOG_PATH, "rb") as f:
        while pos > 0:
            read_size = min(DEBUG_LINE_CHUNK_BYTES, pos)
            pos -= read_size
            f.seek(pos)
            data = f.read(read_size) + buffer
            parts = data.split(b"\n")

            if pos > 0:
                buffer = parts[0]
                complete = parts[1:]
                offset = pos + len(buffer) + 1
            else:
                buffer = b""
                complete = parts
                offset = 0

            rows = []
            for line in complete:
                line_offset = offset
                offset += len(line) + 1
                line = line.rstrip(b"\r")
                if line.strip():
                    rows.append((line_offset, line))

            for line_offset, line in reversed(rows):
                try:
                    event = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(event, dict):
                    event.setdefault("id", line_offset)
                    yield line_offset, event

def _debug_page(
    limit: int = 80,
    before: Optional[int] = None,
    participant_id: str = "",
    session_id: str = "",
    kind: str = "",
    q: str = "",
) -> dict:
    limit = max(1, min(limit, 200))
    rows = []
    scanned = 0
    next_before = None
    q = q.lower().strip()

    for offset, event in _iter_debug_log_reverse(before):
        scanned += 1
        next_before = offset
        if _debug_event_matches(event, participant_id, session_id, kind, q):
            rows.append(_debug_event_summary(event))
            if len(rows) >= limit:
                break
        if scanned >= DEBUG_MAX_SCAN_LINES:
            break

    if rows or DEBUG_LOG_PATH.exists():
        return {
            "events": rows,
            "next_before": next_before if next_before and next_before > 0 else None,
            "has_more": bool(next_before and next_before > 0),
            "scanned": scanned,
        }

    memory_rows = [
        _debug_event_summary(event)
        for event in reversed(debug_events)
        if _debug_event_matches(event, participant_id, session_id, kind, q)
    ][:limit]
    return {
        "events": memory_rows,
        "next_before": None,
        "has_more": False,
        "scanned": len(memory_rows),
    }

def _debug_event_by_id(event_id: int) -> dict:
    if not DEBUG_LOG_PATH.exists():
        for event in debug_events:
            if event.get("id") == event_id:
                return event
        raise HTTPException(404, "Debug event not found")

    try:
        with open(DEBUG_LOG_PATH, "rb") as f:
            f.seek(event_id)
            line = f.readline()
    except OSError:
        raise HTTPException(404, "Debug event not found")

    try:
        event = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(404, "Debug event not found")
    if not isinstance(event, dict):
        raise HTTPException(404, "Debug event not found")
    event.setdefault("id", event_id)
    return event

def _strategy_frame_report(session_id: int) -> dict:
    """Build trigger statistics from experiment-stage expression debug events."""
    session_key = str(session_id)
    counts = {key: 0 for key in STRATEGY_TRIGGER_KEYS}
    frames = []
    total_frames = 0

    if DEBUG_LOG_PATH.exists():
        events = (event for _, event in _iter_debug_log_reverse())
    else:
        events = reversed(debug_events)

    for event in events:
        if event.get("kind") != "expression":
            continue
        if str(event.get("session_id", "")) != session_key:
            continue

        total_frames += 1
        api_response = event.get("api_response")
        if not isinstance(api_response, dict):
            api_response = {}
        triggers = {
            key: api_response.get(key) is True
            for key in STRATEGY_TRIGGER_KEYS
        }
        for key, triggered in triggers.items():
            if triggered:
                counts[key] += 1

        if not event.get("image"):
            continue
        frame_number = event.get("frame_number")
        if frame_number is None:
            match = re.search(r"\bexpression frame\s+(\d+)\b", str(event.get("message", "")))
            frame_number = int(match.group(1)) if match else None
        frames.append({
            "id": event.get("id"),
            "ts": event.get("ts", ""),
            "epoch": event.get("epoch"),
            "frame_number": frame_number,
            "triggers": triggers,
            "image": event.get("image"),
            "bytes": event.get("bytes", 0),
            "elapsed_ms": event.get("elapsed_ms"),
            "message": event.get("message", ""),
        })

    return {
        "session_id": session_id,
        "total_frames": total_frames,
        "photo_frames": len(frames),
        "counts": counts,
        "frames": frames,
    }

def _debug_tail(limit: int = 300) -> list[dict]:
    if not DEBUG_LOG_PATH.exists():
        return list(debug_events)
    rows = deque(maxlen=limit)
    with open(DEBUG_LOG_PATH, "r", encoding="utf-8") as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return list(rows)

def _api_error_payload(err: Exception) -> dict:
    payload = {
        "ok": False,
        "error_type": type(err).__name__,
        "error": str(err)[:1000],
    }
    if isinstance(err, httpx.HTTPStatusError):
        response = err.response
        payload.update({
            "status_code": response.status_code,
            "url": str(response.request.url),
            "body": response.text[:2000],
        })
    elif isinstance(err, httpx.RequestError) and err.request:
        payload["url"] = str(err.request.url)
    return payload

def is_enabled() -> bool:
    return debug_mode


def set_enabled(enabled: bool) -> bool:
    global debug_mode
    debug_mode = enabled
    _write_debug_state(debug_mode)
    return debug_mode
