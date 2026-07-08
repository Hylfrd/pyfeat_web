from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable


FRAME_QUEUE_TIMEOUT_S = 1.0


@dataclass
class PyFeatJob:
    participant_id: str
    session_id: int | None
    kind: str
    func: Callable[..., Any]
    args: tuple[Any, ...]
    created_at: float
    timeout_s: float
    future: asyncio.Future


@dataclass
class PyFeatResult:
    value: Any = None
    dropped: bool = False
    drop_reason: str = ""
    queued_ms: float = 0.0
    elapsed_ms: float = 0.0


class PyFeatScheduler:
    def __init__(self) -> None:
        self._queues: dict[str, deque[PyFeatJob]] = {}
        self._participant_order: deque[str] = deque()
        self._condition: asyncio.Condition | None = None
        self._worker: asyncio.Task | None = None
        self._running = False

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._condition = asyncio.Condition()
        self._worker = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._condition:
            async with self._condition:
                self._condition.notify_all()
        if self._worker:
            await self._worker
        for queue in self._queues.values():
            while queue:
                job = queue.popleft()
                if not job.future.done():
                    job.future.set_result(PyFeatResult(dropped=True, drop_reason="scheduler_stop"))
        self._queues.clear()
        self._participant_order.clear()

    async def submit(
        self,
        participant_id: str,
        session_id: int | None,
        kind: str,
        func: Callable[..., Any],
        *args: Any,
        timeout_s: float = FRAME_QUEUE_TIMEOUT_S,
    ) -> PyFeatResult:
        if not self._running:
            self.start()
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        job = PyFeatJob(
            participant_id=participant_id,
            session_id=session_id,
            kind=kind,
            func=func,
            args=args,
            created_at=time.perf_counter(),
            timeout_s=timeout_s,
            future=future,
        )
        assert self._condition is not None
        async with self._condition:
            if participant_id not in self._queues:
                self._queues[participant_id] = deque()
                self._participant_order.append(participant_id)
            self._queues[participant_id].append(job)
            self._condition.notify()
        return await future

    def _next_job(self) -> PyFeatJob | None:
        while self._participant_order:
            participant_id = self._participant_order.popleft()
            queue = self._queues.get(participant_id)
            if not queue:
                self._queues.pop(participant_id, None)
                continue
            job = queue.popleft()
            if queue:
                self._participant_order.append(participant_id)
            else:
                self._queues.pop(participant_id, None)
            return job
        return None

    async def _run(self) -> None:
        assert self._condition is not None
        while self._running:
            async with self._condition:
                await self._condition.wait_for(
                    lambda: not self._running or any(self._queues.values())
                )
                if not self._running:
                    break
                job = self._next_job()
            if not job:
                continue

            queued_ms = (time.perf_counter() - job.created_at) * 1000
            if queued_ms > job.timeout_s * 1000:
                if not job.future.done():
                    job.future.set_result(
                        PyFeatResult(
                            dropped=True,
                            drop_reason="queue_timeout",
                            queued_ms=round(queued_ms, 1),
                        )
                    )
                continue

            started = time.perf_counter()
            try:
                value = await asyncio.to_thread(job.func, *job.args)
                elapsed_ms = (time.perf_counter() - started) * 1000
                if not job.future.done():
                    job.future.set_result(
                        PyFeatResult(
                            value=value,
                            queued_ms=round(queued_ms, 1),
                            elapsed_ms=round(elapsed_ms, 1),
                        )
                    )
            except Exception as exc:
                elapsed_ms = (time.perf_counter() - started) * 1000
                if not job.future.done():
                    job.future.set_exception(exc)
