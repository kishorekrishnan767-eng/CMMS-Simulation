"""Layers 4–7 HTTP surface: anomalies, decisions, work orders, dispatch, technicians, inventory."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.commands import Ctx, execute
from app.db import get_read_db
from app.errors import Invalid, NotFound
from app.models import (
    AnomalyEvent, AnomalyEvidence, Asset, InventoryItem, RiskAssessment, StockMovement, StockReservation, Technician,
    WorkOrder,
)
from app.modules.cmms import dispatch, inventory, service, workflow
from app.modules.decision.service import risk_dict
from app.modules.events import timeline
from app.modules.monitoring import service as monitoring
from app.security import Actor, current_actor, optional_actor

router = APIRouter(prefix="/api")


class WoCreateIn(BaseModel):
    asset_id: str
    title: str = Field(min_length=3, max_length=200)
    description: str = ""
    failure_mode: str = "MANUAL_REQUEST"
    priority: str = "P3"


class ActionIn(BaseModel):
    note: str | None = None
    technician_id: str | None = None
    reason_code: str | None = None
    findings: str | None = None
    checklist: dict[str, Any] | None = None
    parts_used: list[dict[str, Any]] | None = None
    outcome: str | None = None
    photo_data: str | None = None
    accept: bool = True


class ReceiveIn(BaseModel):
    sku: str
    quantity: int
    note: str | None = None


class AdjustIn(BaseModel):
    sku: str
    delta: int
    note: str = "Cycle count adjustment"


class ClearIn(BaseModel):
    reason: str = Field(min_length=3)


def _page(limit: int, offset: int) -> tuple[int, int]:
    return max(1, min(limit, 500)), max(0, offset)


# --------------------------------------------------------------------------- anomalies & decisions
@router.get("/anomalies")
def list_anomalies(state: str | None = None, asset_id: str | None = None, limit: int = 100, offset: int = 0,
                   db: Session = Depends(get_read_db)) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    stmt = select(AnomalyEvent)
    if state:
        stmt = stmt.where(AnomalyEvent.state == state.upper())
    if asset_id:
        stmt = stmt.where(AnomalyEvent.asset_id == asset_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(AnomalyEvent.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [monitoring.anomaly_dict(a) for a in rows]}


@router.get("/anomalies/{anomaly_id}")
def get_anomaly(anomaly_id: int, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    a = db.get(AnomalyEvent, anomaly_id)
    if a is None:
        raise NotFound(f"Anomaly {anomaly_id} not found")
    ev = db.scalars(select(AnomalyEvidence).where(AnomalyEvidence.anomaly_id == a.id).order_by(AnomalyEvidence.id)).all()
    d = monitoring.anomaly_dict(a, list(ev))
    d["decisions"] = [risk_dict(r) for r in db.scalars(
        select(RiskAssessment).where(RiskAssessment.anomaly_id == a.id).order_by(RiskAssessment.id))]
    wo = db.scalar(select(WorkOrder).where(WorkOrder.anomaly_id == a.id))
    d["work_order"] = {"id": wo.id, "number": wo.number, "status": wo.status} if wo else None
    return d


@router.post("/anomalies/{anomaly_id}/clear")
def clear_anomaly(anomaly_id: int, body: ClearIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        a = c.session.get(AnomalyEvent, anomaly_id)
        if a is None:
            raise NotFound(f"Anomaly {anomaly_id} not found")
        c.correlation_id = a.incident_id
        cleared = monitoring.clear_asset(c.session, a.asset_id, f"Manual clear by {c.actor.display_name}: {body.reason}",
                                         source="supervisor")
        c.after = {"state": "CLEARED"}
        return monitoring.anomaly_dict(cleared)
    return execute(actor, "anomaly.clear", "anomaly.clear", "anomaly", str(anomaly_id), run)


@router.get("/decisions/{decision_id}")
def get_decision(decision_id: int, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    ra = db.get(RiskAssessment, decision_id)
    if ra is None:
        raise NotFound(f"Decision {decision_id} not found")
    return risk_dict(ra)


@router.get("/decisions")
def list_decisions(asset_id: str | None = None, incident_id: str | None = None, limit: int = 50, offset: int = 0,
                   db: Session = Depends(get_read_db)) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    stmt = select(RiskAssessment)
    if asset_id:
        stmt = stmt.where(RiskAssessment.asset_id == asset_id)
    if incident_id:
        stmt = stmt.where(RiskAssessment.incident_id == incident_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(RiskAssessment.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [risk_dict(r) for r in rows]}


@router.get("/incidents/{incident_id}/timeline")
def incident_timeline(incident_id: str, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    return timeline.build(db, incident_id)


@router.get("/incidents")
def list_incidents(db: Session = Depends(get_read_db)) -> list[dict[str, Any]]:
    out = []
    for a in db.scalars(select(AnomalyEvent).order_by(AnomalyEvent.id.desc())):
        wo = db.scalar(select(WorkOrder).where(WorkOrder.anomaly_id == a.id))
        out.append({"incident_id": a.incident_id, "asset_id": a.asset_id, "state": a.state, "severity": a.severity,
                    "detected_at": clock.iso(a.detected_at), "work_order": wo.number if wo else None,
                    "work_order_status": wo.status if wo else None})
    return out


# --------------------------------------------------------------------------- work orders
@router.get("/work-orders")
def list_work_orders(status: str | None = None, asset_id: str | None = None, priority: str | None = None,
                     active: bool | None = None, limit: int = 200, offset: int = 0,
                     db: Session = Depends(get_read_db), actor: Actor | None = Depends(optional_actor)) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    stmt = select(WorkOrder)
    if status:
        stmt = stmt.where(WorkOrder.status == status.upper())
    if asset_id:
        stmt = stmt.where(WorkOrder.asset_id == asset_id)
    if priority:
        stmt = stmt.where(WorkOrder.priority == priority.upper())
    if active is True:
        stmt = stmt.where(WorkOrder.status.notin_(("CLOSED", "REJECTED", "CANCELLED")))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(WorkOrder.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [service.wo_summary(db, w, actor) for w in rows]}


@router.post("/work-orders")
def create_work_order(body: WoCreateIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        asset = c.session.get(Asset, body.asset_id)
        if asset is None:
            raise NotFound(f"Asset {body.asset_id} not found")
        if body.priority not in ("P1", "P2", "P3", "P4"):
            raise Invalid("priority must be P1–P4")
        wo = workflow.create_draft(c.session, asset=asset, failure_mode=body.failure_mode, title=body.title,
                                   description=body.description, priority=body.priority, action="INSPECT",
                                   incident_id=None, anomaly_id=None, risk_assessment_id=None, safety_note=None,
                                   actor=c.actor, evidence={"manual_request": True, "requested_by": c.actor.display_name},
                                   kind="manual_draft")
        c.target_id = wo.number
        return service.wo_detail(c.session, wo, c.actor)
    return execute(actor, "wo.create", "wo.create", "work_order", None, run, audit_allowed=False)


@router.get("/work-orders/{wo_id}")
def get_work_order(wo_id: int, db: Session = Depends(get_read_db),
                   actor: Actor | None = Depends(optional_actor)) -> dict[str, Any]:
    return service.wo_detail(db, workflow.get_wo(db, wo_id), actor)


@router.get("/work-orders/{wo_id}/timeline")
def wo_timeline(wo_id: int, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    wo = workflow.get_wo(db, wo_id)
    if wo.incident_id:
        return timeline.build(db, wo.incident_id)
    d = service.wo_detail(db, wo)
    return {"incident_id": None, "count": len(d["events"]), "simulated": True,
            "items": [{"t": e["occurred_at"], "layer": 6, "type": e["action"], "title": e["action"], "detail": e["note"] or "",
                       "source": "work_order"} for e in d["events"]]}


@router.get("/work-orders/{wo_id}/dispatch-candidates")
def dispatch_candidates(wo_id: int, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    wo = workflow.get_wo(db, wo_id)
    return {"work_order": wo.number, "required_skills": wo.required_skills, "candidates": dispatch.rank_candidates(db, wo),
            "note": "Ranked by a transparent score; a supervisor must confirm the assignment."}


@router.get("/work-orders/{wo_id}/verification")
def verification_preview(wo_id: int, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    """Live Layer 7 window: samples collected so far and the criteria evaluated on them."""
    from app.modules.verification import service as verification
    return verification.evaluate(db, workflow.get_wo(db, wo_id))


@router.post("/work-orders/{wo_id}/acknowledge-escalation")
def acknowledge_escalation(wo_id: int, body: ActionIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        wo = workflow.get_wo(c.session, wo_id)
        c.target_id, c.correlation_id = wo.number, wo.incident_id
        workflow.acknowledge_escalation(c.session, wo, c.actor, body.accept, body.note)
        return service.wo_detail(c.session, wo, c.actor)
    return execute(actor, None, "wo.ack_escalation", "work_order", str(wo_id), run, audit_allowed=False)


@router.post("/work-orders/{wo_id}/{action}")
def work_order_action(wo_id: int, action: str, body: ActionIn | None = None,
                      actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    body = body or ActionIn()
    if action == "verify":
        from app.modules.verification import service as verification

        def verify(c: Ctx) -> dict[str, Any]:
            wo = workflow.get_wo(c.session, wo_id)
            c.target_id, c.correlation_id = wo.number, wo.incident_id
            verification.verify(c.session, wo, c.actor, body.outcome or "auto", body.note)
            return service.wo_detail(c.session, wo, c.actor)
        return execute(actor, None, "wo.verify", "work_order", str(wo_id), verify, audit_allowed=False)

    if action not in workflow.ACTION_PERMISSION or action in ("verify_pass", "verify_fail"):
        raise NotFound(f"Unknown work-order action '{action}'")

    data = {k: v for k, v in body.model_dump().items() if v is not None and k not in ("note", "accept", "outcome")}

    def run(c: Ctx) -> dict[str, Any]:
        wo = workflow.get_wo(c.session, wo_id)
        c.target_id, c.correlation_id = wo.number, wo.incident_id
        workflow.transition(c.session, wo, action, c.actor, note=body.note, data=data)
        return service.wo_detail(c.session, wo, c.actor)
    return execute(actor, None, f"wo.{action}", "work_order", str(wo_id), run, audit_allowed=False)


# --------------------------------------------------------------------------- technicians
@router.get("/technicians")
def list_technicians(db: Session = Depends(get_read_db)) -> list[dict[str, Any]]:
    return [service.technician_dict(db, t) for t in db.scalars(select(Technician).order_by(Technician.id))]


# --------------------------------------------------------------------------- inventory
@router.get("/inventory")
def list_inventory(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    items = [inventory.item_dict(db, i) for i in db.scalars(select(InventoryItem).order_by(InventoryItem.sku))]
    res = db.scalars(select(StockReservation).order_by(StockReservation.id.desc()).limit(100)).all()
    numbers = {w.id: w.number for w in db.scalars(select(WorkOrder))}
    return {"items": items, "low_stock": [i["sku"] for i in items if i["low_stock"]],
            "reservations": [{"id": r.id, "sku": r.sku, "work_order": numbers.get(r.work_order_id), "quantity": r.quantity,
                              "status": r.status, "created_at": clock.iso(r.created_at)} for r in res]}


@router.get("/inventory/movements")
def inventory_movements(sku: str | None = None, limit: int = 100, offset: int = 0,
                        db: Session = Depends(get_read_db)) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    stmt = select(StockMovement)
    if sku:
        stmt = stmt.where(StockMovement.sku == sku)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    numbers = {w.id: w.number for w in db.scalars(select(WorkOrder))}
    rows = db.scalars(stmt.order_by(StockMovement.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [{"id": m.id, "sku": m.sku, "quantity": m.quantity, "movement_type": m.movement_type,
                                       "balance_after": m.balance_after, "work_order": numbers.get(m.work_order_id) if m.work_order_id else None,
                                       "note": m.note, "occurred_at": clock.iso(m.occurred_at)} for m in rows]}


@router.post("/inventory/receive")
def receive_stock(body: ReceiveIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        m = inventory.receive(c.session, body.sku, body.quantity, c.actor.user_id, body.note)
        c.after = {"sku": body.sku, "quantity": body.quantity, "balance_after": m.balance_after}
        resumed: list[str] = []
        if c.actor.role == "SUPERVISOR":
            for wo in c.session.scalars(select(WorkOrder).where(WorkOrder.status == "ON_HOLD",
                                                                 WorkOrder.hold_reason == "AWAITING_PARTS")
                                        .order_by(WorkOrder.priority, WorkOrder.id)):
                try:
                    with c.session.begin_nested():
                        workflow.transition(c.session, wo, "resume", c.actor, note="Stock received — blocker cleared")
                    resumed.append(wo.number)
                except Exception:  # still short for this order; leave it on hold
                    continue
        c.after["resumed"] = resumed
        return {"sku": body.sku, "balance_after": m.balance_after, "resumed_work_orders": resumed}
    return execute(actor, "inventory.receive", "inventory.receive", "inventory", body.sku, run)


@router.post("/inventory/adjust")
def adjust_stock(body: AdjustIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        m = inventory.adjust(c.session, body.sku, body.delta, c.actor.user_id, body.note)
        c.after = {"sku": body.sku, "delta": body.delta, "balance_after": m.balance_after}
        return {"sku": body.sku, "balance_after": m.balance_after}
    return execute(actor, "inventory.adjust", "inventory.adjust", "inventory", body.sku, run)


# --------------------------------------------------------------------------- analytics
@router.get("/analytics/maintenance")
def analytics_maintenance(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    from app.modules.analytics import service as analytics
    return analytics.maintenance_metrics(db)


@router.get("/analytics/detector")
def analytics_detector(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    from app.modules.analytics import service as analytics
    return analytics.detector_metrics(db)


@router.get("/analytics/assets")
def analytics_assets(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    from app.modules.analytics import service as analytics
    return analytics.asset_metrics(db)
