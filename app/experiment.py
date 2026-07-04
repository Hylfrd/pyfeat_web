from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import debug_log
from .ai_client import EVALUATOR_MODEL
from .database import (
    ChatLog, Participant, PostTaskSurvey, PreTaskSurvey, Questionnaire, Session,
)
from .evaluator import (
    check_hard_fail, deterministic_score, evaluate_email, get_matched_markers,
    llm_heuristic_single,
)
from .strategy import StrategySelector


def create_experiment_router(
    root_dir: Path,
    db_session,
    expression_engine,
    selectors,
    eval_ai_client,
) -> APIRouter:
    router = APIRouter()

    GROUPS = ["A", "B", "C", "D"]
    FIFTEEN_MINUTES = 15 * 60

    def _generate_participant_id() -> tuple[str, str]:
        """Auto-generate sequential participant ID and balanced order group.

        Returns (participant_id, order_group).
        Groups assigned cyclically: P001→A, P002→B, P003→C, P004→D, P005→A, ...
        """
        last = db_session.query(Participant).order_by(Participant.id.desc()).first()
        if last and last.id.startswith("P"):
            try:
                n = int(last.id[1:]) + 1
            except ValueError:
                n = 1
        else:
            n = 1
        order_group = GROUPS[(n - 1) % 4]
        return f"P{n:03d}", order_group

    @router.post("/api/session/start")
    async def start_session(
        language: str = Form("zh"),
    ):
        """Create a new participant (auto-generated ID + balanced group) and session."""
        participant_id, order_group = _generate_participant_id()

        p = Participant(id=participant_id, order_group=order_group, language=language)
        db_session.add(p)

        assigned_condition = "text-only" if order_group in ("A", "B") else "affect-aware"
        assigned_scenario = "A" if order_group in ("A", "C") else "B"

        session = Session(
            participant_id=participant_id,
            task_scenario=assigned_scenario,
            condition=assigned_condition,
            condition_order=1,
            start_time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        db_session.add(session)
        db_session.commit()

        selectors[participant_id] = StrategySelector()

        return {
            "participant_id": participant_id,
            "order_group": order_group,
            "session_id": session.id,
            "condition": assigned_condition,
            "scenario": assigned_scenario,
            "time_limit_s": FIFTEEN_MINUTES,
        }

    @router.post("/api/session/next")
    async def next_session(
        participant_id: str = Form(...),
    ):
        """Deprecated: the experiment now uses one assigned writing task."""
        raise HTTPException(410, "This experiment now uses a single task session.")

    PASS_THRESHOLD = int(os.getenv("PASS_THRESHOLD", "20"))

    @router.post("/api/evaluate-draft")
    async def evaluate_draft(draft_text: str = Form(...)):
        """Full hybrid evaluation. Returns score, signals, matched markers, and LLM flags."""

        hard_fail_reason = check_hard_fail(draft_text)
        if hard_fail_reason:
            return {
                "passed": False,
                "score": 100,
                "threshold": PASS_THRESHOLD,
                "hard_fail": True,
                "hard_fail_reason": hard_fail_reason,
                "signals": [],
                "matched_markers": None,
                "llm_flags": [],
            }

        det_result = deterministic_score(draft_text)
        markers_info = get_matched_markers(draft_text)

        SIGNAL_LABELS = {
            "low_burstiness":       ("句长变化",       "句子长度过于均匀，口语通常有长有短。试试把一些句子打断或合并。"),
            "formulaic_markers":    ("AI套话检测",     "检测到 AI 常用短语。删掉这些套话，用你自己的语言改写。"),
            "transition_density":   ("连接词密度",     "连接词太多了（'此外/然而/总之'），真实的邮件很少用这么多过渡词。"),
            "lexical_smoothness":   ("词汇多样性",     "用词重复较多，试着换一些不同的表达方式。"),
            "structured_shape":     ("结构化程度",     "格式太工整了（列表/标题），像模板生成的，试试写得更随意一些。"),
            "compressibility":      ("文本可压缩性",   "文本存在重复模式，真实写作通常更不规则。"),
        }

        signals = []
        for s in det_result.signals:
            label, suggestion = SIGNAL_LABELS.get(s.name, (s.name, ""))
            signals.append({
                "key": s.name,
                "name": label,
                "value": round(s.value, 2),
                "weight": round(s.weight, 2),
                "note": s.note,
                "suggestion": suggestion,
            })

        llm_flags = []
        if not eval_ai_client:
            debug_log._push_debug({
                "kind": "eval",
                "api_response": {
                    "ok": False,
                    "error": "eval_client_disabled",
                    "model": EVALUATOR_MODEL,
                },
                "message": "draft evaluation skipped: no evaluator client",
            })
        elif draft_text.strip():
            eval_started = time.perf_counter()
            try:
                llm_result = await asyncio.wait_for(
                    llm_heuristic_single(eval_ai_client, draft_text),
                    timeout=120.0,
                )
                eval_elapsed_ms = round((time.perf_counter() - eval_started) * 1000, 1)
                FLAG_LABELS = {
                    "emotional_flatline": ("情感平淡",   "危机描述缺乏情感紧迫感，读起来像在描述天气。"),
                    "hollow_empathy":     ("空洞共情",   "表达了理解但没有具体行动，共情没有落到实处。"),
                    "pseudo_humility":    ("伪谦逊式",   "过度道歉或自贬（'我完全理解''我深感抱歉'），真实学生很少这样写。"),
                    "over_polished":      ("过度完美",   "每个标点都正确，没有口语的不规则，不像赶截止日的学生写出来的。"),
                }
                for key, flagged in llm_result.flags.items():
                    name, note = FLAG_LABELS.get(key, (key, ""))
                    llm_flags.append({
                        "key": key,
                        "name": name,
                        "flagged": flagged,
                        "note": note,
                    })
                debug_log._push_debug({
                    "kind": "eval",
                    "elapsed_ms": eval_elapsed_ms,
                    "api_response": {
                        "ok": True,
                        "model": eval_ai_client.model,
                        "base_url": eval_ai_client.base_url,
                        "draft_chars": len(draft_text),
                        "flag_count": len(llm_flags),
                        "flagged": [f["key"] for f in llm_flags if f["flagged"]],
                    },
                    "message": f"draft evaluation LLM: {eval_elapsed_ms} ms",
                })
            except (asyncio.TimeoutError, Exception) as eval_err:
                eval_elapsed_ms = round((time.perf_counter() - eval_started) * 1000, 1)
                api_response = debug_log._api_error_payload(eval_err)
                api_response.update({
                    "model": eval_ai_client.model,
                    "base_url": eval_ai_client.base_url,
                    "draft_chars": len(draft_text),
                })
                debug_log._push_debug({
                    "kind": "eval",
                    "elapsed_ms": eval_elapsed_ms,
                    "api_response": api_response,
                    "message": f"draft evaluation LLM error: {type(eval_err).__name__}",
                })
                llm_flags = []

        llm_score = sum(25 for f in llm_flags if f["flagged"]) if llm_flags else 0
        composite = 0.6 * det_result.score + 0.4 * llm_score if llm_flags else det_result.score
        score = round(composite)
        passed = score < PASS_THRESHOLD

        return {
            "passed": passed,
            "score": score,
            "threshold": PASS_THRESHOLD,
            "hard_fail": False,
            "hard_fail_reason": "",
            "signals": signals,
            "matched_markers": {
                "total": markers_info["total"],
                "lang": markers_info["lang"],
                "hits": [h["matched_text"] for h in markers_info["hits"][:8]],
            },
            "llm_flags": llm_flags,
            "llm_score": llm_score,
            "det_score": det_result.score,
        }

    @router.post("/api/session/complete")
    async def complete_session(
        session_id: int = Form(...),
        final_email: str = Form(...),
        duration_ms: int = Form(...),
        completion_type: str = Form("manual"),
        total_turns: int = Form(0),
        total_revisions: int = Form(0),
        total_frames: int = Form(0),
        unreliable_frames: int = Form(0),
    ):
        """Mark a session as complete and store the final email."""
        session = db_session.query(Session).get(session_id)
        if not session:
            raise HTTPException(404, "Session not found")

        session.end_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        session.duration_ms = duration_ms
        session.completion_type = completion_type
        session.final_email = final_email
        session.total_turns = total_turns
        session.total_revisions = total_revisions
        session.total_frames = total_frames
        session.unreliable_frames = unreliable_frames
        session.completed = True
        db_session.commit()

        if eval_ai_client and final_email.strip():
            asyncio.create_task(_run_posthoc_evaluation(session_id, final_email))

        return {"ok": True, "session_id": session_id}

    async def _run_posthoc_evaluation(session_id: int, final_email: str):
        """Background task: run full hybrid evaluator and store results."""
        try:
            result = await evaluate_email(eval_ai_client, final_email)

            from .database import init_db as _init_bg_db
            bg_db = _init_bg_db(str(root_dir / "data" / "experiment.db"))
            from .database import Evaluation as Eval

            bg_db.add(Eval(session_id=session_id, run_number=0, layer="deterministic",
                            score=result.deterministic_score, evaluator_model="py-feat+regex"))

            bg_db.add(Eval(session_id=session_id, run_number=0, layer="hybrid_composite",
                            score=result.composite_score,
                            evaluator_model=EVALUATOR_MODEL,
                            details_json=json.dumps({
                                "llm_median": result.llm_median_score,
                                "verdict": result.verdict.value,
                                "hard_fail": result.hard_fail,
                            })))
            bg_db.commit()
            bg_db.close()
            print(f"[eval] Session {session_id}: composite={result.composite_score:.0f} "
                  f"det={result.deterministic_score} llm_median={result.llm_median_score:.0f}")
        except Exception as e:
            print(f"[eval] Session {session_id} failed: {e}")

    @router.post("/api/questionnaire")
    async def submit_questionnaire(
        session_id: int = Form(...),

        q1: int = Form(...), q2: int = Form(...), q3: int = Form(...), q4: int = Form(...),

        q5: int = Form(...), q6: int = Form(...), q7: int = Form(...),

        q8: int = Form(...), q9: int = Form(...), q10: int = Form(...),
    ):
        """Submit post-task questionnaire."""
        q = Questionnaire(
            session_id=session_id,
            q1_understood=q1, q2_same_page=q2, q3_aware=q3, q4_connected=q4,
            q5_rewarding=q5, q6_interested=q6, q7_worthwhile=q7,
            q8_frustrated=q8, q9_confusing=q9, q10_taxing=q10,
        )
        db_session.merge(q)
        db_session.commit()
        return {"ok": True}

    @router.get("/api/session/sync/{session_id}")
    async def sync_session_chat(
        session_id: int,
        participant_id: str,
    ):
        """Return the current chat state for participant-side recovery."""
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
            "scenario": session.task_scenario,
            "task_index": session.condition_order,
        }

    @router.post("/api/baseline-calibrate")
    async def baseline_calibrate(participant_id: str = Form(...)):
        """Calibrate baseline using server-side buffered frames from WebSocket."""
        baseline = expression_engine.calibrate_from_buffer(participant_id)
        if baseline is None:
            raise HTTPException(400, "No baseline frames collected. Ensure baseline recording completed.")

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
        p = db_session.query(Participant).filter(Participant.id == participant_id).first()
        if not p:
            raise HTTPException(400, "Participant not found. Complete setup first.")
        values = {
            "a1_age": a1_age, "a2_gender": a2_gender, "a3_ai_frequency": a3_ai_frequency,
            "a4_ai_experience": a4_ai_experience, "a5_writing_confidence": a5_writing_confidence,
            "a6_ai_tool_confidence": a6_ai_tool_confidence, "a7_email_familiarity": a7_email_familiarity,
            "b1_calm": b1_calm, "b2_stressed": b2_stressed, "b3_uncertain": b3_uncertain,
            "b4_confident": b4_confident, "b5_ready": b5_ready, "b6_webcam_comfort": b6_webcam_comfort,
            "c1_expect_helpful": c1_expect_helpful, "c2_expect_understand": c2_expect_understand,
            "c3_expect_easy": c3_expect_easy, "c4_expect_collaborative": c4_expect_collaborative,
        }
        s = db_session.query(PreTaskSurvey).filter(PreTaskSurvey.participant_id == participant_id).first()
        if s:
            for key, value in values.items():
                setattr(s, key, value)
        else:
            s = PreTaskSurvey(participant_id=participant_id, **values)
            db_session.add(s)
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
        m4: int = Form(None), m5: str = Form(""),
    ):
        """Submit post-task survey."""
        sess = db_session.query(Session).filter(Session.id == session_id).first()
        if not sess:
            raise HTTPException(400, "Session not found.")
        s = PostTaskSurvey(
            session_id=session_id,
            u1_understood_needs=u1, u2_aware_difficulty=u2, u3_matched_intent=u3,
            u4_noticed_stuck=u4, u5_aligned_thoughts=u5,
            s1_felt_supported=s1, s2_useful_guidance=s2, s3_reduced_effort=s3,
            s4_concrete_suggestions=s4, s5_efficient=s5,
            sp1_socially_responsive=sp1, sp2_active_partner=sp2, sp3_socially_engaging=sp3,
            cp1_ai_with_me=cp1, cp2_ai_aware_of_me=cp2, cp3_mutual_awareness=cp3,
            r1_acknowledged_difficulty=r1, r2_signaled_uncertainty=r2,
            r3_helped_differently=r3, r4_repair_supportive=r4,
            r5_acknowledgement_appropriate=r5,
            e1_support_matched_awareness=e1, e2_met_expectations=e2,
            e3_more_aware_than_helpful=e3, e4_disappointed=e4, e5_raised_expectations=e5,
            f1_frustrated=f1, f2_smooth=f2, f3_satisfied_draft=f3,
            f4_satisfied_overall=f4, f5_future_use=f5,
            m1_responded_to_emotion=m1, m2_webcam_adapted=m2, m3_changed_strategy=m3,
            m4_suspected_adaptation=m4, m5_open_response=m5,
        )
        try:
            db_session.merge(s)
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
    return router
