from __future__ import annotations

import time

from . import debug_log
from .ai_client import ChatMessage


TASK_TIME_LIMIT_SECONDS = 15 * 60


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def chat_state_from_logs(logs) -> tuple[list[ChatMessage], int, int]:
    history = [
        ChatMessage(role=log.role, content=log.content)
        for log in logs
        if log.role in ("user", "ai")
    ]
    turn_counter = sum(1 for log in logs if log.role == "user")
    revision_counter = sum(
        1 for log in logs
        if log.role == "ai" and "[DRAFT_START]" in log.content
    )
    return history, turn_counter, revision_counter


def chat_sync_payload(logs, session, turn_counter: int, revision_counter: int, session_id: int) -> dict:
    return {
        "type": "chat_sync",
        "messages": [
            {"role": log.role, "text": log.content}
            for log in logs
            if log.role in ("user", "ai")
        ],
        "turn": turn_counter,
        "revision": revision_counter,
        "session_id": session_id,
        "condition": session.condition if session else None,
    }


def ai_success_debug_payload(
    *,
    ai_client,
    condition: str,
    strategy_name: str | None,
    user_text: str,
    chat_history: list[ChatMessage],
    ai_response_text: str,
) -> dict:
    return {
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
    }


def ai_error_debug_payload(
    *,
    api_err: Exception,
    ai_client,
    condition: str,
    strategy_name: str | None,
    user_text: str,
    chat_history: list[ChatMessage],
) -> dict:
    payload = debug_log._api_error_payload(api_err)
    payload.update({
        "model": ai_client.model,
        "base_url": ai_client.base_url,
        "condition": condition,
        "strategy": strategy_name,
        "prompt": user_text,
        "prompt_chars": len(user_text),
        "history_messages": len(chat_history),
    })
    return payload


def ai_unavailable_message() -> str:
    return "抱歉，我暂时无法回应。请稍等片刻再试。"
