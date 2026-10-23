"""Layer 7 learning/evaluation and analytics — everything computed from stored data.

Ground truth comes from ``fault_injections``. For each injected bearing-wear fault we store (on
closure) detection latency, lead time before the alarm limit was crossed, MTTA, MTTR, maintenance
cost and a before/after measurement comparison in ``evaluations``. Live aggregates (precision,
TP/FP/FN, throughput) are derived at query time. Nothing here changes thresholds — threshold changes
happen only via a new versioned policy file plus an audit entry.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from statistics import mean
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.models import (
    AnomalyEvent, Asset, Evaluation, FaultInjection, InspectionRecord, InventoryItem, StockMovement, Technician,
    TelemetryReading, VerificationRecord, WorkOrder,
)
from app.modules.events import bus

FN_AFTER_HOURS = 4.0   # an undetected fault older than this (sim hours) counts as a false negative


def _avg(xs: list[float]) -> float | None:
    return round(mean(xs), 2) if xs else None


def _mins(a: datetime | None, b: datetime | None) -> float | None:
    return clock.minutes_between(a, b)


def record_evaluation(session: Session, envelope: dict[str, Any]) -> None:
    """Consumer of ``WorkOrderClosed``: store the learning record for the incident's fault."""
    wo = session.get(WorkOrder, envelope["payload"]["work_order_id"])
    if wo is None or wo.anomaly_id is None:
        return
    anomaly = session.get(AnomalyEvent, wo.anomaly_id)
    asset = session.get(Asset, wo.asset_id)
    assert anomaly is not None and asset is not None
    fault = session.scalar(select(FaultInjection).where(
        FaultInjection.asset_id == wo.asset_id, FaultInjection.fault_type == "BEARING_WEAR",
        FaultInjection.started_at <= anomaly.detected_at).order_by(FaultInjection.id.desc()))
    if fault is None or session.scalar(select(Evaluation.id).where(Evaluation.fault_injection_id == fault.id)):
        return
    crossing = session.scalar(select(func.min(TelemetryReading.timestamp)).where(
        TelemetryReading.asset_id == wo.asset_id, TelemetryReading.metric == "vibration_velocity",
        TelemetryReading.value >= asset.alarm_limit, TelemetryReading.timestamp > fault.started_at))
    lead_basis = "observed" if crossing is not None else None
    if crossing is None:
        crossing = _counterfactual_crossing(session, fault, asset)
        lead_basis = "counterfactual" if crossing is not None else "never_crossed"
    labour = 0.0
    for rec in session.scalars(select(InspectionRecord).where(InspectionRecord.work_order_id == wo.id)):
        tech = session.get(Technician, rec.technician_id)
        labour += rec.labour_minutes / 60.0 * (tech.hourly_rate if tech else 0.0)
    parts = 0.0
    for m in session.scalars(select(StockMovement).where(StockMovement.work_order_id == wo.id, StockMovement.movement_type == "CONSUME")):
        parts += -m.quantity * session.get(InventoryItem, m.sku).unit_cost  # type: ignore[union-attr]
    before = session.scalars(select(TelemetryReading.value).where(
        TelemetryReading.asset_id == wo.asset_id, TelemetryReading.metric == "vibration_velocity",
        TelemetryReading.timestamp > anomaly.detected_at, TelemetryReading.timestamp <= (wo.completed_at or anomaly.detected_at))).all()
    ver = session.scalars(select(VerificationRecord).where(VerificationRecord.work_order_id == wo.id,
                                                           VerificationRecord.outcome == "PASS").order_by(VerificationRecord.id.desc())).first()
    after = []
    if ver and ver.window_start and ver.window_end:
        after = session.scalars(select(TelemetryReading.value).where(
            TelemetryReading.asset_id == wo.asset_id, TelemetryReading.metric == "vibration_velocity",
            TelemetryReading.timestamp > ver.window_start, TelemetryReading.timestamp <= ver.window_end)).all()
    now = clock.sim_now(session)
    ev = Evaluation(
        fault_injection_id=fault.id, asset_id=wo.asset_id, incident_id=wo.incident_id, work_order_id=wo.id, outcome="TP",
        fault_start=fault.started_at, detected_at=anomaly.detected_at,
        detection_latency_min=_mins(fault.started_at, anomaly.detected_at), alarm_crossed_at=crossing,
        lead_time_min=_mins(anomaly.detected_at, crossing) if crossing else None,
        mtta_min=_mins(anomaly.detected_at, wo.approved_at), mttr_min=_mins(anomaly.detected_at, wo.verified_at),
        labour_cost=round(labour, 2), parts_cost=round(parts, 2),
        before_mean=round(float(mean(before)), 3) if before else None, after_mean=round(float(mean(after)), 3) if after else None,
        details={"repairs": wo.repair_count, "first_time_fix": wo.repair_count == 1,
                 "alarm_limit": asset.alarm_limit, "mtta_assigned_min": _mins(anomaly.detected_at, wo.assigned_at),
                 "lead_time_basis": lead_basis,
                 "lead_time_note": {"observed": "time between detection and the alarm limit actually being crossed",
                                    "counterfactual": "the work was done before the limit was reached; lead time uses when the injected fault "
                                                      "(ground truth) would have crossed the alarm limit if left unrepaired",
                                    "never_crossed": "the injected fault would never have reached the alarm limit"}[lead_basis],
                 "detection_to_repair_min": _mins(anomaly.detected_at, wo.completed_at)},
        computed_at=now)
    session.add(ev)
    session.flush()
    bus.publish(session, "EvaluationRecorded", asset_id=wo.asset_id, correlation_id=wo.incident_id,
                payload={"evaluation_id": ev.id, **eval_dict(ev)})


def _counterfactual_crossing(session: Session, fault: FaultInjection, asset: Asset) -> datetime | None:
    """When would the injected wear have pushed vibration to the alarm limit, had nobody intervened?

    Solves  v_healthy + A·((t − t0)/T)^p = alarm_limit  using the stored fault parameters (ground truth)
    and the mean healthy vibration observed in the hour before the fault started.
    """
    p = fault.params
    A, power, T = float(p.get("amplitude", 7.0)), float(p.get("exponent", 2.0)), float(p.get("duration_h", 1.5))
    base = session.scalars(select(TelemetryReading.value).where(
        TelemetryReading.asset_id == fault.asset_id, TelemetryReading.metric == "vibration_velocity",
        TelemetryReading.timestamp <= fault.started_at,
        TelemetryReading.timestamp > fault.started_at - timedelta(hours=1))).all()
    if not base:
        return None
    needed = asset.alarm_limit - float(mean(base))
    if needed <= 0 or needed > A * 1.15:
        return None
    hours = T * (needed / A) ** (1.0 / power)
    return fault.started_at + timedelta(hours=hours)


def eval_dict(e: Evaluation) -> dict[str, Any]:
    return {"id": e.id, "asset_id": e.asset_id, "incident_id": e.incident_id, "outcome": e.outcome,
            "fault_start": clock.iso(e.fault_start), "detected_at": clock.iso(e.detected_at),
            "detection_latency_min": e.detection_latency_min, "alarm_crossed_at": clock.iso(e.alarm_crossed_at),
            "lead_time_min": e.lead_time_min, "mtta_min": e.mtta_min, "mttr_min": e.mttr_min,
            "labour_cost": e.labour_cost, "parts_cost": e.parts_cost, "total_cost": round(e.labour_cost + e.parts_cost, 2),
            "before_mean": e.before_mean, "after_mean": e.after_mean, "details": e.details}


def detector_metrics(session: Session) -> dict[str, Any]:
    now = clock.sim_now(session)
    faults = session.scalars(select(FaultInjection).where(FaultInjection.fault_type == "BEARING_WEAR")).all()
    anomalies = session.scalars(select(AnomalyEvent).order_by(AnomalyEvent.id)).all()
    tp = fp = fn = pending = 0
    rows = []
    matched: set[int] = set()
    for f in faults:
        a = next((x for x in anomalies if x.asset_id == f.asset_id and x.detected_at >= f.started_at), None)
        if a is not None:
            tp += 1
            matched.add(a.id)
        elif (now - f.started_at).total_seconds() / 3600.0 > FN_AFTER_HOURS or f.status != "ACTIVE":
            fn += 1
        else:
            pending += 1
    for a in anomalies:
        if a.id not in matched and not any(f.asset_id == a.asset_id and f.started_at <= a.detected_at for f in faults):
            fp += 1
    evals = session.scalars(select(Evaluation).order_by(Evaluation.id)).all()
    for e in evals:
        rows.append(eval_dict(e))
    detections = []
    for f in faults:
        a = next((x for x in anomalies if x.asset_id == f.asset_id and x.detected_at >= f.started_at), None)
        if a:
            detections.append(_mins(f.started_at, a.detected_at))
    leads = [e.lead_time_min for e in evals if e.lead_time_min is not None]
    healthy_minutes = session.scalar(select(func.count()).select_from(TelemetryReading).where(
        TelemetryReading.metric == "vibration_velocity")) or 0
    return {
        "true_positives": tp, "false_positives": fp, "false_negatives": fn, "pending_faults": pending,
        "precision": round(tp / (tp + fp), 3) if (tp + fp) else None,
        "recall": round(tp / (tp + fn), 3) if (tp + fn) else None,
        "avg_detection_latency_min": _avg([d for d in detections if d is not None]),
        "avg_lead_time_min": _avg(leads), "evaluations": rows, "fault_count": len(faults),
        "anomaly_count": len(anomalies), "vibration_samples_evaluated": healthy_minutes,
        "note": "Ground truth = fault_injections; demo detector on simulated data, not a claim of real-world accuracy.",
        "simulated": True,
    }


def maintenance_metrics(session: Session) -> dict[str, Any]:
    wos = session.scalars(select(WorkOrder)).all()
    by_status = Counter(w.status for w in wos)
    by_priority = Counter(w.priority for w in wos)
    evals = session.scalars(select(Evaluation)).all()
    mtta = [e.mtta_min for e in evals if e.mtta_min is not None]
    mttr = [e.mttr_min for e in evals if e.mttr_min is not None]
    # in-flight approximations use stored timestamps only
    open_mtta = [m for w in wos if w.approved_at and w.anomaly_id and (m := _mins(
        session.get(AnomalyEvent, w.anomaly_id).detected_at, w.approved_at)) is not None]  # type: ignore[union-attr]
    labour = sum(e.labour_cost for e in evals)
    parts = sum(e.parts_cost for e in evals)
    return {
        "work_orders_total": len(wos), "by_status": dict(by_status), "by_priority": dict(by_priority),
        "closed": by_status.get("CLOSED", 0), "open": sum(v for k, v in by_status.items() if k not in ("CLOSED", "REJECTED", "CANCELLED")),
        "mtta_min": _avg(mtta) if mtta else _avg(open_mtta), "mttr_min": _avg(mttr),
        "mtta_samples": len(mtta) or len(open_mtta), "mttr_samples": len(mttr),
        "labour_cost": round(labour, 2), "parts_cost": round(parts, 2), "total_cost": round(labour + parts, 2),
        "first_time_fix_rate": round(sum(1 for e in evals if e.details.get("first_time_fix")) / len(evals), 3) if evals else None,
        "throughput": [{"status": k, "count": v} for k, v in sorted(by_status.items())],
        "technicians": [{"id": t.id, "name": t.name, "performance": t.performance, "jobs_completed": t.jobs_completed}
                        for t in session.scalars(select(Technician).order_by(Technician.id))],
        "simulated": True,
    }


def asset_metrics(session: Session) -> dict[str, Any]:
    out = []
    for a in session.scalars(select(Asset).order_by(Asset.id)):
        n_anom = session.scalar(select(func.count()).select_from(AnomalyEvent).where(AnomalyEvent.asset_id == a.id)) or 0
        n_wo = session.scalar(select(func.count()).select_from(WorkOrder).where(WorkOrder.asset_id == a.id)) or 0
        cost = sum(e.labour_cost + e.parts_cost for e in session.scalars(select(Evaluation).where(Evaluation.asset_id == a.id)))
        out.append({"asset_id": a.id, "name": a.name, "criticality": a.criticality, "health_state": a.health_state,
                    "alerts": n_anom, "work_orders": n_wo, "cost": round(cost, 2)})
    return {"assets": out, "simulated": True}
