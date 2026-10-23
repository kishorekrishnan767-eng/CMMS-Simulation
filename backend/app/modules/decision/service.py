"""Layer 5 — risk assessment and decision engine (consumer of Layer 4 anomaly events).

For every ``AnomalyDetected`` / ``AnomalyEscalated`` / ``AnomalyCorroborated`` event it computes the
risk score from the event payload (so a replay is deterministic), stores a decision record under the
active policy version, and either creates ONE draft work order or — when an active work order for the
same (asset, failure_mode) exists — attaches the new alert as evidence and, if the priority should
rise, proposes an escalation that a supervisor must acknowledge. The engine never stops equipment.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.models import AnomalyEvent, Asset, RiskAssessment, Sensor
from app.modules.cmms import workflow
from app.modules.decision import risk
from app.modules.decision.policy import load_policy
from app.modules.events import bus

FAILURE_MODE_BY_METRIC = {"vibration_velocity": "VIBRATION_RISE"}
NOTIFY_ON_P1 = ["OPERATOR", "SUPERVISOR"]


def _quality_degraded(session: Session, asset_id: str) -> bool:
    return any(s.quality != "GOOD" for s in session.scalars(
        select(Sensor).where(Sensor.asset_id == asset_id, Sensor.is_primary.is_(False))))


def assess(session: Session, envelope: dict[str, Any]) -> None:
    p = envelope["payload"]
    anomaly = session.get(AnomalyEvent, p["anomaly_id"])
    if anomaly is None or anomaly.state != "ACTIVE":
        return
    asset = session.get(Asset, anomaly.asset_id)
    assert asset is not None
    policy = load_policy()
    failure_mode = FAILURE_MODE_BY_METRIC.get(anomaly.metric, "VIBRATION_RISE")
    r = risk.compute_risk(policy, p["severity"], asset.criticality, int(p["consecutive_anomalous"]), float(p["slope"]),
                          _quality_degraded(session, asset.id))
    d = risk.decide(policy, r["score"], p["severity"])
    now = clock.sim_now(session)
    reason = risk.reason_text(asset.id, p["severity"], r["score"], d["action"], d["priority"])
    safety = policy["safety_note"].strip() if d["action"] == "URGENT_HUMAN_REVIEW" else None
    ra = RiskAssessment(
        anomaly_id=anomaly.id, incident_id=anomaly.incident_id, asset_id=asset.id, trigger_event=envelope["event_type"],
        trigger_event_id=envelope["event_id"], severity=p["severity"], term_s=r["terms"]["S"]["value"],
        term_c=r["terms"]["C"]["value"], term_p=r["terms"]["P"]["value"], term_r=r["terms"]["R"]["value"],
        term_q=r["terms"]["Q"]["value"], risk_score=r["score"], action=d["action"], priority=d["priority"],
        required_approval=d["approval"], reason=reason, safety_note=safety, policy_version=policy["version"],
        breakdown={**r, "decision": d}, created_at=now)
    session.add(ra)
    session.flush()
    bus.publish(session, "RiskAssessed", asset_id=asset.id, correlation_id=anomaly.incident_id, payload={
        "risk_assessment_id": ra.id, "risk_score": ra.risk_score, "action": ra.action, "priority": ra.priority,
        "severity": ra.severity, "terms": r["terms"], "policy_version": policy["version"], "reason": reason,
        "required_approval": d["approval"], "trigger_event": envelope["event_type"],
        "notify_roles": NOTIFY_ON_P1 if d["priority"] == "P1" else []})
    if d["action"] == "MONITOR":
        return

    evidence = {"anomaly_id": anomaly.id, "incident_id": anomaly.incident_id, "trigger_event": envelope["event_type"],
                "trigger_event_id": envelope["event_id"], "severity": p["severity"], "z": p["z"], "slope": p["slope"],
                "confidence": p["confidence"], "risk_assessment_id": ra.id, "risk_score": ra.risk_score,
                "reading_ids": p.get("supporting_reading_ids", []), "explanation": p.get("explanation")}
    existing = workflow.active_wo(session, asset.id, failure_mode)
    if existing is not None:
        workflow.attach_evidence(session, existing, evidence, d["priority"])
        return
    title = f"Inspect {asset.name} — possible bearing degradation (vibration rise)"
    description = f"{p.get('explanation', '')}\n\nDecision: {reason}"
    workflow.create_draft(
        session, asset=asset, failure_mode=failure_mode, title=title, description=description, priority=d["priority"],
        action=d["action"], incident_id=anomaly.incident_id, anomaly_id=anomaly.id, risk_assessment_id=ra.id,
        safety_note=safety, evidence=evidence)


def risk_dict(ra: RiskAssessment) -> dict[str, Any]:
    return {"id": ra.id, "anomaly_id": ra.anomaly_id, "incident_id": ra.incident_id, "asset_id": ra.asset_id,
            "trigger_event": ra.trigger_event, "severity": ra.severity, "risk_score": ra.risk_score, "action": ra.action,
            "priority": ra.priority, "required_approval": ra.required_approval, "reason": ra.reason,
            "safety_note": ra.safety_note, "policy_version": ra.policy_version, "breakdown": ra.breakdown,
            "created_at": clock.iso(ra.created_at), "demo_note": "Demo policy values — not taken from any standard"}
