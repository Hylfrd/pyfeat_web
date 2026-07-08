from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from statistics import mean, stdev
from typing import Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PYFEAT_API_URL = os.getenv("PYFEAT_API_URL", "http://100.93.165.44:8055")
PYFEAT_API_TIMEOUT = float(os.getenv("PYFEAT_API_TIMEOUT", "10"))

PRIMARY_AUS = ["AU01", "AU04", "AU07", "AU12"]
FACS_B = 0.3
FACS_C = 0.5
MAX_YAW = 20
MAX_PITCH = 20
BASELINE_DURATION_S = 5
BASELINE_SAMPLE_INTERVAL = 0.5
BASELINE_KMEANS_K = 2


@dataclass
class AUFrame:
    timestamp: float
    au1: float
    au4: float
    au7: float
    au12: float
    baseline_au1: float = 0.0
    baseline_au4: float = 0.0
    baseline_au7: float = 0.0
    baseline_au12: float = 0.0
    baseline_au1_sd: float = 0.0
    baseline_au4_sd: float = 0.0
    baseline_au7_sd: float = 0.0
    baseline_au12_sd: float = 0.0
    head_yaw: float = 0.0
    head_pitch: float = 0.0
    head_roll: float = 0.0
    face_detected: bool = True
    reliable: bool = True
    drop_reason: str = ""
    queued_ms: float = 0.0

    @property
    def delta_au1(self) -> float:
        return self.au1 - self.baseline_au1

    @property
    def delta_au4(self) -> float:
        return self.au4 - self.baseline_au4

    @property
    def delta_au7(self) -> float:
        return self.au7 - self.baseline_au7

    @property
    def delta_au12(self) -> float:
        return self.au12 - self.baseline_au12

    def au(self, unit: str) -> float:
        return getattr(self, unit.lower())


@dataclass
class BaselineResult:
    au1_mean: float = 0.0
    au4_mean: float = 0.0
    au7_mean: float = 0.0
    au12_mean: float = 0.0
    au1_sd: float = 0.0
    au4_sd: float = 0.0
    au7_sd: float = 0.0
    au12_sd: float = 0.0
    frame_count: int = 0
    artifact_count: int = 0
    calibration_duration_s: float = 0.0


def _number(data: dict, *keys: str, default: float = 0.0) -> float:
    for key in keys:
        if key in data and data[key] is not None:
            try:
                return float(data[key])
            except (TypeError, ValueError):
                return default
    return default


def _boolean(data: dict, *keys: str, default: bool = False) -> bool:
    for key in keys:
        if key in data and data[key] is not None:
            return bool(data[key])
    return default


def _endpoint() -> str:
    value = PYFEAT_API_URL.strip()
    if not value:
        return ""
    if value.rstrip("/").endswith("/detect"):
        return value
    return value.rstrip("/") + "/detect"


class ExpressionEngine:
    def __init__(self):
        self._baselines: Dict[str, BaselineResult] = {}
        self._recent_frames: Dict[str, List[AUFrame]] = {}
        self._expression_labels: Dict[str, str] = {}
        self._baseline_buffer: Dict[str, List[List[float]]] = {}
        self._last_api_response: Optional[dict] = None
        self._started = False

    def start(self):
        self._started = True

    def stop(self):
        self._started = False

    def process_frame(
        self,
        image_base64: str,
        participant_id: str,
    ) -> Optional[AUFrame]:
        if not self._started:
            raise RuntimeError("ExpressionEngine not started. Call .start() first.")

        if not image_base64:
            self._last_api_response = {
                "ok": False,
                "participant_id": participant_id,
                "error": "empty_frame",
            }
            frame = AUFrame(
                timestamp=time.time(),
                au1=0.0,
                au4=0.0,
                au7=0.0,
                au12=0.0,
                face_detected=False,
                reliable=False,
            )
            self._store_frame(participant_id, frame)
            return frame

        data = self._request_detection(image_base64, participant_id)
        if data is None:
            frame = AUFrame(
                timestamp=time.time(),
                au1=0.0,
                au4=0.0,
                au7=0.0,
                au12=0.0,
                face_detected=False,
                reliable=False,
            )
            self._store_frame(participant_id, frame)
            return frame

        baseline = self._baselines.get(participant_id)
        yaw = _number(data, "head_yaw", "yaw", "Yaw")
        pitch = _number(data, "head_pitch", "pitch", "Pitch")
        face_detected = _boolean(data, "face_detected", "face", default=True)
        reliable = _boolean(
            data,
            "reliable",
            "ok",
            default=face_detected and abs(yaw) <= MAX_YAW and abs(pitch) <= MAX_PITCH,
        )

        frame = AUFrame(
            timestamp=_number(data, "timestamp", "time", default=time.time()),
            au1=_number(data, "au1", "AU01", "AU1"),
            au4=_number(data, "au4", "AU04", "AU4"),
            au7=_number(data, "au7", "AU07", "AU7"),
            au12=_number(data, "au12", "AU12"),
            baseline_au1=baseline.au1_mean if baseline else 0.0,
            baseline_au4=baseline.au4_mean if baseline else 0.0,
            baseline_au7=baseline.au7_mean if baseline else 0.0,
            baseline_au12=baseline.au12_mean if baseline else 0.0,
            baseline_au1_sd=baseline.au1_sd if baseline else 0.0,
            baseline_au4_sd=baseline.au4_sd if baseline else 0.0,
            baseline_au7_sd=baseline.au7_sd if baseline else 0.0,
            baseline_au12_sd=baseline.au12_sd if baseline else 0.0,
            head_yaw=yaw,
            head_pitch=pitch,
            head_roll=_number(data, "head_roll", "roll", "Roll"),
            face_detected=face_detected,
            reliable=reliable,
        )
        self._store_frame(participant_id, frame)
        return frame

    def _request_detection(self, image_base64: str, participant_id: str) -> Optional[dict]:
        endpoint = _endpoint()
        self._last_api_response = None
        if not endpoint:
            return None

        payload = json.dumps(
            {
                "image": image_base64,
                "participant_id": participant_id,
            }
        ).encode("utf-8")
        request = Request(
            endpoint,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urlopen(request, timeout=PYFEAT_API_TIMEOUT) as response:
                body = response.read().decode("utf-8")
                data = json.loads(body)
                if isinstance(data, dict):
                    self._last_api_response = data
                if isinstance(data, dict) and isinstance(data.get("data"), dict):
                    return data["data"]
                if isinstance(data, dict):
                    return data
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            self._last_api_response = {
                "ok": False,
                "participant_id": participant_id,
                "error": str(exc),
            }
            return None
        return None

    def get_last_api_response(self) -> Optional[dict]:
        return self._last_api_response

    def collect_baseline_frames(
        self,
        image_base64: str,
        participant_id: str = "__baseline__",
    ) -> Optional[List[float]]:
        frame = self.process_frame(image_base64, participant_id)
        if frame is None or not frame.face_detected or not frame.reliable:
            return None

        vector = [frame.au1, frame.au4, frame.au7, frame.au12]
        if participant_id not in self._baseline_buffer:
            self._baseline_buffer[participant_id] = []
        self._baseline_buffer[participant_id].append(vector)
        return vector

    def calibrate_from_buffer(self, participant_id: str) -> Optional[BaselineResult]:
        frames = self._baseline_buffer.get(participant_id, [])
        if not frames:
            return None
        result = self.calibrate_baseline(participant_id, frames)
        del self._baseline_buffer[participant_id]
        return result

    def clear_baseline_buffer(self, participant_id: str) -> None:
        self._baseline_buffer.pop(participant_id, None)

    def calibrate_baseline(
        self,
        participant_id: str,
        frames: List[List[float]],
    ) -> BaselineResult:
        rows = frames or [[0.0, 0.0, 0.0, 0.0]]
        columns = list(zip(*rows))

        result = BaselineResult(
            au1_mean=float(mean(columns[0])),
            au4_mean=float(mean(columns[1])),
            au7_mean=float(mean(columns[2])),
            au12_mean=float(mean(columns[3])),
            au1_sd=float(stdev(columns[0])) if len(columns[0]) > 1 else 0.0,
            au4_sd=float(stdev(columns[1])) if len(columns[1]) > 1 else 0.0,
            au7_sd=float(stdev(columns[2])) if len(columns[2]) > 1 else 0.0,
            au12_sd=float(stdev(columns[3])) if len(columns[3]) > 1 else 0.0,
            frame_count=len(frames),
            artifact_count=0,
            calibration_duration_s=len(frames) * BASELINE_SAMPLE_INTERVAL,
        )
        self._baselines[participant_id] = result
        return result

    def get_baseline(self, participant_id: str) -> Optional[BaselineResult]:
        return self._baselines.get(participant_id)

    def has_baseline(self, participant_id: str) -> bool:
        return participant_id in self._baselines

    def _store_frame(self, participant_id: str, frame: AUFrame):
        if participant_id not in self._recent_frames:
            self._recent_frames[participant_id] = []
        self._recent_frames[participant_id].append(frame)
        if len(self._recent_frames[participant_id]) > 120:
            self._recent_frames[participant_id] = self._recent_frames[participant_id][-120:]

    def get_recent_frames(self, participant_id: str, n: int = 3) -> List[AUFrame]:
        frames = self._recent_frames.get(participant_id, [])
        return frames[-n:] if frames else []

    def get_all_recent_frames(self, participant_id: str) -> List[AUFrame]:
        return self._recent_frames.get(participant_id, [])

    def update_expression_label(self, frames: List[AUFrame], participant_id: str = "__default__"):
        if not frames:
            return

        recent = frames[-3:]
        mean_au4 = sum(f.au4 for f in recent) / len(recent)
        mean_au7 = sum(f.au7 for f in recent) / len(recent)
        mean_au1 = sum(f.au1 for f in recent) / len(recent)
        mean_au12 = sum(f.au12 for f in recent) / len(recent)

        if mean_au4 >= FACS_B and mean_au7 >= FACS_B:
            label = "frustrated"
        elif mean_au4 >= FACS_B:
            label = "confused"
        elif mean_au1 >= FACS_B:
            label = "hesitant"
        elif mean_au12 >= FACS_B:
            label = "positive"
        else:
            label = "neutral"

        self._expression_labels[participant_id] = label

    def get_expression_label(self, participant_id: str = "__default__") -> str:
        label = self._expression_labels.get(participant_id)
        if label is not None:
            return label
        return self._expression_labels.get("__default__", "neutral")
