"""Layer 5 decision engine + Layer 6 draft/approval behaviour + outbox guarantees."""
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app import clock
from app.db import read_session, write_session
from app.models import AuditLog, DeadLetter, OutboxEvent, ProcessedEvent, RiskAssessment, WorkOrder
from app.modules.decision import risk
from app.modules.decision.policy import load_policy
from app.modules.events import bus
from tests.helpers import act, incident_with_draft, step


def test_risk_formula_and_decision_table_match_spec():
    p = load_policy()
    r = risk.compute_risk(p, "MEDIUM", "HIGH", 6, 3.0, quality_degraded=False)
    assert r["score"] == 58.5   # 100*(0.40*.5 + 0.25*1.0 + 0.20*.3 + 0.15*.5) = 20+25+6+7.5
    assert set(r["terms"]) == {"S", "C", "P", "R", "Q"}
    assert risk.compute_risk(p, "MEDIUM", "HIGH", 6, 3.0, quality_degraded=True)["score"] == pytest.approx(58.5 * 0.85, abs=0.01)
    assert risk.decide(p, 29.9, "LOW")["action"] == "MONITOR"
    assert risk.decide(p, 30, "LOW") == {"action": "INSPECT", "priority": "P3", "approval": "Supervisor"}
    assert risk.decide(p, 55, "LOW")["action"] == "INSPECT_URGENT"
    assert risk.decide(p, 75, "HIGH")["priority"] == "P1"
    assert risk.decide(p, 10, "CRITICAL")["action"] == "URGENT_HUMAN_REVIEW"   # CRITICAL always escalates
    assert risk.compute_risk(p, "CRITICAL", "HIGH", 40, 50.0, False)["score"] == 100.0  # terms are capped


def test_one_draft_work_order_per_incident_with_evidence(client, auth):
    wo = incident_with_draft(client, auth)
    assert wo["status"] == "DRAFT" and wo["asset_id"] == "AHU-02-FAN-01" and wo["incident_id"] == "INC-0001"
    step(client, auth, 40)  # escalations / corroboration are attached as evidence, never as new work orders
    assert len(client.get("/api/work-orders").json()["items"]) == 1
    detail = client.get(f"/api/work-orders/{wo['id']}").json()
    assert len(detail["evidence"]) >= 2
    kinds = {e["kind"] for e in detail["evidence"]}
    assert "system_draft" in kinds and "EVIDENCE_ATTACHED" in kinds
    ra = detail["risk_assessment"]
    assert ra["policy_version"] == "policy_v1" and ra["breakdown"]["terms"]["S"]["label"].startswith("severity")
    assert ra["action"] in ("INSPECT", "INSPECT_URGENT", "URGENT_HUMAN_REVIEW")
    assert "not a confirmed diagnosis" in ra["reason"]


def test_partial_unique_index_blocks_second_active_work_order(client, auth):
    wo = incident_with_draft(client, auth)
    with pytest.raises(IntegrityError):
        with write_session() as s:
            dup = s.get(WorkOrder, wo["id"])
            s.add(WorkOrder(number="WO-9999", asset_id=dup.asset_id, failure_mode=dup.failure_mode, title="dup",
                            description="x", status="OPEN", priority="P3", action="INSPECT", required_skills=[],
                            created_at=dup.created_at, updated_at=dup.updated_at))
    with write_session() as s:  # terminal work orders do not occupy the slot
        s.get(WorkOrder, wo["id"]).status = "CANCELLED"
        s.flush()
        s.add(WorkOrder(number="WO-9998", asset_id="AHU-02-FAN-01", failure_mode="VIBRATION_RISE", title="again",
                        description="x", status="DRAFT", priority="P3", action="INSPECT", required_skills=[],
                        created_at=clock.sim_now(s), updated_at=clock.sim_now(s)))


def test_repeated_alert_events_never_create_a_second_work_order(client, auth):
    wo = incident_with_draft(client, auth)
    with read_session() as s:
        original = s.scalar(select(OutboxEvent).where(OutboxEvent.event_type == "AnomalyDetected"))
        payload, cid = dict(original.payload), original.correlation_id
    before = len(client.get(f"/api/work-orders/{wo['id']}").json()["evidence"])
    for _ in range(3):  # three brand-new alerts (distinct event ids) for the same unresolved incident
        with write_session() as s:
            bus.publish(s, "AnomalyEscalated", asset_id="AHU-02-FAN-01", correlation_id=cid, payload=payload)
        bus.drain()
    assert len(client.get("/api/work-orders").json()["items"]) == 1
    assert len(client.get(f"/api/work-orders/{wo['id']}").json()["evidence"]) == before + 3


def test_replaying_a_processed_event_creates_no_duplicates(client, auth):
    incident_with_draft(client, auth)
    with read_session() as s:
        eid = s.scalar(select(OutboxEvent).where(OutboxEvent.event_type == "AnomalyDetected")).event_id
        counts = [s.scalar(select(func.count()).select_from(t)) for t in (WorkOrder, RiskAssessment, ProcessedEvent)]
    assert bus.redeliver(eid) == 0           # every consumer already processed it
    with read_session() as s:
        again = [s.scalar(select(func.count()).select_from(t)) for t in (WorkOrder, RiskAssessment, ProcessedEvent)]
    assert counts == again


def test_unauthorized_approve_is_403_and_audited_then_supervisor_succeeds(client, auth):
    wo = incident_with_draft(client, auth)
    r = act(client, auth, "operator", wo["id"], "approve")
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_not_permitted"
    with read_session() as s:
        row = s.scalars(select(AuditLog).where(AuditLog.action == "wo.approve").order_by(AuditLog.id.desc())).first()
        assert row.outcome == "DENIED" and row.username == "operator" and row.target_id == wo["number"]
        assert row.correlation_id == wo["incident_id"]
    assert client.get(f"/api/work-orders/{wo['id']}").json()["status"] == "DRAFT"
    ok = act(client, auth, "supervisor", wo["id"], "approve", note="Approved for inspection")
    assert ok.status_code == 200 and ok.json()["status"] == "OPEN"
    with read_session() as s:
        row = s.scalars(select(AuditLog).where(AuditLog.action == "wo.approve", AuditLog.outcome == "ALLOWED")).first()
        assert row is not None and row.after["status"] == "OPEN"


def test_invalid_transitions_and_missing_reasons_are_denied(client, auth):
    wo = incident_with_draft(client, auth)
    assert act(client, auth, "supervisor", wo["id"], "start").status_code == 403       # supervisor is not a technician
    assert act(client, auth, "supervisor", wo["id"], "assign", technician_id="TECH-01").status_code == 409  # still DRAFT
    assert act(client, auth, "supervisor", wo["id"], "reject").status_code == 422      # reason required
    with read_session() as s:
        denied = s.scalars(select(AuditLog).where(AuditLog.outcome == "DENIED")).all()
        assert len(denied) >= 3 and all(d.reason for d in denied)
    assert act(client, auth, "supervisor", wo["id"], "reject", note="false alarm").json()["status"] == "REJECTED"


def test_priority_escalation_requires_supervisor_acknowledgement(client, auth):
    wo = incident_with_draft(client, auth)
    with write_session() as s:   # force a pending proposal the way a worse alert would
        row = s.get(WorkOrder, wo["id"])
        row.priority, row.proposed_priority = "P3", "P1"
    r = client.post(f"/api/work-orders/{wo['id']}/acknowledge-escalation", headers=auth("operator"), json={})
    assert r.status_code == 403
    r = client.post(f"/api/work-orders/{wo['id']}/acknowledge-escalation", headers=auth("supervisor"), json={"accept": True})
    assert r.status_code == 200 and r.json()["priority"] == "P1" and r.json()["proposed_priority"] is None


def test_outbox_retries_with_backoff_then_dead_letters(client):
    bus.BACKOFF_BASE_SECONDS = 0.0
    calls = {"n": 0}

    @bus.subscribe("test.always_fails", ["SimulationControl"])
    def boom(session, envelope):  # noqa: ANN001
        calls["n"] += 1
        raise RuntimeError("consumer exploded")

    try:
        with write_session() as s:
            bus.publish(s, "SimulationControl", payload={"probe": True})
        for _ in range(8):
            bus.drain()
        assert calls["n"] == bus.MAX_ATTEMPTS
        with read_session() as s:
            ev = s.scalars(select(OutboxEvent).where(OutboxEvent.event_type == "SimulationControl")
                           .order_by(OutboxEvent.id.desc())).first()
            assert ev.status == "DEAD" and ev.attempts == bus.MAX_ATTEMPTS and "exploded" in ev.last_error
            dl = s.scalars(select(DeadLetter)).all()
            assert len(dl) == 1 and dl[0].consumer == "test.always_fails"
    finally:
        bus._consumers[:] = [c for c in bus._consumers if c.name != "test.always_fails"]


def test_event_envelope_and_timeline(client, auth):
    wo = incident_with_draft(client, auth)
    items = client.get(f"/api/events?correlation_id={wo['incident_id']}&order=asc").json()["items"]
    types = [e["event_type"] for e in items]
    assert types.index("AnomalyDetected") < types.index("RiskAssessed") < types.index("WorkOrderDrafted")
    for key in ("event_id", "event_type", "layer", "occurred_at", "asset_id", "correlation_id", "schema_version", "payload"):
        assert key in items[0]
    assert {x["layer"] for x in items} >= {4, 5}
    tl = client.get(f"/api/incidents/{wo['incident_id']}/timeline").json()
    assert tl["count"] >= 6 and tl["items"][0]["type"] == "FaultInjected"
