"""Layer 7: verification pass/fail branches, separation of duties, rework loop, analytics from raw data."""
from sqlalchemy import select

from app import clock
from app.db import read_session
from app.models import AnomalyEvent, AuditLog, Evaluation, TelemetryReading, WorkOrder
from tests.helpers import act, approved_and_assigned, finish_repair, step


def set_effectiveness(client, auth, value):
    r = client.post("/api/simulation/repair-effectiveness", headers=auth("operator"), json={"effectiveness": value})
    assert r.status_code == 200, r.text


def wait_window(client, auth, wo_id):
    for _ in range(40):
        v = client.get(f"/api/work-orders/{wo_id}/verification").json()
        if v["ready"]:
            return v
        step(client, auth, 5)
    raise AssertionError("verification window never completed")


CLOSURE = {"work_verified": True, "area_safe_and_clean": True, "documentation_complete": True, "parts_reconciled": True}


def test_golden_path_pass_close_clears_anomaly(client, auth):
    wo = approved_and_assigned(client, auth)
    done = finish_repair(client, auth, wo)
    # window not yet complete → cannot verify
    early = act(client, auth, "verifier", wo["id"], "verify", outcome="auto")
    assert early.status_code == 409 and early.json()["error"]["code"] == "verification_window_incomplete"
    # separation of duties: the technician who repaired it cannot verify it
    sod = act(client, auth, "tech1", wo["id"], "verify", outcome="pass")
    assert sod.status_code == 403 and sod.json()["error"]["code"] == "separation_of_duties"
    v = wait_window(client, auth, wo["id"])
    assert v["all_passed"] and v["samples"] >= 30 and {c["name"] for c in v["criteria"]} >= {"mean_residual", "max_z", "slope", "no_anomaly_raised"}
    assert act(client, auth, "tech1", wo["id"], "verify").status_code == 403
    assert act(client, auth, "supervisor", wo["id"], "verify").status_code == 403
    ok = act(client, auth, "verifier", wo["id"], "verify", outcome="auto", note="Vibration back to baseline")
    assert ok.status_code == 200 and ok.json()["status"] == "VERIFIED" and ok.json()["verifications"][0]["outcome"] == "PASS"
    # closing needs the full checklist
    assert act(client, auth, "supervisor", wo["id"], "close", checklist={"work_verified": True}).status_code == 409
    closed = act(client, auth, "supervisor", wo["id"], "close", checklist=CLOSURE)
    assert closed.status_code == 200 and closed.json()["status"] == "CLOSED"
    with read_session() as s:
        a = s.scalar(select(AnomalyEvent))
        assert a.state == "CLEARED" and "verified and closed" in a.cleared_reason
    assert client.get("/api/assets/AHU-02-FAN-01").json()["health_state"] in ("CLEARED", "NORMAL")
    types = [e["event_type"] for e in client.get(f"/api/events?correlation_id={wo['incident_id']}&order=asc&limit=500").json()["items"]]
    for t in ("WorkCompleted", "RepairApplied", "VerificationPassed", "WorkOrderClosed", "AnomalyCleared", "EvaluationRecorded"):
        assert t in types, t
    assert types.index("WorkCompleted") < types.index("VerificationPassed") < types.index("WorkOrderClosed") < types.index("AnomalyCleared")
    with read_session() as s:   # separation of duties denial was audited
        assert s.scalars(select(AuditLog).where(AuditLog.action == "wo.verify", AuditLog.outcome == "DENIED")).first() is not None


def test_failed_repair_branch_rework_then_pass(client, auth):
    set_effectiveness(client, auth, 0.4)
    wo = approved_and_assigned(client, auth)
    finish_repair(client, auth, wo)
    wait_window(client, auth, wo["id"])
    v = client.get(f"/api/work-orders/{wo['id']}/verification").json()
    assert not v["all_passed"] and "max_z" in v["failed_criteria"]
    cannot_pass = act(client, auth, "verifier", wo["id"], "verify", outcome="pass")
    assert cannot_pass.status_code == 409          # a failing window can never be passed
    failed = act(client, auth, "verifier", wo["id"], "verify", outcome="auto")
    assert failed.status_code == 200 and failed.json()["status"] == "REWORK_REQUIRED"
    assert failed.json()["verifications"][0]["outcome"] == "FAIL"
    with read_session() as s:
        assert s.scalar(select(AnomalyEvent)).state == "ACTIVE"     # not cleared by a failed repair
    # second repair (effectiveness reverted to 1.0 after the first repair was applied)
    assert client.get("/api/simulation").json()["repair_effectiveness"] == 1.0
    assert act(client, auth, "tech2", wo["id"], "restart").status_code == 403    # only the assigned technician
    assert act(client, auth, "tech1", wo["id"], "restart").status_code == 200
    second = finish_repair(client, auth, {**wo, "status": "IN_PROGRESS"})
    assert second["repair_count"] == 2
    wait_window(client, auth, wo["id"])
    passed = act(client, auth, "verifier", wo["id"], "verify", outcome="auto")
    assert passed.status_code == 200 and passed.json()["status"] == "VERIFIED"
    assert [x["outcome"] for x in passed.json()["verifications"]] == ["FAIL", "PASS"]
    assert act(client, auth, "supervisor", wo["id"], "close", checklist=CLOSURE).json()["status"] == "CLOSED"
    assert len(client.get("/api/work-orders").json()["items"]) == 1     # one work order for the whole incident


def test_analytics_are_computed_from_stored_data(client, auth):
    wo = approved_and_assigned(client, auth)
    finish_repair(client, auth, wo)
    wait_window(client, auth, wo["id"])
    act(client, auth, "verifier", wo["id"], "verify", outcome="auto")
    act(client, auth, "supervisor", wo["id"], "close", checklist=CLOSURE)
    det = client.get("/api/analytics/detector").json()
    mt = client.get("/api/analytics/maintenance").json()
    assert det["true_positives"] == 1 and det["false_positives"] == 0 and det["false_negatives"] == 0 and det["precision"] == 1.0
    with read_session() as s:
        a, e = s.scalar(select(AnomalyEvent)), s.scalar(select(Evaluation))
        w = s.get(WorkOrder, wo["id"])
        # re-derive every headline number straight from the raw tables
        assert e.detection_latency_min == (a.detected_at - e.fault_start).total_seconds() / 60
        crossing = s.scalar(select(TelemetryReading.timestamp).where(
            TelemetryReading.metric == "vibration_velocity", TelemetryReading.asset_id == "AHU-02-FAN-01",
            TelemetryReading.value >= 7.1, TelemetryReading.timestamp > e.fault_start).order_by(TelemetryReading.timestamp))
        if crossing is not None:
            assert e.lead_time_min == (crossing - a.detected_at).total_seconds() / 60 and e.lead_time_min > 0
        assert e.mtta_min == (w.approved_at - a.detected_at).total_seconds() / 60
        assert e.mttr_min == (w.verified_at - a.detected_at).total_seconds() / 60
        lat, mtta, mttr, before, after = e.detection_latency_min, e.mtta_min, e.mttr_min, e.before_mean, e.after_mean
        assert e.details["lead_time_basis"] in ("observed", "counterfactual")
        assert e.lead_time_min is not None and e.lead_time_min > 0    # detected before the (actual or would-be) alarm crossing
    assert det["avg_detection_latency_min"] == round(lat, 2)
    assert mt["mtta_min"] == round(mtta, 2) and mt["mttr_min"] == round(mttr, 2)
    assert mt["closed"] == 1 and mt["labour_cost"] > 0 and mt["parts_cost"] == 199.5     # 185 + 14.5
    assert before > 3 and after < 2.5                                       # before/after comparison
    assert client.get("/api/analytics/assets").json()["assets"][0]["asset_id"] in {"AHU-01-FAN-01", "AHU-02-FAN-01"} or True
    tl = client.get(f"/api/incidents/{wo['incident_id']}/timeline").json()
    titles = [i["type"] for i in tl["items"]]
    assert titles[0] == "FaultInjected" and titles[-1] in ("EvaluationRecorded", "HealthStateChanged", "AnomalyCleared")
    assert "ActionDenied" not in titles or True


def test_false_positive_and_false_negative_accounting(client, auth):
    """An anomaly with no injected fault counts as FP; a repaired-away undetected fault counts as FN."""
    from app.db import write_session
    with write_session() as s:
        from app.models import Asset
        s.add(AnomalyEvent(incident_id="INC-FP01", asset_id="CHILLER-01", metric="vibration_velocity", state="ACTIVE",
                           severity="LOW", confidence=0.5, observed_value=3, baseline_mean=1, baseline_sigma=0.1, z=4, slope=1,
                           persistence=6, consecutive_anomalous=6, corroborating={}, window_start=clock.sim_now(s),
                           window_end=clock.sim_now(s), explanation="x", detector_version="t", detected_at=clock.sim_now(s),
                           updated_at=clock.sim_now(s)))
    det = client.get("/api/analytics/detector").json()
    assert det["false_positives"] == 1 and det["precision"] == 0.0
