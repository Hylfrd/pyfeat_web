from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

from fastapi import APIRouter, Form

from . import debug_log
from .ai_client import EVALUATOR_MODEL
from .evaluator import (
    check_hard_fail, deterministic_score, evaluate_email, get_matched_markers,
    llm_heuristic_single,
)


def create_evaluation_router(eval_ai_client) -> APIRouter:
    router = APIRouter()

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
        llm_result = None
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
                    "unctuous_warmth":    ("谄媚温情",   "过度热情和讨好（'非常感谢您的时间''我知道您多么关心学生'），真实压力下的学生不会这样写。"),
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
                llm_result = None

        llm_score = llm_result.score if llm_result else 0
        composite = (
            max(
                0.35 * det_result.score + 0.65 * llm_score,
                0.9 * llm_score,
                0.6 * det_result.score,
            )
            if llm_result else det_result.score
        )
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
    return router


async def run_posthoc_evaluation(root_dir: Path, eval_ai_client, session_id: int, final_email: str):
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
