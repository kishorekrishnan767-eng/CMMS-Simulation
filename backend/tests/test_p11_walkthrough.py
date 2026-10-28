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
    # step 4: the request goes to Kishore with a technician on standby, and Kishore approves by himself
    assert r[4]["requested_to"] == r[4]["approved_by"] == "Kishore" and r[4]["status"] == "OPEN"
    assert r[4]["standby"] == r[5]["technician"]
    assert r[5]["status"] == "ASSIGNED"
    assert r[6]["status"] == "COMPLETED"
    # step 7: an independent check (not the technician) verifies, Kishore closes
    assert r[7]["outcome"] == "CLOSED" and r[7]["verified_by"] == "independent check"
    # the whole thing used the genuine workflow: roles on the work-order events
    api = wt.api()
    wo = api.get("/api/work-orders?asset_id=%s" % ASSET)["items"][0]
    detail = api.get(f"/api/work-orders/{wo['id']}")
    assert {("approve", "SUPERVISOR"), ("assign", "SUPERVISOR"), ("complete", "TECHNICIAN"), ("close", "SUPERVISOR"),
            ("verify_pass", "VERIFIER")} <= {(e["action"], e["actor_role"]) for e in detail["events"]}
    # nothing is staged as a refusal: every request is made by the person whose job it is
    assert api.ok("admin", "get", "/api/audit-logs?outcome=DENIED&limit=50")["total"] == 0
    # the prediction: how far above normal, how fast it rises, and when the alarm limit would be reached
    assert r[2]["z"] > 0 and r[2]["observed"] > r[2]["baseline"] and "at_detection" in r[2]


def test_the_run_records_normal_values_and_the_escalation_ladder(wt):
    wt.auto = True
    wt._play()
    # every sensor's value before the wear began, to compare with the values after it
    assert {"vibration_velocity", "bearing_temperature", "motor_current"} <= set(wt.normal)
    levels = [e["level"] for e in wt.escalation]
    # normal → watch → early warning → work order → escalated to the supervisor → approved, in that order
    order = ["NORMAL", "WATCH", "ANOMALY", "SUPERVISOR", "APPROVED"]
    assert all(lvl in levels for lvl in order)
    assert [levels.index(lvl) for lvl in order] == sorted(levels.index(lvl) for lvl in order)
    assert any(lvl.startswith("WORK_ORDER_P") for lvl in levels)
    assert any(lvl.startswith("SEVERITY_") for lvl in levels)
    # and back to normal at the end; every rung carries its second on the clock, in time order
    assert levels[-1] in ("NORMAL", "CLEARED")
    ts = [e["t"] for e in wt.escalation]
    assert ts == sorted(ts)
    assert wt.state()["escalation"] == wt.escalation and wt.state()["normal"] == wt.normal


def test_automatic_run_plays_every_stage_without_a_click(wt):
    wt.auto = True
    wt._play()
    assert wt.stage == 7 and wt.error is None and wt.started
    assert set(wt.marks) == set(range(1, 8)) and list(wt.marks.values()) == sorted(wt.marks.values())
    assert wt.results[3]["open_work_orders"] == 1
    assert wt.results[4]["approved_by"] == "Kishore" and wt.results[7]["outcome"] == "CLOSED"
    # the crew was told about the job and the candidates were ranked, so the viewer can see how the worker was chosen
    assert wt.results[5]["candidates"] and wt.results[5]["priority"].startswith("P")
    # roughly two hours of building time were simulated; every log line carries its time on the clock
    assert 100 <= wt.sim_minutes <= 200
    assert all("t" in line for line in wt.log)
    state = wt.state()
    assert state["auto"] is True and state["budget_s"] == 60 and state["sim_minutes"] == wt.sim_minutes


def test_run_survives_a_parts_shortage_by_ordering_and_receiving_stock(wt):
    """Stock left by earlier jobs can be gone: the job goes ON_HOLD, so the run orders, receives and resumes it."""
    api = wt.api()
    items = {i["sku"]: i for i in api.get("/api/inventory")["items"]}
    # no bearing set is free: the next job to be assigned is held awaiting parts
    api.ok("admin", "post", "/api/inventory/adjust", json={"sku": "BRG-001", "delta": -items["BRG-001"]["available"], "note": "test: stock gone"})
    assert api.get("/api/inventory")["items"][0]["sku"]  # inventory still readable
    wt.auto = True
    wt._play()
    assert wt.error is None and wt.stage == 7
    ordered = wt.results[5]["parts_ordered"]
    assert [o["sku"] for o in ordered] == ["BRG-001"] and ordered[0]["quantity"] >= 1
    assert wt.results[5]["status"] == "ASSIGNED"  # resumed by the delivery, never started while on hold
    assert wt.results[7]["outcome"] == "CLOSED"
    assert any(e["level"] == "PARTS" for e in wt.escalation)
    assert any("Delivery received" in line["text"] for line in wt.log)
    # the delivery really was booked in as stock, and no action was refused along the way
    moves = api.get("/api/inventory/movements?limit=60")["items"]
    assert any(m["sku"] == "BRG-001" and m["movement_type"] == "RECEIPT" for m in moves) or any(
        m["sku"] == "BRG-001" and m["quantity"] > 0 and m["note"] == "Purchase order delivered" for m in moves)
    assert api.ok("admin", "get", "/api/audit-logs?outcome=DENIED&limit=50")["total"] == 0


def test_only_one_simulation_runs_at_a_time(client, auth, monkeypatch):
    """A second start while one is playing is refused with a clear message, never silently ignored."""
    monkeypatch.setattr(wmod.walkthrough, "busy", True)
    r = client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": ASSET, "auto": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "run_in_progress"
    assert "one runs at a time" in r.json()["error"]["message"].lower() or "only one" in r.json()["error"]["message"].lower()


def test_an_automatic_start_is_never_refused_because_of_leftovers(client, auth, monkeypatch):
    """Leftovers of earlier runs (here: the machine is still wearing) are cleared by the new run, not a 409."""
    seen: list[list[str] | None] = []
    monkeypatch.setattr(wmod.walkthrough, "begin_auto", lambda asset_id, cleared=None: seen.append(cleared) or wmod.walkthrough.state())
    clean = client.get("/api/walkthrough/state").json()
    assert clean["leftovers"] == []
    assert client.post("/api/simulation/faults", headers=auth("operator"), json={"asset_id": ASSET, "fault_type": "bearing_wear"}).status_code == 200
    dirty = client.get("/api/walkthrough/state").json()
    assert dirty["leftovers"] and "wearing" in dirty["leftovers"][0]
    r = client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": ASSET, "auto": True})
    assert r.status_code == 200, r.text
    assert seen == [dirty["leftovers"]]


def test_a_run_started_on_a_dirty_building_clears_it_first_and_still_finishes(wt):
    """Reproduces the 409s: wear still active and a job still open on the machine from an earlier, abandoned run."""
    api = wt.api()
    api.ok("operator", "post", "/api/simulation/faults", json={"asset_id": ASSET, "fault_type": "bearing_wear"})
    for _ in range(60):
        api.ok("operator", "post", "/api/simulation/step", params={"minutes": 1})
        if api.get("/api/work-orders?active=true")["total"]:
            break
    assert api.get("/api/work-orders?active=true")["total"] == 1  # a job is open and stuck
    wt.auto = True
    wt.cleared = ["1 unfinished job", "1 machine still wearing"]
    wt._play()
    assert wt.error is None and wt.stage == 7 and wt.results[7]["outcome"] == "CLOSED"
    assert any("Clearing what earlier runs left behind" in line["text"] for line in wt.log)
    assert wt.preparing is False
    # the stale job is gone: this run's work order is the only one, and nothing is left open afterwards
    assert api.get("/api/work-orders")["total"] == 1
    assert api.get("/api/work-orders?active=true")["total"] == 0
    assert api.ok("admin", "get", "/api/audit-logs?outcome=DENIED&limit=50")["total"] == 0


def test_a_failed_run_does_not_leave_the_building_paused(wt, monkeypatch):
    def boom() -> dict:
        raise RuntimeError("something went wrong in the detector stage")

    monkeypatch.setattr(wt, "_s2", boom)
    wt.auto = True
    wt._reset_run(ASSET, auto=True)
    wt._spawn(wt._play)
    wt._thread.join(timeout=120)
    assert wt.error and "detector stage" in wt.error and not wt.busy
    assert wt.api().get("/api/simulation")["running"] is True  # the clock was set running again


def test_a_failed_independent_check_is_reworked_and_the_run_still_closes(wt):
    """A partial first repair fails the check for real; the run plays the rework and closes the job, never stops there."""
    api = wt.api()
    wt.auto = True
    wt._start()
    wt.started = True
    for n in range(1, 6):
        wt._exec(n)
    api.ok("operator", "post", "/api/simulation/repair-effectiveness", json={"effectiveness": 0.4})  # first repair is only 40 % effective
    wt._exec(6)
    wt._exec(7)
    r = wt.results[7]
    assert wt.error is None and wt.stage == 7
    assert r["outcome"] == "CLOSED" and r["reworks"] == 1 and r["failed_checks"]
    levels = [e["level"] for e in wt.escalation]
    assert "REWORK" in levels and levels.index("REWORK") < levels.index("CLEARED")
    wo = api.get("/api/work-orders?asset_id=%s" % ASSET)["items"][0]
    detail = api.get(f"/api/work-orders/{wo['id']}")
    actions = [e["action"] for e in detail["events"]]
    assert actions.count("complete") == 2 and "verify_fail" in actions and actions[-1] == "close"
    assert actions.index("verify_fail") < actions.index("restart") < max(i for i, a in enumerate(actions) if a == "verify_pass")
    assert detail["repair_count"] == 2
    assert wt.state()["budget_s"] == 60 + 16  # the clock says it ran one rework round longer
    assert api.ok("admin", "get", "/api/audit-logs?outcome=DENIED&limit=50")["total"] == 0


def test_rework_that_needs_missing_parts_orders_them_first(wt):
    """The rework consumes bearings again; if none are left the run orders them instead of failing with a 409."""
    api = wt.api()
    wt.auto = True
    wt._start()
    wt.started = True
    for n in range(1, 6):
        wt._exec(n)
    api.ok("operator", "post", "/api/simulation/repair-effectiveness", json={"effectiveness": 0.4})
    wt._exec(6)
    items = {i["sku"]: i for i in api.get("/api/inventory")["items"]}
    api.ok("admin", "post", "/api/inventory/adjust", json={"sku": "BRG-001", "delta": -items["BRG-001"]["available"], "note": "test: no bearings left"})
    wt._exec(7)
    assert wt.error is None and wt.results[7]["outcome"] == "CLOSED" and wt.results[7]["reworks"] == 1
    assert any(e["level"] == "PARTS" for e in wt.escalation)
    assert any("the rework can start" in line["text"] for line in wt.log)


@pytest.mark.parametrize("asset_id", ["AHU-01-FAN-01", "CHW-PUMP-02", "FCU-05-01"])
def test_machines_whose_check_used_to_fail_now_close(world, asset_id):
    """These three ended in REWORK_REQUIRED (current baseline capped at the vibration limit; one noisy sample)."""
    w = wmod.Walkthrough()
    w.pace = 0.0
    w.auto = True
    w.asset_id = asset_id
    w._play()
    assert w.error is None and w.results[7]["outcome"] == "CLOSED"


def test_run_without_a_shortage_orders_nothing(wt):
    wt.auto = True
    wt._play()
    assert wt.results[5]["parts_ordered"] == []
    assert not any(e["level"] == "PARTS" for e in wt.escalation)


def test_the_phase_follows_the_story_in_order(wt, monkeypatch):
    """The camera and the Process tab are driven by ``phase``: it must walk through the whole story, in order."""
    seen: list[str] = []
    orig = wt._say

    def say(text: str) -> None:
        if not seen or seen[-1] != wt.phase:
            seen.append(wt.phase)
        orig(text)

    monkeypatch.setattr(wt, "_say", say)
    wt.auto = True
    wt._play()
    assert wt.phase == "done" and wt.state()["phase"] == "done"
    story = ["wear", "readings", "prediction", "workorder", "approval", "approved", "dispatch", "walking", "working", "verifying", "closing", "done"]
    assert [p for p in seen if p in story] == story
    # Kishore takes time: two review lines before the approval
    texts = [line["text"] for line in wt.log]
    assert any("opens the request" in t for t in texts) and any("checks the machine's history" in t for t in texts)
    assert texts.index(next(t for t in texts if "opens the request" in t)) < texts.index(next(t for t in texts if "approved WO-" in t))


def test_the_walk_gets_its_own_share_of_the_repair_slot(wt):
    import time

    wt.auto, wt.pace = True, 1.0
    wt._t0 = time.monotonic()
    wt._enter(6, 40)
    wt._enter_part(5, wmod.WALK_SHARE)
    start, end = wt._slot_end(5), wt._slot_end(6)
    assert wt._deadline == pytest.approx(start + wmod.WALK_SHARE * (end - start))
    assert wt._left == 5
    wt._enter_part(29, None)
    assert wt._deadline is None and wt._left == 29


def test_kishore_gets_time_to_review():
    assert wmod.SLOTS[4] >= 6  # the approval is not a blink: the camera stays on Kishore while he reads


def test_slots_fill_exactly_one_minute_and_steps_sit_on_that_clock():
    assert sum(wmod.SLOTS.values()) == wmod.BUDGET_SECONDS == 60
    assert wmod.STEPS[0]["at"] == wmod.SLOTS[0]
    assert all(b["at"] == a["at"] + a["seconds"] for a, b in zip(wmod.STEPS, wmod.STEPS[1:]))
    assert wmod.STEPS[-1]["at"] + wmod.STEPS[-1]["seconds"] == 60


def test_pacing_splits_the_rest_of_the_slot_over_the_expected_calls(wt, monkeypatch):
    import time

    naps: list[float] = []
    monkeypatch.setattr(wt, "_nap", lambda s: naps.append(s))
    wt.auto, wt.pace = True, 1.0
    wt._t0 = time.monotonic()
    end1 = wmod.SLOTS[0] + wmod.SLOTS[1]
    # expecting 4 more calls after this one: the remaining time is shared by (calls_left + 1) = 4 naps
    wt._enter(1, 4)
    wt._tick("readings", 1)
    assert naps[-1] == pytest.approx(end1 / 4, abs=0.05)
    # a stage that runs past its estimate stops spreading its sleep: the last expected call takes what is left
    wt._enter(1, 1)
    wt._tick("readings", 1)
    assert naps[-1] == pytest.approx(end1, abs=0.05)
    # chunks of 4 minutes: 8 expected minutes = 2 calls; after this call 1 is left
    wt._enter(1, 8)
    wt._tick("readings", 4)
    assert naps[-1] == pytest.approx(end1 / 2, abs=0.05)


def test_start_over_cancels_a_run_that_is_waiting(wt):
    import time

    wt.pace = 1.0
    wt.auto = True
    wt._t0 = time.monotonic()
    wt._enter(0, 1)
    wt._cancel.set()
    with pytest.raises(wmod._Cancelled):
        wt._finish_slot()


def test_start_endpoint_chooses_the_automatic_or_the_stepwise_run(client, auth, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(wmod.walkthrough, "begin", lambda asset_id: calls.append("steps") or wmod.walkthrough.state())
    monkeypatch.setattr(wmod.walkthrough, "begin_auto", lambda asset_id, cleared=None: calls.append("auto") or wmod.walkthrough.state())
    assert client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": ASSET}).status_code == 200
    assert client.post("/api/walkthrough/start", headers=auth("operator"), json={"asset_id": ASSET, "auto": True}).status_code == 200
    assert calls == ["steps", "auto"]


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
