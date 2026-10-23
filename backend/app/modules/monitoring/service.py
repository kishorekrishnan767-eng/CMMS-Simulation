"""Layer 4 persistence wrapper: feeds accepted telemetry to the pure detector, stores state,
anomalies and evidence, and publishes ``HealthStateChanged`` / ``AnomalyDetected`` /
``AnomalyEscalated`` / ``AnomalyCorroborated`` / ``AnomalyCleared``.

Consumes ``TelemetryAccepted`` (one event per ingested batch). It reads only the event payload, so
it processes exactly what Layer 3 accepted — late, suspect and rejected readings never arrive here.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.errors import Conflict, NotFound
from app.models import AnomalyEvent, AnomalyEvidence, Asset, DetectorState
from app.modules.events import bus
from app.modules.monitoring import explain
from app.modules.monitoring.detector import (
    DETECTOR_VERSION, PERSIST_N, ResidualTracker, StepResult, VibrationDetector,
)

PRIMARY_METRIC = "vibration_velocity"
CORROBORATING = ("bearing_temperature", "motor_current")
FAILURE_MODE = "VIBRATION_RISE"
EVIDENCE_KEEP = PERSIST_N
_EPOCH = datetime(2000, 1, 1)


def _hours(ts: datetime) -> float:
    return (ts - _EPOCH).total_seconds() / 3600.0


def _get_states(session: Session, asset: Asset) -> dict[str, DetectorState]:
    rows = {r.metric: r for r in session.scalars(select(DetectorState).where(DetectorState.asset_id == asset.id))}
    for metric, role in [(PRIMARY_METRIC, "PRIMARY"), *[(m, "CORROBORATING") for m in CORROBORATING]]:
        if metric not in rows:
            row = DetectorState(asset_id=asset.id, metric=metric, role=role, state="NORMAL", memory={},
                                detector_version=DETECTOR_VERSION)
            session.add(row)
            rows[metric] = row
    return rows


def _next_incident_id(session: Session) -> str:
    n = session.scalar(select(func.count()).select_from(AnomalyEvent)) or 0
    return f"INC-{n + 1:04d}"


def _confidence(corr: dict[str, bool]) -> float:
    """Base 0.5, +0.25 for each corroborating metric, capped at 1.0 (never raises severity)."""
    return min(1.0, 0.5 + 0.25 * sum(corr.values()))


def on_telemetry(session: Session, envelope: dict[str, Any]) -> None:
    by_asset: dict[str, dict[str, dict[str, tuple[int, float]]]] = defaultdict(lambda: defaultdict(dict))
    for r in envelope["payload"]["readings"]:
        by_asset[r["asset_id"]][r["ts"]][r["metric"]] = (r["id"], r["value"])
    for asset_id, series in by_asset.items():
        asset = session.get(Asset, asset_id)
        if asset is not None:
            _process_asset(session, asset, series)


def _process_asset(session: Session, asset: Asset, series: dict[str, dict[str, tuple[int, float]]]) -> None:
    rows = _get_states(session, asset)
    prim = rows[PRIMARY_METRIC]
    mem = dict(prim.memory or {})
    det = VibrationDetector(mem.get("detector"), limits=(asset.warn_limit, asset.alarm_limit, asset.critical_limit))
    trackers = {m: ResidualTracker((rows[m].memory or {}).get("tracker")) for m in CORROBORATING}
    evidence: list[list[Any]] = list(mem.get("evidence", []))   # [reading_id, ts, value, z]
    anomaly: AnomalyEvent | None = session.get(AnomalyEvent, prim.current_anomaly_id) if prim.current_anomaly_id else None
    last: StepResult | None = None
    last_ts: datetime | None = None
    last_corr: dict[str, bool] = {}

    for ts_iso in sorted(series):
        sample = series[ts_iso]
        ts = clock.parse_iso(ts_iso)
        load = sample["speed_command"][1] / 100.0 if "speed_command" in sample else det.last_load
        for m in CORROBORATING:
            if m in sample:
                trackers[m].update(load, sample[m][1], allow_update=(det.state == "NORMAL"))
        if PRIMARY_METRIC not in sample:
            continue
        rid, value = sample[PRIMARY_METRIC]
        res = det.update(_hours(ts), value, load)
        last, last_ts = res, ts
        evidence.append([rid, ts_iso, value, round(res.z, 2)])
        del evidence[:-EVIDENCE_KEEP]
        last_corr = {m: trackers[m].corroborates() for m in CORROBORATING}
        for tr in res.transitions:
            anomaly = _handle_transition(session, asset, prim, det, res, tr, ts, evidence, last_corr, anomaly)
        if anomaly is not None and anomaly.state == "ACTIVE" and res.state == "ANOMALY":
            _refresh_anomaly(session, asset, anomaly, det, res, ts, evidence, last_corr)

    # persist
    for metric, row in rows.items():
        if metric == PRIMARY_METRIC:
            row.memory = {"detector": det.to_dict(), "evidence": evidence}
            row.state = det.state
            row.baseline_a, row.baseline_b, row.sigma = det.baseline.a, det.baseline.b, det.baseline.sigma
            if last is not None:
                row.last_z, row.last_slope, row.last_timestamp = last.z, last.slope, last_ts
            row.current_anomaly_id = anomaly.id if anomaly is not None and anomaly.state == "ACTIVE" else None
        else:
            tr = trackers[metric]
            row.memory = {"tracker": tr.to_dict()}
            row.last_z = tr.last_z
            row.baseline_a, row.baseline_b, row.sigma = tr.baseline.a, tr.baseline.b, tr.baseline.sigma
            row.state = prim.state
        row.detector_version = DETECTOR_VERSION


def _handle_transition(session: Session, asset: Asset, prim: DetectorState, det: VibrationDetector, res: StepResult,
                       tr: str, ts: datetime, evidence: list[list[Any]], corr: dict[str, bool],
                       anomaly: AnomalyEvent | None) -> AnomalyEvent | None:
    if tr in ("NORMAL->WATCH", "CLEARED->WATCH"):
        asset.health_state = "WATCH"
        base = {"asset_id": asset.id, "metric": PRIMARY_METRIC, "z": round(res.z, 2), "slope": round(res.slope, 3),
                "observed_value": res.value}
        bus.publish(session, "HealthStateChanged", asset_id=asset.id, occurred_at=ts,
                    payload={**base, "from": res.prev_state, "to": "WATCH"})
        bus.publish(session, "AnomalyWatch", asset_id=asset.id, occurred_at=ts, payload=base)
    elif tr == "WATCH->NORMAL" or tr == "CLEARED->NORMAL":
        asset.health_state = "NORMAL"
        bus.publish(session, "HealthStateChanged", asset_id=asset.id, occurred_at=ts, payload={
            "asset_id": asset.id, "from": res.prev_state, "to": "NORMAL", "z": round(res.z, 2)})
    elif tr == "ANOMALY_DETECTED":
        anomaly = _create_anomaly(session, asset, det, res, ts, evidence, corr)
        prim.current_anomaly_id = anomaly.id
    elif tr == "ESCALATED" and anomaly is not None:
        old = anomaly.severity
        anomaly.severity = res.severity
        _refresh_anomaly(session, asset, anomaly, det, res, ts, evidence, corr, publish_corroboration=False)
        payload = _anomaly_payload(anomaly, det, res, evidence, corr)
        payload["previous_severity"] = old
        session.add(AnomalyEvidence(anomaly_id=anomaly.id, kind="ESCALATION", severity=res.severity,
                                    observed_value=res.value, z=res.z, slope=res.slope, confidence=anomaly.confidence,
                                    reading_ids=[e[0] for e in evidence], payload=payload, created_at=ts))
        bus.publish(session, "AnomalyEscalated", asset_id=asset.id, correlation_id=anomaly.incident_id,
                    occurred_at=ts, payload=payload)
    return anomaly


def _projection(det: VibrationDetector, res: StepResult, asset: Asset) -> float | None:
    return det.projection_hours(res.value, res.slope, asset.alarm_limit)


def _anomaly_payload(a: AnomalyEvent, det: VibrationDetector, res: StepResult, evidence: list[list[Any]],
                     corr: dict[str, bool]) -> dict[str, Any]:
    return {
        "anomaly_id": a.id, "incident_id": a.incident_id, "asset_id": a.asset_id, "metric": a.metric,
        "observed_value": res.value, "baseline_mean": round(res.expected, 4), "baseline_sigma": round(res.sigma, 4),
        "z": round(res.z, 2), "slope": round(res.slope, 3), "persistence": res.persistence,
        "consecutive_anomalous": res.consecutive_anomalous, "severity": a.severity,
        "confidence": a.confidence, "corroborating": {m: {"corroborates": c} for m, c in corr.items()},
        "window_start": clock.iso(a.window_start), "window_end": clock.iso(a.window_end),
        "supporting_reading_ids": [e[0] for e in evidence], "detector_version": DETECTOR_VERSION,
        "projection_hours": a.projection_hours,
        "projection_note": "trend extrapolation, indicative, not a prediction guarantee",
        "explanation": a.explanation, "limits_note": "demo thresholds, not taken from any standard",
    }


def _create_anomaly(session: Session, asset: Asset, det: VibrationDetector, res: StepResult, ts: datetime,
                    evidence: list[list[Any]], corr: dict[str, bool]) -> AnomalyEvent:
    window_start = clock.parse_iso(evidence[0][1])
    onset_minutes = ((_hours(ts) - det.onset_h) * 60.0) if det.onset_h is not None else 0.0
    corroborating = [m for m, c in corr.items() if c]
    a = AnomalyEvent(
        incident_id=_next_incident_id(session), asset_id=asset.id, metric=PRIMARY_METRIC, state="ACTIVE",
        severity=res.severity, confidence=_confidence(corr), observed_value=res.value, baseline_mean=res.expected,
        baseline_sigma=res.sigma, z=res.z, slope=res.slope, persistence=res.persistence,
        consecutive_anomalous=res.consecutive_anomalous,
        corroborating={m: {"corroborates": c} for m, c in corr.items()},
        window_start=window_start, window_end=ts, projection_hours=_projection(det, res, asset),
        explanation=explain.explain_vibration(asset.id, res.z, res.slope, onset_minutes, corroborating),
        detector_version=DETECTOR_VERSION, detected_at=ts, updated_at=ts)
    session.add(a)
    session.flush()
    asset.health_state = "ANOMALY"
    payload = _anomaly_payload(a, det, res, evidence, corr)
    session.add(AnomalyEvidence(anomaly_id=a.id, kind="DETECTION", severity=a.severity, observed_value=res.value,
                                z=res.z, slope=res.slope, confidence=a.confidence,
                                reading_ids=[e[0] for e in evidence], payload=payload, created_at=ts))
    bus.publish(session, "HealthStateChanged", asset_id=asset.id, correlation_id=a.incident_id, occurred_at=ts,
                payload={"asset_id": asset.id, "from": "WATCH", "to": "ANOMALY", "z": round(res.z, 2),
                         "slope": round(res.slope, 3), "observed_value": res.value})
    bus.publish(session, "AnomalyDetected", asset_id=asset.id, correlation_id=a.incident_id, occurred_at=ts,
                payload=payload)
    return a


def _refresh_anomaly(session: Session, asset: Asset, a: AnomalyEvent, det: VibrationDetector, res: StepResult,
                     ts: datetime, evidence: list[list[Any]], corr: dict[str, bool],
                     publish_corroboration: bool = True) -> None:
    """Keep the live anomaly row current; announce newly corroborating metrics once."""
    previously = {m for m, v in (a.corroborating or {}).items() if v.get("corroborates")}
    now_corr = {m for m, c in corr.items() if c}
    a.observed_value, a.baseline_mean, a.baseline_sigma = res.value, res.expected, res.sigma
    a.z, a.slope, a.persistence, a.consecutive_anomalous = res.z, res.slope, res.persistence, res.consecutive_anomalous
    a.window_start, a.window_end, a.updated_at = clock.parse_iso(evidence[0][1]), ts, ts
    a.projection_hours = _projection(det, res, asset)
    a.corroborating = {m: {"corroborates": c} for m, c in corr.items()}
    a.confidence = _confidence(corr)
    minutes = ((_hours(ts) - det.onset_h) * 60.0) if det.onset_h is not None else 0.0
    a.explanation = explain.explain_vibration(asset.id, res.z, res.slope, minutes, sorted(now_corr))
    if publish_corroboration and now_corr - previously:
        payload = _anomaly_payload(a, det, res, evidence, corr)
        payload["newly_corroborating"] = sorted(now_corr - previously)
        bus.publish(session, "AnomalyCorroborated", asset_id=asset.id, correlation_id=a.incident_id,
                    occurred_at=ts, payload=payload)


# --------------------------------------------------------------------------- clearing (Layer 7 / supervisor)
def clear_asset(session: Session, asset_id: str, reason: str, correlation_id: str | None = None,
                source: str = "verification") -> AnomalyEvent:
    """ANOMALY → CLEARED. Called by a passing verification or an explicit supervisor action."""
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise NotFound(f"Asset {asset_id} not found")
    prim = session.scalar(select(DetectorState).where(DetectorState.asset_id == asset_id,
                                                      DetectorState.metric == PRIMARY_METRIC))
    anomaly = session.get(AnomalyEvent, prim.current_anomaly_id) if prim and prim.current_anomaly_id else None
    if prim is None or anomaly is None or anomaly.state != "ACTIVE":
        raise Conflict(f"No active anomaly on {asset_id} to clear", code="no_active_anomaly")
    now = clock.sim_now(session)
    det = VibrationDetector((prim.memory or {}).get("detector"),
                            limits=(asset.warn_limit, asset.alarm_limit, asset.critical_limit))
    det.clear()
    memory = dict(prim.memory or {})
    memory["detector"] = det.to_dict()
    prim.memory = memory
    prim.state = "CLEARED"
    prim.current_anomaly_id = None
    anomaly.state = "CLEARED"
    anomaly.cleared_at = now
    anomaly.cleared_reason = reason
    anomaly.updated_at = now
    asset.health_state = "CLEARED"
    session.add(AnomalyEvidence(anomaly_id=anomaly.id, kind="CLEARED", severity=anomaly.severity,
                                observed_value=anomaly.observed_value, z=anomaly.z, slope=anomaly.slope,
                                confidence=anomaly.confidence, reading_ids=[], payload={"reason": reason, "source": source},
                                created_at=now))
    cid = correlation_id or anomaly.incident_id
    bus.publish(session, "AnomalyCleared", asset_id=asset_id, correlation_id=cid, occurred_at=now,
                payload={"anomaly_id": anomaly.id, "incident_id": anomaly.incident_id, "reason": reason, "source": source})
    bus.publish(session, "HealthStateChanged", asset_id=asset_id, correlation_id=cid, occurred_at=now,
                payload={"asset_id": asset_id, "from": "ANOMALY", "to": "CLEARED"})
    return anomaly


def anomaly_dict(a: AnomalyEvent, evidence: list[AnomalyEvidence] | None = None) -> dict[str, Any]:
    d = {
        "id": a.id, "incident_id": a.incident_id, "asset_id": a.asset_id, "metric": a.metric, "state": a.state,
        "severity": a.severity, "confidence": a.confidence, "observed_value": a.observed_value,
        "baseline_mean": a.baseline_mean, "baseline_sigma": a.baseline_sigma, "z": a.z, "slope": a.slope,
        "persistence": a.persistence, "consecutive_anomalous": a.consecutive_anomalous,
        "corroborating": a.corroborating, "window_start": clock.iso(a.window_start),
        "window_end": clock.iso(a.window_end), "projection_hours": a.projection_hours,
        "projection_note": "trend extrapolation, indicative, not a prediction guarantee",
        "explanation": a.explanation, "detector_version": a.detector_version,
        "detected_at": clock.iso(a.detected_at), "updated_at": clock.iso(a.updated_at),
        "cleared_at": clock.iso(a.cleared_at), "cleared_reason": a.cleared_reason,
        "limits_note": "demo thresholds, not taken from any standard", "simulated": True,
    }
    if evidence is not None:
        d["evidence"] = [{"id": e.id, "kind": e.kind, "severity": e.severity, "observed_value": e.observed_value,
                          "z": e.z, "slope": e.slope, "confidence": e.confidence, "reading_ids": e.reading_ids,
                          "created_at": clock.iso(e.created_at), "payload": e.payload} for e in evidence]
    return d
