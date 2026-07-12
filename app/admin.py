from __future__ import annotations

import asyncio
import base64
import calendar
import json
import shutil
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import debug_log
from .auth import require_admin
from .database import (
    ChatLog, Evaluation, ExpressionFrame, Participant, PostTaskSurvey, PreTaskSurvey, Questionnaire, Session,
    SessionEvent,
)
from .expression import PYFEAT_API_TIMEOUT
from .experiment_slots import peek_experiment_slot_status
from .session_activity import forget_session, get_session_activity, is_session_active


ROOT_DIR = Path(__file__).resolve().parent.parent
VIDEO_ROOT = ROOT_DIR / "data" / "videos"


def _video_dir(session: Session) -> Path:
    return VIDEO_ROOT / session.participant_id


def _video_chunk_paths(session: Session) -> list[Path]:
    video_dir = _video_dir(session)
    if not video_dir.exists():
        return []
    return sorted(
        path for path in video_dir.glob(f"{session.id}_*.webm")
        if path.is_file() and path.stem.rsplit("_", 1)[-1].isdigit()
    )


def _combined_video_path(session: Session) -> Path:
    return _video_dir(session) / f"{session.id}.webm"


def _format_bytes(value: int) -> str:
    size = float(value or 0)
    units = ["B", "KB", "MB", "GB"]
    unit = 0
    while size >= 1024 and unit < len(units) - 1:
        size /= 1024
        unit += 1
    digits = 0 if unit == 0 else (1 if size >= 10 else 2)
    return f"{size:.{digits}f} {units[unit]}"


def _format_duration_ms(value: int | None) -> str:
    if not value:
        return "-"
    total = max(0, int(round(value / 1000)))
    minutes = total // 60
    seconds = total % 60
    return f"{minutes}:{seconds:02d}"


def _utc_iso_epoch(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except (TypeError, ValueError):
        return None


def _session_stage(session: Session, slot: dict | None = None) -> str:
    slot = slot or peek_experiment_slot_status(session.id)
    phase = slot.get("phase")
    if phase == "baseline":
        return "基准测试"
    if phase == "task":
        return "实验中"
    if session.completed:
        return "实验后问卷"
    return "实验前问卷"


def _ensure_combined_video(session: Session) -> tuple[Path | None, list[Path]]:
    final_path = _combined_video_path(session)
    chunks = _video_chunk_paths(session)
    if final_path.exists():
        return final_path, chunks
    if not chunks:
        return None, chunks

    output = final_path
    latest_chunk_mtime = max(path.stat().st_mtime for path in chunks)
    if output.exists() and output.stat().st_mtime >= latest_chunk_mtime:
        return output, chunks

    output.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output.with_suffix(".webm.tmp")
    with tmp_path.open("wb") as out:
        for chunk_path in chunks:
            with chunk_path.open("rb") as src:
                shutil.copyfileobj(src, out)
    tmp_path.replace(output)
    return output, chunks


def _file_range_iter(path: Path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open("rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _video_file_response(path: Path, filename: str | None, range_header: str | None):
    size = path.stat().st_size
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
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
        })
        if filename:
            headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        return StreamingResponse(
            _file_range_iter(path, start, end),
            status_code=206,
            media_type="video/webm",
            headers=headers,
        )
    return FileResponse(path, media_type="video/webm", filename=filename, headers=headers)


def _event_payload(event: SessionEvent) -> dict:
    if not event.payload_json:
        return {}
    try:
        value = json.loads(event.payload_json)
        return value if isinstance(value, dict) else {"value": value}
    except json.JSONDecodeError:
        return {"raw": event.payload_json}


def _delete_video_files(session: Session) -> int:
    deleted = 0
    for path in [*_video_chunk_paths(session), _combined_video_path(session)]:
        try:
            if path.exists() and path.is_file():
                path.unlink()
                deleted += 1
        except OSError:
            pass
    return deleted


def create_admin_router(db_session_factory, expression_engine) -> APIRouter:
    router = APIRouter()

    @router.get("/api/admin/sessions")
    async def admin_sessions(_: None = Depends(require_admin)):
        """Return all sessions for the dashboard."""
        with db_session_factory() as db_session:
            sessions = db_session.query(Session).order_by(Session.id.desc()).all()
            return [
                {
                    "id": s.id,
                    "participant_id": s.participant_id,
                    "condition": s.condition,
                    "completed": s.completed,
                    "completion_type": s.completion_type,
                    "total_turns": s.total_turns,
                    "total_revisions": s.total_revisions,
                    "duration_ms": s.duration_ms,
                    "frame_loss_ratio": round(s.frame_loss_ratio, 3),
                "excluded": s.excluded,
                "excluded_by_frame_loss": s.excluded_by_frame_loss,
                "exclusion_override": s.exclusion_override,
                "consent_agreed": s.consent_agreed,
                "consent_taker_name": s.consent_taker_name,
                "consent_date": s.consent_date,
                "activity": get_session_activity(s.id),
            }
                for s in sessions
            ]

    @router.get("/api/admin/chat-logs/{session_id}")
    async def admin_chat_logs(session_id: int, _: None = Depends(require_admin)):
        """Return chat logs for a specific session."""
        with db_session_factory() as db_session:
            logs = (
                db_session.query(ChatLog)
                .filter(ChatLog.session_id == session_id)
                .order_by(ChatLog.seq)
                .all()
            )
            return [
                {
                    "seq": log.seq,
                    "role": log.role,
                    "content": log.content,
                    "timestamp": log.timestamp,
                    "expression_label": log.expression_label,
                    "strategy_applied": log.strategy_applied,
                    "is_hidden": log.is_hidden,
                }
                for log in logs
            ]

    @router.get("/api/admin/expression/{session_id}")
    async def admin_expression(session_id: int, _: None = Depends(require_admin)):
        """Return expression timeline for a session."""
        with db_session_factory() as db_session:
            frames = (
                db_session.query(ExpressionFrame)
                .filter(ExpressionFrame.session_id == session_id)
                .order_by(ExpressionFrame.timestamp)
                .all()
            )
            return [
                {
                    "timestamp": f.timestamp,
                    "au1": f.au1, "au4": f.au4, "au7": f.au7, "au12": f.au12,
                    "reliable": f.reliable,
                    "head_yaw": f.head_yaw, "head_pitch": f.head_pitch,
                    "face_detected": f.face_detected,
                    "drop_reason": f.drop_reason,
                    "queued_ms": f.queued_ms,
                }
                for f in frames
            ]

    @router.get("/api/admin/participants/{participant_id}/baseline")
    async def admin_baseline(participant_id: str, _: None = Depends(require_admin)):
        """Return baseline AU data for a participant."""
        with db_session_factory() as db_session:
            p = db_session.query(Participant).get(participant_id)
            if not p:
                raise HTTPException(404, "Participant not found")
            return {
                "participant_id": p.id,
                "order_group": p.order_group,
                "language": p.language,
                "baseline_au1": p.baseline_au1,
                "baseline_au4": p.baseline_au4,
                "baseline_au7": p.baseline_au7,
                "baseline_au12": p.baseline_au12,
                "frame_count": p.baseline_frame_count,
                "artifact_count": p.baseline_artifact_count,
            }

    @router.delete("/api/admin/sessions/{session_id}")
    async def admin_delete_session(session_id: int, _: None = Depends(require_admin)):
        """Delete a session and all its related data."""
        if is_session_active(session_id):
            raise HTTPException(409, "用户正在实验中")

        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")
            db_session.query(Evaluation).filter(Evaluation.session_id == session_id).delete()
            db_session.query(PostTaskSurvey).filter(PostTaskSurvey.session_id == session_id).delete()
            db_session.query(Questionnaire).filter(Questionnaire.session_id == session_id).delete()
            db_session.query(ExpressionFrame).filter(ExpressionFrame.session_id == session_id).delete()
            db_session.query(ChatLog).filter(ChatLog.session_id == session_id).delete()
            db_session.query(SessionEvent).filter(SessionEvent.session_id == session_id).delete()
            _delete_video_files(session)
            db_session.delete(session)
            db_session.commit()
        forget_session(session_id)
        return {"ok": True, "deleted_session_id": session_id}

    @router.get("/api/admin/sessions/{session_id}/video/info")
    async def admin_session_video_info(session_id: int, _: None = Depends(require_admin)):
        """Return video metadata and current experiment stage for a session."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")
            slot = peek_experiment_slot_status(session.id)
            video_path, chunks = _ensure_combined_video(session)
            if video_path:
                session.video_path = str(video_path.relative_to(ROOT_DIR))
                db_session.commit()
            size = video_path.stat().st_size if video_path and video_path.exists() else 0
            updated_at = None
            if video_path and video_path.exists():
                updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(video_path.stat().st_mtime))
            return {
                "session_id": session.id,
                "participant_id": session.participant_id,
                "stage": _session_stage(session, slot),
                "slot": slot,
                "available": bool(video_path and video_path.exists()),
                "chunk_count": len(chunks),
                "size_bytes": size,
                "size_human": _format_bytes(size),
                "duration_ms": session.video_duration_ms,
                "duration_human": _format_duration_ms(session.video_duration_ms),
                "updated_at": updated_at,
                "url": f"/api/admin/sessions/{session.id}/video/file",
                "download_url": f"/api/admin/sessions/{session.id}/video/file?download=1",
            }

    @router.get("/api/admin/sessions/{session_id}/video/file")
    async def admin_session_video_file(
        session_id: int,
        download: bool = Query(False),
        range_header: str | None = Header(None, alias="Range"),
        _: None = Depends(require_admin),
    ):
        """Serve a combined WebM video for the admin player or download."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")
            video_path, _ = _ensure_combined_video(session)
            if not video_path or not video_path.exists():
                raise HTTPException(404, "Video not found")
            filename = f"session_{session.id}_{session.participant_id}.webm" if download else None
            return _video_file_response(video_path, filename, range_header)

    @router.get("/api/admin/sessions/{session_id}/timeline")
    async def admin_session_timeline(session_id: int, _: None = Depends(require_admin)):
        """Return stored session markers for synchronized video review."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")
            events = (
                db_session.query(SessionEvent)
                .filter(SessionEvent.session_id == session_id)
                .order_by(SessionEvent.t_ms, SessionEvent.id)
                .all()
            )
            return {
                "session_id": session.id,
                "participant_id": session.participant_id,
                "start_time": session.start_time,
                "events": [
                    {
                        "id": event.id,
                        "type": event.event_type,
                        "t_ms": event.t_ms,
                        "time_s": round(event.t_ms / 1000, 3),
                        "timestamp": event.timestamp,
                        "payload": _event_payload(event),
                    }
                    for event in events
                ],
            }

    @router.delete("/api/admin/sessions/{session_id}/video")
    async def admin_delete_session_video(session_id: int, _: None = Depends(require_admin)):
        """Delete recorded video chunks and the combined video for one session."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")
            deleted = _delete_video_files(session)
            session.video_path = None
            session.video_duration_ms = None
            db_session.commit()
            return {"ok": True, "session_id": session_id, "deleted_files": deleted}

    @router.post("/api/admin/sessions/{session_id}/exclusion")
    async def admin_set_session_exclusion(
        session_id: int,
        excluded: bool = Form(...),
        _: None = Depends(require_admin),
    ):
        """Manually include or exclude a session from analysis."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")
            session.exclusion_override = "exclude" if excluded else "include"
            db_session.commit()
            return {
                "ok": True,
                "session_id": session.id,
                "excluded": session.excluded,
                "excluded_by_frame_loss": session.excluded_by_frame_loss,
                "exclusion_override": session.exclusion_override,
            }

    @router.get("/api/admin/sessions/{session_id}/export")
    async def admin_export_session(session_id: int, _: None = Depends(require_admin)):
        """Export a single session as JSON including chat, expression, questionnaire, evaluations."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session:
                raise HTTPException(404, "Session not found")

            participant = db_session.query(Participant).get(session.participant_id)

            chat_logs = (
                db_session.query(ChatLog)
                .filter(ChatLog.session_id == session_id)
                .order_by(ChatLog.seq)
                .all()
            )
            expression_frames = (
                db_session.query(ExpressionFrame)
                .filter(ExpressionFrame.session_id == session_id)
                .order_by(ExpressionFrame.timestamp)
                .all()
            )
            questionnaire = (
                db_session.query(Questionnaire)
                .filter(Questionnaire.session_id == session_id)
                .first()
            )
            pre_survey = (
                db_session.query(PreTaskSurvey)
                .filter(PreTaskSurvey.participant_id == session.participant_id)
                .first()
            )
            post_survey = (
                db_session.query(PostTaskSurvey)
                .filter(PostTaskSurvey.session_id == session_id)
                .first()
            )
            evaluations = (
                db_session.query(Evaluation)
                .filter(Evaluation.session_id == session_id)
                .all()
            )

        return {
            "session": {
                "id": session.id,
                "participant_id": session.participant_id,
                "task_scenario": session.task_scenario,
                "condition": session.condition,
                "condition_order": session.condition_order,
                "start_time": session.start_time,
                "end_time": session.end_time,
                "duration_ms": session.duration_ms,
                "completion_type": session.completion_type,
                "final_email": session.final_email,
                "total_turns": session.total_turns,
                "total_revisions": session.total_revisions,
                "total_frames": session.total_frames,
                "unreliable_frames": session.unreliable_frames,
                "frame_loss_ratio": session.frame_loss_ratio,
                "excluded": session.excluded,
                "excluded_by_frame_loss": session.excluded_by_frame_loss,
                "exclusion_override": session.exclusion_override,
                "consent_agreed": session.consent_agreed,
                "consent_taker_name": session.consent_taker_name,
                "consent_date": session.consent_date,
                "consent_signature": session.consent_signature,
                "activity": get_session_activity(session.id),
            },
            "participant": {
                "id": participant.id if participant else None,
                "order_group": participant.order_group if participant else None,
                "baseline_au1": participant.baseline_au1 if participant else None,
                "baseline_au4": participant.baseline_au4 if participant else None,
                "baseline_au7": participant.baseline_au7 if participant else None,
                "baseline_au12": participant.baseline_au12 if participant else None,
                "baseline_frame_count": participant.baseline_frame_count if participant else None,
            } if participant else None,
            "chat_logs": [
                {
                    "seq": log.seq,
                    "role": log.role,
                    "content": log.content,
                    "timestamp": log.timestamp,
                    "expression_label": log.expression_label,
                    "strategy_applied": log.strategy_applied,
                }
                for log in chat_logs
            ],
            "expression_frames": [
                {
                    "timestamp": f.timestamp,
                    "au1": f.au1, "au4": f.au4, "au7": f.au7, "au12": f.au12,
                    "head_yaw": f.head_yaw, "head_pitch": f.head_pitch, "head_roll": f.head_roll,
                    "face_detected": f.face_detected, "reliable": f.reliable,
                    "drop_reason": f.drop_reason,
                    "queued_ms": f.queued_ms,
                }
                for f in expression_frames
            ],
            "questionnaire": {
                "q1": questionnaire.q1_understood,
                "q2": questionnaire.q2_same_page,
                "q3": questionnaire.q3_aware,
                "q4": questionnaire.q4_connected,
                "q5": questionnaire.q5_rewarding,
                "q6": questionnaire.q6_interested,
                "q7": questionnaire.q7_worthwhile,
                "q8": questionnaire.q8_frustrated,
                "q9": questionnaire.q9_confusing,
                "q10": questionnaire.q10_taxing,
            } if questionnaire else None,
            "pre_survey": {
                "a1_age": pre_survey.a1_age,
                "a2_gender": pre_survey.a2_gender,
                "a3_ai_frequency": pre_survey.a3_ai_frequency,
                "a4_ai_experience": pre_survey.a4_ai_experience,
                "a5_writing_confidence": pre_survey.a5_writing_confidence,
                "a6_ai_tool_confidence": pre_survey.a6_ai_tool_confidence,
                "a7_email_familiarity": pre_survey.a7_email_familiarity,
                "b1_calm": pre_survey.b1_calm,
                "b2_stressed": pre_survey.b2_stressed,
                "b3_uncertain": pre_survey.b3_uncertain,
                "b4_confident": pre_survey.b4_confident,
                "b5_ready": pre_survey.b5_ready,
                "b6_webcam_comfort": pre_survey.b6_webcam_comfort,
                "c1_expect_helpful": pre_survey.c1_expect_helpful,
                "c2_expect_understand": pre_survey.c2_expect_understand,
                "c3_expect_easy": pre_survey.c3_expect_easy,
                "c4_expect_collaborative": pre_survey.c4_expect_collaborative,
                "created_at": pre_survey.created_at,
            } if pre_survey else None,
            "post_survey": {
                "u1": post_survey.u1_understood_needs,
                "u2": post_survey.u2_aware_difficulty,
                "u3": post_survey.u3_matched_intent,
                "u4": post_survey.u4_noticed_stuck,
                "u5": post_survey.u5_aligned_thoughts,
                "s1": post_survey.s1_felt_supported,
                "s2": post_survey.s2_useful_guidance,
                "s3": post_survey.s3_reduced_effort,
                "s4": post_survey.s4_concrete_suggestions,
                "s5": post_survey.s5_efficient,
                "sp1": post_survey.sp1_socially_responsive,
                "sp2": post_survey.sp2_active_partner,
                "sp3": post_survey.sp3_socially_engaging,
                "cp1": post_survey.cp1_ai_with_me,
                "cp2": post_survey.cp2_ai_aware_of_me,
                "cp3": post_survey.cp3_mutual_awareness,
                "r1": post_survey.r1_acknowledged_difficulty,
                "r2": post_survey.r2_signaled_uncertainty,
                "r3": post_survey.r3_helped_differently,
                "r4": post_survey.r4_repair_supportive,
                "r5": post_survey.r5_acknowledgement_appropriate,
                "e1": post_survey.e1_support_matched_awareness,
                "e2": post_survey.e2_met_expectations,
                "e3": post_survey.e3_more_aware_than_helpful,
                "e4": post_survey.e4_disappointed,
                "e5": post_survey.e5_raised_expectations,
                "f1": post_survey.f1_frustrated,
                "f2": post_survey.f2_smooth,
                "f3": post_survey.f3_satisfied_draft,
                "f4": post_survey.f4_satisfied_overall,
                "f5": post_survey.f5_future_use,
                "m1": post_survey.m1_responded_to_emotion,
                "m2": post_survey.m2_webcam_adapted,
                "m3": post_survey.m3_changed_strategy,
                "m4": post_survey.m4_suspected_adaptation,
                "m5": post_survey.m5_open_response,
                "created_at": post_survey.created_at,
            } if post_survey else None,
            "evaluations": [
                {
                    "run_number": e.run_number,
                    "layer": e.layer,
                    "score": e.score,
                    "evaluator_model": e.evaluator_model,
                    "details_json": e.details_json,
                }
                for e in evaluations
            ],
        }

    @router.get("/api/admin/expression/{session_id}/stats")
    async def admin_expression_stats(session_id: int, _: None = Depends(require_admin)):
        """Return aggregated expression statistics for a session."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            frames = (
                db_session.query(ExpressionFrame)
                .filter(ExpressionFrame.session_id == session_id)
                .order_by(ExpressionFrame.timestamp)
                .all()
            )
        if not frames:
            return {"session_id": session_id, "total_frames": 0}

        total = len(frames)
        reliable = sum(1 for f in frames if f.reliable)
        face_detected = sum(1 for f in frames if f.face_detected)
        face_lost = total - face_detected
        queue_timeout = sum(1 for f in frames if f.drop_reason == "queue_timeout")

        def _mean(values):
            return sum(values) / len(values) if values else 0.0

        def _pct(part):
            return round(part / total * 100, 1) if total else 0.0

        au4_vals = [f.au4 for f in frames]
        au12_vals = [f.au12 for f in frames]
        au7_vals = [f.au7 for f in frames]
        au1_vals = [f.au1 for f in frames]

        au4_triggers = sum(1 for v in au4_vals if v >= 0.4)
        au12_triggers = sum(1 for v in au12_vals if v >= 0.4)
        au7_triggers = sum(1 for v in au7_vals if v >= 0.4)
        au1_triggers = sum(1 for v in au1_vals if v >= 0.3)
        video_start_epoch = _utc_iso_epoch(session.start_time if session else None) or frames[0].timestamp

        return {
            "session_id": session_id,
            "total_frames": total,
            "reliable_frames": reliable,
            "unreliable_frames": total - reliable,
            "reliable_pct": _pct(reliable),
            "face_detected_frames": face_detected,
            "face_lost_frames": face_lost,
            "face_lost_pct": _pct(face_lost),
            "queue_timeout_frames": queue_timeout,
            "queue_timeout_pct": _pct(queue_timeout),
            "means": {
                "au1": round(_mean(au1_vals), 3),
                "au4": round(_mean(au4_vals), 3),
                "au7": round(_mean(au7_vals), 3),
                "au12": round(_mean(au12_vals), 3),
            },
            "max": {
                "au1": round(max(au1_vals), 3),
                "au4": round(max(au4_vals), 3),
                "au7": round(max(au7_vals), 3),
                "au12": round(max(au12_vals), 3),
            },
            "triggers_above_0_4": {
                "au1": au1_triggers,
                "au4": au4_triggers,
                "au7": au7_triggers,
                "au12": au12_triggers,
            },
            "frames": [
                {
                    "t": round(f.timestamp - frames[0].timestamp, 1),
                    "video_t": round(f.timestamp - video_start_epoch, 1),
                    "au1": round(f.au1, 2),
                    "au4": round(f.au4, 2),
                    "au7": round(f.au7, 2),
                    "au12": round(f.au12, 2),
                    "yaw": round(f.head_yaw, 1),
                    "pitch": round(f.head_pitch, 1),
                    "face": f.face_detected,
                    "ok": f.reliable,
                    "drop_reason": f.drop_reason,
                    "queued_ms": round(f.queued_ms or 0.0, 1),
                }
                for f in frames
            ],
        }

    @router.get("/api/admin/face-status/{participant_id}")
    async def admin_face_status(participant_id: str, _: None = Depends(require_admin)):
        """Return current face detection status for a participant."""
        frames = expression_engine.get_recent_frames(participant_id, 3)
        if not frames:
            return {
                "participant_id": participant_id,
                "face_detected": False,
                "reliable": False,
                "message": "no_data",
                "latest_aus": None,
            }
        latest = frames[-1]
        return {
            "participant_id": participant_id,
            "face_detected": latest.face_detected,
            "reliable": latest.reliable,
            "message": "ok" if (latest.face_detected and latest.reliable) else (
                "pose" if latest.face_detected else "no_face"
            ),
            "latest_aus": {
                "au1": round(latest.au1, 2),
                "au4": round(latest.au4, 2),
                "au7": round(latest.au7, 2),
                "au12": round(latest.au12, 2),
                "head_yaw": round(latest.head_yaw, 1),
                "head_pitch": round(latest.head_pitch, 1),
            },
        }

    @router.get("/api/admin/debug")
    async def admin_debug(
        limit: int = Query(80, ge=1, le=200),
        before: Optional[int] = Query(None, ge=0),
        participant_id: str = "",
        session_id: str = "",
        kind: str = "",
        q: str = "",
        _: None = Depends(require_admin),
    ):
        page = debug_log._debug_page(
            limit=limit,
            before=before,
            participant_id=participant_id,
            session_id=session_id,
            kind=kind,
            q=q,
        )
        return {
            "enabled": debug_log.is_enabled(),
            **page,
        }

    @router.get("/api/admin/debug-event/{event_id}")
    async def admin_debug_event(event_id: int, _: None = Depends(require_admin)):
        return debug_log._debug_event_by_id(event_id)

    @router.get("/api/admin/sessions/{session_id}/strategy-frames")
    async def admin_strategy_frames(session_id: int, _: None = Depends(require_admin)):
        """Return strategy trigger frequencies and experiment-stage photo logs."""
        with db_session_factory() as db_session:
            if not db_session.query(Session.id).filter(Session.id == session_id).first():
                raise HTTPException(404, "Session not found")
        return await asyncio.to_thread(debug_log._strategy_frame_report, session_id)

    @router.get("/api/admin/debug-event/{event_id}/json")
    async def admin_debug_event_json(
        event_id: int,
        part: str = Query("event"),
        _: None = Depends(require_admin),
    ):
        if part not in {"event", "api"}:
            raise HTTPException(400, "part must be 'event' or 'api'")
        event = debug_log._debug_event_by_id(event_id)
        if part == "api":
            if "api_response" not in event:
                raise HTTPException(404, "This debug event has no API response")
            payload = event["api_response"]
        else:
            payload = dict(event)
            if payload.get("image"):
                payload["image"] = "[image omitted; use debug event detail image link]"
        return JSONResponse(payload)

    @router.get("/api/admin/debug-image/{filename}")
    async def admin_debug_image(filename: str, _: None = Depends(require_admin)):
        if Path(filename).name != filename:
            raise HTTPException(404, "Debug image not found")
        path = debug_log.DEBUG_IMAGE_DIR / filename
        if not path.exists() or not path.is_file():
            raise HTTPException(404, "Debug image not found")
        return FileResponse(path)

    @router.get("/api/admin/debug-cache")
    async def admin_debug_cache(_: None = Depends(require_admin)):
        return debug_log._debug_image_cache()

    @router.post("/api/admin/debug-clear")
    async def admin_debug_clear(_: None = Depends(require_admin)):
        with debug_log.debug_lock:
            debug_log.debug_events.clear()
            try:
                if debug_log.DEBUG_LOG_PATH.exists():
                    debug_log.DEBUG_LOG_PATH.unlink()
            except OSError as exc:
                raise HTTPException(500, f"Failed to clear debug log: {exc}") from exc
        deleted_images = debug_log._clear_debug_images()
        return {
            "ok": True,
            "deleted_images": deleted_images,
            "cache": debug_log._debug_image_cache(),
        }

    @router.post("/api/admin/debug-mode")
    async def admin_debug_mode(enabled: bool = Form(...), _: None = Depends(require_admin)):
        debug_log.set_enabled(enabled)
        event = debug_log._push_debug({
            "kind": "debug",
            "message": f"debug mode {'enabled' if enabled else 'disabled'}",
        })
        return {
            "ok": True,
            "enabled": debug_log.is_enabled(),
            "event": event,
        }

    @router.get("/api/admin/debug-health")
    async def admin_debug_health(_: None = Depends(require_admin)):
        return await debug_log._pyfeat_health()

    @router.post("/api/admin/debug-detect")
    async def admin_debug_detect(file: UploadFile = File(...), _: None = Depends(require_admin)):
        started = time.perf_counter()
        image_bytes = await file.read()
        image_b64 = base64.b64encode(image_bytes).decode("ascii")
        content_type = file.content_type or "image/jpeg"
        url = debug_log._pyfeat_base_url() + "/detect"
        payload = {
            "image": f"data:{content_type};base64,{image_b64}",
            "participant_id": "__debug_upload__",
        }
        try:
            async with httpx.AsyncClient(timeout=PYFEAT_API_TIMEOUT) as client:
                response = await client.post(url, json=payload)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            body = response.json() if response.headers.get("content-type", "").startswith("application/json") else response.text
            return {
                "ok": response.is_success,
                "url": url,
                "status_code": response.status_code,
                "filename": file.filename,
                "bytes": len(image_bytes),
                "elapsed_ms": elapsed_ms,
                "body": body,
            }
        except Exception as exc:
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            return {
                "ok": False,
                "url": url,
                "filename": file.filename,
                "bytes": len(image_bytes),
                "elapsed_ms": elapsed_ms,
                "error": str(exc),
            }

    @router.get("/api/admin/debug-ai/{provider}")
    async def admin_debug_ai(provider: str, _: None = Depends(require_admin)):
        return await debug_log._ai_status(provider)

    return router
