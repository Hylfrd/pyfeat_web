from __future__ import annotations

import asyncio
import json
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import debug_log
from .ai_client import ChatMessage
from .database import ChatLog, ExpressionFrame, Session
from .expression import AUFrame
from .strategy import Strategy, UserTurn


def create_websocket_router(db_session, expression_engine, selectors, ai_client) -> APIRouter:
    router = APIRouter()
    active_connections: dict[str, WebSocket] = {}

    async def _detect_frame(participant_id: str, image_base64: str) -> AUFrame:
        return await asyncio.to_thread(expression_engine.process_frame, image_base64, participant_id)

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
                        if debug_log.is_enabled():
                            debug_event = debug_log._push_debug({
                                "kind": "baseline",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "bytes": debug_log._frame_bytes(frame_b64),
                                "elapsed_ms": elapsed_ms,
                                "face_detected": vector is not None,
                                "reliable": vector is not None,
                                "image": debug_log._debug_image(frame_b64),
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

                        await websocket.send_text(json.dumps({
                            "type": "face_status",
                            "face_detected": au_frame.face_detected if au_frame else False,
                            "reliable": au_frame.reliable if au_frame else False,
                        }))
                        if debug_log.is_enabled():
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
                            debug_event = debug_log._push_debug({
                                "kind": "expression",
                                "participant_id": participant_id,
                                "session_id": current_session_id,
                                "bytes": debug_log._frame_bytes(frame_b64),
                                "elapsed_ms": elapsed_ms,
                                "face_detected": au_frame.face_detected if au_frame else False,
                                "reliable": au_frame.reliable if au_frame else False,
                                "image": debug_log._debug_image(frame_b64),
                                "api_response": api_response,
                                "message": f"expression frame {total_frames}: {elapsed_ms} ms",
                            })
                            await websocket.send_text(json.dumps({
                                "type": "debug_log",
                                "event": debug_event,
                            }))

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
                            db_session.add(ChatLog(
                                session_id=current_session_id,
                                seq=turn_counter * 2 - 1,
                                role="user",
                                content=user_text,
                                timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                expression_label=expression_engine.get_expression_label(participant_id),
                            ))
                            db_session.commit()

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
                            api_response = debug_log._api_error_payload(api_err)
                            api_response.update({
                                "model": ai_client.model,
                                "base_url": ai_client.base_url,
                                "condition": condition,
                                "strategy": strategy_name,
                                "prompt": user_text,
                                "prompt_chars": len(user_text),
                                "history_messages": len(chat_history),
                            })
                            debug_log._push_debug({
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
                            strategy_name = None

                        if "[DRAFT_START]" in ai_response_text:
                            revision_counter += 1

                        if current_session_id:
                            db_session.add(ChatLog(
                                session_id=current_session_id,
                                seq=turn_counter * 2,
                                role="ai",
                                content=ai_response_text,
                                timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
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
                            "time_remaining_s": max(0, FIFTEEN_MINUTES - int(elapsed)),
                        })

                except WebSocketDisconnect:
                    raise
                except json.JSONDecodeError:

                    import sys
                    print(f"[ws] Bad JSON from {participant_id}", file=sys.stderr)
                except Exception as inner_err:
                    import sys
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
                db_session.commit()
            except Exception:
                pass
            active_connections.pop(participant_id, None)
    return router
