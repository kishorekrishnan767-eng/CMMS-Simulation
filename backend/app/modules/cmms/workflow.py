"""Layer 6 — the work-order state machine.

``transition(session, wo, action, actor, …)`` is the ONLY code allowed to assign ``wo.status``
(enforced by tests/test_module_boundaries.py). Every transition runs inside the caller's single
transaction and writes, atomically: the new status, a ``work_order_events`` row, an ``audit_logs``
row (outcome ALLOWED) and an outbox event. Anything else raises a ``DomainError`` (403/409/422) which
the command executor turns into an ``outcome=DENIED`` audit row.

    (new)             system draft     → DRAFT            system        decision exists
    DRAFT             approve          → OPEN             SUPERVISOR    evidence attached
    DRAFT             reject           → REJECTED         SUPERVISOR    reason required
    DRAFT / OPEN      cancel           → CANCELLED        SUPERVISOR    reason required
    OPEN              assign           → ASSIGNED         SUPERVISOR    technician eligible (+ parts reserved)
    OPEN / ASSIGNED   hold             → ON_HOLD          SUPERVISOR / assigned TECHNICIAN   reason
    ON_HOLD           resume           → previous state   SUPERVISOR    blocker cleared
    ASSIGNED          start            → IN_PROGRESS      assigned TECHNICIAN only   on site
    IN_PROGRESS       complete         → COMPLETED        assigned TECHNICIAN only   inspection + findings + parts used
    COMPLETED         verify_pass      → VERIFIED         VERIFIER (≠ technician)    Layer 7 criteria pass
    COMPLETED         verify_fail      → REWORK_REQUIRED  VERIFIER      reason + evidence
    REWORK_REQUIRED   restart          → IN_PROGRESS      assigned TECHNICIAN
    VERIFIED          close            → CLOSED           SUPERVISOR    closure checklist complete
"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import clock
from app.errors import Conflict, Forbidden, Invalid, NotFound
from app.models import (
    Approval, Asset, InspectionRecord, InventoryItem, Technician, User, WorkOrder, WorkOrderEvent, WorkOrderPart,
)
from app.modules.audit import service as audit
from app.modules.cmms import dispatch, inventory
from app.modules.decision.policy import load_policy
from app.modules.events import bus
from app.security import SYSTEM_ACTOR, Actor, check_permission

TRANSITIONS: dict[tuple[str, str], str | None] = {
    ("DRAFT", "approve"): "OPEN",
    ("DRAFT", "reject"): "REJECTED",
    ("DRAFT", "cancel"): "CANCELLED",
    ("OPEN", "cancel"): "CANCELLED",
    ("OPEN", "assign"): "ASSIGNED",
    ("OPEN", "hold"): "ON_HOLD",
    ("ASSIGNED", "hold"): "ON_HOLD",
    ("ON_HOLD", "resume"): None,  # previous state
    ("ASSIGNED", "start"): "IN_PROGRESS",
    ("IN_PROGRESS", "complete"): "COMPLETED",
    ("COMPLETED", "verify_pass"): "VERIFIED",
    ("COMPLETED", "verify_fail"): "REWORK_REQUIRED",
    ("REWORK_REQUIRED", "restart"): "IN_PROGRESS",
    ("VERIFIED", "close"): "CLOSED",
}
ACTION_PERMISSION = {
    "approve": "wo.approve", "reject": "wo.reject", "cancel": "wo.cancel", "assign": "wo.assign",
    "hold": "wo.hold", "resume": "wo.resume", "start": "wo.start", "complete": "wo.complete",
    "verify_pass": "wo.verify", "verify_fail": "wo.verify", "restart": "wo.restart", "close": "wo.close",
}
TECHNICIAN_ONLY = {"start", "complete", "restart"}
REASON_REQUIRED = {"reject", "cancel", "hold", "verify_fail"}
CLOSURE_CHECKLIST = ("work_verified", "area_safe_and_clean", "documentation_complete", "parts_reconciled")


# --------------------------------------------------------------------------- helpers
def _next_number(session: Session) -> str:
    n = session.scalar(select(func.count()).select_from(WorkOrder)) or 0
    return f"WO-{n + 1:04d}"


def _log(session: Session, wo: WorkOrder, action: str, actor: Actor, from_s: str | None, to_s: str | None,
         note: str | None = None, data: dict[str, Any] | None = None) -> None:
    session.add(WorkOrderEvent(work_order_id=wo.id, action=action, from_status=from_s, to_status=to_s,
                               actor_user_id=actor.user_id, actor_name=actor.display_name, actor_role=actor.role,
                               note=note, data=data or {}, occurred_at=clock.sim_now(session)))


def _publish(session: Session, wo: WorkOrder, event_type: str, payload: dict[str, Any] | None = None) -> None:
    bus.publish(session, event_type, asset_id=wo.asset_id, correlation_id=wo.incident_id, payload={
        "work_order": wo.number, "work_order_id": wo.id, "status": wo.status, "priority": wo.priority,
        "asset_id": wo.asset_id, "technician_id": wo.assigned_technician_id, **(payload or {})})


def get_wo(session: Session, wo_id: int) -> WorkOrder:
    wo = session.get(WorkOrder, wo_id)
    if wo is None:
        raise NotFound(f"Work order {wo_id} not found")
    return wo


def active_wo(session: Session, asset_id: str, failure_mode: str) -> WorkOrder | None:
    return session.scalar(select(WorkOrder).where(
        WorkOrder.asset_id == asset_id, WorkOrder.failure_mode == failure_mode,
        WorkOrder.status.notin_(("CLOSED", "REJECTED", "CANCELLED"))))


def evidence_count(session: Session, wo: WorkOrder) -> int:
    return int(session.scalar(select(func.count()).select_from(WorkOrderEvent).where(
        WorkOrderEvent.work_order_id == wo.id,
        WorkOrderEvent.action.in_(("system_draft", "manual_draft", "EVIDENCE_ATTACHED")))) or 0)


def planned_parts(wo: WorkOrder, session: Session) -> list[dict[str, Any]]:
    return [{"sku": p.sku, "quantity": p.quantity_planned}
            for p in session.scalars(select(WorkOrderPart).where(WorkOrderPart.work_order_id == wo.id))]


def allowed_actions(session: Session, wo: WorkOrder, actor: Actor) -> list[str]:
    """Actions this actor may take right now (UI convenience; the backend enforces them regardless)."""
    out = []
    for (status, action), _ in TRANSITIONS.items():
        if status != wo.status:
            continue
        try:
            _authorize(wo, action, actor)
        except Forbidden:
            continue
        out.append(action)
    return out


def _authorize(wo: WorkOrder, action: str, actor: Actor) -> None:
    if action in ("verify_pass", "verify_fail") and wo.assigned_technician_id and \
            actor.technician_id == wo.assigned_technician_id:
        raise Forbidden("Separation of duties: the technician who performed the repair cannot verify it",
                        code="separation_of_duties",
                        details={"technician_id": wo.assigned_technician_id})
    check_permission(actor, ACTION_PERMISSION[action])
    if action in TECHNICIAN_ONLY or (action == "hold" and actor.role == "TECHNICIAN"):
        if actor.technician_id is None or actor.technician_id != wo.assigned_technician_id:
            raise Forbidden("Only the assigned technician may perform this action", code="not_assigned_technician",
                            details={"assigned_technician_id": wo.assigned_technician_id})


# --------------------------------------------------------------------------- creation (system / manual)
def create_draft(session: Session, *, asset: Asset, failure_mode: str, title: str, description: str, priority: str,
                 action: str, incident_id: str | None, anomaly_id: int | None, risk_assessment_id: int | None,
                 safety_note: str | None, actor: Actor = SYSTEM_ACTOR, evidence: dict[str, Any] | None = None,
                 kind: str = "system_draft") -> WorkOrder:
    """New DRAFT work order. Enforces one active WO per (asset, failure_mode): the application check
    runs in this transaction and the partial unique index is the backstop for races."""
    existing = active_wo(session, asset.id, failure_mode)
    if existing is not None:
        raise Conflict(f"{existing.number} is already active for {asset.id} / {failure_mode}",
                       code="duplicate_active_work_order", details={"work_order": existing.number})
    now = clock.sim_now(session)
    policy = load_policy()
    wo = WorkOrder(number=_next_number(session), asset_id=asset.id, failure_mode=failure_mode, incident_id=incident_id,
                   anomaly_id=anomaly_id, risk_assessment_id=risk_assessment_id, title=title, description=description,
                   status="DRAFT", priority=priority, action=action, required_skills=list(asset.required_skills),
                   safety_note=safety_note, created_at=now, updated_at=now)
    try:
        with session.begin_nested():
            session.add(wo)
            session.flush()
    except IntegrityError as e:  # lost a race against the partial unique index
        raise Conflict(f"An active work order already exists for {asset.id} / {failure_mode}",
                       code="duplicate_active_work_order") from e
    for part in policy["failure_modes"].get(failure_mode, {}).get("parts", []):
        if session.get(InventoryItem, part["sku"]) is not None:
            session.add(WorkOrderPart(work_order_id=wo.id, sku=part["sku"], quantity_planned=part["quantity"]))
    session.flush()
    _log(session, wo, kind, actor, None, "DRAFT", note=title, data=evidence or {})
    audit.record(session, actor, f"wo.{kind}", "work_order", wo.number, "ALLOWED", after={"status": "DRAFT", "priority": priority},
                 correlation_id=incident_id)
    _publish(session, wo, "WorkOrderDrafted", {"action": action, "title": title, "risk_assessment_id": risk_assessment_id,
                                              "anomaly_id": anomaly_id, "safety_note": safety_note})
    return wo


def attach_evidence(session: Session, wo: WorkOrder, data: dict[str, Any], proposed_priority: str | None,
                    actor: Actor = SYSTEM_ACTOR) -> None:
    """A later alert for an already-open incident: attach it, never create a second work order."""
    policy = load_policy()
    _log(session, wo, "EVIDENCE_ATTACHED", actor, wo.status, wo.status, data=data)
    wo.updated_at = clock.sim_now(session)
    _publish(session, wo, "EvidenceAttached", {"evidence": data})
    if proposed_priority and policy["priority_rank"][proposed_priority] < policy["priority_rank"][wo.priority] \
            and wo.proposed_priority != proposed_priority:
        wo.proposed_priority = proposed_priority
        _log(session, wo, "PRIORITY_ESCALATION_PROPOSED", actor, wo.status, wo.status,
             note=f"{wo.priority} → {proposed_priority} proposed; supervisor acknowledgement required",
             data={"from": wo.priority, "to": proposed_priority})
        _publish(session, wo, "PriorityEscalationProposed", {"from": wo.priority, "to": proposed_priority})


def acknowledge_escalation(session: Session, wo: WorkOrder, actor: Actor, accept: bool, note: str | None) -> WorkOrder:
    check_permission(actor, "wo.ack_escalation")
    if wo.proposed_priority is None:
        raise Conflict("No priority escalation is pending on this work order", code="no_pending_escalation")
    old, new = wo.priority, wo.proposed_priority
    if accept:
        wo.priority = new
    wo.proposed_priority = None
    wo.updated_at = clock.sim_now(session)
    session.add(Approval(work_order_id=wo.id, user_id=actor.user_id or 0, role=actor.role, decision="ACKNOWLEDGED",
                         comment=note, occurred_at=wo.updated_at))
    _log(session, wo, "ESCALATION_ACKNOWLEDGED", actor, wo.status, wo.status,
         note=note, data={"accepted": accept, "from": old, "to": new})
    audit.record(session, actor, "wo.ack_escalation", "work_order", wo.number, "ALLOWED",
                 before={"priority": old}, after={"priority": wo.priority}, correlation_id=wo.incident_id)
    _publish(session, wo, "PriorityEscalationAcknowledged", {"accepted": accept, "from": old, "to": new})
    return wo


# --------------------------------------------------------------------------- the state machine
def transition(session: Session, wo: WorkOrder, action: str, actor: Actor, *, note: str | None = None,
               data: dict[str, Any] | None = None) -> WorkOrder:
    data = dict(data or {})
    if action not in ACTION_PERMISSION:
        raise Invalid(f"Unknown action '{action}'")
    _authorize(wo, action, actor)
    key = (wo.status, action)
    if key not in TRANSITIONS:
        raise Conflict(f"Action '{action}' is not allowed while the work order is {wo.status}",
                       code="invalid_transition", details={"status": wo.status, "action": action})
    if action in REASON_REQUIRED and not (note or "").strip():
        raise Invalid(f"A reason is required to {action.replace('_', ' ')} a work order", code="reason_required")

    now = clock.sim_now(session)
    from_status = wo.status
    to_status = TRANSITIONS[key] or wo.previous_status or "OPEN"
    extra: dict[str, Any] = {}
    handler = _HANDLERS.get(action)
    if handler:
        extra = handler(session, wo, actor, note, data, now) or {}

    wo.previous_status = from_status if to_status == "ON_HOLD" else wo.previous_status
    wo.status = to_status
    wo.updated_at = now
    _log(session, wo, action, actor, from_status, to_status, note=note, data=extra)
    audit.record(session, actor, f"wo.{action}", "work_order", wo.number, "ALLOWED", reason=note,
                 before={"status": from_status}, after={"status": to_status, **{k: v for k, v in extra.items()
                                                                               if isinstance(v, (str, int, float, bool))}},
                 correlation_id=wo.incident_id)
    _emit_events(session, wo, action, from_status, to_status, note, extra)
    if action == "assign" and extra.get("shortages"):
        _auto_hold_for_parts(session, wo, extra["shortages"])
    return wo


def _emit_events(session: Session, wo: WorkOrder, action: str, from_s: str, to_s: str, note: str | None,
                 extra: dict[str, Any]) -> None:
    base = {"from_status": from_s, "to_status": to_s, "note": note}
    if action == "approve":
        _publish(session, wo, "WorkOrderApproved", base)
    elif action == "reject":
        _publish(session, wo, "WorkOrderRejected", base)
    elif action == "cancel":
        _publish(session, wo, "WorkOrderCancelled", base)
    elif action == "assign":
        _publish(session, wo, "TechnicianAssigned", {**base, **{k: v for k, v in extra.items() if k != "shortages"}})
        if extra.get("shortages"):
            _publish(session, wo, "PartsShortage", {"shortages": extra["shortages"],
                                                    "reorder": _reorder_suggestions(session, extra["shortages"])})
        else:
            _publish(session, wo, "PartsReserved", {"parts": planned_parts(wo, session)})
    elif action == "hold":
        _publish(session, wo, "WorkOrderOnHold", {**base, "reason_code": wo.hold_reason})
    elif action == "resume":
        _publish(session, wo, "WorkOrderResumed", base)
        if extra.get("parts_reserved"):
            _publish(session, wo, "PartsReserved", {"parts": planned_parts(wo, session)})
    elif action == "start":
        _publish(session, wo, "WorkStarted", {**base, **extra})
    elif action == "complete":
        _publish(session, wo, "WorkCompleted", {**base, **extra})
    elif action == "verify_pass":
        _publish(session, wo, "VerificationPassed", {**base, **extra})
    elif action == "verify_fail":
        _publish(session, wo, "VerificationFailed", {**base, **extra})
        _publish(session, wo, "ReworkRequired", {**base, "failed_criteria": extra.get("failed_criteria", [])})
    elif action == "restart":
        _publish(session, wo, "ReworkStarted", {**base, **extra})
    elif action == "close":
        _publish(session, wo, "WorkOrderClosed", {**base, **extra})


def _reorder_suggestions(session: Session, shortages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for s in shortages:
        item = session.get(InventoryItem, s["sku"])
        if item:
            out.append({"sku": s["sku"], "suggested_quantity": max(item.reorder_quantity, s["short_by"]),
                        "name": item.name})
    return out


def _auto_hold_for_parts(session: Session, wo: WorkOrder, shortages: list[dict[str, Any]]) -> None:
    """Assignment succeeded but parts are short → ON_HOLD (AWAITING_PARTS) within the same transaction."""
    now = clock.sim_now(session)
    prev = wo.status
    wo.previous_status = prev
    wo.status = "ON_HOLD"
    wo.hold_reason = "AWAITING_PARTS"
    wo.updated_at = now
    note = "Awaiting parts: " + ", ".join(f"{s['sku']} (short by {s['short_by']})" for s in shortages)
    _log(session, wo, "hold", SYSTEM_ACTOR, prev, "ON_HOLD", note=note, data={"reason_code": "AWAITING_PARTS", "shortages": shortages})
    audit.record(session, SYSTEM_ACTOR, "wo.hold", "work_order", wo.number, "ALLOWED", reason=note,
                 before={"status": prev}, after={"status": "ON_HOLD", "hold_reason": "AWAITING_PARTS"},
                 correlation_id=wo.incident_id)
    _publish(session, wo, "WorkOrderOnHold", {"reason_code": "AWAITING_PARTS", "note": note, "from_status": prev})


# --------------------------------------------------------------------------- per-action effects
def _h_approve(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    if evidence_count(session, wo) < 1:
        raise Conflict("Evidence must be attached before approval", code="evidence_required")
    wo.approved_at = now
    session.add(Approval(work_order_id=wo.id, user_id=actor.user_id or 0, role=actor.role, decision="APPROVED",
                         comment=note, occurred_at=now))
    return {}


def _h_reject(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    session.add(Approval(work_order_id=wo.id, user_id=actor.user_id or 0, role=actor.role, decision="REJECTED",
                         comment=note, occurred_at=now))
    return {}


def _h_cancel(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    inventory.release_reservations(session, wo)
    _release_technician(session, wo)
    return {}


def _release_technician(session: Session, wo: WorkOrder) -> None:
    if wo.assigned_technician_id:
        tech = session.get(Technician, wo.assigned_technician_id)
        if tech and dispatch.active_jobs(session, tech.id, exclude_wo=wo.id) == 0:
            tech.status = "AVAILABLE"
            tech.current_floor = tech.current_floor


def _h_assign(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    tech_id = data.get("technician_id")
    if not tech_id:
        raise Invalid("technician_id is required", code="technician_required")
    tech = session.get(Technician, tech_id)
    if tech is None:
        raise NotFound(f"Technician {tech_id} not found")
    asset = session.get(Asset, wo.asset_id)
    assert asset is not None
    cand = dispatch.score_technician(session, tech, asset, wo.required_skills, now, wo.id)
    if not cand["eligible"]:
        raise Conflict(f"{tech.name} is not eligible for {wo.number}: " + "; ".join(cand["ineligible_reasons"]),
                       code="technician_ineligible", details={"technician_id": tech.id, "reasons": cand["ineligible_reasons"]})
    wo.assigned_technician_id = tech.id
    wo.assigned_at = now
    travel = cand["travel_minutes"]
    from datetime import timedelta
    wo.arrives_at = now + timedelta(minutes=travel)
    tech.status = "TRAVELING"
    shortages = inventory.reserve_parts(session, wo, planned_parts(wo, session))
    return {"technician_id": tech.id, "technician_name": tech.name, "score": cand["score"],
            "score_breakdown": cand["breakdown"], "arrives_at": clock.iso(wo.arrives_at), "travel_minutes": travel,
            "shortages": shortages}


def _h_hold(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    wo.hold_reason = str(data.get("reason_code") or "OTHER")[:40]
    return {"reason_code": wo.hold_reason}


def _h_resume(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if wo.hold_reason == "AWAITING_PARTS":
        shortages = inventory.reserve_parts(session, wo, planned_parts(wo, session))
        if shortages:
            raise Conflict("Parts are still unavailable: " + ", ".join(f"{s['sku']} (short by {s['short_by']})" for s in shortages),
                           code="blocker_not_cleared", details={"shortages": shortages})
        out["parts_reserved"] = True
    wo.hold_reason = None
    return out


def _h_start(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    if wo.arrives_at is not None and now < wo.arrives_at:
        raise Conflict(f"Technician is still travelling to the asset (arrives {clock.iso(wo.arrives_at)})",
                       code="technician_not_on_site", details={"arrives_at": clock.iso(wo.arrives_at)})
    wo.started_at = wo.started_at or now
    tech = session.get(Technician, wo.assigned_technician_id)
    if tech:
        tech.status = "ON_SITE"
    asset = session.get(Asset, wo.asset_id)
    if asset:
        asset.status = "UNDER_MAINTENANCE"
    return {"started_at": clock.iso(now)}


def _h_complete(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    findings = str(data.get("findings") or "").strip()
    if not findings:
        raise Invalid("Findings are required to complete a work order", code="findings_required")
    if "parts_used" not in data or not isinstance(data["parts_used"], list):
        raise Invalid("Parts used must be recorded (use an empty list if none)", code="parts_used_required")
    if wo.arrives_at is not None and now < wo.arrives_at:
        raise Conflict("Technician is not yet on site", code="technician_not_on_site")
    checklist = data.get("checklist") or {}
    if not isinstance(checklist, dict):
        raise Invalid("checklist must be an object")
    parts_used = [{"sku": str(p["sku"]), "quantity": int(p["quantity"])} for p in data["parts_used"]]
    consumed = inventory.consume_parts(session, wo, parts_used, actor.user_id)
    started = wo.started_at or now
    labour_min = max(0.0, (now - started).total_seconds() / 60.0)
    repair_no = wo.repair_count + 1
    wo.repair_count = repair_no
    wo.completed_at = now
    session.add(InspectionRecord(work_order_id=wo.id, technician_id=wo.assigned_technician_id or "", repair_number=repair_no,
                                 findings=findings, checklist=checklist, parts_used=consumed or parts_used,
                                 labour_minutes=labour_min, recorded_at=now))
    tech = session.get(Technician, wo.assigned_technician_id)
    asset = session.get(Asset, wo.asset_id)
    from datetime import timedelta
    if tech and asset:
        wo.returns_at = now + timedelta(minutes=dispatch.travel_minutes(asset.floor.level, tech.home_floor))
        tech.status = "RETURNING"
        tech.current_floor = asset.floor.level
    if asset:
        asset.status = "OPERATIONAL"
    return {"repair_number": repair_no, "findings": findings, "parts_used": consumed or parts_used,
            "labour_minutes": round(labour_min, 1), "completed_at": clock.iso(now)}


def _h_verify_pass(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    if data.get("criteria_passed") is not True:
        raise Conflict("Verification criteria have not passed", code="verification_criteria_failed")
    wo.verified_at = now
    return {"criteria": data.get("criteria")}


def _h_verify_fail(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    return {"failed_criteria": data.get("failed_criteria", []), "criteria": data.get("criteria")}


def _h_restart(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    shortages = inventory.reserve_parts(session, wo, planned_parts(wo, session))
    if shortages:
        raise Conflict("Rework needs parts that are not in stock: " + ", ".join(s["sku"] for s in shortages) +
                       ". A supervisor must receive stock first.", code="insufficient_stock", details={"shortages": shortages})
    tech = session.get(Technician, wo.assigned_technician_id)
    asset = session.get(Asset, wo.asset_id)
    from datetime import timedelta
    if tech and asset:
        wo.arrives_at = now + timedelta(minutes=dispatch.travel_minutes(tech.current_floor, asset.floor.level))
        tech.status = "TRAVELING"
    if asset:
        asset.status = "UNDER_MAINTENANCE"
    return {"arrives_at": clock.iso(wo.arrives_at), "repair_number": wo.repair_count + 1}


def _h_close(session: Session, wo: WorkOrder, actor: Actor, note: str | None, data: dict[str, Any], now: Any) -> dict[str, Any]:
    checklist = data.get("checklist") or {}
    missing = [k for k in CLOSURE_CHECKLIST if checklist.get(k) is not True]
    if missing:
        raise Conflict("Closure checklist incomplete: " + ", ".join(missing), code="closure_checklist_incomplete",
                       details={"missing": missing, "required": list(CLOSURE_CHECKLIST)})
    wo.closed_at = now
    first_time_fix = wo.repair_count == 1
    tech = session.get(Technician, wo.assigned_technician_id) if wo.assigned_technician_id else None
    if tech:
        tech.jobs_completed += 1
        tech.first_time_fixes += 1 if first_time_fix else 0
        # Bayesian blend: 5 pseudo-jobs at the seeded rate, then real outcomes (learning without auto-tuning thresholds)
        tech.performance = round((tech.seeded_performance * 5 + tech.first_time_fixes) / (5 + tech.jobs_completed), 4)
    asset = session.get(Asset, wo.asset_id)
    if asset:
        asset.last_maintenance = date.fromisoformat(now.date().isoformat())
        asset.status = "OPERATIONAL"
    inventory.release_reservations(session, wo)
    return {"first_time_fix": first_time_fix, "repairs": wo.repair_count, "checklist": checklist}


_HANDLERS = {
    "approve": _h_approve, "reject": _h_reject, "cancel": _h_cancel, "assign": _h_assign, "hold": _h_hold,
    "resume": _h_resume, "start": _h_start, "complete": _h_complete, "verify_pass": _h_verify_pass,
    "verify_fail": _h_verify_fail, "restart": _h_restart, "close": _h_close,
}

_unused = (User,)  # imported for type completeness in downstream modules
