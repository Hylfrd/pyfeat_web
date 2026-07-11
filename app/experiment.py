from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError

from .database import (
    ChatLog, ExpressionFrame, Participant, PostTaskSurvey, PreTaskSurvey, Questionnaire, Session,
)
from .evaluation import run_posthoc_evaluation
from .experiment_slots import (
    get_experiment_slot_status,
    release_experiment_slot,
    request_experiment_slot,
)
from .session_activity import get_session_activity
from .session_events import add_session_event, add_session_event_once, parse_utc_timestamp
from .strategy import StrategySelector


def _form_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def create_experiment_router(
    root_dir: Path,
    db_session_factory,
    expression_engine,
    selectors,
    eval_ai_client,
) -> APIRouter:
    router = APIRouter()

    GROUPS = ["A", "B"]
    FIFTEEN_MINUTES = 15 * 60

    def _generate_participant_id(db_session) -> tuple[str, str]:
        """Auto-generate sequential participant ID and balanced order group.

        Returns (participant_id, order_group).
        Groups are assigned cyclically across the two retained conditions.
        """
        participant_ids = db_session.query(Participant.id).filter(Participant.id.like("P%")).all()
        numbers = []
        for (participant_id,) in participant_ids:
            try:
                numbers.append(int(participant_id[1:]))
            except (TypeError, ValueError):
                continue
        n = (max(numbers) + 1) if numbers else 1
        order_group = GROUPS[(n - 1) % len(GROUPS)]
        return f"P{n:03d}", order_group

    @router.post("/api/session/start")
    async def start_session(
        consent_agreed: bool = Form(False),
        consent_taker_name: str = Form(""),
        consent_signature: str = Form(""),
    ):
        """Create a new participant (auto-generated ID + balanced group) and session."""
        consent_taker_name = consent_taker_name.strip()
        consent_signature = consent_signature.strip()
        if not consent_agreed:
            raise HTTPException(400, "Consent is required before starting the experiment.")
        if not consent_taker_name:
            raise HTTPException(400, "Consent taker name is required.")
        if not consent_signature.startswith("data:image/png;base64,"):
            raise HTTPException(400, "Experimenter signature is required.")

        for _ in range(5):
            with db_session_factory() as db_session:
                participant_id, order_group = _generate_participant_id(db_session)
                p = Participant(id=participant_id, order_group=order_group, language="zh")
                db_session.add(p)

                assigned_condition = "text-only" if order_group == "A" else "affect-aware"

                session = Session(
                    participant_id=participant_id,
                    task_scenario="A",
                    condition=assigned_condition,
                    condition_order=1,
                    start_time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    consent_agreed=True,
                    consent_taker_name=consent_taker_name,
                    consent_date=time.strftime("%Y-%m-%d", time.localtime()),
                    consent_signature=consent_signature,
                )
                db_session.add(session)
                try:
                    db_session.flush()
                    add_session_event(
                        db_session,
                        session,
                        "session_started",
                        {"participant_id": participant_id, "condition": assigned_condition},
                        epoch=parse_utc_timestamp(session.start_time),
                    )
                    db_session.commit()
                except IntegrityError:
                    db_session.rollback()
                    continue

                selectors[participant_id] = StrategySelector()
                return {
                    "participant_id": participant_id,
                    "session_id": session.id,
                    "condition": assigned_condition,
                    "time_limit_s": FIFTEEN_MINUTES,
                }

        raise HTTPException(503, "Failed to allocate participant ID. Please retry.")

    @router.get("/api/session/status/{session_id}")
    async def session_status(
        session_id: int,
        participant_id: str,
    ):
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session or session.participant_id != participant_id:
                raise HTTPException(404, "Session not found")
            return {
                "ok": True,
                "session_id": session.id,
                "participant_id": session.participant_id,
                "completed": session.completed,
                "activity": get_session_activity(session.id),
                "slot": get_experiment_slot_status(session.id),
            }

    @router.post("/api/session/slot/request")
    async def request_session_slot(
        participant_id: str = Form(...),
        session_id: int = Form(...),
    ):
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session or session.participant_id != participant_id:
                raise HTTPException(404, "Session not found")
            if session.completed:
                raise HTTPException(400, "Session already completed")
            add_session_event_once(
                db_session,
                session,
                "pre_survey_finished",
                {"participant_id": participant_id},
                commit=True,
            )
        return request_experiment_slot(participant_id, session_id)

    @router.get("/api/session/slot/status/{session_id}")
    async def session_slot_status(
        session_id: int,
        participant_id: str,
    ):
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session or session.participant_id != participant_id:
                raise HTTPException(404, "Session not found")
        return get_experiment_slot_status(session_id)

    @router.post("/api/session/slot/release")
    async def release_session_slot(
        participant_id: str = Form(...),
        session_id: int = Form(...),
    ):
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session or session.participant_id != participant_id:
                return {"ok": True, "released": False}
        release_experiment_slot(session_id)
        return {"ok": True, "released": True}

    @router.post("/api/session/complete")
    async def complete_session(
        session_id: str = Form("0"),
        final_email: str = Form(""),
        duration_ms: str = Form("0"),
        completion_type: str = Form("manual"),
        total_turns: str = Form("0"),
        total_revisions: str = Form("0"),
        total_frames: str = Form("0"),
        unreliable_frames: str = Form("0"),
    ):
        """Mark a session as complete and store the final email."""
        session_id_int = _form_int(session_id)
        if session_id_int <= 0:
            raise HTTPException(400, "Invalid session")
        duration_ms_int = max(0, _form_int(duration_ms))
        total_turns_int = max(0, _form_int(total_turns))
        total_revisions_int = max(0, _form_int(total_revisions))
        total_frames_int = max(0, _form_int(total_frames))
        unreliable_frames_int = max(0, _form_int(unreliable_frames))
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id_int)
            if not session:
                raise HTTPException(404, "Session not found")

            session.end_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            session.duration_ms = duration_ms_int
            session.completion_type = completion_type
            session.final_email = final_email
            session.total_turns = total_turns_int
            session.total_revisions = total_revisions_int
            stored_frames = (
                db_session.query(ExpressionFrame)
                .filter(ExpressionFrame.session_id == session_id_int)
                .all()
            )
            if stored_frames:
                session.total_frames = len(stored_frames)
                session.unreliable_frames = sum(1 for frame in stored_frames if not frame.reliable)
            else:
                session.total_frames = total_frames_int
                session.unreliable_frames = unreliable_frames_int
            session.completed = True
            add_session_event_once(
                db_session,
                session,
                "task_completed",
                {
                    "completion_type": completion_type,
                    "duration_ms": duration_ms_int,
                    "turns": total_turns_int,
                    "revisions": total_revisions_int,
                },
            )
            db_session.commit()

        release_experiment_slot(session_id_int)

        if eval_ai_client and final_email.strip():
            asyncio.create_task(run_posthoc_evaluation(root_dir, eval_ai_client, session_id_int, final_email))

        return {"ok": True, "session_id": session_id_int}

    @router.post("/api/questionnaire")
    async def submit_questionnaire(
        session_id: int = Form(...),

        q1: int = Form(...), q2: int = Form(...), q3: int = Form(...), q4: int = Form(...),

        q5: int = Form(...), q6: int = Form(...), q7: int = Form(...),

        q8: int = Form(...), q9: int = Form(...), q10: int = Form(...),
    ):
        """Submit post-task questionnaire."""
        with db_session_factory() as db_session:
            q = Questionnaire(
                session_id=session_id,
                q1_understood=q1, q2_same_page=q2, q3_aware=q3, q4_connected=q4,
                q5_rewarding=q5, q6_interested=q6, q7_worthwhile=q7,
                q8_frustrated=q8, q9_confusing=q9, q10_taxing=q10,
            )
            db_session.merge(q)
            session = db_session.query(Session).get(session_id)
            add_session_event_once(db_session, session, "questionnaire_submitted")
            db_session.commit()
        return {"ok": True}

    @router.get("/api/session/sync/{session_id}")
    async def sync_session_chat(
        session_id: int,
        participant_id: str,
    ):
        """Return the current chat state for participant-side recovery."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session or session.participant_id != participant_id:
                raise HTTPException(404, "Session not found")
            logs = (
                db_session.query(ChatLog)
                .filter(ChatLog.session_id == session_id)
                .order_by(ChatLog.seq)
                .all()
            )
            return {
                "type": "chat_sync",
                "messages": [
                    {"role": log.role, "text": log.content}
                    for log in logs
                    if log.role in ("user", "ai")
                ],
                "turn": sum(1 for log in logs if log.role == "user"),
                "revision": sum(
                    1 for log in logs
                    if log.role == "ai" and "[DRAFT_START]" in log.content
                ),
                "session_id": session.id,
                "condition": session.condition,
            }

    @router.post("/api/baseline-calibrate")
    async def baseline_calibrate(participant_id: str = Form(...)):
        """Calibrate baseline using server-side buffered frames from WebSocket."""
        baseline = expression_engine.calibrate_from_buffer(participant_id)
        if baseline is None:
            raise HTTPException(400, "No baseline frames collected. Ensure baseline recording completed.")

        with db_session_factory() as db_session:
            p = db_session.query(Participant).get(participant_id)
            if p:
                p.baseline_au1 = baseline.au1_mean
                p.baseline_au4 = baseline.au4_mean
                p.baseline_au7 = baseline.au7_mean
                p.baseline_au12 = baseline.au12_mean
                p.baseline_frame_count = baseline.frame_count
                p.baseline_artifact_count = baseline.artifact_count
                db_session.commit()

        return {
            "ok": True,
            "frame_count": baseline.frame_count,
            "artifact_count": baseline.artifact_count,
        }

    @router.post("/api/pre-survey")
    async def submit_pre_survey(
        participant_id: str = Form(...),
        a1_age: str = Form(""), a2_gender: str = Form(""), a3_ai_frequency: str = Form(""),
        a4_ai_experience: int = Form(None), a5_writing_confidence: int = Form(None),
        a6_ai_tool_confidence: int = Form(None), a7_email_familiarity: int = Form(None),
        b1_calm: int = Form(None), b2_stressed: int = Form(None),
        b3_uncertain: int = Form(None), b4_confident: int = Form(None),
        b5_ready: int = Form(None), b6_webcam_comfort: int = Form(None),
        c1_expect_helpful: int = Form(None), c2_expect_understand: int = Form(None),
        c3_expect_easy: int = Form(None), c4_expect_collaborative: int = Form(None),
    ):
        """Submit pre-task survey."""
        values = {
            "a1_age": a1_age, "a2_gender": a2_gender, "a3_ai_frequency": a3_ai_frequency,
            "a4_ai_experience": a4_ai_experience, "a5_writing_confidence": a5_writing_confidence,
            "a6_ai_tool_confidence": a6_ai_tool_confidence, "a7_email_familiarity": a7_email_familiarity,
            "b1_calm": b1_calm, "b2_stressed": b2_stressed, "b3_uncertain": b3_uncertain,
            "b4_confident": b4_confident, "b5_ready": b5_ready, "b6_webcam_comfort": b6_webcam_comfort,
            "c1_expect_helpful": c1_expect_helpful, "c2_expect_understand": c2_expect_understand,
            "c3_expect_easy": c3_expect_easy, "c4_expect_collaborative": c4_expect_collaborative,
        }
        with db_session_factory() as db_session:
            p = db_session.query(Participant).filter(Participant.id == participant_id).first()
            if not p:
                raise HTTPException(400, "Participant not found. Complete setup first.")
            s = db_session.query(PreTaskSurvey).filter(PreTaskSurvey.participant_id == participant_id).first()
            if s:
                for key, value in values.items():
                    setattr(s, key, value)
            else:
                s = PreTaskSurvey(participant_id=participant_id, **values)
                db_session.add(s)
            session = (
                db_session.query(Session)
                .filter(Session.participant_id == participant_id)
                .order_by(Session.id.desc())
                .first()
            )
            add_session_event_once(db_session, session, "pre_survey_submitted")
            try:
                db_session.commit()
            except Exception as e:
                db_session.rollback()
                raise HTTPException(400, f"Failed to save pre-task survey: {e}")
        return {"ok": True}

    @router.post("/api/post-survey")
    async def submit_post_survey(
        session_id: int = Form(...),
        u1: int = Form(None), u2: int = Form(None), u3: int = Form(None),
        u4: int = Form(None), u5: int = Form(None),
        s1: int = Form(None), s2: int = Form(None), s3: int = Form(None),
        s4: int = Form(None), s5: int = Form(None),
        sp1: int = Form(None), sp2: int = Form(None), sp3: int = Form(None),
        cp1: int = Form(None), cp2: int = Form(None), cp3: int = Form(None),
        r1: int = Form(None), r2: int = Form(None), r3: int = Form(None),
        r4: int = Form(None), r5: int = Form(None),
        e1: int = Form(None), e2: int = Form(None), e3: int = Form(None),
        e4: int = Form(None), e5: int = Form(None),
        f1: int = Form(None), f2: int = Form(None), f3: int = Form(None),
        f4: int = Form(None), f5: int = Form(None),
        m1: int = Form(None), m2: int = Form(None), m3: int = Form(None),
        m4: str = Form(""), m5: str = Form(""),
    ):
        """Submit post-task survey."""
        values = {
            "u1_understood_needs": u1, "u2_aware_difficulty": u2, "u3_matched_intent": u3,
            "u4_noticed_stuck": u4, "u5_aligned_thoughts": u5,
            "s1_felt_supported": s1, "s2_useful_guidance": s2, "s3_reduced_effort": s3,
            "s4_concrete_suggestions": s4, "s5_efficient": s5,
            "sp1_socially_responsive": sp1, "sp2_active_partner": sp2, "sp3_socially_engaging": sp3,
            "cp1_ai_with_me": cp1, "cp2_ai_aware_of_me": cp2, "cp3_mutual_awareness": cp3,
            "r1_acknowledged_difficulty": r1, "r2_signaled_uncertainty": r2,
            "r3_helped_differently": r3, "r4_repair_supportive": r4,
            "r5_acknowledgement_appropriate": r5,
            "e1_support_matched_awareness": e1, "e2_met_expectations": e2,
            "e3_more_aware_than_helpful": e3, "e4_disappointed": e4, "e5_raised_expectations": e5,
            "f1_frustrated": f1, "f2_smooth": f2, "f3_satisfied_draft": f3,
            "f4_satisfied_overall": f4, "f5_future_use": f5,
            "m1_responded_to_emotion": m1, "m2_webcam_adapted": m2, "m3_changed_strategy": m3,
            "m4_suspected_adaptation": m4, "m5_open_response": m5,
        }
        with db_session_factory() as db_session:
            sess = db_session.query(Session).filter(Session.id == session_id).first()
            if not sess:
                raise HTTPException(400, "Session not found.")
            s = db_session.query(PostTaskSurvey).filter(PostTaskSurvey.session_id == session_id).first()
            if s:
                for key, value in values.items():
                    setattr(s, key, value)
            else:
                s = PostTaskSurvey(session_id=session_id, **values)
                db_session.add(s)
            add_session_event_once(db_session, sess, "post_survey_submitted")
            try:
                db_session.commit()
            except Exception as e:
                db_session.rollback()
                raise HTTPException(400, f"Failed to save post-task survey: {e}")
        return {"ok": True}

    @router.post("/api/debrief")
    async def debrief(
        participant_id: str = Form(...),
        guessed_purpose: str = Form(""),
        comments: str = Form(""),
    ):
        """Store debrief responses."""

        log_path = root_dir / "data" / "debrief.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "participant_id": participant_id,
                "guessed_purpose": guessed_purpose,
                "comments": comments,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }, ensure_ascii=False) + "\n")
        return {"ok": True}

    @router.post("/api/video-chunk")
    async def upload_video_chunk(
        participant_id: str = Form(...),
        session_id: int = Form(...),
        chunk_index: int = Form(...),
        chunk: UploadFile = File(...),
    ):
        """Receive a video chunk from the browser."""
        video_dir = root_dir / "data" / "videos" / participant_id
        video_dir.mkdir(parents=True, exist_ok=True)
        chunk_path = video_dir / f"{session_id}_{chunk_index:04d}.webm"
        chunk_path.write_bytes(await chunk.read())
        return {"ok": True}

    @router.post("/api/video-final")
    async def upload_video_final(
        participant_id: str = Form(...),
        session_id: int = Form(...),
        video: UploadFile = File(...),
    ):
        """Receive the final browser-produced WebM for playback and download."""
        with db_session_factory() as db_session:
            session = db_session.query(Session).get(session_id)
            if not session or session.participant_id != participant_id:
                raise HTTPException(404, "Session not found")

            video_dir = root_dir / "data" / "videos" / participant_id
            video_dir.mkdir(parents=True, exist_ok=True)
            final_path = video_dir / f"{session_id}.webm"
            tmp_path = final_path.with_suffix(".webm.tmp")
            size = 0
            with tmp_path.open("wb") as out:
                while True:
                    data = await video.read(1024 * 1024)
                    if not data:
                        break
                    size += len(data)
                    out.write(data)
            tmp_path.replace(final_path)
            session.video_path = str(final_path.relative_to(root_dir))
            add_session_event(
                db_session,
                session,
                "video_final_uploaded",
                {"bytes": size, "filename": final_path.name},
            )
            db_session.commit()
        return {"ok": True, "session_id": session_id, "bytes": size}
    return router
