"""Operations autopilot: random wear + the simulated crew work an incident end to end via the real API."""
from __future__ import annotations

from app.modules.autopilot.operations import Autopilot
from app.modules.cmms import procedures

from .helpers import inject_wear, step


def _all_wos(client):
    return client.get("/api/work-orders").json()["items"]


def test_autopilot_works_an_incident_from_detection_to_closure(client, auth):
    ap = Autopilot(enabled=True)
    ap.configure(fault_rate="off")  # this test injects the wear itself
    inject_wear(client, auth)
    seen: list[str] = []
    for _ in range(420):
        step(client, auth, 1)
        ap.tick(require_running=False)
        wos = _all_wos(client)
        if wos and (not seen or seen[-1] != wos[0]["status"]):
            seen.append(wos[0]["status"])
        if wos and wos[0]["status"] == "CLOSED":
            break
    assert seen[-1] == "CLOSED", seen
    assert len(_all_wos(client)) == 1  # one incident → one work order, never a duplicate
    for status in ("ASSIGNED", "IN_PROGRESS", "COMPLETED", "VERIFIED"):
        assert status in seen, seen

    wo = client.get(f"/api/work-orders/{_all_wos(client)[0]['id']}").json()
    actors = {(e["action"], e["actor_role"]) for e in wo["events"]}
    assert {("approve", "SUPERVISOR"), ("assign", "SUPERVISOR"), ("start", "TECHNICIAN"), ("complete", "TECHNICIAN"),
            ("close", "SUPERVISOR")} <= actors
    # the technician followed the planned procedure and signed it off step by step
    inspection = wo["inspections"][-1]
    assert set(inspection["checklist"]) >= {k for k, _, _ in procedures.steps("SUPPLY_FAN", inspection["repair_number"] > 1)}
    assert inspection["labour_minutes"] >= procedures.planned_minutes("SUPPLY_FAN", inspection["repair_number"] > 1) - 1
    # every action is a genuine, audited API call by the seeded users
    audit = client.get("/api/audit-logs?limit=200", headers=auth("admin")).json()["items"]
    assert {"supervisor", "verifier"} <= {a["username"] for a in audit if a["outcome"] == "ALLOWED"}
    assert any(e["kind"] == "action" for e in ap.state()["log"])


def test_autopilot_schedules_seeded_wear_and_respects_off(client, auth):
    ap = Autopilot(enabled=True)
    ap.configure(fault_rate="high")
    for _ in range(36):  # six simulated hours in 10-minute strides
        step(client, auth, 10)
        ap.tick(require_running=False)
    faults = client.get("/api/simulation").json()["active_faults"]
    assert any(f["fault_type"] == "BEARING_WEAR" for f in faults) or _all_wos(client)
    assert any(e["kind"] == "fault" for e in ap.state()["log"])

    off = Autopilot(enabled=False)
    off.tick(require_running=False)
    assert off.state()["status"] == "off"


def test_autopilot_toggle_is_permissioned_and_audited(client, auth):
    denied = client.patch("/api/autopilot", headers=auth("tech1"), json={"enabled": False})
    assert denied.status_code == 403
    rows = client.get("/api/audit-logs?outcome=DENIED&action=sim.autopilot", headers=auth("admin")).json()["items"]
    assert rows and rows[0]["username"] == "tech1"
    bad = client.patch("/api/autopilot", headers=auth("operator"), json={"fault_rate": "extreme"})
    assert bad.status_code == 422
    ok = client.patch("/api/autopilot", headers=auth("operator"), json={"enabled": False, "fault_rate": "low"})
    assert ok.status_code == 200 and ok.json()["enabled"] is False and ok.json()["fault_rate"] == "low"
    assert client.get("/api/procedures").json()["procedures"]["SUPPLY_FAN"][0]["key"] == "permit"
