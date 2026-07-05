from __future__ import annotations

import time
from dataclasses import dataclass


ACTIVE_SESSION_TTL = 90


@dataclass
class SessionActivity:
    participant_id: str
    session_id: int
    last_seen: float
    connected: bool = True


_by_session: dict[int, SessionActivity] = {}
_by_participant: dict[str, int] = {}


def touch_session(participant_id: str, session_id: int | None) -> None:
    if not session_id:
        return
    now = time.time()
    previous_session_id = _by_participant.get(participant_id)
    if previous_session_id and previous_session_id != session_id:
        _by_session.pop(previous_session_id, None)
    _by_participant[participant_id] = session_id
    _by_session[session_id] = SessionActivity(
        participant_id=participant_id,
        session_id=session_id,
        last_seen=now,
        connected=True,
    )


def mark_disconnected(participant_id: str) -> None:
    session_id = _by_participant.get(participant_id)
    if not session_id:
        return
    activity = _by_session.get(session_id)
    if activity:
        activity.connected = False
        activity.last_seen = time.time()


def forget_participant(participant_id: str) -> None:
    session_id = _by_participant.pop(participant_id, None)
    if session_id:
        _by_session.pop(session_id, None)


def forget_session(session_id: int) -> None:
    activity = _by_session.pop(session_id, None)
    if activity:
        _by_participant.pop(activity.participant_id, None)


def get_session_activity(session_id: int) -> dict:
    activity = _by_session.get(session_id)
    if not activity:
        return {"active": False, "connected": False, "age_s": None}
    age_s = time.time() - activity.last_seen
    if age_s > ACTIVE_SESSION_TTL:
        forget_session(session_id)
        return {"active": False, "connected": False, "age_s": round(age_s, 1)}
    return {
        "active": True,
        "connected": activity.connected,
        "participant_id": activity.participant_id,
        "session_id": activity.session_id,
        "age_s": round(age_s, 1),
    }


def is_session_active(session_id: int) -> bool:
    activity = get_session_activity(session_id)
    return bool(activity.get("active") and activity.get("connected"))
