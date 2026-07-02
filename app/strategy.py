"""
Strategy Layer — Expression-Driven Intervention Engine
======================================================
Implements the 6-strategy decision tree for the affect-aware condition.
All strategies share a mandatory dual gate:
  (1) raw AU ≥ 2 (FACS Level B), AND
  (2) ΔAU ≥ DELTA_SD_MULTIPLIER × baseline_sd (above personal noise floor)

AU4 presence gate: AU4_PRESENT_MIN_RATIO (default 0.33) — lower than the
conventional 50% majority to compensate for frame-level AU detection noise
(Cheong et al., 2023). Cooldown mechanism prevents false-positive cascades.

Release: uses AU4 dropping (corrugator relaxation) instead of AU12 (smile).
The cessation of a negative signal = the emergence of a positive one.
Supported by Achour-Benallegue et al. (ISASE 2025):
  Positive emotion = Zygomaticus + Orbicularis Oculi − Corrugator

References:
  - JITAI framework (Nahum-Shani et al., 2018)
  - PEAC model (Carpenter & Roberts, 2025)
  - Corrugator EMG → AU4 signal (Elkins-Brown et al., 2016; Berger et al., 2020)
  - Grafsgaard et al. (2013): AU4/AU7 → confusion/frustration
  - D'Mello et al. (2009): AU4+AU7 → confusion
  - Achour-Benallegue et al. (2025): corrugator deactivation as positive signal
"""

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, List, Optional, Tuple
import time

# Re-export AUFrame from expression.py (single source of truth)
from .expression import AUFrame


# ── Types ──────────────────────────────────────────────────────────

class Strategy(Enum):
    """Six expression-driven strategies (Release is internal-only).

    Release uses AU4 *deactivation* (corrugator relaxation / brow unfurrowing)
    rather than AU12 (smile), because:
      - Genuine smiles are rare in frustrating co-writing tasks.
      - "Angry laughter" (气笑了): AU12 can co-occur with negative AUs,
        making it an unreliable positive signal.
      - Cessation of a negative signal is better evidence of relief
        than the appearance of a positive one (AIST ISASE 2025).
    """
    CHECK_IN  = "check_in"
    PROBE     = "probe"
    RESET     = "reset"
    OFFER     = "offer"
    ESCALATE  = "escalate"
    RELEASE   = "release"  # internal state modifier, no user-visible output


# Priority: higher number = higher priority
# Reset > Escalate > Check-in > Probe > Offer
# Release is independent (not in priority chain)
PRIORITY: Dict[Strategy, int] = {
    Strategy.RESET:     5,
    Strategy.ESCALATE:  4,
    Strategy.CHECK_IN:  3,
    Strategy.PROBE:     2,
    Strategy.OFFER:     1,
    Strategy.RELEASE:   0,  # not compared
}

# Cooldown: turns before same strategy can fire again
# Values > 5 compensate for higher severity (Reset is the most disruptive)
COOLDOWN: Dict[Strategy, int] = {
    Strategy.RESET:     5,   # tied for highest cooldown with Escalate/Check-in/Probe
    Strategy.ESCALATE:  5,
    Strategy.CHECK_IN:  5,
    Strategy.PROBE:     5,
    Strategy.OFFER:     3,   # shortest: low-disruption, safe to re-offer
    Strategy.RELEASE:   0,   # no cooldown — it removes cooldowns
}

# Hard gate: AU must reach this FACS intensity threshold
FACS_B_LEVEL = 0.3  # "slight but clearly present"
FACS_C_LEVEL = 0.5  # "pronounced"

# Dual threshold: delta AU must exceed multiplier × baseline_sd
# (adapts to per-participant noise — a restless baseline widens the gate)
DELTA_SD_MULTIPLIER = 1.0

# Escalate: per-frame AU4 slope window (3 frames ≈ 1.5s at 500ms sampling)
ESCALATE_LOOKBACK_FRAMES = 3

# Release: AU4 must drop from elevated to near-baseline across this many frames
# 5 frames ≈ 2.5s — catches the moment of "unfurrowing" (松了一口气)
AU4_DROP_FRAMES = 5

# AU4 present gate: fraction of frames in a turn that must pass dual gate.
# Frame-level AU detection is inherently noisy (Py-Feat per-frame accuracy
# for individual AUs varies 50–80%; Cheong et al., 2023). A strict majority
# (50%) risks missing real signals due to frame-level noise. A lower fraction
# trades some specificity for sensitivity, which is acceptable because:
#   (a) the cooldown mechanism prevents rapid re-triggering, and
#   (b) false positives are low-cost (a brief check-in vs. missing real frustration).
AU4_PRESENT_MIN_RATIO = 0.33


# ── Data structures ────────────────────────────────────────────────

@dataclass
class UserTurn:
    """One user→AI exchange."""
    turn_number: int
    user_text: str
    user_text_length: int
    frames: List[AUFrame] = field(default_factory=list)
    idle_before_typing: float = 0.0  # seconds user sat idle before typing


@dataclass
class StrategyState:
    """Mutable state tracked across turns."""
    last_fired: Dict[Strategy, int] = field(default_factory=dict)
    cooldown_until: Dict[Strategy, int] = field(default_factory=dict)
    escalate_level: int = 0  # 0 = idle, 1-3 = escalation tiers
    frame_history: List[AUFrame] = field(default_factory=list)  # all frames, sliding window
    turn_history: List[UserTurn] = field(default_factory=list)   # recent turns
    expression_label: str = "neutral"  # most recent expression label
    last_trigger_checks: Dict[str, bool] = field(default_factory=dict)


# ── Trigger checks ─────────────────────────────────────────────────

def _au4_present(frames: List[AUFrame]) -> bool:
    """Check if AU4 meets dual threshold in at least AU4_PRESENT_MIN_RATIO of frames.

    Frame-level AU detection is noisy (Cheong et al., 2023: per-frame accuracy
    for individual AUs varies 50–80%). A strict majority (50%) loses sensitivity.
    The lower gate (default 33%) compensates for frame-level noise while the
    cooldown system prevents false-positive over-triggering.
    """
    if not frames:
        return False
    present = sum(
        1 for f in frames
        if f.au4 >= FACS_B_LEVEL
        and f.delta_au4 >= DELTA_SD_MULTIPLIER * f.baseline_au4_sd
    )
    return present >= max(2, len(frames) * AU4_PRESENT_MIN_RATIO)


def _au4_rising(frames: List[AUFrame], window_s: float = 60.0) -> bool:
    """
    Check-in trigger: AU4 rose from <1 to >=2 within a time window.
    AU4 going from absent/trace to clearly present = early signal.
    """
    if len(frames) < 2:
        return False
    now = frames[-1].timestamp
    window_start = now - window_s
    recent = [f for f in frames if f.timestamp >= window_start]

    if len(recent) < 3:
        return False

    # Find the minimum AU4 value in the window and the current value
    min_au4 = min(f.au4 for f in recent)
    max_au4 = max(f.au4 for f in recent)

    # Trigger: started below 1, now at or above 2, and CURRENTLY elevated
    # The last 3 frames (≈1.5s) should pass dual threshold to confirm it's sustained
    last_few = recent[-3:] if len(recent) >= 3 else recent
    currently_elevated = all(
        f.au4 >= FACS_B_LEVEL
        and f.delta_au4 >= DELTA_SD_MULTIPLIER * f.baseline_au4_sd
        for f in last_few
    )
    return min_au4 < 1.0 and max_au4 >= FACS_B_LEVEL and currently_elevated


def _input_shrinking(turns: List[UserTurn], n: int = 3) -> bool:
    """Probe trigger: last n turns show monotonically decreasing input length."""
    if len(turns) < n:
        return False
    recent = turns[-n:]
    lengths = [t.user_text_length for t in recent]
    return all(lengths[i] > lengths[i + 1] for i in range(len(lengths) - 1))


def _sustained_present(frames_across_turns: List[List[AUFrame]], n_turns: int = 3) -> bool:
    """Reset trigger: AU4 or AU7 present for n consecutive turns."""
    if len(frames_across_turns) < n_turns:
        return False
    recent = frames_across_turns[-n_turns:]
    return all(_au4_present(turn_frames) for turn_frames in recent)


def _idle_with_au1(turn: UserTurn) -> bool:
    """Offer trigger: input idle > 15s with AU1 present."""
    if turn.idle_before_typing < 15.0:
        return False
    if not turn.frames:
        return False
    # Check AU1 in frames during idle period (before typing started)
    idle_frames = [f for f in turn.frames
                   if f.timestamp <= turn.frames[-1].timestamp - turn.idle_before_typing]
    if not idle_frames:
        idle_frames = turn.frames[-3:]  # fallback: last few frames
    return any(
        f.au1 >= FACS_B_LEVEL
        and f.delta_au1 >= DELTA_SD_MULTIPLIER * f.baseline_au1_sd
        for f in idle_frames
    )


def _au4_slope(frame_history: List[AUFrame], n_frames: int = None) -> Tuple[bool, float]:
    """
    Escalate trigger: AU4 rising trend across last n_frames with peak >= C level.
    Uses per-frame AU4 values (not per-turn means) for faster response.
    Default 3 frames ≈ 1.5s at 500ms sampling.

    Returns (triggered, slope).
    """
    if n_frames is None:
        n_frames = ESCALATE_LOOKBACK_FRAMES

    # Only consider reliable frames meeting dual threshold
    reliable = [
        f for f in frame_history
        if f.reliable
        and f.au4 >= FACS_B_LEVEL
        and f.delta_au4 >= DELTA_SD_MULTIPLIER * f.baseline_au4_sd
    ]

    if len(reliable) < n_frames:
        return False, 0.0

    # AU4 values from last n_frames
    recent = reliable[-n_frames:]
    ys = [f.au4 for f in recent]

    if len(ys) < 2:
        return False, 0.0

    # Simple linear regression over frame indices
    xs = list(range(len(ys)))
    n = len(xs)
    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_xx = sum(x * x for x in xs)

    denominator = n * sum_xx - sum_x * sum_x
    if denominator == 0:
        return False, 0.0

    slope = (n * sum_xy - sum_x * sum_y) / denominator
    peak = max(ys)

    triggered = slope > 0 and peak >= FACS_C_LEVEL
    return triggered, slope


def _au4_dropping(frame_history: List[AUFrame], n_frames: int = None) -> bool:
    """
    Release trigger: AU4 was elevated (met dual gate) and has now dropped
    back to near-baseline over the last n_frames.

    "松了一口气" — corrugator relaxation after tension.
    Rationale for not using AU12 (Lip Corner Puller / smile):
      - In a frustrating co-writing task, genuine smiles are rare.
      - "气笑了" (angry laughter): AU12 can co-occur with AU4+AU7 in
        ambivalent or masking expressions, making it an unreliable
        signal of genuine positive affect.
      - AIST (Achour-Benallegue et al., ISASE 2025) directly supports
        corrugator (AU4) deactivation as a positive-emotion signal:
        Positivity = Zygomaticus + Orbicularis − Corrugator.
        AU4 activity *detracts* from positivity; its removal IS the signal.
      - Cessation of a negative signal (brow unfurrowing) is more reliably
        detectable in this context than the appearance of a positive one.

    Default 5 frames ≈ 2.5s at 500ms sampling.
    """
    if n_frames is None:
        n_frames = AU4_DROP_FRAMES

    if len(frame_history) < n_frames + 5:
        return False  # need enough history to establish "was elevated → now dropped"

    # Earlier window (n_frames+5 to n_frames back): was AU4 elevated?
    earlier = frame_history[-(n_frames + 5):-n_frames]
    was_elevated = any(
        f.au4 >= FACS_B_LEVEL
        and f.delta_au4 >= DELTA_SD_MULTIPLIER * f.baseline_au4_sd
        for f in earlier
    )

    if not was_elevated:
        return False

    # Current window (last n_frames): has AU4 dropped substantially?
    current = frame_history[-n_frames:]
    all_dropped = all(
        f.delta_au4 <= DELTA_SD_MULTIPLIER * f.baseline_au4_sd * 0.5
        for f in current
    )

    return all_dropped


def _trigger_checks(
    current_turn: UserTurn,
    all_turns: List[UserTurn],
    frame_history: List[AUFrame],
) -> Dict[str, bool]:
    frames_across_turns = [t.frames for t in all_turns]
    probe_text = _input_shrinking(all_turns, 3)
    probe_au = _au4_present(current_turn.frames)
    esc_triggered, _ = _au4_slope(frame_history)
    release_triggered = _au4_dropping(frame_history)
    return {
        "_au4_present": probe_au,
        "_au4_rising": _au4_rising(frame_history, 60.0),
        "_input_shrinking": probe_text,
        "_sustained_present": _sustained_present(frames_across_turns, 3),
        "_idle_with_au1": _idle_with_au1(current_turn),
        "_au4_slope": esc_triggered,
        "_au4_dropping": release_triggered,
    }


# ── Main strategy selector ─────────────────────────────────────────

class StrategySelector:
    """
    Selects the appropriate expression-driven strategy based on
    real-time AU data, turn history, and internal state.
    """

    def __init__(self):
        self.state = StrategyState()

    def evaluate(
        self,
        current_turn: UserTurn,
        prior_turns: List[UserTurn],
    ) -> Optional[Strategy]:
        """
        Evaluate all strategy triggers for the current turn.
        Returns the highest-priority active strategy, or None.
        Release is checked first (it always fires if triggered, independently).

        Parameters
        ----------
        current_turn : UserTurn
            The turn about to be sent to the AI.
        prior_turns : List[UserTurn]
            All completed turns BEFORE this one.
            current_turn is appended internally to form the full sequence.
        """
        all_turns = prior_turns + [current_turn]
        self.state.turn_history = all_turns
        self.state.frame_history.extend(current_turn.frames)

        # Collect all frames across turns for sustained checks
        self.state.last_trigger_checks = _trigger_checks(
            current_turn,
            all_turns,
            self.state.frame_history,
        )

        # ── 1. Check Release first (always, independent of priority) ──
        # Uses AU4 dropping (corrugator relaxation) instead of AU12 (smile).
        # See _au4_dropping() docstring for rationale.
        probe_text = self.state.last_trigger_checks["_input_shrinking"]
        probe_au = self.state.last_trigger_checks["_au4_present"]
        esc_triggered = self.state.last_trigger_checks["_au4_slope"]
        release_triggered = self.state.last_trigger_checks["_au4_dropping"]
        if release_triggered:
            self._apply_release()
            return Strategy.RELEASE

        # ── 2. Evaluate triggers ──

        triggers: List[Tuple[Strategy, bool]] = []

        # Reset: sustained AU4 or AU7 across 3 turns
        if self.state.last_trigger_checks["_sustained_present"]:
            triggers.append((Strategy.RESET, True))
        else:
            triggers.append((Strategy.RESET, False))

        # Escalate: AU4 rising slope over last 1.5s (3 frames) + peak >= C
        triggers.append((Strategy.ESCALATE, esc_triggered))

        # Check-in: AU4 rising within 60s window
        triggers.append((Strategy.CHECK_IN, self.state.last_trigger_checks["_au4_rising"]))

        # Probe: shrinking input + AU4 present
        triggers.append((Strategy.PROBE, probe_text and probe_au))

        # Offer: idle > 15s + AU1 present
        triggers.append((Strategy.OFFER, self.state.last_trigger_checks["_idle_with_au1"]))

        # ── 3. Select highest-priority triggered strategy ──

        active = [(s, triggered) for s, triggered in triggers if triggered]

        if not active:
            return None

        # Sort by priority (highest first), then filter by cooldown
        active.sort(key=lambda x: PRIORITY[x[0]], reverse=True)

        for strategy, _ in active:
            if self._can_fire(strategy, current_turn.turn_number):
                self._record_fire(strategy, current_turn.turn_number)
                return strategy

        return None  # all eligible strategies are on cooldown

    # ── State management ────────────────────────────────────────

    def _can_fire(self, strategy: Strategy, turn: int) -> bool:
        """Check if a strategy is past its cooldown."""
        if strategy not in self.state.cooldown_until:
            return True
        return turn >= self.state.cooldown_until[strategy]

    def _record_fire(self, strategy: Strategy, turn: int):
        """Record that a strategy fired and set its cooldown."""
        self.state.last_fired[strategy] = turn
        self.state.cooldown_until[strategy] = turn + COOLDOWN[strategy]

        # Escalate has three tiers
        if strategy == Strategy.ESCALATE:
            self.state.escalate_level = min(self.state.escalate_level + 1, 3)
        elif strategy == Strategy.RESET:
            self.state.escalate_level = 0  # Reset clears escalation

    def _apply_release(self):
        """Release: cancel all cooldowns and downgrade escalate."""
        self.state.cooldown_until.clear()
        self.state.escalate_level = max(0, self.state.escalate_level - 1)

    def get_escalate_level(self) -> int:
        """Current escalation tier (0 = idle, 1-3 = active)."""
        return self.state.escalate_level

    def get_expression_label(self) -> str:
        """Most recent expression label."""
        return self.state.expression_label

    def get_trigger_checks(self) -> Dict[str, bool]:
        return dict(self.state.last_trigger_checks)

    def preview_trigger_checks(
        self,
        current_turn: UserTurn,
        prior_turns: List[UserTurn],
        frame_history: Optional[List[AUFrame]] = None,
    ) -> Dict[str, bool]:
        all_turns = prior_turns + [current_turn]
        frames = frame_history if frame_history is not None else self.state.frame_history + current_turn.frames
        return _trigger_checks(current_turn, all_turns, frames)

    def update_expression_label(self, frames: List[AUFrame]):
        """
        Derive a coarse expression label from recent AU frames.
        For logging purposes only — strategy triggers use raw AU values.
        """
        if not frames:
            self.state.expression_label = "neutral"
            return

        recent = frames[-3:]  # last 3 frames ≈ 1.5 seconds
        mean_au4 = sum(f.au4 for f in recent) / len(recent)
        mean_au7 = sum(f.au7 for f in recent) / len(recent)
        mean_au1 = sum(f.au1 for f in recent) / len(recent)
        mean_au12 = sum(f.au12 for f in recent) / len(recent)

        if mean_au4 >= FACS_B_LEVEL and mean_au7 >= FACS_B_LEVEL:
            self.state.expression_label = "frustrated"
        elif mean_au4 >= FACS_B_LEVEL:
            self.state.expression_label = "confused"
        elif mean_au1 >= FACS_B_LEVEL:
            self.state.expression_label = "hesitant"
        elif mean_au12 >= FACS_B_LEVEL:
            self.state.expression_label = "positive"
        else:
            self.state.expression_label = "neutral"
