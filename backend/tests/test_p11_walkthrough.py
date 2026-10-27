"""The one-click walkthrough drives one anomaly end to end through the real API, one stage per click."""
from __future__ import annotations

import pytest

from app.modules.demo import walkthrough as wmod

ASSET = "AHU-02-FAN-01"


@pytest.fixture
def wt(world):  # type: ignore[no-untyped-def]
    w = wmod.Walkthrough()
    w.pace = 0.0
    w.asset_id = ASSET
    return w


def test_seven_stages_run_end_to_end(wt):
    wt._start()
    wt.started = True
    for n in range(1, len(wmod.STEPS) + 1):
        wt._exec(n)
    assert wt.stage == 7 and wt.error is None
    r = wt.results
    # step 1: every sensor of the machine had its repeated reading dropped, none stored twice
    assert set(r[1]["duplicates"]) and all(c >= 1 for c in r[1]["duplicates"].values())
    # step 3: exactly one work order, with evidence attached instead of duplicates
    assert r[3]["open_work_orders"] == 1 and r[3]["evidence"] >= 2
    # step 4: an operator is refused (403), the supervisor approves
    assert r[4]["operator_denied"] == 403 and r[4]["status"] == "OPEN"
    assert r[5]["status"] == "ASSIGNED"
    assert r[6]["status"] == "COMPLETED"
    # step 7: a technician cannot verify their own work; an independent verifier can
    assert r[7]["own_work_denied"] == 403
    assert r[7]["outcome"] == "CLOSED"
    # the whole thing used the genuine workflow: roles on the work-order events
    api = wt.api()
    wo = api.get("/api/work-orders?asset_id=%s" % ASSET)["items"][0]
    detail = api.get(f"/api/work-orders/{wo['id']}")
    assert {("approve", "SUPERVISOR"), ("assign", "SUPERVISOR"), ("complete", "TECHNICIAN"), ("close", "SUPERVISOR")} <= {
        (e["action"], e["actor_role"]) for e in detail["events"]}


def test_start_pauses_the_clock_and_stops_the_autopilot(wt):
    from app.modules.autopilot.operations import autopilot

    autopilot.configure(enabled=True)
    wt._start()
    assert autopilot.enabled is False
    assert wt.api().get("/api/simulation")["running"] is False
    assert any(f["fault_type"] == "BEARING_WEAR" for f in wt.api().get("/api/simulation")["active_faults"])


def test_next_is_ignored_until_started_and_while_busy(wt):
    assert wt.next_step()["stage"] == 0 and not wt.busy
    wt.started, wt.busy = True, True
    wt.next_step()
    assert wt.stage == 0  # busy → the click is ignored, no second stage is queued


def test_start_endpoint_refuses_a_machine_that_already_has_a_problem(client, auth, monkeypatch):
    monkeypatch.setattr(wmod.walkthrough, "begin", lambda asset_id: wmod.walkthrough.state())
    ok = client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": ASSET})
    assert ok.status_code == 200
    r = client.post("/api/simulation/faults", headers=auth("operator"), json={"asset_id": ASSET, "fault_type": "bearing_wear"})
    assert r.status_code == 200
    busy = client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": ASSET})
    assert busy.status_code == 409
    assert client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": "NOPE"}).status_code == 404


def test_walkthrough_requires_a_signed_in_user(client):
    assert client.post("/api/walkthrough/next").status_code in (401, 403)
    assert client.get("/api/walkthrough/state").status_code == 200  # read-only state is public like the demo state


def test_rejected_readings_can_be_filtered_by_machine(client, auth):
    client.post("/api/simulation/faults", headers=auth("operator"), json={"asset_id": ASSET, "fault_type": "duplicate"})
    client.post("/api/simulation/step?minutes=3", headers=auth("operator"))
    mine = client.get(f"/api/telemetry/rejected?asset_id={ASSET}&reason=DUPLICATE").json()
    other = client.get("/api/telemetry/rejected?asset_id=NOPE").json()
    assert mine["total"] >= 1 and other["total"] == 0
