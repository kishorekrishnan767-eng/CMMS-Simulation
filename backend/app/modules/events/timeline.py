"""Incident timeline: the whole journey of one correlation_id, from first deviation to closure."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.models import AnomalyEvent, AuditLog, FaultInjection, OutboxEvent, TelemetryReading

TITLES = {
    "AnomalyWatch": "Detector entered WATCH", "HealthStateChanged": "Health state changed",
    "AnomalyDetected": "Anomaly detected", "AnomalyEscalated": "Anomaly escalated", "AnomalyCorroborated": "Corroborating sensor agrees",
    "AnomalyCleared": "Anomaly cleared", "RiskAssessed": "Risk assessed", "WorkOrderDrafted": "Draft work order created",
    "EvidenceAttached": "Alert attached as evidence (no duplicate work order)", "PriorityEscalationProposed": "Priority escalation proposed",
    "PriorityEscalationAcknowledged": "Priority escalation acknowledged", "WorkOrderApproved": "Work order approved",
    "WorkOrderRejected": "Work order rejected", "WorkOrderCancelled": "Work order cancelled", "TechnicianAssigned": "Technician assigned",
    "PartsReserved": "Parts reserved", "PartsShortage": "Parts shortage", "WorkOrderOnHold": "Work order on hold",
    "WorkOrderResumed": "Work order resumed", "WorkStarted": "Work started", "WorkCompleted": "Work completed",
    "RepairApplied": "Repair applied to the simulated asset", "VerificationPassed": "Verification passed",
    "VerificationFailed": "Verification failed", "ReworkRequired": "Rework required", "ReworkStarted": "Rework started",
    "WorkOrderClosed": "Work order closed", "EvaluationRecorded": "Learning record stored", "FaultInjected": "Fault injected (simulation ground truth)",
}


def build(session: Session, incident_id: str) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    anomaly = session.scalar(select(AnomalyEvent).where(AnomalyEvent.incident_id == incident_id))
    if anomaly is not None:
        fault = session.scalar(select(FaultInjection).where(
            FaultInjection.asset_id == anomaly.asset_id, FaultInjection.fault_type == "BEARING_WEAR",
            FaultInjection.started_at <= anomaly.detected_at).order_by(FaultInjection.id.desc()))
        if fault is not None:
            items.append({"t": clock.iso(fault.started_at), "layer": 2, "type": "FaultInjected",
                          "title": TITLES["FaultInjected"], "detail": "Simulation ground truth: bearing wear began", "source": "simulation", "sort": (fault.started_at, 0)})
            first = session.scalar(select(TelemetryReading).where(
                TelemetryReading.asset_id == anomaly.asset_id, TelemetryReading.metric == anomaly.metric,
                TelemetryReading.timestamp > fault.started_at).order_by(TelemetryReading.timestamp))
            if first is not None:
                items.append({"t": clock.iso(first.timestamp), "layer": 2, "type": "FirstReading",
                              "title": "First reading after fault start", "detail": f"{first.value:.2f} {first.unit} stored (simulated)",
                              "source": "telemetry", "sort": (first.timestamp, 1)})
    for e in session.scalars(select(OutboxEvent).where(OutboxEvent.correlation_id == incident_id).order_by(OutboxEvent.id)):
        detail = e.payload.get("explanation") or e.payload.get("reason") or e.payload.get("note") or ""
        if e.event_type == "TechnicianAssigned":
            detail = f"{e.payload.get('technician_name')} (score {e.payload.get('score')})"
        elif e.event_type == "RiskAssessed":
            detail = f"risk {e.payload.get('risk_score')} → {e.payload.get('action')} ({e.payload.get('priority')})"
        elif e.event_type == "HealthStateChanged":
            detail = f"{e.payload.get('from')} → {e.payload.get('to')}"
        items.append({"t": clock.iso(e.occurred_at), "layer": e.layer, "type": e.event_type,
                      "title": TITLES.get(e.event_type, e.event_type), "detail": detail, "source": "event",
                      "event_id": e.event_id, "work_order": e.payload.get("work_order"), "sort": (e.occurred_at, 10 + e.id)})
    for a in session.scalars(select(AuditLog).where(AuditLog.correlation_id == incident_id, AuditLog.outcome == "DENIED")):
        items.append({"t": clock.iso(a.occurred_at), "layer": 6, "type": "ActionDenied",
                      "title": f"Denied: {a.action} by {a.username} ({a.role})", "detail": a.reason or "", "source": "audit",
                      "sort": (a.occurred_at, 10_000_000 + a.id)})
    items.sort(key=lambda x: x["sort"])
    for i in items:
        i.pop("sort")
    return {"incident_id": incident_id, "count": len(items), "items": items, "simulated": True}
