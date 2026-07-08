"""
Database Layer — SQLAlchemy ORM
================================
Six tables: participants, sessions, chat_logs, expression_frames,
questionnaires, evaluations.

Missing-data policy (§10.1):
  - Expression frames: >30% unreliable → session excluded
  - Admin manual override can exclude or re-include a session
  - Questionnaires: >2 missing items (out of 10) → response excluded

The LLM for evaluation (Gemini) differs from the writing-task LLM (DeepSeek V4 Flash).
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column, Integer, String, Float, Boolean, Text, DateTime,
    ForeignKey, create_engine, text,
)
from sqlalchemy.engine import URL
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, relationship, sessionmaker

from .mysql_config import (
    MYSQL_CHARSET,
    MYSQL_COLLATION,
    MYSQL_DATABASE,
    MYSQL_HOST,
    MYSQL_MAX_OVERFLOW,
    MYSQL_PASSWORD,
    MYSQL_POOL_RECYCLE_SECONDS,
    MYSQL_POOL_SIZE,
    MYSQL_PORT,
    MYSQL_USER,
)


# ── Base ────────────────────────────────────────────────────────────

class Base(DeclarativeBase):
    pass


# ── Tables ──────────────────────────────────────────────────────────

class Participant(Base):
    __tablename__ = "participants"

    id: Mapped[str] = Column(String(32), primary_key=True)  # e.g. "P01"
    order_group: Mapped[str] = Column(String(1), nullable=False)  # A/B condition balancing group
    language: Mapped[str] = Column(String(2), nullable=False, default="zh")  # fixed zh
    baseline_au1: Mapped[float] = Column(Float, default=0.0)
    baseline_au4: Mapped[float] = Column(Float, default=0.0)
    baseline_au7: Mapped[float] = Column(Float, default=0.0)
    baseline_au12: Mapped[float] = Column(Float, default=0.0)
    baseline_frame_count: Mapped[int] = Column(Integer, default=0)
    baseline_artifact_count: Mapped[int] = Column(Integer, default=0)
    created_at: Mapped[str] = Column(String(32), default=lambda: datetime.utcnow().isoformat())

    sessions: Mapped[list["Session"]] = relationship(back_populates="participant")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    participant_id: Mapped[str] = Column(String(32), ForeignKey("participants.id"), nullable=False)
    task_scenario: Mapped[str] = Column(String(1), nullable=False)  # fixed A for current single-task flow
    condition: Mapped[str] = Column(String(32), nullable=False)  # text-only / affect-aware
    condition_order: Mapped[int] = Column(Integer, nullable=False)  # 1 for current single-task flow
    start_time: Mapped[Optional[str]] = Column(String(32), nullable=True)
    end_time: Mapped[Optional[str]] = Column(String(32), nullable=True)
    duration_ms: Mapped[Optional[int]] = Column(Integer, nullable=True)
    completion_type: Mapped[str] = Column(String(32), default="manual")  # manual / timeout
    final_email: Mapped[Optional[str]] = Column(Text, nullable=True)
    total_turns: Mapped[int] = Column(Integer, default=0)
    total_revisions: Mapped[int] = Column(Integer, default=0)
    total_frames: Mapped[int] = Column(Integer, default=0)
    unreliable_frames: Mapped[int] = Column(Integer, default=0)
    exclusion_override: Mapped[Optional[str]] = Column(String(32), nullable=True)  # exclude / include / None
     
    completed: Mapped[bool] = Column(Boolean, default=False)
    video_path: Mapped[Optional[str]] = Column(String(512), nullable=True)

    participant: Mapped[Participant] = relationship(back_populates="sessions")
    chat_logs: Mapped[list["ChatLog"]] = relationship(back_populates="session")
    expression_frames: Mapped[list["ExpressionFrame"]] = relationship(back_populates="session")
    questionnaire: Mapped[Optional["Questionnaire"]] = relationship(back_populates="session")
    evaluations: Mapped[list["Evaluation"]] = relationship(back_populates="session")

    @property
    def frame_loss_ratio(self) -> float:
        if self.total_frames == 0:
            return 0.0
        return self.unreliable_frames / self.total_frames

    @property
    def excluded_by_frame_loss(self) -> bool:
        return self.frame_loss_ratio > 0.30

    @property
    def excluded(self) -> bool:
        if self.exclusion_override == "exclude":
            return True
        if self.exclusion_override == "include":
            return False
        return self.excluded_by_frame_loss


class ChatLog(Base):
    __tablename__ = "chat_logs"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    seq: Mapped[int] = Column(Integer, nullable=False)
    role: Mapped[str] = Column(String(4), nullable=False)  # "user" / "ai"
    content: Mapped[str] = Column(Text, nullable=False)
    timestamp: Mapped[str] = Column(String(32), nullable=False)
    expression_label: Mapped[Optional[str]] = Column(String(32), nullable=True)
    strategy_applied: Mapped[Optional[str]] = Column(String(64), nullable=True)  # Strategy.name
    is_hidden: Mapped[bool] = Column(Boolean, default=False)

    session: Mapped[Session] = relationship(back_populates="chat_logs")


class ExpressionFrame(Base):
    __tablename__ = "expression_frames"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    timestamp: Mapped[float] = Column(Float, nullable=False)
    au1: Mapped[float] = Column(Float, default=0.0)
    au4: Mapped[float] = Column(Float, default=0.0)
    au7: Mapped[float] = Column(Float, default=0.0)
    au12: Mapped[float] = Column(Float, default=0.0)
    head_yaw: Mapped[float] = Column(Float, default=0.0)
    head_pitch: Mapped[float] = Column(Float, default=0.0)
    head_roll: Mapped[float] = Column(Float, default=0.0)
    face_detected: Mapped[bool] = Column(Boolean, default=True)
    reliable: Mapped[bool] = Column(Boolean, default=True)

    session: Mapped[Session] = relationship(back_populates="expression_frames")


class Questionnaire(Base):
    """10 items: PSU-AI (4) + UES-SF Reward Factor (3) + UES-SF Perceived Usability (3, reverse-scored)."""
    __tablename__ = "questionnaires"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = Column(Integer, ForeignKey("sessions.id"), nullable=False, unique=True)

    # PSU-AI: Perceived understanding and support (ω = .92; Liang & Banks, 2025)
    q1_understood: Mapped[Optional[int]] = Column(Integer, nullable=True)   # "The AI understood what I was trying to achieve."
    q2_same_page: Mapped[Optional[int]] = Column(Integer, nullable=True)    # "The AI and I were on the same page."
    q3_aware: Mapped[Optional[int]] = Column(Integer, nullable=True)        # "The AI was aware of what I needed in our interaction."
    q4_connected: Mapped[Optional[int]] = Column(Integer, nullable=True)    # "The AI and I were connected to each other."

    # UES-SF Reward Factor: Satisfaction (O'Brien et al., 2018)
    q5_rewarding: Mapped[Optional[int]] = Column(Integer, nullable=True)    # "This experience was rewarding."
    q6_interested: Mapped[Optional[int]] = Column(Integer, nullable=True)   # "I felt interested in this experience."
    q7_worthwhile: Mapped[Optional[int]] = Column(Integer, nullable=True)   # "This experience was worthwhile."

    # UES-SF Perceived Usability: Frustration (reverse-scored)
    q8_frustrated: Mapped[Optional[int]] = Column(Integer, nullable=True)   # "I felt frustrated while using this assistant." [R]
    q9_confusing: Mapped[Optional[int]] = Column(Integer, nullable=True)    # "I found this assistant confusing to use." [R]
    q10_taxing: Mapped[Optional[int]] = Column(Integer, nullable=True)      # "Using this assistant was mentally taxing." [R]

    session: Mapped[Session] = relationship(back_populates="questionnaire")

    @property
    def psua_mean(self) -> Optional[float]:
        vals = [self.q1_understood, self.q2_same_page, self.q3_aware, self.q4_connected]
        valid = [v for v in vals if v is not None]
        return sum(valid) / len(valid) if valid else None

    @property
    def ues_reward_mean(self) -> Optional[float]:
        vals = [self.q5_rewarding, self.q6_interested, self.q7_worthwhile]
        valid = [v for v in vals if v is not None]
        return sum(valid) / len(valid) if valid else None

    @property
    def ues_usability_mean(self) -> Optional[float]:
        """Reverse-scored: higher = less frustrated (better)."""
        vals = [self.q8_frustrated, self.q9_confusing, self.q10_taxing]
        valid = [8 - v for v in vals if v is not None]  # reverse 1-7 scale
        return sum(valid) / len(valid) if valid else None

    @property
    def missing_count(self) -> int:
        all_items = [
            self.q1_understood, self.q2_same_page, self.q3_aware, self.q4_connected,
            self.q5_rewarding, self.q6_interested, self.q7_worthwhile,
            self.q8_frustrated, self.q9_confusing, self.q10_taxing,
        ]
        return sum(1 for v in all_items if v is None)

    @property
    def excluded_by_missing(self) -> bool:
        return self.missing_count > 2


class Evaluation(Base):
    __tablename__ = "evaluations"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    run_number: Mapped[int] = Column(Integer, nullable=False)  # 1/2/3 for self-consistency
    layer: Mapped[str] = Column(String(64), nullable=False)  # "deterministic" / "llm_heuristic"
    score: Mapped[float] = Column(Float, nullable=False)
    evaluator_model: Mapped[str] = Column(String(128), nullable=False)  # e.g. "kimi-k2.6"
    details_json: Mapped[Optional[str]] = Column(Text, nullable=True)
    timestamp: Mapped[str] = Column(String(32), default=lambda: datetime.utcnow().isoformat())

    session: Mapped[Session] = relationship(back_populates="evaluations")


class PreTaskSurvey(Base):
    """Pre-task survey: Background (A1-A7) + Baseline state (B1-B6) + Expectations (C1-C4)."""
    __tablename__ = "pre_task_surveys"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    participant_id: Mapped[str] = Column(String(32), ForeignKey("participants.id"), nullable=False, unique=True)

    # A1-A7: Background and prior experience
    a1_age: Mapped[Optional[str]] = Column(String(64), nullable=True)
    a2_gender: Mapped[Optional[str]] = Column(String(64), nullable=True)
    a3_ai_frequency: Mapped[Optional[str]] = Column(String(64), nullable=True)
    a4_ai_experience: Mapped[Optional[int]] = Column(Integer, nullable=True)
    a5_writing_confidence: Mapped[Optional[int]] = Column(Integer, nullable=True)
    a6_ai_tool_confidence: Mapped[Optional[int]] = Column(Integer, nullable=True)
    a7_email_familiarity: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # B1-B6: Baseline emotional and task state
    b1_calm: Mapped[Optional[int]] = Column(Integer, nullable=True)
    b2_stressed: Mapped[Optional[int]] = Column(Integer, nullable=True)
    b3_uncertain: Mapped[Optional[int]] = Column(Integer, nullable=True)
    b4_confident: Mapped[Optional[int]] = Column(Integer, nullable=True)
    b5_ready: Mapped[Optional[int]] = Column(Integer, nullable=True)
    b6_webcam_comfort: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # C1-C4: Pre-task expectations
    c1_expect_helpful: Mapped[Optional[int]] = Column(Integer, nullable=True)
    c2_expect_understand: Mapped[Optional[int]] = Column(Integer, nullable=True)
    c3_expect_easy: Mapped[Optional[int]] = Column(Integer, nullable=True)
    c4_expect_collaborative: Mapped[Optional[int]] = Column(Integer, nullable=True)

    created_at: Mapped[str] = Column(String(32), default=lambda: datetime.utcnow().isoformat())
    participant: Mapped[Participant] = relationship()


class PostTaskSurvey(Base):
    """Post-task survey: Understanding (U1-U5) + Support (S1-S5) + Social presence (SP1-SP3) +
    Co-presence (CP1-CP3) + Repair (R1-R5) + Expectation (E1-E5) + Satisfaction (F1-F5) + Manipulation check (M1-M5)."""
    __tablename__ = "post_task_surveys"

    id: Mapped[int] = Column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = Column(Integer, ForeignKey("sessions.id"), nullable=False, unique=True)

    # U1-U5: Perceived understanding
    u1_understood_needs: Mapped[Optional[int]] = Column(Integer, nullable=True)
    u2_aware_difficulty: Mapped[Optional[int]] = Column(Integer, nullable=True)
    u3_matched_intent: Mapped[Optional[int]] = Column(Integer, nullable=True)
    u4_noticed_stuck: Mapped[Optional[int]] = Column(Integer, nullable=True)
    u5_aligned_thoughts: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # S1-S5: Perceived support
    s1_felt_supported: Mapped[Optional[int]] = Column(Integer, nullable=True)
    s2_useful_guidance: Mapped[Optional[int]] = Column(Integer, nullable=True)
    s3_reduced_effort: Mapped[Optional[int]] = Column(Integer, nullable=True)
    s4_concrete_suggestions: Mapped[Optional[int]] = Column(Integer, nullable=True)
    s5_efficient: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # SP1-SP3: Social presence
    sp1_socially_responsive: Mapped[Optional[int]] = Column(Integer, nullable=True)
    sp2_active_partner: Mapped[Optional[int]] = Column(Integer, nullable=True)
    sp3_socially_engaging: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # CP1-CP3: Co-presence
    cp1_ai_with_me: Mapped[Optional[int]] = Column(Integer, nullable=True)
    cp2_ai_aware_of_me: Mapped[Optional[int]] = Column(Integer, nullable=True)
    cp3_mutual_awareness: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # R1-R5: Repair recognition
    r1_acknowledged_difficulty: Mapped[Optional[int]] = Column(Integer, nullable=True)
    r2_signaled_uncertainty: Mapped[Optional[int]] = Column(Integer, nullable=True)
    r3_helped_differently: Mapped[Optional[int]] = Column(Integer, nullable=True)
    r4_repair_supportive: Mapped[Optional[int]] = Column(Integer, nullable=True)
    r5_acknowledgement_appropriate: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # E1-E5: Expectation fulfillment
    e1_support_matched_awareness: Mapped[Optional[int]] = Column(Integer, nullable=True)
    e2_met_expectations: Mapped[Optional[int]] = Column(Integer, nullable=True)
    e3_more_aware_than_helpful: Mapped[Optional[int]] = Column(Integer, nullable=True)
    e4_disappointed: Mapped[Optional[int]] = Column(Integer, nullable=True)
    e5_raised_expectations: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # F1-F5: Frustration, satisfaction, future use
    f1_frustrated: Mapped[Optional[int]] = Column(Integer, nullable=True)
    f2_smooth: Mapped[Optional[int]] = Column(Integer, nullable=True)
    f3_satisfied_draft: Mapped[Optional[int]] = Column(Integer, nullable=True)
    f4_satisfied_overall: Mapped[Optional[int]] = Column(Integer, nullable=True)
    f5_future_use: Mapped[Optional[int]] = Column(Integer, nullable=True)

    # M1-M5: Manipulation check (M5 is open text)
    m1_responded_to_emotion: Mapped[Optional[int]] = Column(Integer, nullable=True)
    m2_webcam_adapted: Mapped[Optional[int]] = Column(Integer, nullable=True)
    m3_changed_strategy: Mapped[Optional[int]] = Column(Integer, nullable=True)
    m4_suspected_adaptation: Mapped[Optional[int]] = Column(Integer, nullable=True)
    m5_open_response: Mapped[Optional[str]] = Column(Text, nullable=True)

    created_at: Mapped[str] = Column(String(32), default=lambda: datetime.utcnow().isoformat())
    session: Mapped[Session] = relationship()


# ── Engine helper ──────────────────────────────────────────────────

def _mysql_url() -> URL:
    return URL.create(
        "mysql+pymysql",
        username=MYSQL_USER,
        password=MYSQL_PASSWORD,
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        database=MYSQL_DATABASE,
        query={"charset": MYSQL_CHARSET},
    )


def _mysql_server_url() -> URL:
    return URL.create(
        "mysql+pymysql",
        username=MYSQL_USER,
        password=MYSQL_PASSWORD,
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        query={"charset": MYSQL_CHARSET},
    )


def _ensure_mysql_database() -> None:
    database = MYSQL_DATABASE.replace("`", "``")
    server_engine = create_engine(
        _mysql_server_url(),
        echo=False,
        pool_pre_ping=True,
        pool_recycle=MYSQL_POOL_RECYCLE_SECONDS,
    )
    try:
        with server_engine.begin() as conn:
            conn.execute(text(
                f"CREATE DATABASE IF NOT EXISTS `{database}` "
                f"CHARACTER SET {MYSQL_CHARSET} COLLATE {MYSQL_COLLATION}"
            ))
    finally:
        server_engine.dispose()


def init_session_factory():
    """Create tables and return a session factory.

    SQLAlchemy Session objects are not safe to share between concurrent requests,
    so the FastAPI app keeps this factory globally and opens short-lived sessions
    around each database operation.
    """
    _ensure_mysql_database()
    engine = create_engine(
        _mysql_url(),
        echo=False,
        pool_pre_ping=True,
        pool_size=MYSQL_POOL_SIZE,
        max_overflow=MYSQL_MAX_OVERFLOW,
        pool_recycle=MYSQL_POOL_RECYCLE_SECONDS,
    )

    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> Session:
    """Create tables and return a standalone session for compatibility."""
    return init_session_factory()()
