from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from . import debug_log
from .auth import require_admin
from .database import (
    ChatLog, Evaluation, ExpressionFrame, Participant, PostTaskSurvey, PreTaskSurvey, Questionnaire, Session,
)
from .expression import PYFEAT_API_TIMEOUT
from .session_activity import forget_session, get_session_activity, is_session_active


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
            db_session.delete(session)
            db_session.commit()
        forget_session(session_id)
        return {"ok": True, "deleted_session_id": session_id}

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
