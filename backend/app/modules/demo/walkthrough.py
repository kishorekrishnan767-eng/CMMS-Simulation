"""Walkthrough — a one-click-per-step client demo of how one anomaly is found and fixed.

Like the guided demo director and the autopilot, the walkthrough is only an API client: it logs in as
the seeded users (operator, supervisor, technicians, verifier) and calls the same HTTP endpoints a
person would, so permissions, audit rows, events and the work-order state machine are all genuine.

Nothing runs by itself. The simulation clock is paused and each press of *Next* advances simulated
time just far enough for the next stage to happen (``/api/simulation/step``), so there are no
real-world waits; the small ``PACE`` sleeps only let the browser draw the fan degrading or the
technician walking.

    start   a bearing begins to wear on the chosen machine (hidden ground truth)       L1
    1       every sensor sends readings; copies of the same reading are dropped        L2 · L3
    2       the detector compares each sensor with normal and raises an early warning  L4
    3       the risk is scored and ONE work order is created (repeats attach evidence) L5
    4       the supervisor (Kishore) approves                                          L6
    5       the best-matching technician is dispatched with the right parts            L6
    6       the technician walks to the machine, repairs it and signs off              L6
    7       an independent verifier checks fresh readings; the supervisor closes       L7
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

from app.config import get_settings
from app.modules.cmms import procedures
from app.modules.demo.director import CLOSURE, Api

TECH_USER = {"TECH-01": "tech1", "TECH-02": "tech2", "TECH-03": "tech3"}

# seconds of real time per simulated minute: just enough for the 3D view to show the change
PACE = {"readings": 0.12, "detect": 0.07, "walk": 0.35, "work": 0.2, "verify": 0.1}

STEPS: list[dict[str, Any]] = [
    {"id": 1, "layers": "L2 · L3", "short": "Duplicate check", "title": "Readings arrive. Copies are dropped.",
     "text": "Every sensor sends a reading each minute. If the same reading arrives twice, only one copy is kept."},
    {"id": 2, "layers": "L4", "short": "Anomaly found", "title": "Vibration is higher than normal.",
     "text": "Each sensor is compared with what is normal for this machine at this load. An early warning is raised."},
    {"id": 3, "layers": "L5", "short": "Risk and work order", "title": "The risk is scored. One work order is made.",
     "text": "Repeat alerts for the same problem are added to the same work order. Never a duplicate."},
    {"id": 4, "layers": "L6", "short": "Kishore approves", "title": "Kishore approves the job.",
     "text": "Only a supervisor can approve. Walk Kishore to his desk on Floor 3 and press E."},
    {"id": 5, "layers": "L6", "short": "Dispatch", "title": "The right technician is sent.",
     "text": "Technicians are ranked by skill, distance and workload. The spare parts are reserved."},
    {"id": 6, "layers": "L6", "short": "Repair", "title": "The technician walks to the machine and repairs it.",
     "text": "Tools, lift, isolate, fix, then sign off with findings and the parts used."},
    {"id": 7, "layers": "L7", "short": "Verify and close", "title": "An independent check proves the fix.",
     "text": "Fresh readings are compared with normal. The technician cannot verify their own work. The supervisor closes the job."},
]


class Walkthrough:
    def __init__(self) -> None:
        self.asset_id: str | None = None
        self.started = False
        self.stage = 0
        self.busy = False
        self.error: str | None = None
        self.log: list[dict[str, Any]] = []
        self.results: dict[int, dict[str, Any]] = {}
        self.pace = get_settings().demo_pace  # >1 slows the pacing, 0 = as fast as possible
        self._thread: threading.Thread | None = None
        self._api: Api | None = None

    # ------------------------------------------------------------------ public
    def state(self) -> dict[str, Any]:
        return {"asset_id": self.asset_id, "started": self.started, "stage": self.stage, "total": len(STEPS),
                "busy": self.busy, "error": self.error, "steps": STEPS, "results": self.results,
                "log": self.log[-20:], "simulated": True}

    def begin(self, asset_id: str) -> dict[str, Any]:
        """Choose the machine, switch the autopilot off, pause the clock and start the wear (in the background)."""
        if self.busy:
            return self.state()
        self.asset_id, self.started, self.stage, self.error, self.results, self.log = asset_id, False, 0, None, {}, []
        return self._spawn(self._start)

    def next_step(self) -> dict[str, Any]:
        if self.busy or not self.started or self.stage >= len(STEPS):
            return self.state()
        return self._spawn(lambda: self._exec(self.stage + 1))

    def clear(self) -> dict[str, Any]:
        """Forget the walkthrough (the caller resets the simulated world itself)."""
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=60)
        self.asset_id, self.started, self.stage, self.busy, self.error, self.results, self.log = None, False, 0, False, None, {}, []
        self._api = None
        return self.state()

    # ------------------------------------------------------------------ internals
    def api(self) -> Api:
        if self._api is None:
            self._api = Api()
        return self._api

    def _spawn(self, fn: Callable[[], None]) -> dict[str, Any]:
        self.busy = True
        self.error = None

        def run() -> None:
            try:
                fn()
            except Exception as exc:  # noqa: BLE001 — surface any failure in the UI instead of dying silently
                self.error = f"{type(exc).__name__}: {exc}"
            finally:
                self.busy = False

        self._thread = threading.Thread(target=run, daemon=True, name="walkthrough")
        self._thread.start()
        return self.state()

    def _say(self, text: str) -> None:
        self.log.append({"stage": self.stage, "text": text})

    def _sleep(self, key: str, minutes: float = 1.0) -> None:
        if self.pace > 0:
            time.sleep(PACE[key] * self.pace * minutes)

    def _advance(self, minutes: int, pace: str) -> None:
        for _ in range(minutes):
            self.api().ok("operator", "post", "/api/simulation/step", params={"minutes": 1})
            self._sleep(pace)

    def _until(self, predicate: Callable[[], bool], max_minutes: int, pace: str) -> None:
        for _ in range(max_minutes):
            if predicate():
                return
            self._advance(1, pace)
        if not predicate():
            raise RuntimeError("the next stage was not reached in time")

    def _wos(self) -> list[dict[str, Any]]:
        return self.api().get(f"/api/work-orders?active=true&asset_id={self.asset_id}")["items"]

    def _wo(self) -> dict[str, Any]:
        wos = self._wos()
        if not wos:
            raise RuntimeError("no open work order for this machine")
        return self.api().get(f"/api/work-orders/{wos[0]['id']}")

    # ------------------------------------------------------------------ stages
    def _start(self) -> None:
        from app.modules.autopilot.operations import autopilot

        api = self.api()
        autopilot.configure(enabled=False)  # the crew only moves when you press Next
        api.ok("operator", "post", "/api/simulation/pause")
        api.ok("operator", "post", "/api/simulation/faults", json={"asset_id": self.asset_id, "fault_type": "bearing_wear"})
        self._say("A bearing starts to wear. The detector is not told.")
        self._advance(6, "readings")
        self.started = True

    def _exec(self, n: int) -> None:
        self.stage = n
        self._say(STEPS[n - 1]["title"])
        try:
            self.results[n] = (self._s1, self._s2, self._s3, self._s4, self._s5, self._s6, self._s7)[n - 1]()
        except Exception:
            self.stage = n - 1  # the click can be repeated
            raise

    def _s1(self) -> dict[str, Any]:
        api = self.api()
        asset = api.get(f"/api/assets/{self.asset_id}")
        for s in asset["sensors"]:
            api.ok("operator", "post", "/api/simulation/faults",
                   json={"asset_id": self.asset_id, "fault_type": "duplicate", "sensor_id": s["id"]})
        self._advance(3, "readings")
        dup = api.get(f"/api/telemetry/rejected?asset_id={self.asset_id}&reason=DUPLICATE&limit=100")["items"]
        per_sensor: dict[str, int] = {}
        for r in dup:
            per_sensor[r["sensor_id"]] = per_sensor.get(r["sensor_id"], 0) + 1
        self._say(f"{len(dup)} duplicate readings dropped, one copy kept")
        return {"duplicates": per_sensor}

    def _s2(self) -> dict[str, Any]:
        api = self.api()
        self._until(lambda: bool(api.get(f"/api/anomalies?state=ACTIVE&asset_id={self.asset_id}")["items"]), 240, "detect")
        a = api.get(f"/api/anomalies?state=ACTIVE&asset_id={self.asset_id}")["items"][0]
        self._say(a["explanation"])
        return {"anomaly_id": a["id"]}

    def _s3(self) -> dict[str, Any]:
        self._until(lambda: bool(self._wos()), 120, "detect")
        self._advance(10, "detect")  # later alerts arrive and are attached as evidence
        wos = self._wos()
        wo = self.api().get(f"/api/work-orders/{wos[0]['id']}")
        self._say(f"{wo['number']} created; {len(wos)} open work order for this machine")
        return {"work_order": wo["number"], "open_work_orders": len(wos), "evidence": len(wo["evidence"])}

    def _s4(self) -> dict[str, Any]:
        api = self.api()
        wid = self._wo()["id"]
        denied = api.call("operator", "post", f"/api/work-orders/{wid}/approve", json={"note": "Looks urgent"})
        ok = api.ok("supervisor", "post", f"/api/work-orders/{wid}/approve", json={"note": "Evidence reviewed — approved"})
        self._say(f"Operator approve refused (HTTP {denied.status_code}); supervisor approved → {ok['status']}")
        return {"operator_denied": denied.status_code, "status": ok["status"]}

    def _s5(self) -> dict[str, Any]:
        api = self.api()
        wo = self._wo()
        cands = api.get(f"/api/work-orders/{wo['id']}/dispatch-candidates")["candidates"]
        best = next((c for c in cands if c["eligible"]), None)
        if best is None:
            raise RuntimeError("no eligible technician right now")
        res = api.ok("supervisor", "post", f"/api/work-orders/{wo['id']}/assign", json={"technician_id": best["technician_id"]})
        self._say(f"{best['name']} dispatched (score {best['score']:.2f})")
        return {"technician": best["name"], "technician_id": best["technician_id"], "status": res["status"],
                "travel_minutes": best["travel_minutes"]}

    def _s6(self) -> dict[str, Any]:
        api = self.api()
        wo = self._wo()
        tid = wo["assigned_technician"]["id"]
        user = TECH_USER[tid]
        asset_type = api.get(f"/api/assets/{self.asset_id}")["asset_type"]
        self._until(lambda: next(t for t in api.get("/api/technicians") if t["id"] == tid)["status"] == "ON_SITE", 90, "walk")
        api.ok(user, "post", f"/api/work-orders/{wo['id']}/start", json={"note": "On site, starting work"})
        self._say("Technician on site, work started")
        self._advance(procedures.planned_minutes(asset_type, False), "work")
        parts = [{"sku": p["sku"], "quantity": p["planned"]} for p in api.get(f"/api/work-orders/{wo['id']}")["parts"] if p["planned"] > 0]
        done = api.ok(user, "post", f"/api/work-orders/{wo['id']}/complete", json={
            "findings": procedures.findings(asset_type, False),
            "checklist": {k: True for k, _, _ in procedures.steps(asset_type, False)}, "parts_used": parts})
        self._say("Repair done and signed off")
        return {"status": done["status"], "findings": procedures.findings(asset_type, False)}

    def _s7(self) -> dict[str, Any]:
        api = self.api()
        wo = self._wo()
        wid, user = wo["id"], TECH_USER[wo["assigned_technician"]["id"]]
        for _ in range(40):
            if api.get(f"/api/work-orders/{wid}/verification")["ready"]:
                break
            self._advance(5, "verify")
        own = api.call(user, "post", f"/api/work-orders/{wid}/verify", json={"outcome": "auto"})
        res = api.ok("verifier", "post", f"/api/work-orders/{wid}/verify", json={"outcome": "auto", "note": "Fresh readings back to normal"})
        out: dict[str, Any] = {"own_work_denied": own.status_code, "outcome": res["status"]}
        if res["status"] == "VERIFIED":
            closed = api.ok("supervisor", "post", f"/api/work-orders/{wid}/close", json={"checklist": CLOSURE, "note": "Closed after verification"})
            self._advance(2, "verify")
            api.ok("operator", "post", "/api/simulation/start")  # the demo is over: the building runs live again
            out["outcome"] = closed["status"]
            self._say("Verified by an independent check, work order closed")
        else:
            self._say("Verification failed — the work order goes back for rework")
        return out


walkthrough = Walkthrough()
