"""Operations autopilot — makes the simulated building run itself, end to end.

Like the guided-demo director, the autopilot is only an API client: it logs in as the seeded users
(operator, supervisor, technicians, verifier) and calls the same HTTP endpoints a person would, so
permissions, audit rows, events and the work-order state machine are all genuine. It never touches
the database. Switch it off and every step can be done by hand from the UI instead.

Two things happen while the simulation clock runs:

1. Random equipment wear (the "world"). Bearing-wear faults arrive as a Poisson process in SIM time:
       gap ~ Exponential(mean = MEAN_GAP_H[rate])  (hours, floored at MIN_GAP_MIN minutes)
       asset ~ Uniform(assets without an active fault or active work order)
       amplitude A ~ U(6.0, 8.5) mm/s,  duration T ~ PROFILE_T · U(0.9, 1.8)
   The schedule is drawn from ``numpy.random.default_rng((seed, run_id, 7))`` so a run is reproducible.
   The detector is never told — it has to find the wear in the telemetry.

2. The maintenance crew (the "people"). Each active work order advances once its delay has elapsed
   in sim time; delays are drawn per work order from ``default_rng((seed, run_id, wo_id))``:
       DRAFT            supervisor reviews and approves      after REVIEW_MIN[priority] + U(0, 3) min
       OPEN             supervisor dispatches the top ranked eligible technician   + U(1, 3) min
       ON_HOLD (parts)  supervisor raises a purchase order; stock arrives after U(30, 60) min
       ASSIGNED         technician on site → toolbox talk → start                  arrives_at + 1 min
       IN_PROGRESS      technician follows the procedure, signs off after Σ step minutes
       COMPLETED        verifier runs the Layer 7 check once the window is full
       REWORK_REQUIRED  technician returns to the asset                            + 3 min
       VERIFIED         supervisor closes with the checklist                       + U(2, 5) min
   With probability P_PARTIAL a first repair is only 40 % effective, so verification fails and the
   rework loop runs — exactly as it would if a person set that on the Control page.

3. Expedited repair (the per-asset "Repair" button). ``expedite(asset_id)`` asks the crew to work that
   asset's work order even while the autopilot is off (no random faults are injected then). The
   management waits (review, dispatch, closure delay) are skipped; travel, the repair procedure and the
   Layer 7 verification window still take their normal sim time, and every step still goes through the
   public API, so permissions, audit rows and the work-order state machine stay genuine. An asset leaves
   the expedite set once it has neither an active wear fault nor an active work order.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta
from typing import Any

import numpy as np

from app.modules.cmms import procedures
from app.modules.demo.director import Api, director
from app.modules.simulation.engine import PROFILE_DURATION_H

MEAN_GAP_H: dict[str, float | None] = {"off": None, "low": 8.0, "normal": 4.0, "high": 1.5}
MIN_GAP_MIN = 20
MAX_CONCURRENT = 2
REVIEW_MIN = {"P1": 2, "P2": 4, "P3": 8, "P4": 12}
P_PARTIAL = 0.15
CLOSURE = {"work_verified": True, "area_safe_and_clean": True, "documentation_complete": True, "parts_reconciled": True}
POLL_SECONDS = 0.4


def _t(iso: str | None) -> datetime | None:
    return datetime.fromisoformat(iso.rstrip("Z")) if iso else None


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds") + "Z"


class Autopilot:
    def __init__(self, enabled: bool = False) -> None:
        self.enabled = enabled
        self.fault_rate = "normal"
        self.log: list[dict[str, Any]] = []
        self.error: str | None = None
        self.status = "idle"
        self._api: Api | None = None
        self._run_key: tuple[int, int] | None = None
        self._rng: np.random.Generator | None = None
        self._next_fault: datetime | None = None
        self._plans: dict[int, dict[str, float]] = {}
        self._waiting: dict[int, str] = {}
        self._orders: dict[str, datetime] = {}
        self._expedite: set[str] = set()
        self._tech_users: dict[str, tuple[str, str]] = {}
        self._names: dict[str, str] = {}
        self._now: datetime | None = None
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    # ------------------------------------------------------------------ public
    def state(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "fault_rate": self.fault_rate, "fault_rates": list(MEAN_GAP_H),
                "status": self.status, "error": self.error, "expedited": sorted(self._expedite),
                "next_fault_at": _iso(self._next_fault) if self._next_fault and self.enabled else None,
                "log": self.log[-80:], "simulated": True}

    def configure(self, enabled: bool | None = None, fault_rate: str | None = None) -> dict[str, Any]:
        with self._lock:
            if fault_rate is not None:
                if fault_rate not in MEAN_GAP_H:
                    raise ValueError(f"fault_rate must be one of {', '.join(MEAN_GAP_H)}")
                if fault_rate != self.fault_rate:
                    self.fault_rate = fault_rate
                    self._next_fault = None  # redraw the schedule at the new rate
            if enabled is not None and enabled != self.enabled:
                self.enabled = enabled
                self._next_fault = None
                self._say(None, "Operations", "SYSTEM", "Autopilot switched " + ("on" if enabled else "off"), "info")
        return self.state()

    def expedite(self, asset_id: str) -> dict[str, Any]:
        """Ask the crew to repair ``asset_id`` now, whether or not the autopilot is switched on."""
        with self._lock:
            if asset_id not in self._expedite:
                self._expedite.add(asset_id)
                self._say({"number": None, "asset_id": asset_id}, "Operations", "SYSTEM",
                          f"Repair of {asset_id} requested — the crew is fast-tracking it", "info")
        return self.state()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="autopilot", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def tick(self, require_running: bool = True) -> None:
        """One evaluation pass: maybe inject wear, then advance every active work order."""
        with self._lock:
            api = self.api()
            sim = api.get("/api/simulation")
            if not self.enabled and not self._expedite:
                self.status = "off"
                return
            if director.busy or director.autoplay:
                self.status = "paused — guided demo running"
                return
            if require_running and not sim["running"]:
                self.status = "waiting — simulation paused"
                return
            self.status = "running"
            now = _t(sim["sim_now"])
            assert now is not None
            self._now = now
            key = (int(sim["seed"]), int(sim["run_id"]))
            if key != self._run_key:  # first tick, or the world was reset to seed
                if self._run_key is not None:
                    self.log.clear()  # a reset wipes the activity history too
                self._run_key = key
                self._rng = np.random.default_rng((key[0], key[1], 7))
                self._next_fault, self._plans, self._waiting, self._orders = None, {}, {}, {}
            wos = api.get("/api/work-orders?active=true")["items"]
            self._receive_due_orders(now)
            self._expedite &= {w["asset_id"] for w in wos} | {
                f["asset_id"] for f in sim["active_faults"] if f["fault_type"] == "BEARING_WEAR"}
            if self.enabled:
                self._maybe_inject(now, sim, wos)
            else:  # crew-only mode: just the work the user asked for
                wos = [w for w in wos if w["asset_id"] in self._expedite]
            techs = {t["id"]: t for t in api.get("/api/technicians")}
            for wo in sorted(wos, key=lambda w: w["id"]):
                try:
                    self._advance(wo, now, techs)
                except _Denied as e:  # a person acted first, or a guard refused: log it and move on
                    self._wait(wo, f"{e}")

    # ------------------------------------------------------------------ internals
    def api(self) -> Api:
        if self._api is None:
            self._api = Api()
            for u in self._api.get("/api/auth/demo-users"):
                self._names[u["username"]] = u["display_name"]
                if u["technician_id"]:
                    self._tech_users[u["technician_id"]] = (u["username"], u["display_name"])
        return self._api

    def _loop(self) -> None:
        while not self._stop.wait(POLL_SECONDS):
            if not self.enabled and not self._expedite:
                self.status = "off"
                continue
            try:
                self.tick()
                self.error = None
            except Exception as exc:  # noqa: BLE001 — keep the crew alive across transient errors
                self.error = f"{type(exc).__name__}: {exc}"
                time.sleep(2)

    def _say(self, wo: dict[str, Any] | None, actor: str, role: str, text: str, kind: str = "action",
             at: datetime | None = None) -> None:
        self.log.append({"t": _iso(at) if at else None, "wo": wo["number"] if wo else None,
                         "asset_id": wo["asset_id"] if wo else None, "actor": actor, "role": role, "text": text,
                         "kind": kind})
        del self.log[:-300]
        if wo and "id" in wo:
            self._waiting.pop(wo["id"], None)

    def _wait(self, wo: dict[str, Any], reason: str) -> None:
        if self._waiting.get(wo["id"]) != reason:
            self._waiting[wo["id"]] = reason
            self._say(wo, "Operations", "SYSTEM", reason, "wait", self._now)

    def _plan(self, wo_id: int) -> dict[str, float]:
        if wo_id not in self._plans:
            assert self._run_key is not None
            r = np.random.default_rng((self._run_key[0], self._run_key[1], wo_id))
            self._plans[wo_id] = {"review": float(r.uniform(0, 3)), "dispatch": float(r.uniform(1, 3)),
                                  "close": float(r.uniform(2, 5)), "partial": float(r.random() < P_PARTIAL)}
        return self._plans[wo_id]

    def _post(self, user: str, path: str, body: dict[str, Any] | None = None) -> Any:
        r = self.api().call(user, "post", path, json=body or {})
        if r.status_code >= 400:
            err = r.json().get("error", {}) if "json" in r.headers.get("content-type", "") else {}
            raise _Denied(err.get("message") or f"HTTP {r.status_code}", err.get("code"), err.get("details") or {})
        return r.json()

    # -- the world ----------------------------------------------------------------
    def _maybe_inject(self, now: datetime, sim: dict[str, Any], wos: list[dict[str, Any]]) -> None:
        mean_h = MEAN_GAP_H[self.fault_rate]
        if mean_h is None or self._rng is None:
            self._next_fault = None
            return
        if self._next_fault is None:
            first = self._rng.uniform(0.15, 0.5) * mean_h
            self._next_fault = now + timedelta(hours=float(first))
            return
        if now < self._next_fault:
            return
        gap = max(MIN_GAP_MIN / 60.0, float(self._rng.exponential(mean_h)))
        self._next_fault = now + timedelta(hours=gap)
        wear = [f for f in sim["active_faults"] if f["fault_type"] == "BEARING_WEAR"]
        if len(wear) + len(wos) >= MAX_CONCURRENT * 2 or len(wear) >= MAX_CONCURRENT:
            return
        busy = {f["asset_id"] for f in wear} | {w["asset_id"] for w in wos}
        assets = sorted(a["id"] for a in self.api().get("/api/assets") if a["id"] not in busy)
        if not assets:
            return
        asset = assets[int(self._rng.integers(len(assets)))]
        amplitude = round(float(self._rng.uniform(6.0, 8.5)), 2)
        duration = round(PROFILE_DURATION_H.get(sim["profile"], 1.5) * float(self._rng.uniform(0.9, 1.8)), 2)
        self._post("operator", "/api/simulation/faults",
                   {"asset_id": asset, "fault_type": "bearing_wear", "params": {"amplitude": amplitude, "duration_h": duration}})
        self._say({"number": None, "asset_id": asset}, "Simulation", "WORLD",
                  f"Bearing wear begins on {asset} (hidden ground truth: A={amplitude} mm/s over {duration} h). "
                  "The detector is not told.", "fault", now)

    # -- the crew -----------------------------------------------------------------
    def _advance(self, wo: dict[str, Any], now: datetime, techs: dict[str, dict[str, Any]]) -> None:
        plan = self._plan(wo["id"])
        wid, status = wo["id"], wo["status"]
        fast = wo["asset_id"] in self._expedite
        if wo.get("proposed_priority"):
            self._post("supervisor", f"/api/work-orders/{wid}/acknowledge-escalation",
                       {"accept": True, "note": "Escalation accepted after reviewing the new evidence"})
            self._say(wo, self._names.get("supervisor", "Supervisor"), "SUPERVISOR", f"Accepted escalation to {wo['proposed_priority']}", at=now)
            return

        if status == "DRAFT":
            due = _t(wo["created_at"]) + timedelta(minutes=0 if fast else REVIEW_MIN.get(wo["priority"], 6) + plan["review"])
            if now < due:
                return self._wait(wo, f"Supervisor reviewing the evidence (decision due {_iso(due)[11:16]})")
            self._post("supervisor", f"/api/work-orders/{wid}/approve",
                       {"note": "Evidence reviewed — approved for inspection and repair"})
            self._say(wo, self._names.get("supervisor", "Supervisor"), "SUPERVISOR", f"Approved {wo['number']} ({wo['priority']})", at=now)

        elif status == "OPEN":
            due = _t(wo["approved_at"] or wo["updated_at"]) + timedelta(minutes=0 if fast else plan["dispatch"])
            if now < due:
                return self._wait(wo, "Supervisor checking crew availability")
            cands = self.api().get(f"/api/work-orders/{wid}/dispatch-candidates")["candidates"]
            eligible = [c for c in cands if c["eligible"]]
            if not eligible:
                reasons = "; ".join(f"{c['name'].split()[0]}: {', '.join(c['ineligible_reasons'])}" for c in cands)
                return self._wait(wo, f"No eligible technician yet — {reasons}")
            # prefer someone already back in the crew room over someone still walking back
            best = next((c for c in eligible if techs.get(c["technician_id"], {}).get("status") == "AVAILABLE"), eligible[0])
            res = self._post("supervisor", f"/api/work-orders/{wid}/assign", {"technician_id": best["technician_id"]})
            parts = ", ".join(f"{p['sku']}×{p['planned']}" for p in res.get("parts", [])) or "none"
            self._say(wo, self._names.get("supervisor", "Supervisor"), "SUPERVISOR",
                      f"Dispatched {best['name']} (score {best['score']:.2f}, ETA {best['travel_minutes']} min). "
                      f"Parts reserved: {parts}", at=now)

        elif status == "ON_HOLD":
            if wo.get("hold_reason") == "AWAITING_PARTS":
                detail = self.api().get(f"/api/work-orders/{wid}")
                self._order([p["sku"] for p in detail["parts"] if p["reserved"] < p["planned"]], now, wo)

        elif status == "ASSIGNED":
            tech = techs.get(wo["assigned_technician"]["id"]) if wo["assigned_technician"] else None
            arrives = _t(wo["arrives_at"])
            if tech is None or arrives is None:
                return
            if now < arrives:
                return self._wait(wo, f"{tech['name']} travelling to {wo['asset_id']} (ETA {_iso(arrives)[11:16]})")
            if now < arrives + timedelta(minutes=1):
                return self._wait(wo, f"{tech['name']} on site — toolbox talk and risk assessment")
            user, name = self._tech_users[tech["id"]]
            self._post(user, f"/api/work-orders/{wid}/start", {"note": "On site, permit issued, starting work"})
            self._say(wo, name, "TECHNICIAN", f"Started work on {wo['asset_id']}", at=now)

        elif status == "IN_PROGRESS":
            tech_id = wo["assigned_technician"]["id"]
            user, name = self._tech_users[tech_id]
            rework = wo["repair_count"] >= 1
            arrives = _t(wo["arrives_at"])
            began = max(t for t in (_t(wo["started_at"]), arrives) if t is not None)
            if arrives and now < arrives:
                return self._wait(wo, f"{name} returning to {wo['asset_id']} for rework")
            asset_type = self._asset_type(wo["asset_id"])
            done_at = began + timedelta(minutes=procedures.planned_minutes(asset_type, rework))
            if now < done_at:
                return self._wait(wo, f"{name} working through the {'rework' if rework else 'repair'} procedure")
            if not rework and plan["partial"]:
                self._post("operator", "/api/simulation/repair-effectiveness", {"effectiveness": 0.4})
                self._say(wo, "Simulation", "WORLD", "Hidden ground truth: this repair will only be 40 % effective "
                          "(e.g. a misalignment was missed). Verification should catch it.", "fault", now)
            detail = self.api().get(f"/api/work-orders/{wid}")
            parts = [{"sku": p["sku"], "quantity": p["planned"]} for p in detail["parts"] if p["planned"] > 0]
            try:
                self._post(user, f"/api/work-orders/{wid}/complete", {
                    "findings": procedures.findings(asset_type, rework),
                    "checklist": {k: True for k, _, _ in procedures.steps(asset_type, rework)},
                    "parts_used": parts, "note": "Job complete, area left safe and clean"})
            except _Denied as e:
                if e.code == "insufficient_stock":
                    return self._order([p["sku"] for p in parts], now, wo)
                raise
            self._say(wo, name, "TECHNICIAN", f"Completed {'rework' if rework else 'repair'} — "
                      f"{procedures.findings(asset_type, rework)}", at=now)

        elif status == "COMPLETED":
            v = self.api().get(f"/api/work-orders/{wid}/verification")
            if not v["ready"]:
                return self._wait(wo, f"Verifier waiting for the post-repair window ({v['samples']}/{v['samples_required']} samples)")
            res = self._post("verifier", f"/api/work-orders/{wid}/verify", {"outcome": "auto", "note": "Layer 7 criteria evaluated"})
            outcome = "passed" if res["status"] == "VERIFIED" else "FAILED — rework required"
            self._say(wo, self._names.get("verifier", "Verifier"), "VERIFIER", f"Verification {outcome}", "action" if res["status"] == "VERIFIED" else "warn", now)

        elif status == "REWORK_REQUIRED":
            due = _t(wo["updated_at"]) + timedelta(minutes=3)
            if now < due:
                return self._wait(wo, "Technician notified: verification failed, rework needed")
            user, name = self._tech_users[wo["assigned_technician"]["id"]]
            try:
                self._post(user, f"/api/work-orders/{wid}/restart", {"note": "Returning for rework"})
            except _Denied as e:
                if e.code == "insufficient_stock":
                    return self._order([s["sku"] for s in e.details.get("shortages", [])], now, wo)
                raise
            self._say(wo, name, "TECHNICIAN", f"Heading back to {wo['asset_id']} for rework", at=now)

        elif status == "VERIFIED":
            due = _t(wo["verified_at"] or wo["updated_at"]) + timedelta(minutes=0 if fast else plan["close"])
            if now < due:
                return self._wait(wo, "Supervisor reviewing documentation before closure")
            self._post("supervisor", f"/api/work-orders/{wid}/close", {"checklist": CLOSURE, "note": "Closed after verification"})
            self._say(wo, self._names.get("supervisor", "Supervisor"), "SUPERVISOR", f"Closed {wo['number']}", at=now)

    def _asset_type(self, asset_id: str) -> str:
        return str(self.api().get(f"/api/assets/{asset_id}")["asset_type"])

    def _order(self, skus: list[str], now: datetime, wo: dict[str, Any]) -> None:
        new = [s for s in skus if s not in self._orders]
        for sku in new:
            assert self._rng is not None
            self._orders[sku] = now + timedelta(minutes=float(self._rng.uniform(30, 60)))
        if new:
            eta = max(self._orders[s] for s in new)
            self._say(wo, self._names.get("supervisor", "Supervisor"), "SUPERVISOR",
                      f"Purchase order raised for {', '.join(new)} — delivery expected {_iso(eta)[11:16]}", "warn", now)
        else:
            self._wait(wo, "Waiting for parts delivery")

    def _receive_due_orders(self, now: datetime) -> None:
        due = [s for s, t in self._orders.items() if now >= t]
        if not due:
            return
        items = {i["sku"]: i for i in self.api().get("/api/inventory")["items"]}
        for sku in due:
            qty = int(items.get(sku, {}).get("reorder_quantity", 4))
            self._post("supervisor", "/api/inventory/receive", {"sku": sku, "quantity": qty, "note": "Purchase order delivered"})
            del self._orders[sku]
            self._say(None, "Stores", "SUPERVISOR", f"Delivery received: {sku} ×{qty} (waiting jobs resume)", "info", now)


class _Denied(Exception):
    def __init__(self, message: str, code: str | None, details: dict[str, Any]) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


autopilot = Autopilot()
