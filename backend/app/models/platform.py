"""Cross-cutting tables — outbox/eventing, simulation state, fault ground truth, audit."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

FAULT_TYPES = (
    "BEARING_WEAR", "FLATLINE", "SPIKE", "DROPOUT", "DUPLICATE", "LATE_EVENT", "BAD_UNIT", "UNKNOWN_SENSOR",
)


class OutboxEvent(Base):
    __tablename__ = "outbox_events"
    __table_args__ = (
        CheckConstraint("status IN ('PENDING', 'DISPATCHED', 'DEAD')", name="status"),
        CheckConstraint("layer BETWEEN 1 AND 7", name="layer"),
        Index("ix_outbox_status_id", "status", "id"),
        Index("ix_outbox_correlation", "correlation_id"),
        Index("ix_outbox_type", "event_type"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True)
    event_type: Mapped[str] = mapped_column(String(40))
    layer: Mapped[int] = mapped_column(Integer)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
    asset_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    correlation_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(12), default="PENDING")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # Retry scheduling is infrastructure, so it uses a monotonic wall-clock (seconds), not sim time.
    next_attempt_at: Mapped[float] = mapped_column(Float, default=0.0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProcessedEvent(Base):
    __tablename__ = "processed_events"
    __table_args__ = (UniqueConstraint("event_id", "consumer"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), index=True)
    consumer: Mapped[str] = mapped_column(String(60))
    processed_at: Mapped[datetime] = mapped_column(DateTime)


class DeadLetter(Base):
    __tablename__ = "dead_letters"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), index=True)
    event_type: Mapped[str] = mapped_column(String(40))
    consumer: Mapped[str] = mapped_column(String(60))
    attempts: Mapped[int] = mapped_column(Integer)
    error: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seed: Mapped[int] = mapped_column(Integer)
    profile: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[datetime] = mapped_column(DateTime)  # sim time at reset (epoch)
    note: Mapped[str] = mapped_column(Text, default="")


class SimulationState(Base):
    """Singleton row (id = 1): the simulation clock and controls."""

    __tablename__ = "simulation_state"
    __table_args__ = (
        CheckConstraint("id = 1", name="singleton"),
        CheckConstraint("speed > 0", name="speed"),
        CheckConstraint("repair_effectiveness >= 0 AND repair_effectiveness <= 1", name="effectiveness"),
        CheckConstraint("profile IN ('demo', 'realistic')", name="profile"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("simulation_runs.id"))
    sim_now: Mapped[datetime] = mapped_column(DateTime)
    last_sample_at: Mapped[datetime] = mapped_column(DateTime)
    epoch: Mapped[datetime] = mapped_column(DateTime)
    speed: Mapped[float] = mapped_column(Float, default=60.0)
    running: Mapped[bool] = mapped_column(Boolean, default=False)
    seed: Mapped[int] = mapped_column(Integer, default=42)
    profile: Mapped[str] = mapped_column(String(20), default="demo")
    repair_effectiveness: Mapped[float] = mapped_column(Float, default=1.0)
    samples_generated: Mapped[int] = mapped_column(Integer, default=0)


class FaultInjection(Base):
    """Ground truth for every injected fault (bearing wear and data-quality faults)."""

    __tablename__ = "fault_injections"
    __table_args__ = (
        CheckConstraint(f"fault_type IN {FAULT_TYPES}", name="fault_type"),
        CheckConstraint("status IN ('ACTIVE', 'REPAIRED', 'ENDED')", name="status"),
        Index("ix_fault_asset_status", "asset_id", "status"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("simulation_runs.id"))
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    sensor_id: Mapped[str | None] = mapped_column(ForeignKey("sensors.id"), nullable=True)
    fault_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(10), default="ACTIVE")
    started_at: Mapped[datetime] = mapped_column(DateTime)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    repairs: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(40))


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        CheckConstraint("outcome IN ('ALLOWED', 'DENIED')", name="outcome"),
        Index("ix_audit_outcome", "outcome"),
        Index("ix_audit_correlation", "correlation_id"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    username: Mapped[str] = mapped_column(String(40))
    role: Mapped[str] = mapped_column(String(20))
    action: Mapped[str] = mapped_column(String(60))
    target_type: Mapped[str] = mapped_column(String(40))
    target_id: Mapped[str | None] = mapped_column(String(60), nullable=True)
    outcome: Mapped[str] = mapped_column(String(8))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    before: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    correlation_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
