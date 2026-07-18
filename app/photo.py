from __future__ import annotations

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect


class _PhotoRelay:
    """A deliberately tiny in-memory relay for the temporary photo page."""

    def __init__(self) -> None:
        self.phone: WebSocket | None = None
        self.computer: WebSocket | None = None

    def _get(self, role: str) -> WebSocket | None:
        return self.phone if role == "phone" else self.computer

    def _set(self, role: str, websocket: WebSocket | None) -> None:
        if role == "phone":
            self.phone = websocket
        else:
            self.computer = websocket

    async def send_json(self, role: str, payload: dict) -> bool:
        websocket = self._get(role)
        if websocket is None:
            return False
        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:
            if self._get(role) is websocket:
                self._set(role, None)
            return False

    async def send_bytes(self, role: str, payload: bytes) -> bool:
        websocket = self._get(role)
        if websocket is None:
            return False
        try:
            await websocket.send_bytes(payload)
            return True
        except Exception:
            if self._get(role) is websocket:
                self._set(role, None)
            return False

    async def register(self, role: str, websocket: WebSocket) -> None:
        previous = self._get(role)
        self._set(role, websocket)
        if previous and previous is not websocket:
            try:
                await previous.close(code=4001, reason="replaced")
            except Exception:
                pass

        peer_role = "computer" if role == "phone" else "phone"
        await self.send_json(role, {
            "type": "relay_ready",
            "role": role,
            "peer_connected": self._get(peer_role) is not None,
        })
        await self.send_json(peer_role, {"type": f"{role}_connected"})

    async def unregister(self, role: str, websocket: WebSocket) -> None:
        if self._get(role) is not websocket:
            return
        self._set(role, None)
        peer_role = "computer" if role == "phone" else "phone"
        await self.send_json(peer_role, {"type": f"{role}_disconnected"})


def create_photo_router() -> APIRouter:
    router = APIRouter()
    relay = _PhotoRelay()

    @router.websocket("/ws/photo")
    async def photo_websocket(websocket: WebSocket) -> None:
        role = websocket.query_params.get("role")
        if role not in {"phone", "computer"}:
            await websocket.close(code=1008, reason="role must be phone or computer")
            return

        await websocket.accept()
        await relay.register(role, websocket)

        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break

                if role != "phone":
                    continue

                binary_payload = message.get("bytes")
                if binary_payload:
                    await relay.send_bytes("computer", binary_payload)
                    continue

                text_payload = message.get("text")
                if not text_payload:
                    continue
                try:
                    payload = json.loads(text_payload)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") in {"recording_start", "recording_stop"}:
                    await relay.send_json("computer", payload)
        except WebSocketDisconnect:
            pass
        finally:
            await relay.unregister(role, websocket)

    return router
