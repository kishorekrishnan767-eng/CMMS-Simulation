"""Guided Demo director — a scripted storyline that drives the REAL backend.

The director is nothing more than an API client: it logs in as the seeded demo users and calls the
same HTTP endpoints a person would (including actions that the backend DENIES on purpose). It never
touches the database or the services directly, so audit rows, events and permissions are genuine.

Each step runs in a background thread so the browser stays live over the WebSocket while simulated
time advances (paced so that technicians visibly walk and the fan visibly degrades).
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

from fastapi.testclient import TestClient

from app.config import get_settings

DEMO_PASSWORD = "demo1234"
ASSET = "AHU-02-FAN-01"
CLOSURE = {"work_verified": True, "area_safe_and_clean": True, "documentation_complete": True, "parts_reconciled": True}
REPAIR = {
    "findings": "Inner-race spalling found on the drive-end bearing; bearing set replaced and re-greased.",
    "photo_data": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>",
    "checklist": {"lockout_tagout": True, "bearing_replaced": True, "alignment_checked": True},
    "parts_used": [{"sku": "BRG-001", "quantity": 1}, {"sku": "GRS-001", "quantity": 1}],
}

STEPS: list[dict[str, Any]] = [
    {"id": 1, "layer": 1, "short": "The building", "title": "Every machine in the building is connected",
     "narration": "This is the Livewire Digital Solutions building. Fans and air handlers on the roof, chillers and pumps in the basement and an AC unit on every floor each report vibration, temperature, motor current and speed every minute. We will follow the roof supply fan AHU-02. All sensor data here is simulated.",
     "camera": {"view": "overview"}},
    {"id": 2, "layer": 3, "short": "Clean data", "title": "Bad sensor data is caught, never trusted",
     "narration": "Real sensors send duplicates, wrong units and readings from unknown devices. Each one is rejected and stored with the reason, so no decision is ever made on bad data.",
     "camera": {"view": "asset", "asset": ASSET}},
    {"id": 3, "layer": 4, "short": "Early warning", "title": "Early warning: the fan bearing starts to wear",
     "narration": "The fan's bearing begins to wear. Vibration creeps up long before any alarm would fire. The system compares it with what is normal for this fan at this load and raises an early warning, with the evidence and the time left before the alarm limit. That is prediction: the problem is found before it becomes a breakdown.",
     "camera": {"view": "asset", "asset": ASSET, "close": True}},
    {"id": 4, "layer": 5, "short": "Risk & work order", "title": "The risk is scored and one work order is raised",
     "narration": "How bad is it, how important is this fan, how fast is it getting worse? A risk score turns that into a priority and a single work order. New alerts about the same problem are added as evidence; no duplicates are created.",
     "camera": {"view": "asset", "asset": ASSET}},
    {"id": 5, "layer": 6, "short": "Approval", "title": "Kishore, the BMS supervisor, approves the job",
     "narration": "An operator tries to approve the work and is refused, because only a supervisor may approve. The refusal is recorded. Kishore reviews the evidence from the BMS control room on Floor 3 and approves it.",
     "camera": {"view": "bms"}},
    {"id": 6, "layer": 6, "short": "Dispatch", "title": "The right technician is sent, with the right parts",
     "narration": "Technicians are ranked by skills, distance, workload and track record. Someone without bearing skills cannot be assigned. The best match gets a dispatch message in the crew room, and the spare bearing is reserved from the store.",
     "camera": {"view": "crew"}},
    {"id": 7, "layer": 6, "short": "Repair", "title": "The technician walks to the fan and repairs it",
     "narration": "The technician collects the tools, takes the lift to the roof, isolates the fan and replaces the bearing step by step, then records what was found and the parts that were used.",
     "camera": {"view": "follow", "asset": ASSET}},
    {"id": 8, "layer": 7, "short": "Verification", "title": "An independent check proves the fix worked",
     "narration": "After the repair, thirty fresh readings are compared with the fan's normal behaviour. The technician cannot sign off their own work; an independent verifier does. Kishore closes the job and the warning clears.",
     "camera": {"view": "asset", "asset": ASSET}},
    {"id": 9, "layer": 7, "short": "Rework", "title": "If a repair is not good enough, it is caught",
     "narration": "The same fault comes back and this time the repair is only partly effective. The check fails, the job goes back to the technician, and a second repair fixes it for good, all within the same work order.",
     "camera": {"view": "asset", "asset": ASSET}},
    {"id": 10, "layer": 7, "short": "Results", "title": "Results: faster response, lower cost, no breakdown",
     "narration": "Time to respond, time to repair, cost, and how early the problem was seen are all measured from the stored data, so the building gets better at maintenance over time.",
     "camera": {"view": "overview"}},
]


class Director:
    def __init__(self) -> None:
        self.step = 0
        self.busy = False
        self.autoplay = False
        self.error: str | None = None
        self.log: list[dict[str, Any]] = []
        self.results: dict[int, dict[str, Any]] = {}
        self.pace = get_settings().demo_pace   # >1 slows pacing (more visible), 0 = as fast as possible
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._api: "Api | None" = None

    # ------------------------------------------------------------------ public
    def state(self) -> dict[str, Any]:
        return {"step": self.step, "total": len(STEPS), "busy": self.busy, "autoplay": self.autoplay, "error": self.error,
                "steps": STEPS, "current": STEPS[self.step - 1] if self.step else None,
                "results": self.results, "log": self.log[-60:]}

    def next_step(self) -> dict[str, Any]:
        if self.busy:
            return self.state()
        if self.step >= len(STEPS):
            return self.state()
        self.busy = True
        self.error = None
        self._thread = threading.Thread(target=self._run_next, daemon=True, name="demo-director")
        self._thread.start()
        return self.state()

    def start_autoplay(self, pause_s: float = 4.0) -> dict[str, Any]:
        if self.busy:
            return self.state()
        self.autoplay = True
        self._stop.clear()
        self.busy = True
        self._thread = threading.Thread(target=self._run_all, args=(pause_s,), daemon=True, name="demo-autoplay")
        self._thread.start()
        return self.state()

    def stop(self) -> None:
        self._stop.set()
        self.autoplay = False

    def reset(self) -> dict[str, Any]:
        self.stop()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=60)
        self.step, self.busy, self.error, self.log, self.results = 0, False, None, [], {}
        self._api = None
        api = self.api()
        api.call("admin", "post", "/api/simulation/reset", json={})
        api.call("admin", "post", "/api/simulation/pause")
        self._say("Demo reset to seed state (6 h healthy history backfilled)")
        return self.state()

    # ------------------------------------------------------------------ internals
    def api(self) -> "Api":
        if self._api is None:
            self._api = Api()
        return self._api

    def _say(self, text: str, **extra: Any) -> None:
        self.log.append({"step": self.step, "text": text, **extra})

    def _run_all(self, pause_s: float) -> None:
        try:
            while self.step < len(STEPS) and not self._stop.is_set():
                self._exec_next()
                if self._stop.wait(pause_s):
                    break
        except Exception as exc:  # noqa: BLE001
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.busy = False
            self.autoplay = False

    def _run_next(self) -> None:
        try:
            self._exec_next()
        except Exception as exc:  # noqa: BLE001
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.busy = False

    def _exec_next(self) -> None:
        n = self.step + 1
        self.step = n
        self._say(STEPS[n - 1]["title"], kind="title")
        self.results[n] = _STEP_FUNCS[n - 1](self)

    # ------------------------------------------------------------------ helpers used by steps
    def advance(self, minutes: int, per_minute_s: float = 0.0) -> None:
        for _ in range(minutes):
            if self._stop.is_set():
                return
            self.api().call("operator", "post", "/api/simulation/step", params={"minutes": 1})
            if per_minute_s * self.pace > 0:
                time.sleep(per_minute_s * self.pace)

    def until(self, predicate: Callable[[], bool], max_minutes: int, per_minute_s: float = 0.0) -> int:
        for i in range(max_minutes):
            if predicate():
                return i
            self.advance(1, per_minute_s)
        if not predicate():
            raise RuntimeError("condition not reached in time")
        return max_minutes


class Api:
    """Tiny in-process HTTP client: real requests, real JWTs, real permission checks."""

    def __init__(self) -> None:
        from app.main import app
        self.client = TestClient(app)
        self.tokens: dict[str, str] = {}

    def token(self, user: str) -> str:
        if user not in self.tokens:
            r = self.client.post("/api/auth/login", json={"username": user, "password": DEMO_PASSWORD})
            r.raise_for_status()
            self.tokens[user] = r.json()["access_token"]
        return self.tokens[user]

    def call(self, user: str, method: str, path: str, **kw: Any) -> Any:
        token = self.token(user)
        r = self.client.request(method.upper(), path, headers={"Authorization": f"Bearer {token}"}, **kw)
        if r.status_code == 401 and r.json().get("error", {}).get("code") in {"token_expired", "invalid_token"}:
            self.tokens.pop(user, None)
            r = self.client.request(
                method.upper(), path, headers={"Authorization": f"Bearer {self.token(user)}"}, **kw
            )
        return r

    def ok(self, user: str, method: str, path: str, **kw: Any) -> Any:
        r = self.call(user, method, path, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} as {user} -> {r.status_code}: {r.text}")
        return r.json()

    def get(self, path: str, **kw: Any) -> Any:
        r = self.client.get(path, **kw)
        r.raise_for_status()
        return r.json()


def _denied(r: Any) -> dict[str, Any]:
    body = r.json().get("error", {}) if r.headers.get("content-type", "").startswith("application/json") else {}
    return {"status_code": r.status_code, "code": body.get("code"), "message": body.get("message")}


# ---------------------------------------------------------------------------------- step bodies
def _s1(d: Director) -> dict[str, Any]:
    api = d.api()
    api.call("operator", "post", "/api/simulation/pause")
    tree = api.get("/api/buildings/TOWER-A/tree")
    assets = [a for f in tree["floors"] for a in f["assets"]]
    asset = api.get(f"/api/assets/{ASSET}")
    d._say(f"{len(assets)} assets registered in {tree['name']}; {ASSET} has {len(asset['sensors'])} sensors")
    return {"assets": len(assets), "sensors": len(asset["sensors"]), "asset": asset}


def _s2(d: Director) -> dict[str, Any]:
    api = d.api()
    before = api.get("/api/telemetry/stats")
    for ftype, sensor in (("duplicate", "VIB-001"), ("bad_unit", "TMP-001"), ("unknown_sensor", None)):
        api.ok("operator", "post", "/api/simulation/faults", json={"asset_id": ASSET, "fault_type": ftype, "sensor_id": sensor})
    d.advance(4, 0.25)
    after = api.get("/api/telemetry/stats")
    rej = api.get("/api/telemetry/rejected?limit=10")["items"]
    d._say("Layer 3 rejected: " + ", ".join(sorted({r["reason"] for r in rej})))
    return {"before": before, "after": after, "rejected": rej[:6]}


def _s3(d: Director) -> dict[str, Any]:
    api = d.api()
    api.ok("operator", "post", "/api/simulation/faults", json={"asset_id": ASSET, "fault_type": "bearing_wear"})
    d._say("Bearing wear injected (simulation ground truth)")
    d.until(lambda: any(a["state"] == "ACTIVE" for a in api.get("/api/anomalies")["items"]), 120, 0.2)
    a = api.get("/api/anomalies?state=ACTIVE")["items"][0]
    d._say(f"{a['incident_id']}: {a['explanation']}")
    return {"anomaly": api.get(f"/api/anomalies/{a['id']}")}


def _s4(d: Director) -> dict[str, Any]:
    api = d.api()
    d.until(lambda: api.get("/api/work-orders?active=true")["total"] >= 1, 60, 0.2)
    d.advance(12, 0.2)   # keep running so later alerts arrive and are attached as evidence
    wos = api.get("/api/work-orders?active=true")["items"]
    wo = api.get(f"/api/work-orders/{wos[0]['id']}")
    d._say(f"{wo['number']} is DRAFT — {len(wo['evidence'])} evidence entries, {len(wos)} active work order")
    return {"work_order": wo, "active_work_orders": len(wos), "risk": wo["risk_assessment"]}


def _wo_id(d: Director) -> int:
    return d.api().get("/api/work-orders?active=true")["items"][0]["id"]


def _s5(d: Director) -> dict[str, Any]:
    api = d.api()
    wid = _wo_id(d)
    denied = api.call("operator", "post", f"/api/work-orders/{wid}/approve", json={"note": "Looks urgent"})
    d._say(f"Operator approve → HTTP {denied.status_code} ({_denied(denied)['code']})")
    ok = api.ok("supervisor", "post", f"/api/work-orders/{wid}/approve", json={"note": "Approved for inspection and repair"})
    d._say(f"Supervisor approve → {ok['status']}")
    audit = api.ok("admin", "get", "/api/audit-logs?outcome=DENIED&limit=5")
    return {"denied": _denied(denied), "approved": ok["status"], "audit_denied": audit["items"][:3]}


def _s6(d: Director) -> dict[str, Any]:
    api = d.api()
    wid = _wo_id(d)
    cands = api.get(f"/api/work-orders/{wid}/dispatch-candidates")["candidates"]
    ineligible = next((c for c in cands if not c["eligible"]), None)
    rejected = None
    if ineligible:
        r = api.call("supervisor", "post", f"/api/work-orders/{wid}/assign", json={"technician_id": ineligible["technician_id"]})
        rejected = _denied(r)
        d._say(f"Assign {ineligible['name']} → HTTP {r.status_code}: {'; '.join(ineligible['ineligible_reasons'])}")
    best = next(c for c in cands if c["eligible"])
    wo = api.ok("supervisor", "post", f"/api/work-orders/{wid}/assign", json={"technician_id": best["technician_id"]})
    d._say(f"Assigned {best['name']} (score {best['score']:.2f}); status {wo['status']}")
    return {"candidates": cands, "rejected_assignment": rejected, "work_order": wo}


def _s7(d: Director) -> dict[str, Any]:
    api = d.api()
    wid = _wo_id(d)
    wo = api.get(f"/api/work-orders/{wid}")
    tech_user = {"TECH-01": "tech1", "TECH-02": "tech2", "TECH-03": "tech3"}[wo["assigned_technician"]["id"]]
    tid = wo["assigned_technician"]["id"]
    d.until(lambda: next(t for t in api.get("/api/technicians") if t["id"] == tid)["status"] == "ON_SITE", 60, 0.45)
    api.ok(tech_user, "post", f"/api/work-orders/{wid}/start")
    d._say("Technician on site, work started")
    d.advance(10, 0.35)
    done = api.ok(tech_user, "post", f"/api/work-orders/{wid}/complete", json=REPAIR)
    d._say(f"Work completed; parts consumed: {', '.join(p['sku'] for p in done['inspections'][-1]['parts_used'])}")
    return {"work_order": done, "inventory": api.get("/api/inventory")["items"]}


def _verify_flow(d: Director, wid: int, tech_user: str, expect_pass: bool, note: str) -> dict[str, Any]:
    api = d.api()
    for _ in range(40):
        v = api.get(f"/api/work-orders/{wid}/verification")
        if v["ready"]:
            break
        d.advance(5, 0.12)
    sod = api.call(tech_user, "post", f"/api/work-orders/{wid}/verify", json={"outcome": "auto"})
    d._say(f"Technician tries to verify own work → HTTP {sod.status_code} ({_denied(sod)['code']})")
    res = api.ok("verifier", "post", f"/api/work-orders/{wid}/verify", json={"outcome": "auto", "note": note})
    d._say(f"Verifier outcome → {res['status']}")
    return {"verification": api.get(f"/api/work-orders/{wid}/verification"), "separation_of_duties": _denied(sod),
            "work_order": res}


def _s8(d: Director) -> dict[str, Any]:
    api = d.api()
    wid = _wo_id(d)
    wo = api.get(f"/api/work-orders/{wid}")
    tech_user = {"TECH-01": "tech1", "TECH-02": "tech2", "TECH-03": "tech3"}[wo["assigned_technician"]["id"]]
    out = _verify_flow(d, wid, tech_user, True, "Vibration back at baseline")
    closed = api.ok("supervisor", "post", f"/api/work-orders/{wid}/close", json={"checklist": CLOSURE, "note": "Closed after verification"})
    d.advance(2, 0.1)
    d._say(f"{closed['number']} {closed['status']}; asset health {api.get('/api/assets/' + ASSET)['health_state']}")
    out["closed"] = closed["status"]
    out["asset"] = api.get(f"/api/assets/{ASSET}")["health_state"]
    return out


def _s9(d: Director) -> dict[str, Any]:
    api = d.api()
    api.ok("operator", "post", "/api/simulation/repair-effectiveness", json={"effectiveness": 0.4})
    api.ok("operator", "post", "/api/simulation/faults", json={"asset_id": ASSET, "fault_type": "bearing_wear"})
    d._say("Second incident: bearing wear again; the next repair will only be 40% effective")
    d.until(lambda: api.get("/api/work-orders?active=true")["total"] >= 1, 150, 0.1)
    wid = _wo_id(d)
    api.ok("supervisor", "post", f"/api/work-orders/{wid}/approve", json={"note": "Approved"})
    cands = api.get(f"/api/work-orders/{wid}/dispatch-candidates")["candidates"]
    best = next(c for c in cands if c["eligible"])
    wo = api.ok("supervisor", "post", f"/api/work-orders/{wid}/assign", json={"technician_id": best["technician_id"]})
    tid = wo["assigned_technician"]["id"]
    tech_user = {"TECH-01": "tech1", "TECH-02": "tech2", "TECH-03": "tech3"}[tid]
    d.until(lambda: next(t for t in api.get("/api/technicians") if t["id"] == tid)["status"] == "ON_SITE", 60, 0.35)
    api.ok(tech_user, "post", f"/api/work-orders/{wid}/start")
    d.advance(8, 0.3)
    api.ok(tech_user, "post", f"/api/work-orders/{wid}/complete", json=REPAIR)
    first = _verify_flow(d, wid, tech_user, False, "Residual vibration still elevated")
    d._say(f"First repair verification → {first['work_order']['status']} (failing: {', '.join(first['verification'].get('failed_criteria', []))})")
    api.ok(tech_user, "post", f"/api/work-orders/{wid}/restart")
    d.until(lambda: next(t for t in api.get("/api/technicians") if t["id"] == tid)["status"] == "ON_SITE", 60, 0.35)
    d.advance(8, 0.3)
    api.ok(tech_user, "post", f"/api/work-orders/{wid}/complete", json={**REPAIR, "findings": "Rework: second bearing set fitted, shaft re-aligned."})
    second = _verify_flow(d, wid, tech_user, True, "Second repair verified")
    closed = api.ok("supervisor", "post", f"/api/work-orders/{wid}/close", json={"checklist": CLOSURE})
    d._say(f"Second verification → {second['work_order']['status']}; work order {closed['status']}")
    return {"first_verification": first["verification"], "first_outcome": first["work_order"]["status"],
            "second_outcome": second["work_order"]["status"], "final": closed["status"],
            "verifications": closed["verifications"]}


def _s10(d: Director) -> dict[str, Any]:
    api = d.api()
    res = {"detector": api.get("/api/analytics/detector"), "maintenance": api.get("/api/analytics/maintenance")}
    d._say(f"MTTA {res['maintenance']['mtta_min']} min · MTTR {res['maintenance']['mttr_min']} min · "
           f"cost ${res['maintenance']['total_cost']}")
    return res


_STEP_FUNCS = [_s1, _s2, _s3, _s4, _s5, _s6, _s7, _s8, _s9, _s10]
director = Director()
