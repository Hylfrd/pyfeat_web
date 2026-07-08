from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import debug_log
from .ai_client import ChatMessage
from .database import ChatLog, ExpressionFrame, Participant, Session
from .expression import AUFrame
from .experiment_slots import touch_experiment_slot
from .session_activity import mark_disconnected, touch_session
from .strategy import Strategy, UserTurn
from .websocket_utils import (
    TASK_TIME_LIMIT_SECONDS,
    ai_error_debug_payload,
    ai_success_debug_payload,
    ai_unavailable_message,
    chat_state_from_logs,
    chat_sync_payload,
    utc_timestamp,
)


def create_websocket_router(db_session_factory, expression_engine, pyfeat_scheduler, selectors, ai_client) -> APIRouter:
    router = APIRouter()
    active_connections: dict[str, WebSocket] = {}

    async def _detect_frame(participant_id: str, session_id: int | None, image_base64: str) -> tuple[AUFrame, float]:
        result = await pyfeat_scheduler.submit(
            participant_id,
            session_id,
            "expression",
            expression_engine.process_frame,
            image_base64,
            participant_id,
        )
        if result.dropped:
            frame = AUFrame(
                timestamp=time.time(),
                au1=0.0,
                au4=0.0,
                au7=0.0,
                au12=0.0,
                face_detected=False,
                reliable=False,
                drop_reason=result.drop_reason,
                queued_ms=result.queued_ms,
            )
            expression_engine._store_frame(participant_id, frame)
            return frame, result.elapsed_ms

        frame = result.value
        if frame:
            frame.queued_ms = result.queued_ms
            if not frame.reliable and not frame.drop_reason:
                frame.drop_reason = "pose_unreliable" if frame.face_detected else "no_face"
        return frame, result.elapsed_ms

    @router.websocket("/ws/{participant_id}")
    async def websocket_endpoint(websocket: WebSocket, participant_id: str):
        """Main WebSocket for participant communication."""
        await websocket.accept()
        active_connections[participant_id] = websocket

        chat_history: list[ChatMessage] = []
        turn_counter: int = 0
        revision_counter: int = 0
        session_start = time.time()
        last_chat_time = time.time()
        current_session_id: Optional[int] = None
        baseline_count: int = 0
        total_frames: int = 0
        unreliable_frames: int = 0
        no_face_prompt_sent: bool = False
        socket_alive: bool = True
        pending_expression_frames: list[ExpressionFrame] = []

        async def safe_send(payload: dict) -> bool:
            nonlocal socket_alive
            if not socket_alive:
                return False
            try:
                await websocket.send_text(json.dumps(payload, ensure_ascii=False))
                return True
            except (WebSocketDisconnect, RuntimeError):
                socket_alive = False
                return False

        async def ensure_session_exists() -> bool:
            if not current_session_id:
                return True
            with db_session_factory() as db_session:
                exists = db_session.query(Session).get(current_session_id) is not None
            if exists:
                return True
            await safe_send({"type": "session_missing"})
            return False

        def flush_expression_frames() -> None:
            if not pending_expression_frames:
                return
            with db_session_factory() as db_session:
                db_session.add_all(pending_expression_frames)
                db_session.commit()
            pending_expression_frames.clear()

        try:
            while True:
                try:
                    data = await websocket.receive_text()
                    msg = json.loads(data)
                    msg_type = msg.get("type")

                    if msg_type == "session_init":
                        current_session_id = msg.get("session_id")
                        with db_session_factory() as db_session:
                            session = db_session.query(Session).get(current_session_id)
                            if not session:
                                await safe_send({"type": "session_missing"})
                                continue
                            logs = (
                                db_session.query(ChatLog)
                                .filter(ChatLog.session_id == current_session_id)
                                .order_by(ChatLog.seq)
                                .all()
                            )
                            chat_history, turn_counter, revision_counter = chat_state_from_logs(logs)
                            sync_payload = chat_sync_payload(
                                logs,
                                session,
                                turn_counter,
                                revision_counter,
                                current_session_id,
                            )
                        touch_session(participant_id, current_session_id)
                        await websocket.send_text(json.dumps({"type": "ready"}))
                        await websocket.send_text(json.dumps(sync_payload, ensure_ascii=False))

                    elif msg_type == "baseline_reset":
                        touch_experiment_slot(current_session_id, "baseline")
                        baseline_count = 0
                        expression_engine.clear_baseline_buffer(participant_id)
                        await safe_send({
                            "type": "baseline_ack",
                            "collected": baseline_count,
                        })

                    elif msg_type == "baseline_frame":
                        if not await ensure_session_exists():
                            continue
                        touch_session(participant_id, current_session_id)
                        touch_experiment_slot(current_session_id, "baseline")

                        frame_b64 = msg.get("frame", "")
                        result = await pyfeat_scheduler.submit(
                            participant_id,
                            current_session_id,
                            "baseline",
                            expression_engine.collect_baseline_frames,
                            frame_b64,
                            participant_id,
                        )
                        vector = None if result.dropped else result.value
                        elapsed_ms = result.elapsed_ms
                        if vector is not None:
                            baseline_count += 1
                        if debug_log.is_enabled():
                            debug_log._push_debug({
                                "kind": "baseline",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "bytes": debug_log._frame_bytes(frame_b64),
                                "elapsed_ms": elapsed_ms,
                                "queued_ms": result.queued_ms,
                                "drop_reason": result.drop_reason,
                                "face_detected": vector is not None,
                                "reliable": vector is not None,
                                "image": debug_log._debug_image(frame_b64),
                                "api_response": None if result.dropped else expression_engine.get_last_api_response(),
                                "message": (
                                    f"baseline frame dropped: {result.drop_reason}"
                                    if result.dropped else f"baseline frame {baseline_count}: {elapsed_ms} ms"
                                ),
                            })
                        if not await safe_send({
                            "type": "baseline_ack",
                            "collected": baseline_count,
                            "face_detected": vector is not None,
                            "reliable": vector is not None,
                            "drop_reason": result.drop_reason,
                            "elapsed_ms": elapsed_ms,
                            "queued_ms": result.queued_ms,
                        }):
                            break

                    elif msg_type == "baseline_calibrate":
                        touch_experiment_slot(current_session_id, "baseline")
                        baseline = expression_engine.calibrate_from_buffer(participant_id)
                        if baseline is None:
                            baseline_count = 0
                            await safe_send({
                                "type": "baseline_calibrated",
                                "ok": False,
                                "message": "No baseline frames collected.",
                            })
                            continue

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

                        baseline_count = 0
                        await safe_send({
                            "type": "baseline_calibrated",
                            "ok": True,
                            "frame_count": baseline.frame_count,
                            "artifact_count": baseline.artifact_count,
                        })

                    elif msg_type == "task_started":
                        if not await ensure_session_exists():
                            continue
                        touch_session(participant_id, current_session_id)
                        touch_experiment_slot(current_session_id, "task")
                        await safe_send({"type": "task_started_ack"})

                    elif msg_type == "expression_frame":
                        if not await ensure_session_exists():
                            continue
                        touch_session(participant_id, current_session_id)
                        touch_experiment_slot(current_session_id, "task")

                        frame_b64 = msg.get("frame", "")
                        au_frame, elapsed_ms = await _detect_frame(participant_id, current_session_id, frame_b64)
                        total_frames += 1

                        face_ok = au_frame and au_frame.face_detected and au_frame.reliable
                        if face_ok:
                            expression_engine._store_frame(participant_id, au_frame)
                            expression_engine.update_expression_label([au_frame], participant_id)
                            no_face_prompt_sent = False
                        else:
                            unreliable_frames += 1

                            internal_drop = au_frame and au_frame.drop_reason in {"queue_timeout", "scheduler_stop"}
                            if internal_drop:
                                pass
                            elif not no_face_prompt_sent:
                                reason = "请面对摄像头。"
                                if au_frame and au_frame.face_detected and not au_frame.reliable:
                                    reason = "检测到面部角度不佳，请正对摄像头。"
                                elif not au_frame or not au_frame.face_detected:
                                    reason = "未检测到面部，请面对摄像头。"
                                if not await safe_send({
                                    "type": "prompt",
                                    "message": reason,
                                }):
                                    break
                                no_face_prompt_sent = True

                        if not await safe_send({
                            "type": "face_status",
                            "face_detected": au_frame.face_detected if au_frame else False,
                            "reliable": au_frame.reliable if au_frame else False,
                            "drop_reason": au_frame.drop_reason if au_frame else "pyfeat_error",
                            "elapsed_ms": elapsed_ms,
                            "queued_ms": au_frame.queued_ms if au_frame else 0.0,
                            "frame_index": total_frames,
                        }):
                            break
                        if debug_log.is_enabled():
                            api_response = (
                                {"ok": False, "drop_reason": au_frame.drop_reason}
                                if au_frame and au_frame.drop_reason == "queue_timeout"
                                else expression_engine.get_last_api_response()
                            )
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
                            debug_log._push_debug({
                                "kind": "expression",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "bytes": debug_log._frame_bytes(frame_b64),
                                "elapsed_ms": elapsed_ms,
                                "queued_ms": au_frame.queued_ms if au_frame else 0.0,
                                "drop_reason": au_frame.drop_reason if au_frame else "pyfeat_error",
                                "face_detected": au_frame.face_detected if au_frame else False,
                                "reliable": au_frame.reliable if au_frame else False,
                                "image": debug_log._debug_image(frame_b64),
                                "api_response": api_response,
                                "message": (
                                    f"expression frame {total_frames}: {au_frame.drop_reason}"
                                    if au_frame and au_frame.drop_reason
                                    else f"expression frame {total_frames}: {elapsed_ms} ms"
                                ),
                            })

                        if current_session_id and au_frame:
                            pending_expression_frames.append(ExpressionFrame(
                                session_id=current_session_id,
                                timestamp=au_frame.timestamp,
                                au1=au_frame.au1, au4=au_frame.au4,
                                au7=au_frame.au7, au12=au_frame.au12,
                                head_yaw=au_frame.head_yaw,
                                head_pitch=au_frame.head_pitch,
                                head_roll=au_frame.head_roll,
                                face_detected=au_frame.face_detected,
                                reliable=au_frame.reliable,
                                drop_reason=au_frame.drop_reason or None,
                                queued_ms=au_frame.queued_ms,
                            ))
                            if len(pending_expression_frames) >= 10:
                                flush_expression_frames()

                    elif msg_type == "chat":
                        if not await ensure_session_exists():
                            continue
                        touch_session(participant_id, current_session_id)

                        user_text = msg.get("text", "")
                        condition = msg.get("condition", "text-only")

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

                        if debug_log.is_enabled() and trigger_checks:
                            api_response = expression_engine.get_last_api_response()
                            if isinstance(api_response, dict):
                                api_response = {**api_response, **trigger_checks}
                            else:
                                api_response = {"raw": api_response, **trigger_checks}
                            debug_log._push_debug({
                                "kind": "strategy",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "face_detected": latest_frames[-1].face_detected if latest_frames else False,
                                "reliable": latest_frames[-1].reliable if latest_frames else False,
                                "api_response": api_response,
                                "message": f"strategy checks turn {turn_counter}: {strategy_name or 'none'}",
                            })

                        if current_session_id:
                            with db_session_factory() as db_session:
                                db_session.add(ChatLog(
                                    session_id=current_session_id,
                                    seq=turn_counter * 2 - 1,
                                    role="user",
                                    content=user_text,
                                    timestamp=utc_timestamp(),
                                    expression_label=expression_engine.get_expression_label(participant_id),
                                ))
                                db_session.commit()

                        ai_started = time.perf_counter()
                        try:
                            ai_task = asyncio.create_task(ai_client.chat(
                                prompt=user_text,
                                history=chat_history,
                                condition=condition,
                                email_language="zh",
                                strategy=strategy,
                                escalate_level=escalate_level,
                            ))
                            while not ai_task.done():
                                try:
                                    await asyncio.wait_for(asyncio.shield(ai_task), timeout=10.0)
                                except asyncio.TimeoutError:
                                    await safe_send({
                                        "type": "ai_wait",
                                        "elapsed_ms": round((time.perf_counter() - ai_started) * 1000, 1),
                                    })
                            ai_response_text = ai_task.result()
                            ai_elapsed_ms = round((time.perf_counter() - ai_started) * 1000, 1)
                            if debug_log.is_enabled():
                                debug_log._push_debug({
                                    "kind": "ai",
                                    "participant_id": participant_id,
                                    "session_id": current_session_id,
                                    "elapsed_ms": ai_elapsed_ms,
                                    "api_response": ai_success_debug_payload(
                                        ai_client=ai_client,
                                        condition=condition,
                                        strategy_name=strategy_name,
                                        user_text=user_text,
                                        chat_history=chat_history,
                                        ai_response_text=ai_response_text,
                                    ),
                                    "message": f"AI response turn {turn_counter}: {ai_elapsed_ms} ms",
                                })
                        except Exception as api_err:
                            ai_elapsed_ms = round((time.perf_counter() - ai_started) * 1000, 1)
                            api_response = ai_error_debug_payload(
                                api_err=api_err,
                                ai_client=ai_client,
                                condition=condition,
                                strategy_name=strategy_name,
                                user_text=user_text,
                                chat_history=chat_history,
                            )
                            debug_log._push_debug({
                                "kind": "ai",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "elapsed_ms": ai_elapsed_ms,
                                "api_response": api_response,
                                "message": f"AI error turn {turn_counter}: {type(api_err).__name__}",
                            })
                            print(f"[ws] AI API error for {participant_id}: {api_err}", file=sys.stderr)
                            ai_response_text = ai_unavailable_message()
                            strategy_name = None

                        if "[DRAFT_START]" in ai_response_text:
                            revision_counter += 1

                        if current_session_id:
                            with db_session_factory() as db_session:
                                db_session.add(ChatLog(
                                    session_id=current_session_id,
                                    seq=turn_counter * 2,
                                    role="ai",
                                    content=ai_response_text,
                                    timestamp=utc_timestamp(),
                                    strategy_applied=strategy_name,
                                ))
                                db_session.commit()

                        chat_history.append(ChatMessage(role="user", content=user_text))
                        chat_history.append(ChatMessage(role="ai", content=ai_response_text))

                        elapsed = time.time() - session_start

                        await safe_send({
                            "type": "ai_response",
                            "text": ai_response_text,
                            "turn": turn_counter,
                            "revision": revision_counter,
                            "strategy": strategy_name,
                            "elapsed_s": round(elapsed, 1),
                            "time_remaining_s": max(0, TASK_TIME_LIMIT_SECONDS - int(elapsed)),
                        })

                except WebSocketDisconnect:
                    raise
                except json.JSONDecodeError:
                    print(f"[ws] Bad JSON from {participant_id}", file=sys.stderr)
                except Exception as inner_err:
                    print(f"[ws] Unexpected error for {participant_id}: {inner_err}", file=sys.stderr)

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

            try:
                flush_expression_frames()
            except Exception:
                pass
            active_connections.pop(participant_id, None)
            mark_disconnected(participant_id)
    return router
