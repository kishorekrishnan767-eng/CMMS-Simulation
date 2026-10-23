"""Layers 2–5 — raw telemetry, rejected telemetry, detector state, anomalies, risk assessments."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

READING_STATUSES = ("ACCEPTED", "LATE", "SUSPECT")
READING_QUALITIES = ("GOOD", "SUSPECT_FLATLINE", "LATE")
DETECTOR_STATES = ("NORMAL", "WATCH", "ANOMALY", "CLEARED")
SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")


class TelemetryReading(Base):
    """Raw original readings (never modified by analysis). Derived analysis lives elsewhere."""

    __tablename__ = "telemetry_readings"
    __table_args__ = (
        Index("ix_telemetry_sensor_ts", "sensor_id", "timestamp"),
        Index("ix_telemetry_asset_ts", "asset_id", "timestamp"),
        CheckConstraint(f"status IN {READING_STATUSES}", name="status"),
        CheckConstraint(f"quality IN {READING_QUALITIES}", name="quality"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(80), unique=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    sensor_id: Mapped[str] = mapped_column(ForeignKey("sensors.id"))
    metric: Mapped[str] = mapped_column(String(40))
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(12))
    timestamp: Mapped[datetime] = mapped_column(DateTime)
    received_at: Mapped[datetime] = mapped_column(DateTime)
    source: Mapped[str] = mapped_column(String(30), default="simulation")
    quality: Mapped[str] = mapped_column(String(20), default="GOOD")
    status: Mapped[str] = mapped_column(String(12), default="ACCEPTED")
    fed_to_detector: Mapped[bool] = mapped_column(Boolean, default=True)


class RejectedTelemetry(Base):
    __tablename__ = "rejected_telemetry"
    __table_args__ = (Index("ix_rejected_received", "received_at"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    asset_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    sensor_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    reason: Mapped[str] = mapped_column(String(30))
    detail: Mapped[str] = mapped_column(Text, default="")
    raw: Mapped[dict[str, Any]] = mapped_column(JSON)
    received_at: Mapped[datetime] = mapped_column(DateTime)


class DetectorState(Base):
    """Persistent per-(asset, metric) detector memory. Window/recent are derived data (JSON)."""

    __tablename__ = "detector_state"
    __table_args__ = (
        UniqueConstraint("asset_id", "metric"),
        CheckConstraint(f"state IN {DETECTOR_STATES}", name="state"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    metric: Mapped[str] = mapped_column(String(40))
    role: Mapped[str] = mapped_column(String(16))  # PRIMARY | CORROBORATING
    state: Mapped[str] = mapped_column(String(10), default="NORMAL")
    baseline_a: Mapped[float | None] = mapped_column(Float, nullable=True)
    baseline_b: Mapped[float | None] = mapped_column(Float, nullable=True)
    sigma: Mapped[float | None] = mapped_column(Float, nullable=True)
    memory: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    last_z: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_slope: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_timestamp: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    current_anomaly_id: Mapped[int | None] = mapped_column(ForeignKey("anomaly_events.id"), nullable=True)
    detector_version: Mapped[str] = mapped_column(String(20))


class AnomalyEvent(Base):
    __tablename__ = "anomaly_events"
    __table_args__ = (
        CheckConstraint(f"severity IN {SEVERITIES}", name="severity"),
        CheckConstraint("state IN ('ACTIVE', 'CLEARED')", name="state"),
        CheckConstraint("confidence >= 0 AND confidence <= 1", name="confidence"),
        Index("ix_anomaly_asset_state", "asset_id", "state"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    incident_id: Mapped[str] = mapped_column(String(20), unique=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    metric: Mapped[str] = mapped_column(String(40))
    state: Mapped[str] = mapped_column(String(10), default="ACTIVE")
    severity: Mapped[str] = mapped_column(String(10))
    confidence: Mapped[float] = mapped_column(Float)
    observed_value: Mapped[float] = mapped_column(Float)
    baseline_mean: Mapped[float] = mapped_column(Float)
    baseline_sigma: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    slope: Mapped[float] = mapped_column(Float)
    persistence: Mapped[int] = mapped_column(Integer)
    consecutive_anomalous: Mapped[int] = mapped_column(Integer)
    corroborating: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    window_start: Mapped[datetime] = mapped_column(DateTime)
    window_end: Mapped[datetime] = mapped_column(DateTime)
    projection_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    explanation: Mapped[str] = mapped_column(Text)
    detector_version: Mapped[str] = mapped_column(String(20))
    detected_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cleared_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class AnomalyEvidence(Base):
    __tablename__ = "anomaly_evidence"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    anomaly_id: Mapped[int] = mapped_column(ForeignKey("anomaly_events.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # DETECTION | ESCALATION | CLEARED
    severity: Mapped[str] = mapped_column(String(10))
    observed_value: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    slope: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    reading_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class PolicyVersion(Base):
    __tablename__ = "policy_versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[str] = mapped_column(String(20), unique=True)
    file_name: Mapped[str] = mapped_column(String(80))
    sha256: Mapped[str] = mapped_column(String(64))
    content: Mapped[dict[str, Any]] = mapped_column(JSON)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    loaded_at: Mapped[datetime] = mapped_column(DateTime)


class RiskAssessment(Base):
    __tablename__ = "risk_assessments"
    __table_args__ = (
        CheckConstraint("risk_score >= 0 AND risk_score <= 100", name="risk_range"),
        CheckConstraint("action IN ('MONITOR', 'INSPECT', 'INSPECT_URGENT', 'URGENT_HUMAN_REVIEW')", name="action"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    anomaly_id: Mapped[int] = mapped_column(ForeignKey("anomaly_events.id"), index=True)
    incident_id: Mapped[str] = mapped_column(String(20), index=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    trigger_event: Mapped[str] = mapped_column(String(40))
    trigger_event_id: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(10))
    term_s: Mapped[float] = mapped_column(Float)
    term_c: Mapped[float] = mapped_column(Float)
    term_p: Mapped[float] = mapped_column(Float)
    term_r: Mapped[float] = mapped_column(Float)
    term_q: Mapped[float] = mapped_column(Float)
    risk_score: Mapped[float] = mapped_column(Float)
    action: Mapped[str] = mapped_column(String(24))
    priority: Mapped[str | None] = mapped_column(String(4), nullable=True)
    required_approval: Mapped[str] = mapped_column(String(80))
    reason: Mapped[str] = mapped_column(Text)
    safety_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    policy_version: Mapped[str] = mapped_column(String(20))
    breakdown: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime)
