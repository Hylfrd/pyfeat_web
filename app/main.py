"""
Experiment Server — FastAPI Application
=======================================
Orchestrates the entire experiment flow:
  - WebSocket: expression frames, chat messages
  - REST: session lifecycle, questionnaires
  - Integrates: expression.py, strategy.py, ai_client.py, database.py, evaluator.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
import httpx
from collections import deque
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Form, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse

from .database import (
    init_db, Participant, Session, ChatLog, ExpressionFrame,
    Questionnaire, Evaluation, PreTaskSurvey, PostTaskSurvey,
)
from .expression import AUFrame, ExpressionEngine, BaselineResult, PYFEAT_API_URL, PYFEAT_API_TIMEOUT
from .strategy import StrategySelector, UserTurn, Strategy
from .ai_client import AIClient, ChatMessage, EVALUATOR_API_KEY, EVALUATOR_BASE_URL, EVALUATOR_MODEL
from .evaluator import (
    deterministic_score, evaluate_email, get_matched_markers,
    check_hard_fail, llm_heuristic_single,
)

# ── App setup ──────────────────────────────────────────────────────

ROOT_DIR = Path(__file__).resolve().parent.parent  # project root (one level above app/)
STATIC_DIR = ROOT_DIR / "static"

app = FastAPI(title="Co-Writing Emotion AI Study")

# Initialize components
db_session = init_db(str(ROOT_DIR / "data" / "experiment.db"))
expression_engine = ExpressionEngine()
ai_client = AIClient()

eval_ai_client = None
if EVALUATOR_API_KEY:
    eval_ai_client = AIClient(
        model=EVALUATOR_MODEL,
        api_key=EVALUATOR_API_KEY,
        base_url=EVALUATOR_BASE_URL,
    )

# Active WebSocket connections: participant_id → websocket
active_connections: dict[str, WebSocket] = {}
# Active strategy selectors: participant_id → StrategySelector
selectors: dict[str, StrategySelector] = {}
debug_mode = False
debug_events = deque(maxlen=300)
DEBUG_LOG_PATH = ROOT_DIR / "data" / "debug_events.jsonl"

FIFTEEN_MINUTES = 15 * 60  # seconds


def _frame_bytes(image_base64: str) -> int:
    value = image_base64.split(",", 1)[-1]
    padding = value.count("=")
    return max(0, int(len(value) * 3 / 4) - padding)


def _debug_image(image_base64: str) -> Optional[str]:
    return None


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
    payload = {
        "ts": time.strftime("%H:%M:%S", time.localtime()),
        **event,
    }
    debug_events.append(payload)
    DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return payload


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


# ── Startup / Shutdown ─────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    expression_engine.start()
    print("ExpressionEngine started.")


@app.on_event("shutdown")
async def shutdown():
    db_session.close()
    expression_engine.stop()


# ── Pages ──────────────────────────────────────────────────────────

@app.get("/")
async def participant_page():
    """Serve participant HTML."""
    return FileResponse(STATIC_DIR / "participant.html", headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    })


@app.get("/admin")
async def admin_page():
    """Serve experimenter dashboard."""
    return FileResponse(STATIC_DIR / "admin.html", headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    })


@app.get("/api/model-health")
async def model_health():
    return await _pyfeat_health()


# ── Participant API ────────────────────────────────────────────────

GROUPS = ["A", "B", "C", "D"]


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


@app.post("/api/session/start")
async def start_session(
    language: str = Form("zh"),
):
    """Create a new participant (auto-generated ID + balanced group) and first session."""
    participant_id, order_group = _generate_participant_id()

    # Create participant
    p = Participant(id=participant_id, order_group=order_group, language=language)
    db_session.add(p)

    # Determine first task from order group
    first_condition = "text-only" if order_group in ("A", "B") else "affect-aware"
    first_scenario = "A" if order_group in ("A", "C") else "B"

    session = Session(
        participant_id=participant_id,
        task_scenario=first_scenario,
        condition=first_condition,
        condition_order=1,
        start_time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    db_session.add(session)
    db_session.commit()

    # Initialize strategy selector
    selectors[participant_id] = StrategySelector()

    return {
        "participant_id": participant_id,
        "order_group": order_group,
        "session_id": session.id,
        "condition": first_condition,
        "scenario": first_scenario,
        "time_limit_s": FIFTEEN_MINUTES,
    }


@app.post("/api/session/next")
async def next_session(
    participant_id: str = Form(...),
):
    """Start the second task (after completing the first)."""
    p = db_session.query(Participant).get(participant_id)
    if not p:
        raise HTTPException(404, "Participant not found")

    # Determine second task from order group
    second_condition = "affect-aware" if p.order_group in ("A", "B") else "text-only"
    second_scenario = "B" if p.order_group in ("A", "C") else "A"

    session = Session(
        participant_id=participant_id,
        task_scenario=second_scenario,
        condition=second_condition,
        condition_order=2,
        start_time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    db_session.add(session)
    db_session.commit()

    return {
        "session_id": session.id,
        "condition": second_condition,
        "scenario": second_scenario,
        "time_limit_s": FIFTEEN_MINUTES,
    }


PASS_THRESHOLD = int(os.getenv("PASS_THRESHOLD", "20"))


@app.post("/api/evaluate-draft")
async def evaluate_draft(draft_text: str = Form(...)):
    """Full hybrid evaluation. Returns score, signals, matched markers, and LLM flags."""
    # Hard fail check
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

    # Layer 1: Deterministic
    det_result = deterministic_score(draft_text)
    markers_info = get_matched_markers(draft_text)

    # Human-readable signal mapping
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

    # Layer 2: LLM heuristic (async, with 30s timeout)
    llm_flags = []
    if not eval_ai_client:
        _push_debug({
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
            _push_debug({
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
            api_response = _api_error_payload(eval_err)
            api_response.update({
                "model": eval_ai_client.model,
                "base_url": eval_ai_client.base_url,
                "draft_chars": len(draft_text),
            })
            _push_debug({
                "kind": "eval",
                "elapsed_ms": eval_elapsed_ms,
                "api_response": api_response,
                "message": f"draft evaluation LLM error: {type(eval_err).__name__}",
            })
            llm_flags = []  # graceful degradation

    # Composite score
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


@app.post("/api/session/complete")
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

    # Fire post-hoc evaluation in background
    if eval_ai_client and final_email.strip():
        asyncio.create_task(_run_posthoc_evaluation(session_id, final_email))

    return {"ok": True, "session_id": session_id}


async def _detect_frame(participant_id: str, image_base64: str) -> AUFrame:
    return await asyncio.to_thread(expression_engine.process_frame, image_base64, participant_id)

async def _run_posthoc_evaluation(session_id: int, final_email: str):
    """Background task: run full hybrid evaluator and store results."""
    try:
        result = await evaluate_email(eval_ai_client, final_email)
        # Use a fresh DB session (background task, not thread-safe to share)
        from .database import init_db as _init_bg_db
        bg_db = _init_bg_db(str(ROOT_DIR / "data" / "experiment.db"))
        from .database import Evaluation as Eval
        # Store deterministic pass
        bg_db.add(Eval(session_id=session_id, run_number=0, layer="deterministic",
                        score=result.deterministic_score, evaluator_model="py-feat+regex"))
        # Store 3 LLM heuristic runs placeholder (actual runs stored by evaluator)
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


@app.post("/api/questionnaire")
async def submit_questionnaire(
    session_id: int = Form(...),
    # PSU-AI (4 items)
    q1: int = Form(...), q2: int = Form(...), q3: int = Form(...), q4: int = Form(...),
    # UES-SF Reward Factor (3 items)
    q5: int = Form(...), q6: int = Form(...), q7: int = Form(...),
    # UES-SF Perceived Usability (3 items, reverse-scored)
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


@app.post("/api/baseline-calibrate")
async def baseline_calibrate(participant_id: str = Form(...)):
    """Calibrate baseline using server-side buffered frames from WebSocket."""
    baseline = expression_engine.calibrate_from_buffer(participant_id)
    if baseline is None:
        raise HTTPException(400, "No baseline frames collected. Ensure baseline recording completed.")

    # Store in participant record
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


@app.post("/api/pre-survey")
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


@app.post("/api/post-survey")
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


@app.post("/api/debrief")
async def debrief(
    participant_id: str = Form(...),
    guessed_purpose: str = Form(""),
    comments: str = Form(""),
):
    """Store debrief responses."""
    # Minimal — just log to a JSON file for now
    log_path = ROOT_DIR / "data" / "debrief.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "participant_id": participant_id,
            "guessed_purpose": guessed_purpose,
            "comments": comments,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, ensure_ascii=False) + "\n")
    return {"ok": True}


# ── Video upload ───────────────────────────────────────────────────

@app.post("/api/video-chunk")
async def upload_video_chunk(
    participant_id: str = Form(...),
    session_id: int = Form(...),
    chunk_index: int = Form(...),
    chunk: UploadFile = File(...),
):
    """Receive a video chunk from the browser."""
    video_dir = ROOT_DIR / "data" / "videos" / participant_id
    video_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = video_dir / f"{session_id}_{chunk_index:04d}.webm"
    chunk_path.write_bytes(await chunk.read())
    return {"ok": True}


# ── Admin API ──────────────────────────────────────────────────────

@app.get("/api/admin/sessions")
async def admin_sessions():
    """Return all sessions for the dashboard."""
    sessions = db_session.query(Session).order_by(Session.id.desc()).all()
    return [
        {
            "id": s.id,
            "participant_id": s.participant_id,
            "condition": s.condition,
            "task_scenario": s.task_scenario,
            "condition_order": s.condition_order,
            "completed": s.completed,
            "completion_type": s.completion_type,
            "total_turns": s.total_turns,
            "total_revisions": s.total_revisions,
            "duration_ms": s.duration_ms,
            "frame_loss_ratio": round(s.frame_loss_ratio, 3),
            "excluded": s.excluded_by_frame_loss,
        }
        for s in sessions
    ]


@app.get("/api/admin/chat-logs/{session_id}")
async def admin_chat_logs(session_id: int):
    """Return chat logs for a specific session."""
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


@app.get("/api/admin/expression/{session_id}")
async def admin_expression(session_id: int):
    """Return expression timeline for a session."""
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
        }
        for f in frames
    ]


# ── Admin: Baseline data ─────────────────────────────────────────

@app.get("/api/admin/participants/{participant_id}/baseline")
async def admin_baseline(participant_id: str):
    """Return baseline AU data for a participant."""
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


# ── Admin: Delete session ───────────────────────────────────────

@app.delete("/api/admin/sessions/{session_id}")
async def admin_delete_session(session_id: int):
    """Delete a session and all its related data."""
    session = db_session.query(Session).get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    # Delete in dependency order
    db_session.query(Evaluation).filter(Evaluation.session_id == session_id).delete()
    db_session.query(Questionnaire).filter(Questionnaire.session_id == session_id).delete()
    db_session.query(ExpressionFrame).filter(ExpressionFrame.session_id == session_id).delete()
    db_session.query(ChatLog).filter(ChatLog.session_id == session_id).delete()
    db_session.delete(session)
    db_session.commit()
    return {"ok": True, "deleted_session_id": session_id}


# ── Admin: Export session ────────────────────────────────────────

@app.get("/api/admin/sessions/{session_id}/export")
async def admin_export_session(session_id: int):
    """Export a single session as JSON including chat, expression, questionnaire, evaluations."""
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
            "excluded_by_frame_loss": session.excluded_by_frame_loss,
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


# ── Admin: Expression stats ──────────────────────────────────────

@app.get("/api/admin/expression/{session_id}/stats")
async def admin_expression_stats(session_id: int):
    """Return aggregated expression statistics for a session."""
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

    def _mean(values):
        return sum(values) / len(values) if values else 0.0

    def _pct(part):
        return round(part / total * 100, 1) if total else 0.0

    au4_vals = [f.au4 for f in frames]
    au12_vals = [f.au12 for f in frames]
    au7_vals = [f.au7 for f in frames]
    au1_vals = [f.au1 for f in frames]

    # Count frames where AU >= 2 (trigger threshold)
    au4_triggers = sum(1 for v in au4_vals if v >= 2)
    au12_triggers = sum(1 for v in au12_vals if v >= 2)
    au7_triggers = sum(1 for v in au7_vals if v >= 2)
    au1_triggers = sum(1 for v in au1_vals if v >= 1.5)  # lower threshold for AU1 (hesitation)

    return {
        "session_id": session_id,
        "total_frames": total,
        "reliable_frames": reliable,
        "unreliable_frames": total - reliable,
        "reliable_pct": _pct(reliable),
        "face_detected_frames": face_detected,
        "face_lost_frames": face_lost,
        "face_lost_pct": _pct(face_lost),
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
        "triggers_above_2": {
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
            }
            for f in frames
        ],
    }


# ── Admin: Face detection status (for participant page polling) ──

@app.get("/api/admin/face-status/{participant_id}")
async def admin_face_status(participant_id: str):
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


@app.get("/api/admin/debug")
async def admin_debug():
    return {
        "enabled": debug_mode,
        "events": _debug_tail(),
    }


@app.post("/api/admin/debug-mode")
async def admin_debug_mode(enabled: bool = Form(...)):
    global debug_mode
    debug_mode = enabled
    event = _push_debug({
        "kind": "debug",
        "message": f"debug mode {'enabled' if enabled else 'disabled'}",
    })
    return {
        "ok": True,
        "enabled": debug_mode,
        "event": event,
    }


@app.get("/api/admin/debug-health")
async def admin_debug_health():
    return await _pyfeat_health()


@app.post("/api/admin/debug-detect")
async def admin_debug_detect(file: UploadFile = File(...)):
    started = time.perf_counter()
    image_bytes = await file.read()
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    content_type = file.content_type or "image/jpeg"
    url = _pyfeat_base_url() + "/detect"
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


# ── WebSocket ──────────────────────────────────────────────────────

@app.websocket("/ws/{participant_id}")
async def websocket_endpoint(websocket: WebSocket, participant_id: str):
    """Main WebSocket for participant communication."""
    await websocket.accept()
    active_connections[participant_id] = websocket

    # Per-participant state
    chat_history: list[ChatMessage] = []
    turn_counter: int = 0
    revision_counter: int = 0
    session_start = time.time()
    last_chat_time = time.time()  # for idle detection (Offer strategy)
    current_session_id: Optional[int] = None
    baseline_count: int = 0
    total_frames: int = 0
    unreliable_frames: int = 0
    no_face_prompt_sent: bool = False

    try:
        while True:
            try:
                data = await websocket.receive_text()
                msg = json.loads(data)
                msg_type = msg.get("type")

                if msg_type == "session_init":
                    current_session_id = msg.get("session_id")
                    session = db_session.query(Session).get(current_session_id)
                    logs = (
                        db_session.query(ChatLog)
                        .filter(ChatLog.session_id == current_session_id)
                        .order_by(ChatLog.seq)
                        .all()
                    )
                    chat_history = [
                        ChatMessage(role=log.role, content=log.content)
                        for log in logs
                        if log.role in ("user", "ai")
                    ]
                    turn_counter = sum(1 for log in logs if log.role == "user")
                    revision_counter = sum(
                        1 for log in logs
                        if log.role == "ai" and "[DRAFT_START]" in log.content
                    )
                    await websocket.send_text(json.dumps({"type": "ready"}))
                    await websocket.send_text(json.dumps({
                        "type": "chat_sync",
                        "messages": [
                            {"role": log.role, "text": log.content}
                            for log in logs
                            if log.role in ("user", "ai")
                        ],
                        "turn": turn_counter,
                        "revision": revision_counter,
                        "session_id": current_session_id,
                        "condition": session.condition if session else None,
                        "scenario": session.task_scenario if session else None,
                        "task_index": session.condition_order if session else None,
                    }, ensure_ascii=False))

                elif msg_type == "baseline_frame":
                    # During baseline recording — buffer server-side
                    frame_b64 = msg.get("frame", "")
                    started = time.perf_counter()
                    vector = await asyncio.to_thread(
                        expression_engine.collect_baseline_frames,
                        frame_b64,
                        participant_id,
                    )
                    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
                    if vector is not None:
                        baseline_count += 1
                    debug_event = None
                    if debug_mode:
                        debug_event = _push_debug({
                            "kind": "baseline",
                            "participant_id": participant_id,
                            "session_id": current_session_id,
                            "bytes": _frame_bytes(frame_b64),
                            "elapsed_ms": elapsed_ms,
                            "face_detected": vector is not None,
                            "reliable": vector is not None,
                            "image": _debug_image(frame_b64),
                            "api_response": expression_engine.get_last_api_response(),
                            "message": f"baseline frame {baseline_count}: {elapsed_ms} ms",
                        })
                    await websocket.send_text(json.dumps({
                        "type": "baseline_ack",
                        "collected": baseline_count,
                    }))
                    if debug_event:
                        await websocket.send_text(json.dumps({
                            "type": "debug_log",
                            "event": debug_event,
                        }))

                elif msg_type == "expression_frame":
                    # Regular expression frame during task
                    frame_b64 = msg.get("frame", "")
                    started = time.perf_counter()
                    au_frame = await _detect_frame(participant_id, frame_b64)
                    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
                    total_frames += 1

                    face_ok = au_frame and au_frame.face_detected and au_frame.reliable
                    if face_ok:
                        expression_engine._store_frame(participant_id, au_frame)
                        expression_engine.update_expression_label([au_frame], participant_id)
                        no_face_prompt_sent = False
                    else:
                        unreliable_frames += 1
                        # Prompt on ANY unreliability: no face, covered face, or bad head pose
                        if not no_face_prompt_sent:
                            reason = "请面对摄像头。"
                            if au_frame and au_frame.face_detected and not au_frame.reliable:
                                reason = "检测到面部角度不佳，请正对摄像头。"
                            elif not au_frame or not au_frame.face_detected:
                                reason = "未检测到面部，请面对摄像头。"
                            await websocket.send_text(json.dumps({
                                "type": "prompt",
                                "message": reason,
                            }))
                            no_face_prompt_sent = True

                    # Send face status back to participant (persistent binary indicator)
                    await websocket.send_text(json.dumps({
                        "type": "face_status",
                        "face_detected": au_frame.face_detected if au_frame else False,
                        "reliable": au_frame.reliable if au_frame else False,
                    }))
                    if debug_mode:
                        api_response = expression_engine.get_last_api_response()
                        selector = selectors.get(participant_id)
                        if selector:
                            preview_turn = UserTurn(
                                turn_number=turn_counter + 1,
                                user_text="",
                                user_text_length=0,
                                frames=expression_engine.get_recent_frames(participant_id, 3) or [],
                                idle_before_typing=time.time() - last_chat_time,
                            )
                            trigger_checks = selector.preview_trigger_checks(
                                preview_turn,
                                selector.state.turn_history,
                                expression_engine.get_all_recent_frames(participant_id),
                            )
                            if isinstance(api_response, dict):
                                api_response = {**api_response, **trigger_checks}
                            else:
                                api_response = {"raw": api_response, **trigger_checks}
                        debug_event = _push_debug({
                            "kind": "expression",
                            "participant_id": participant_id,
                            "session_id": current_session_id,
                            "bytes": _frame_bytes(frame_b64),
                            "elapsed_ms": elapsed_ms,
                            "face_detected": au_frame.face_detected if au_frame else False,
                            "reliable": au_frame.reliable if au_frame else False,
                            "image": _debug_image(frame_b64),
                            "api_response": api_response,
                            "message": f"expression frame {total_frames}: {elapsed_ms} ms",
                        })
                        await websocket.send_text(json.dumps({
                            "type": "debug_log",
                            "event": debug_event,
                        }))

                    # Batch DB insert (commit every ~10 frames)
                    if current_session_id and au_frame:
                        db_session.add(ExpressionFrame(
                            session_id=current_session_id,
                            timestamp=au_frame.timestamp,
                            au1=au_frame.au1, au4=au_frame.au4,
                            au7=au_frame.au7, au12=au_frame.au12,
                            head_yaw=au_frame.head_yaw,
                            head_pitch=au_frame.head_pitch,
                            head_roll=au_frame.head_roll,
                            face_detected=au_frame.face_detected,
                            reliable=au_frame.reliable,
                        ))
                        if total_frames % 10 == 0:
                            db_session.commit()

                elif msg_type == "chat":
                    # User sent a chat message
                    user_text = msg.get("text", "")
                    condition = msg.get("condition", "text-only")
                    email_language = msg.get("language", "zh")

                    turn_counter += 1
                    latest_frames = expression_engine.get_recent_frames(participant_id, 3)
                    idle_time = time.time() - last_chat_time
                    last_chat_time = time.time()

                    turn = UserTurn(
                        turn_number=turn_counter,
                        user_text=user_text,
                        user_text_length=len(user_text),
                        frames=latest_frames or [],
                        idle_before_typing=idle_time,
                    )

                    # Strategy selection (affect-aware only)
                    strategy: Optional[Strategy] = None
                    escalate_level: int = 0
                    strategy_name: Optional[str] = None
                    trigger_checks: dict[str, bool] = {}

                    if condition == "affect-aware":
                        selector = selectors.get(participant_id)
                        if selector:
                            prior_turns = [t for t in selector.state.turn_history
                                           if t.turn_number < turn_counter]
                            strategy = selector.evaluate(turn, prior_turns)
                            escalate_level = selector.get_escalate_level()
                            strategy_name = strategy.value if strategy else None
                            trigger_checks = selector.get_trigger_checks()

                    if debug_mode and trigger_checks:
                        api_response = expression_engine.get_last_api_response()
                        if isinstance(api_response, dict):
                            api_response = {**api_response, **trigger_checks}
                        else:
                            api_response = {"raw": api_response, **trigger_checks}
                        _push_debug({
                            "kind": "strategy",
                            "participant_id": participant_id,
                            "session_id": current_session_id,
                            "face_detected": latest_frames[-1].face_detected if latest_frames else False,
                            "reliable": latest_frames[-1].reliable if latest_frames else False,
                            "api_response": api_response,
                            "message": f"strategy checks turn {turn_counter}: {strategy_name or 'none'}",
                        })

                    # Call AI
                    ai_started = time.perf_counter()
                    try:
                        ai_task = asyncio.create_task(ai_client.chat(
                            prompt=user_text,
                            history=chat_history,
                            condition=condition,
                            email_language=email_language,
                            strategy=strategy,
                            escalate_level=escalate_level,
                        ))
                        while not ai_task.done():
                            try:
                                await asyncio.wait_for(asyncio.shield(ai_task), timeout=10.0)
                            except asyncio.TimeoutError:
                                await websocket.send_text(json.dumps({
                                    "type": "ai_wait",
                                    "elapsed_ms": round((time.perf_counter() - ai_started) * 1000, 1),
                                }))
                        ai_response_text = ai_task.result()
                        ai_elapsed_ms = round((time.perf_counter() - ai_started) * 1000, 1)
                        if debug_mode:
                            _push_debug({
                                "kind": "ai",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "elapsed_ms": ai_elapsed_ms,
                                "api_response": {
                                    "ok": True,
                                    "model": ai_client.model,
                                    "base_url": ai_client.base_url,
                                    "condition": condition,
                                    "strategy": strategy_name,
                                    "prompt": user_text,
                                    "response": ai_response_text,
                                    "prompt_chars": len(user_text),
                                    "history_messages": len(chat_history),
                                    "response_chars": len(ai_response_text),
                                },
                                "message": f"AI response turn {turn_counter}: {ai_elapsed_ms} ms",
                            })
                    except Exception as api_err:
                        import sys
                        ai_elapsed_ms = round((time.perf_counter() - ai_started) * 1000, 1)
                        api_response = _api_error_payload(api_err)
                        api_response.update({
                            "model": ai_client.model,
                            "base_url": ai_client.base_url,
                            "condition": condition,
                            "strategy": strategy_name,
                            "prompt": user_text,
                            "prompt_chars": len(user_text),
                            "history_messages": len(chat_history),
                        })
                        _push_debug({
                            "kind": "ai",
                            "participant_id": participant_id,
                            "session_id": current_session_id,
                            "elapsed_ms": ai_elapsed_ms,
                            "api_response": api_response,
                            "message": f"AI error turn {turn_counter}: {type(api_err).__name__}",
                        })
                        print(f"[ws] AI API error for {participant_id}: {api_err}", file=sys.stderr)
                        ai_response_text = (
                            "抱歉，我暂时无法回应。请稍等片刻再试。"
                            if email_language == "zh"
                            else "Sorry, I'm temporarily unavailable. Please try again in a moment."
                        )
                        strategy_name = None  # Don't record a strategy for a failed call

                    # Detect revisions
                    if "[DRAFT_START]" in ai_response_text:
                        revision_counter += 1

                    # Store chat logs (user=T*2-1, ai=T*2)
                    if current_session_id:
                        db_session.add(ChatLog(
                            session_id=current_session_id,
                            seq=turn_counter * 2 - 1,
                            role="user",
                            content=user_text,
                            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            expression_label=expression_engine.get_expression_label(participant_id),
                        ))
                        db_session.add(ChatLog(
                            session_id=current_session_id,
                            seq=turn_counter * 2,
                            role="ai",
                            content=ai_response_text,
                            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            strategy_applied=strategy_name,
                        ))
                        db_session.commit()

                    # Update chat history
                    chat_history.append(ChatMessage(role="user", content=user_text))
                    chat_history.append(ChatMessage(role="ai", content=ai_response_text))

                    # Calculate elapsed time
                    elapsed = time.time() - session_start

                    await websocket.send_text(json.dumps({
                        "type": "ai_response",
                        "text": ai_response_text,
                        "turn": turn_counter,
                        "revision": revision_counter,
                        "strategy": strategy_name,
                        "elapsed_s": round(elapsed, 1),
                        "time_remaining_s": max(0, FIFTEEN_MINUTES - int(elapsed)),
                    }, ensure_ascii=False))

            except WebSocketDisconnect:
                raise  # re-raise to outer handler
            except json.JSONDecodeError:
                # Malformed message — log and continue
                import sys
                print(f"[ws] Bad JSON from {participant_id}", file=sys.stderr)
            except Exception as inner_err:
                import sys
                print(f"[ws] Unexpected error for {participant_id}: {inner_err}", file=sys.stderr)
                # Try to notify the client, but don't crash if the send itself fails
                try:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "服务器内部错误，请刷新页面重试。",
                    }))
                except Exception:
                    pass

    except WebSocketDisconnect:
        pass
    finally:
        # Flush any remaining uncommitted expression frames
        try:
            db_session.commit()
        except Exception:
            pass
        active_connections.pop(participant_id, None)
        # Don't remove selector — may be needed for second task


# ── Run ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
