"""Layers 6–7 — work orders, approvals, inspection/verification, people, inventory."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

WO_STATUSES = (
    "DRAFT", "OPEN", "ASSIGNED", "ON_HOLD", "IN_PROGRESS", "COMPLETED",
    "VERIFIED", "REWORK_REQUIRED", "CLOSED", "REJECTED", "CANCELLED",
)
TERMINAL_STATUSES = ("CLOSED", "REJECTED", "CANCELLED")
PRIORITIES = ("P1", "P2", "P3", "P4")
ROLES = ("ADMIN", "OPERATOR", "SUPERVISOR", "TECHNICIAN", "VERIFIER")

# Partial unique index predicate shared by SQLite and PostgreSQL: one ACTIVE work order per
# (asset_id, failure_mode). Terminal states are excluded so history can hold many.
_ACTIVE_WO_PREDICATE = text("status NOT IN ('CLOSED', 'REJECTED', 'CANCELLED')")


class Role(Base):
    __tablename__ = "roles"
    name: Mapped[str] = mapped_column(String(20), primary_key=True)
    description: Mapped[str] = mapped_column(Text)


class Technician(Base):
    __tablename__ = "technicians"
    __table_args__ = (
        CheckConstraint("performance >= 0 AND performance <= 1", name="performance"),
        CheckConstraint("max_jobs > 0", name="max_jobs"),
        CheckConstraint("certification_level BETWEEN 1 AND 3", name="cert"),
    )
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    skills: Mapped[list[str]] = mapped_column(JSON)
    certification_level: Mapped[int] = mapped_column(Integer)
    home_floor: Mapped[int] = mapped_column(Integer)
    current_floor: Mapped[int] = mapped_column(Integer)
    max_jobs: Mapped[int] = mapped_column(Integer, default=2)
    performance: Mapped[float] = mapped_column(Float)  # first-time-fix rate
    seeded_performance: Mapped[float] = mapped_column(Float)
    jobs_completed: Mapped[int] = mapped_column(Integer, default=0)
    first_time_fixes: Mapped[int] = mapped_column(Integer, default=0)
    hourly_rate: Mapped[float] = mapped_column(Float)
    color: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(12), default="AVAILABLE")  # AVAILABLE|TRAVELING|ON_SITE|RETURNING


class TechnicianShift(Base):
    __tablename__ = "technician_shifts"
    __table_args__ = (
        CheckConstraint("weekday BETWEEN 0 AND 6", name="weekday"),
        CheckConstraint("start_hour >= 0 AND end_hour <= 24 AND start_hour < end_hour", name="hours"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    technician_id: Mapped[str] = mapped_column(ForeignKey("technicians.id"), index=True)
    weekday: Mapped[int] = mapped_column(Integer)  # 0 = Monday
    start_hour: Mapped[float] = mapped_column(Float)
    end_hour: Mapped[float] = mapped_column(Float)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(40), unique=True)
    display_name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(ForeignKey("roles.name"))
    password_hash: Mapped[str] = mapped_column(String(200))
    technician_id: Mapped[str | None] = mapped_column(ForeignKey("technicians.id"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class WorkOrder(Base):
    __tablename__ = "work_orders"
    __table_args__ = (
        CheckConstraint(f"status IN {WO_STATUSES}", name="status"),
        CheckConstraint(f"priority IN {PRIORITIES}", name="priority"),
        Index(
            "uq_work_orders_active_asset_failure_mode",
            "asset_id", "failure_mode",
            unique=True,
            sqlite_where=_ACTIVE_WO_PREDICATE,
            postgresql_where=_ACTIVE_WO_PREDICATE,
        ),
        Index("ix_work_orders_status", "status"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    number: Mapped[str] = mapped_column(String(20), unique=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    failure_mode: Mapped[str] = mapped_column(String(40))
    incident_id: Mapped[str | None] = mapped_column(String(20), index=True, nullable=True)
    anomaly_id: Mapped[int | None] = mapped_column(ForeignKey("anomaly_events.id"), nullable=True)
    risk_assessment_id: Mapped[int | None] = mapped_column(ForeignKey("risk_assessments.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20))
    previous_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    priority: Mapped[str] = mapped_column(String(4))
    proposed_priority: Mapped[str | None] = mapped_column(String(4), nullable=True)
    action: Mapped[str] = mapped_column(String(24))
    required_skills: Mapped[list[str]] = mapped_column(JSON)
    safety_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    hold_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    assigned_technician_id: Mapped[str | None] = mapped_column(ForeignKey("technicians.id"), nullable=True)
    repair_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    arrives_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    returns_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class WorkOrderEvent(Base):
    __tablename__ = "work_order_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    action: Mapped[str] = mapped_column(String(40))
    from_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    to_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(80))
    actor_role: Mapped[str] = mapped_column(String(20))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)


class WorkOrderPart(Base):
    __tablename__ = "work_order_parts"
    __table_args__ = (
        UniqueConstraint("work_order_id", "sku"),
        CheckConstraint("quantity_planned >= 0 AND quantity_used >= 0", name="qty"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    sku: Mapped[str] = mapped_column(ForeignKey("inventory_items.sku"))
    quantity_planned: Mapped[int] = mapped_column(Integer)
    quantity_used: Mapped[int] = mapped_column(Integer, default=0)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (CheckConstraint("decision IN ('APPROVED', 'REJECTED', 'ACKNOWLEDGED')", name="decision"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(20))
    decision: Mapped[str] = mapped_column(String(20))
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)


class InspectionRecord(Base):
    __tablename__ = "inspection_records"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    technician_id: Mapped[str] = mapped_column(ForeignKey("technicians.id"))
    repair_number: Mapped[int] = mapped_column(Integer)
    findings: Mapped[str] = mapped_column(Text)
    photo_data: Mapped[str] = mapped_column(Text)
    checklist: Mapped[dict[str, Any]] = mapped_column(JSON)
    parts_used: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    labour_minutes: Mapped[float] = mapped_column(Float)
    recorded_at: Mapped[datetime] = mapped_column(DateTime)


class VerificationRecord(Base):
    __tablename__ = "verification_records"
    __table_args__ = (CheckConstraint("outcome IN ('PASS', 'FAIL')", name="outcome"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    verifier_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    repair_number: Mapped[int] = mapped_column(Integer)
    outcome: Mapped[str] = mapped_column(String(4))
    criteria: Mapped[dict[str, Any]] = mapped_column(JSON)
    window_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    window_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)


class InventoryItem(Base):
    __tablename__ = "inventory_items"
    __table_args__ = (CheckConstraint("unit_cost >= 0 AND reorder_level >= 0", name="values"),)
    sku: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    unit: Mapped[str] = mapped_column(String(12))
    unit_cost: Mapped[float] = mapped_column(Float)
    reorder_level: Mapped[int] = mapped_column(Integer)
    reorder_quantity: Mapped[int] = mapped_column(Integer, default=4)
    location: Mapped[str] = mapped_column(String(60))
    # Bumped on every movement/reservation so PostgreSQL row locks have something to lock and
    # optimistic readers can detect concurrent change.
    version: Mapped[int] = mapped_column(Integer, default=0)


class StockMovement(Base):
    """The ledger. quantity_on_hand(sku) = Σ quantity over all movements of that sku."""

    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint("movement_type IN ('INITIAL', 'RECEIVE', 'CONSUME', 'ADJUST')", name="type"),
        CheckConstraint("quantity <> 0", name="nonzero"),
        Index("ix_stock_movements_sku", "sku"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sku: Mapped[str] = mapped_column(ForeignKey("inventory_items.sku"))
    quantity: Mapped[int] = mapped_column(Integer)
    movement_type: Mapped[str] = mapped_column(String(10))
    work_order_id: Mapped[int | None] = mapped_column(ForeignKey("work_orders.id"), nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    balance_after: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)


class StockReservation(Base):
    __tablename__ = "stock_reservations"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="qty"),
        CheckConstraint("status IN ('ACTIVE', 'CONSUMED', 'RELEASED')", name="status"),
        Index("ix_stock_reservations_sku_status", "sku", "status"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sku: Mapped[str] = mapped_column(ForeignKey("inventory_items.sku"))
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id"), index=True)
    quantity: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(10), default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class Evaluation(Base):
    """Layer 7 learning record per injected fault (ground truth from fault_injections)."""

    __tablename__ = "evaluations"
    __table_args__ = (UniqueConstraint("fault_injection_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fault_injection_id: Mapped[int] = mapped_column(ForeignKey("fault_injections.id"))
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    incident_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    work_order_id: Mapped[int | None] = mapped_column(ForeignKey("work_orders.id"), nullable=True)
    outcome: Mapped[str] = mapped_column(String(4))  # TP | FN
    fault_start: Mapped[datetime] = mapped_column(DateTime)
    detected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    detection_latency_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    alarm_crossed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    lead_time_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    mtta_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    mttr_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    labour_cost: Mapped[float] = mapped_column(Float, default=0.0)
    parts_cost: Mapped[float] = mapped_column(Float, default=0.0)
    before_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    after_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    computed_at: Mapped[datetime] = mapped_column(DateTime)
