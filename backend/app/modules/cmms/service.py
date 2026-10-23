"""Work-order queries/serialisation and the simulation tick hook for technician movement."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import write_session
from app.models import (
    Approval, Asset, InspectionRecord, InventoryItem, RiskAssessment, StockMovement, StockReservation, Technician,
    TechnicianShift, VerificationRecord, WorkOrder, WorkOrderEvent, WorkOrderPart,
)
from app.modules.cmms import dispatch, inventory, workflow
from app.modules.decision.service import risk_dict
from app.security import Actor


def wo_summary(session: Session, wo: WorkOrder, actor: Actor | None = None) -> dict[str, Any]:
    asset = session.get(Asset, wo.asset_id)
    tech = session.get(Technician, wo.assigned_technician_id) if wo.assigned_technician_id else None
    d = {
        "id": wo.id, "number": wo.number, "asset_id": wo.asset_id, "asset_name": asset.name if asset else None,
        "floor_level": asset.floor.level if asset else None, "failure_mode": wo.failure_mode,
        "incident_id": wo.incident_id, "title": wo.title, "status": wo.status, "priority": wo.priority,
        "proposed_priority": wo.proposed_priority, "action": wo.action, "hold_reason": wo.hold_reason,
        "assigned_technician": {"id": tech.id, "name": tech.name, "color": tech.color} if tech else None,
        "repair_count": wo.repair_count, "required_skills": wo.required_skills,
        "created_at": clock.iso(wo.created_at), "updated_at": clock.iso(wo.updated_at),
        "approved_at": clock.iso(wo.approved_at), "assigned_at": clock.iso(wo.assigned_at),
        "arrives_at": clock.iso(wo.arrives_at), "started_at": clock.iso(wo.started_at),
        "completed_at": clock.iso(wo.completed_at), "returns_at": clock.iso(wo.returns_at),
        "verified_at": clock.iso(wo.verified_at), "closed_at": clock.iso(wo.closed_at),
        "safety_note": wo.safety_note, "simulated": True,
    }
    if actor is not None:
        d["allowed_actions"] = workflow.allowed_actions(session, wo, actor)
        if wo.proposed_priority and actor.role == "SUPERVISOR":
            d["allowed_actions"].append("acknowledge_escalation")
    return d


def wo_detail(session: Session, wo: WorkOrder, actor: Actor | None = None) -> dict[str, Any]:
    d = wo_summary(session, wo, actor)
    d["description"] = wo.description
    ra = session.get(RiskAssessment, wo.risk_assessment_id) if wo.risk_assessment_id else None
    d["risk_assessment"] = risk_dict(ra) if ra else None
    events = session.scalars(select(WorkOrderEvent).where(WorkOrderEvent.work_order_id == wo.id)
                             .order_by(WorkOrderEvent.id)).all()
    d["events"] = [{"id": e.id, "action": e.action, "from_status": e.from_status, "to_status": e.to_status,
                    "actor": e.actor_name, "actor_role": e.actor_role, "note": e.note, "data": e.data,
                    "occurred_at": clock.iso(e.occurred_at)} for e in events]
    d["evidence"] = [{"id": e.id, "kind": e.action, "occurred_at": clock.iso(e.occurred_at), **(e.data or {})}
                     for e in events if e.action in ("system_draft", "manual_draft", "EVIDENCE_ATTACHED")]
    d["approvals"] = [{"id": a.id, "role": a.role, "decision": a.decision, "comment": a.comment,
                       "occurred_at": clock.iso(a.occurred_at)}
                      for a in session.scalars(select(Approval).where(Approval.work_order_id == wo.id).order_by(Approval.id))]
    parts = session.scalars(select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id)).all()
    d["parts"] = [{"sku": p.sku, "planned": p.quantity_planned,
                   "name": session.get(InventoryItem, p.sku).name,  # type: ignore[union-attr]
                   "reserved": sum(r.quantity for r in session.scalars(select(StockReservation).where(
                       StockReservation.work_order_id == wo.id, StockReservation.sku == p.sku,
                       StockReservation.status == "ACTIVE"))),
                   "consumed": -sum(m.quantity for m in session.scalars(select(StockMovement).where(
                       StockMovement.work_order_id == wo.id, StockMovement.sku == p.sku,
                       StockMovement.movement_type == "CONSUME")))} for p in parts]
    d["inspections"] = [{"id": i.id, "repair_number": i.repair_number, "technician_id": i.technician_id,
                         "findings": i.findings, "checklist": i.checklist, "parts_used": i.parts_used,
                         "labour_minutes": i.labour_minutes, "recorded_at": clock.iso(i.recorded_at)}
                        for i in session.scalars(select(InspectionRecord).where(InspectionRecord.work_order_id == wo.id)
                                                 .order_by(InspectionRecord.id))]
    d["verifications"] = [{"id": v.id, "repair_number": v.repair_number, "outcome": v.outcome, "criteria": v.criteria,
                           "sample_count": v.sample_count, "window_start": clock.iso(v.window_start),
                           "window_end": clock.iso(v.window_end), "notes": v.notes, "occurred_at": clock.iso(v.occurred_at)}
                          for v in session.scalars(select(VerificationRecord).where(VerificationRecord.work_order_id == wo.id)
                                                   .order_by(VerificationRecord.id))]
    d["closure_checklist_required"] = list(workflow.CLOSURE_CHECKLIST)
    return d


def technician_dict(session: Session, t: Technician) -> dict[str, Any]:
    now = clock.sim_now(session)
    jobs = session.scalars(select(WorkOrder).where(WorkOrder.assigned_technician_id == t.id,
                                                   WorkOrder.status.in_(dispatch.ACTIVE_JOB_STATUSES)))
    shifts = session.scalars(select(TechnicianShift).where(TechnicianShift.technician_id == t.id)
                             .order_by(TechnicianShift.weekday)).all()
    return {"id": t.id, "name": t.name, "skills": t.skills, "certification_level": t.certification_level,
            "home_floor": t.home_floor, "current_floor": t.current_floor, "status": t.status, "max_jobs": t.max_jobs,
            "active_jobs": [{"number": j.number, "status": j.status, "asset_id": j.asset_id} for j in jobs],
            "performance": t.performance, "jobs_completed": t.jobs_completed, "first_time_fixes": t.first_time_fixes,
            "hourly_rate": t.hourly_rate, "color": t.color, "on_shift": dispatch.on_shift(session, t.id, now),
            "shifts": [{"weekday": s.weekday, "start": s.start_hour, "end": s.end_hour} for s in shifts]}


def on_tick(now: datetime) -> None:
    """Simulation tick hook: technicians arrive at the asset / return to their home floor in sim time."""
    with write_session() as s:
        for t in s.scalars(select(Technician).where(Technician.status.in_(("TRAVELING", "RETURNING")))):
            wo = s.scalar(select(WorkOrder).where(WorkOrder.assigned_technician_id == t.id).order_by(WorkOrder.id.desc()))
            if wo is None:
                t.status = "AVAILABLE"
                continue
            asset = s.get(Asset, wo.asset_id)
            if t.status == "TRAVELING" and wo.arrives_at and now >= wo.arrives_at and asset:
                t.status = "ON_SITE"
                t.current_floor = asset.floor.level
            elif t.status == "RETURNING" and wo.returns_at and now >= wo.returns_at:
                t.status = "AVAILABLE"
                t.current_floor = t.home_floor
