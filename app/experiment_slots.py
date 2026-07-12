from __future__ import annotations

import time
from dataclasses import dataclass

from .websocket_utils import TASK_TIME_LIMIT_SECONDS


MAX_ACTIVE_EXPERIMENTS = 2
ACTIVE_SLOT_TTL = 15
QUEUE_SLOT_TTL = 15


@dataclass
class ExperimentSlot:
    participant_id: str
    session_id: int
    phase: str
    requested_at: float
    last_seen: float
    active_at: float | None = None
    task_started_at: float | None = None


_active: dict[int, ExperimentSlot] = {}
_queue: list[ExperimentSlot] = []


def _now() -> float:
    return time.time()


def _remaining_s(slot: ExperimentSlot, now: float) -> int:
    if slot.task_started_at:
        return max(0, int(TASK_TIME_LIMIT_SECONDS - (now - slot.task_started_at)))
    return TASK_TIME_LIMIT_SECONDS


def _promote_waiting(now: float) -> None:
    while len(_active) < MAX_ACTIVE_EXPERIMENTS and _queue:
        slot = _queue.pop(0)
        slot.active_at = now
        slot.last_seen = now
        _active[slot.session_id] = slot


def _prune(now: float | None = None) -> None:
    now = now or _now()
    for session_id, slot in list(_active.items()):
        if now - slot.last_seen > ACTIVE_SLOT_TTL:
            _active.pop(session_id, None)
    _queue[:] = [
        slot
        for slot in _queue
        if now - slot.last_seen <= QUEUE_SLOT_TTL and slot.session_id not in _active
    ]
    _promote_waiting(now)


def _estimate_for(session_id: int, now: float) -> int:
    lanes = sorted(_remaining_s(slot, now) for slot in _active.values())
    while len(lanes) < MAX_ACTIVE_EXPERIMENTS:
        lanes.append(0)
    lanes = lanes[:MAX_ACTIVE_EXPERIMENTS]

    for index, slot in enumerate(_queue):
        lane_index = index % MAX_ACTIVE_EXPERIMENTS
        wait_s = lanes[lane_index]
        if slot.session_id == session_id:
            return wait_s
        lanes[lane_index] += TASK_TIME_LIMIT_SECONDS
    return 0


def _position(session_id: int) -> int:
    for index, slot in enumerate(_queue):
        if slot.session_id == session_id:
            return index + 1
    return 0


def _active_payload(slot: ExperimentSlot, now: float) -> dict:
    payload = {
        "ok": True,
        "state": "active",
        "participant_id": slot.participant_id,
        "session_id": slot.session_id,
        "phase": slot.phase,
        "position": 0,
        "active_count": len(_active),
        "queue_length": len(_queue),
        "max_active": MAX_ACTIVE_EXPERIMENTS,
        "remaining_s": _remaining_s(slot, now),
        "estimated_wait_s": 0,
    }
    payload.update(_debug_payload(now))
    return payload


def _queued_payload(slot: ExperimentSlot, now: float) -> dict:
    payload = {
        "ok": True,
        "state": "queued",
        "participant_id": slot.participant_id,
        "session_id": slot.session_id,
        "phase": slot.phase,
        "position": _position(slot.session_id),
        "active_count": len(_active),
        "queue_length": len(_queue),
        "max_active": MAX_ACTIVE_EXPERIMENTS,
        "remaining_s": None,
        "estimated_wait_s": _estimate_for(slot.session_id, now),
    }
    payload.update(_debug_payload(now))
    return payload


def _debug_payload(now: float) -> dict:
    return {
        "active_slots": [
            {
                "participant_id": slot.participant_id,
                "session_id": slot.session_id,
                "phase": slot.phase,
                "remaining_s": _remaining_s(slot, now),
            }
            for slot in sorted(_active.values(), key=lambda s: s.active_at or s.requested_at)
        ],
        "queued_slots": [
            {
                "participant_id": slot.participant_id,
                "session_id": slot.session_id,
                "phase": slot.phase,
                "position": index + 1,
                "estimated_wait_s": _estimate_for(slot.session_id, now),
            }
            for index, slot in enumerate(_queue)
        ],
    }


def request_experiment_slot(
    participant_id: str,
    session_id: int,
    phase: str = "baseline",
    task_started_at: float | None = None,
) -> dict:
    now = _now()
    _prune(now)

    active_slot = _active.get(session_id)
    if active_slot:
        active_slot.last_seen = now
        return _active_payload(active_slot, now)

    for slot in _queue:
        if slot.session_id == session_id:
            slot.last_seen = now
            return _queued_payload(slot, now)

    slot = ExperimentSlot(
        participant_id=participant_id,
        session_id=session_id,
        phase="task" if phase == "task" else "baseline",
        requested_at=now,
        last_seen=now,
        task_started_at=task_started_at if phase == "task" else None,
    )
    if len(_active) < MAX_ACTIVE_EXPERIMENTS:
        slot.active_at = now
        _active[session_id] = slot
        return _active_payload(slot, now)

    _queue.append(slot)
    return _queued_payload(slot, now)


def get_experiment_slot_status(session_id: int) -> dict:
    now = _now()
    _prune(now)

    active_slot = _active.get(session_id)
    if active_slot:
        active_slot.last_seen = now
        return _active_payload(active_slot, now)

    for slot in _queue:
        if slot.session_id == session_id:
            slot.last_seen = now
            return _queued_payload(slot, now)

    payload = {
        "ok": True,
        "state": "none",
        "session_id": session_id,
        "phase": "none",
        "position": 0,
        "active_count": len(_active),
        "queue_length": len(_queue),
        "max_active": MAX_ACTIVE_EXPERIMENTS,
        "remaining_s": None,
        "estimated_wait_s": 0,
    }
    payload.update(_debug_payload(now))
    return payload


def peek_experiment_slot_status(session_id: int) -> dict:
    now = _now()
    _prune(now)

    active_slot = _active.get(session_id)
    if active_slot:
        return _active_payload(active_slot, now)

    for slot in _queue:
        if slot.session_id == session_id:
            return _queued_payload(slot, now)

    payload = {
        "ok": True,
        "state": "none",
        "session_id": session_id,
        "phase": "none",
        "position": 0,
        "active_count": len(_active),
        "queue_length": len(_queue),
        "max_active": MAX_ACTIVE_EXPERIMENTS,
        "remaining_s": None,
        "estimated_wait_s": 0,
    }
    payload.update(_debug_payload(now))
    return payload


def touch_experiment_slot(session_id: int | None, phase: str | None = None) -> None:
    if not session_id:
        return
    now = _now()
    slot = _active.get(session_id)
    if not slot:
        return
    slot.last_seen = now
    if phase:
        slot.phase = phase
        if phase == "task" and not slot.task_started_at:
            slot.task_started_at = now


def release_experiment_slot(session_id: int | None) -> None:
    if not session_id:
        return
    now = _now()
    _active.pop(session_id, None)
    _queue[:] = [slot for slot in _queue if slot.session_id != session_id]
    _promote_waiting(now)
