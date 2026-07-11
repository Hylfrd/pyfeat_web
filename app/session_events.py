from __future__ import annotations

import calendar
import json
import time
from typing import Any

from .database import Session, SessionEvent


def utc_timestamp(epoch: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch or time.time()))


def parse_utc_timestamp(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except (TypeError, ValueError):
        return None


def session_event_ms(session: Session, epoch: float | None = None) -> int:
    start = parse_utc_timestamp(session.start_time)
    at = epoch if epoch is not None else time.time()
    if start is None:
        return 0
    return max(0, int(round((at - start) * 1000)))


def add_session_event(
    db_session,
    session: Session | None,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    epoch: float | None = None,
    commit: bool = False,
) -> SessionEvent | None:
    if not session:
        return None
    at = epoch if epoch is not None else time.time()
    event = SessionEvent(
        session_id=session.id,
        event_type=event_type,
        t_ms=session_event_ms(session, at),
        timestamp=utc_timestamp(at),
        payload_json=json.dumps(payload or {}, ensure_ascii=False),
    )
    db_session.add(event)
    if commit:
        db_session.commit()
    return event


def add_session_event_once(
    db_session,
    session: Session | None,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    epoch: float | None = None,
    commit: bool = False,
) -> SessionEvent | None:
    if not session:
        return None
    existing = (
        db_session.query(SessionEvent)
        .filter(SessionEvent.session_id == session.id, SessionEvent.event_type == event_type)
        .first()
    )
    if existing:
        return existing
    return add_session_event(db_session, session, event_type, payload, epoch=epoch, commit=commit)
