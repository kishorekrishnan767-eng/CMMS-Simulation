"""Layer 7 — repair verification.

After ``COMPLETED`` the simulated world applies the repair (effectiveness set by the scenario).
Verification evaluates a window of 30 post-repair samples, starting after a 30 min settle period
(6τ of the 5 min exponential settle, ASSUMPTIONS #23), against the detector's FROZEN baseline.
ALL of these must hold:

    mean(residual) within ±2σ of baseline          (σ = baseline robust sigma)
    max(z) < 3.0 over the window
    |slope| < 0.3 mm/s/h                           (not significantly positive)
    no anomaly raised during the window            (no new/escalated anomaly events)
    corroborating metrics (temperature, current) normal: mean z < 3.0
    verifier != technician                         (separation of duties)

Pass → VERIFIED (supervisor then closes → anomaly CLEARED). Fail → REWORK_REQUIRED listing the
failing criteria. The criteria are computed here from stored readings; nothing is hand-set.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.errors import Conflict, Forbidden, Invalid
from app.models import DetectorState, OutboxEvent, TelemetryReading, VerificationRecord, WorkOrder
from app.modules.cmms import workflow
from app.modules.monitoring.detector import ols_slope
from app.security import Actor

WINDOW_SAMPLES = 30
SETTLE_MINUTES = 30
MEAN_SIGMAS = 2.0
MAX_Z = 3.0
MAX_ABS_SLOPE = 0.3
CORROBORATION_MEAN_Z = 3.0
_EPOCH = datetime(2000, 1, 1)


def _hours(t: datetime) -> float:
    return (t - _EPOCH).total_seconds() / 3600.0


def window_bounds(wo: WorkOrder) -> tuple[datetime, datetime] | None:
    if wo.completed_at is None:
        return None
    start = wo.completed_at + timedelta(minutes=SETTLE_MINUTES)
    return start, start + timedelta(minutes=WINDOW_SAMPLES)


def _series(session: Session, asset_id: str, metric: str, start: datetime, end: datetime) -> dict[datetime, float]:
    rows = session.execute(select(TelemetryReading.timestamp, TelemetryReading.value).where(
        TelemetryReading.asset_id == asset_id, TelemetryReading.metric == metric,
        TelemetryReading.timestamp > start, TelemetryReading.timestamp <= end,
        TelemetryReading.fed_to_detector.is_(True)).order_by(TelemetryReading.timestamp)).all()
    return {r.timestamp: r.value for r in rows}


def evaluate(session: Session, wo: WorkOrder) -> dict[str, Any]:
    """Compute the verification criteria from stored readings (also used for the live preview)."""
    bounds = window_bounds(wo)
    now = clock.sim_now(session)
    base = {"samples_required": WINDOW_SAMPLES, "settle_minutes": SETTLE_MINUTES, "simulated": True,
            "note": "Demo criteria on simulated data — not a standard"}
    if bounds is None:
        return {**base, "ready": False, "samples": 0, "criteria": [], "all_passed": False, "reason": "work not completed"}
    start, end = bounds
    vib = _series(session, wo.asset_id, "vibration_velocity", start, min(end, now))
    spd = _series(session, wo.asset_id, "speed_command", start, min(end, now))
    states = {d.metric: d for d in session.scalars(select(DetectorState).where(DetectorState.asset_id == wo.asset_id))}
    prim = states.get("vibration_velocity")
    out = {**base, "window_start": clock.iso(start), "window_end": clock.iso(end), "samples": len(vib),
           "ready": len(vib) >= WINDOW_SAMPLES, "criteria": [], "all_passed": False,
           "ready_at": clock.iso(end)}
    if prim is None or prim.sigma is None or not vib:
        return {**out, "reason": "no baseline or no samples yet"}
    sigma = max(prim.sigma, 1e-6)
    ts_sorted = sorted(vib)
    resid = np.array([vib[t] - (prim.baseline_a + prim.baseline_b * (spd.get(t, 80.0) / 100.0)) for t in ts_sorted])
    z = resid / sigma
    slope = ols_slope([_hours(t) for t in ts_sorted], list(resid))
    mean_r = float(resid.mean())
    crit: list[dict[str, Any]] = [
        {"name": "mean_residual", "label": "Mean residual within ±2σ of baseline", "passed": abs(mean_r) <= MEAN_SIGMAS * sigma,
         "value": round(mean_r, 3), "threshold": round(MEAN_SIGMAS * sigma, 3), "unit": "mm/s"},
        {"name": "max_z", "label": "Max z-score below 3.0", "passed": float(z.max()) < MAX_Z, "value": round(float(z.max()), 2),
         "threshold": MAX_Z, "unit": "σ"},
        {"name": "slope", "label": "No significant trend (|slope| < 0.3 mm/s/h)", "passed": abs(slope) < MAX_ABS_SLOPE,
         "value": round(slope, 3), "threshold": MAX_ABS_SLOPE, "unit": "mm/s/h"},
    ]
    events = session.scalars(select(OutboxEvent).where(
        OutboxEvent.asset_id == wo.asset_id, OutboxEvent.event_type.in_(("AnomalyDetected", "AnomalyEscalated")),
        OutboxEvent.occurred_at > start, OutboxEvent.occurred_at <= end)).all()
    crit.append({"name": "no_anomaly_raised", "label": "No anomaly raised during the window", "passed": len(events) == 0,
                 "value": len(events), "threshold": 0, "unit": "events"})
    for metric, label in (("bearing_temperature", "Bearing temperature normal"), ("motor_current", "Motor current normal")):
        st = states.get(metric)
        series = _series(session, wo.asset_id, metric, start, min(end, now))
        if st is None or st.sigma is None or not series:
            crit.append({"name": metric, "label": label, "passed": False, "value": None, "threshold": CORROBORATION_MEAN_Z, "unit": "σ"})
            continue
        zs = [(series[t] - (st.baseline_a + st.baseline_b * (spd.get(t, 80.0) / 100.0))) / max(st.sigma, 1e-6) for t in sorted(series)]
        mz = float(np.mean(zs))
        crit.append({"name": metric, "label": label + " (mean z < 3.0)", "passed": mz < CORROBORATION_MEAN_Z,
                     "value": round(mz, 2), "threshold": CORROBORATION_MEAN_Z, "unit": "σ"})
    out["criteria"] = crit
    out["all_passed"] = out["ready"] and all(c["passed"] for c in crit)
    out["failed_criteria"] = [c["name"] for c in crit if not c["passed"]]
    out["baseline"] = {"a": prim.baseline_a, "b": prim.baseline_b, "sigma": sigma}
    out["mean_value"] = round(float(np.mean([vib[t] for t in ts_sorted])), 3)
    return out


def verify(session: Session, wo: WorkOrder, actor: Actor, outcome: str, notes: str | None) -> WorkOrder:
    """Verifier decision. Separation of duties and role are enforced by ``workflow.transition``."""
    outcome = (outcome or "auto").lower()
    if outcome not in ("auto", "pass", "fail"):
        raise Invalid("outcome must be auto, pass or fail")
    if wo.status != "COMPLETED":
        raise Conflict(f"Verification applies to COMPLETED work orders, not {wo.status}", code="invalid_transition")
    # Run the role / separation-of-duties gate before doing any expensive evaluation.
    workflow._authorize(wo, "verify_pass", actor)
    ev = evaluate(session, wo)
    if not ev["ready"]:
        raise Conflict(f"Verification window incomplete: {ev['samples']}/{WINDOW_SAMPLES} post-repair samples "
                       f"(ready at {ev.get('ready_at')})", code="verification_window_incomplete", details=ev)
    passed = ev["all_passed"]
    if outcome == "pass" and not passed:
        raise Conflict("Cannot pass a verification whose criteria fail: " + ", ".join(ev["failed_criteria"]),
                       code="verification_criteria_failed", details=ev)
    wants_pass = passed if outcome == "auto" else outcome == "pass"
    now = clock.sim_now(session)
    session.add(VerificationRecord(
        work_order_id=wo.id, verifier_user_id=actor.user_id or 0, repair_number=wo.repair_count,
        outcome="PASS" if wants_pass else "FAIL", criteria={"criteria": ev["criteria"], "baseline": ev.get("baseline")},
        window_start=clock.parse_iso(ev["window_start"]), window_end=clock.parse_iso(ev["window_end"]),
        sample_count=ev["samples"], notes=notes, occurred_at=now))
    if wants_pass:
        workflow.transition(session, wo, "verify_pass", actor, note=notes,
                            data={"criteria_passed": True, "criteria": ev["criteria"]})
    else:
        reason = notes or ("Verification criteria failed: " + ", ".join(ev["failed_criteria"]))
        workflow.transition(session, wo, "verify_fail", actor, note=reason,
                            data={"failed_criteria": ev["failed_criteria"], "criteria": ev["criteria"]})
    return wo


_unused = (Forbidden,)
