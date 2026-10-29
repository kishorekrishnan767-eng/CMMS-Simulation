"""Walkthrough — a client demo of how one anomaly is found and fixed, in two and a half minutes.

Like the guided demo director and the autopilot, the walkthrough is only an API client: it acts as the
simulated people (Kishore the supervisor, the technicians, the independent check) and calls the same HTTP
endpoints they would, so audit rows, events and the work-order state machine are all genuine. It never
stages a refused action: each request is made by the person whose job it is, and approved automatically.

Besides the stages it records what a client needs to see the difference an anomaly makes:
``normal`` (every sensor's value before the wear began) and ``escalation`` (the ladder the problem climbs:
normal → watch → early warning → severity rises → work order priority → escalated to the supervisor →
approved → back to normal), each entry stamped with its second on the 150-second clock.

Two ways to run it:

* **automatic** (``begin_auto``): one click on *Inject anomaly* plays every stage by itself and the whole
  story, from the first worn bearing to the closed work order, takes ``BUDGET_SECONDS`` (two and a half minutes) of
  real time. Roughly two simulated hours are compressed into that minute.
* **step by step** (``begin`` + ``next_step``): the simulation clock is paused and each press of *Next*
  advances simulated time just far enough for the next stage to happen.

    start   a bearing begins to wear on the chosen machine (hidden ground truth)       L1
    1       every sensor sends readings; copies of the same reading are dropped        L2 · L3
    2       the detector compares each sensor with normal and raises an early warning  L4
    3       the risk is scored and ONE work order is created (repeats attach evidence) L5
    4       the request goes to Kishore, the best technician waits; Kishore approves    L6
    5       the best-matching technician is dispatched with the right parts            L6
    6       the technician walks to the machine, repairs it and signs off              L6
    7       an independent check of fresh readings passes; Kishore closes the job      L7

Pacing of an automatic run (wall-clock schedule). Stage k owns the slot ``SLOTS[k]`` seconds and must end
at ``end_k = t0 + pace · Σ_{j ≤ k} SLOTS[j]`` (``pace`` = ``demo_pace``, 1.0 → 150 s, 0 → no sleeping). The
stage expects to need ``m`` simulated minutes (``_enter``). After each simulated minute (or chunk of
``c`` minutes) the run sleeps

    nap = max(0, end_k − now) / (calls_left + 1),   calls_left = ceil(max(0, m_left − c) / c)

so a stage that needs exactly ``m`` minutes ends on time; one that needs fewer is padded to ``end_k`` and
one that needs more stops sleeping (the later slots absorb the delay, because their ends are absolute).
Only ``time.monotonic()`` is used, for pacing and for the elapsed clock shown to the viewer; every
timestamp in the domain still comes from the simulation clock.
"""
from __future__ import annotations

import math
import threading
import time
from datetime import datetime
from typing import Any, Callable

from app.config import get_settings
from app.modules.cmms import procedures
from app.modules.demo.director import CLOSURE, Api

TECH_USER = {"TECH-01": "tech1", "TECH-02": "tech2", "TECH-03": "tech3"}

# seconds of real time per simulated minute in step-by-step mode: just enough to see the change in 3D
PACE = {"readings": 0.12, "detect": 0.07, "walk": 0.35, "work": 0.2, "verify": 0.1}

BUDGET_SECONDS = 150.0
# simulated minutes a purchase order takes to arrive when a job's spare parts are short (the autopilot waits 30–60)
DELIVERY_MINUTES = 3
# A failed independent check is a real outcome (a repair can be partial, or noise can trip the "max z < 3.0 over
# 30 samples" rule in ~4 % of healthy repairs): the job goes back for rework. Each rework round adds this many
# seconds to the clock, and at most MAX_REWORK rounds are played before the run reports an error.
REWORK_SECONDS = 40.0
MAX_REWORK = 2
# Wall-clock slot of each part of the automatic run, in seconds (key 0 = the wear begins). Σ = BUDGET_SECONDS.
# Computing the whole story takes ≈ 32 s with a browser attached (≈ 0.15 s per simulated minute); the rest of the
# 150 s is deliberate screen time so each step can be read: the walk (≈ 26 s) and the repair get half of the run.
SLOTS: dict[int, float] = {0: 6, 1: 9, 2: 17, 3: 11, 4: 17, 5: 12, 6: 48, 7: 30}
# Within stage 6 the walk (crew room → tools → lift → machine) gets this share of the slot, the repair the rest,
# so the walk and the lift ride last long enough to be followed at a natural walking pace (≈ 1.5 m/s).
WALK_SHARE = 0.55

STEPS: list[dict[str, Any]] = [
    {"id": 1, "layers": "L2 · L3", "short": "Duplicate check", "title": "Readings arrive. Copies are dropped.",
     "text": "Every sensor sends a reading each minute. If the same reading arrives twice, only one copy is kept."},
    {"id": 2, "layers": "L4", "short": "Prediction", "title": "Vibration is rising. The trend is projected forward.",
     "text": "Each sensor is compared with what is normal for this machine at this load. The trend shows when the alarm limit would be reached, so the warning comes early."},
    {"id": 3, "layers": "L5", "short": "Risk and work order", "title": "The risk is scored. One work order is made.",
     "text": "The risk sets the priority. Repeat alerts for the same problem are added to the same work order. Never a duplicate."},
    {"id": 4, "layers": "L6", "short": "Approval", "title": "Sent to Kishore. Kishore approves.",
     "text": "The request goes to Kishore, the supervisor, with the evidence. The best technician is lined up and waits. Kishore approves automatically."},
    {"id": 5, "layers": "L6", "short": "Dispatch", "title": "The technician is allocated and gets the job.",
     "text": "Technicians are ranked by skill, distance and workload. The spare parts are reserved and the job reaches the crew room."},
    {"id": 6, "layers": "L6", "short": "Repair", "title": "The technician walks to the machine and repairs it.",
     "text": "Tools, lift, isolate, fix, then sign off with findings and the parts used."},
    {"id": 7, "layers": "L7", "short": "Verify and close", "title": "An independent check proves the fix.",
     "text": "Fresh readings are compared with normal by a check that is independent of the technician. Kishore closes the job."},
]
_at = SLOTS[0]
for _s in STEPS:  # where each stage sits on the 150-second clock
    _s["at"], _s["seconds"] = _at, SLOTS[_s["id"]]
    _at += SLOTS[_s["id"]]
assert abs(_at - BUDGET_SECONDS) < 1e-9

# what each machine health state means, as one rung of the escalation ladder
HEALTH_TEXT = {"NORMAL": "Back to normal", "WATCH": "Watch: readings are drifting away from normal",
               "ANOMALY": "Early warning: the reading has left the normal band", "CLEARED": "Warning cleared"}
SEVERITY_RANK = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}


class _Cancelled(Exception):
    """The viewer pressed *Start over* while a run was in progress."""


class Walkthrough:
    def __init__(self) -> None:
        self.asset_id: str | None = None
        self.started = False
        self.stage = 0
        self.busy = False
        self.auto = False
        self.preparing = False  # clearing an earlier run's leftovers, before the 150-second clock starts
        # what is happening right now: idle, preparing, wear, readings, prediction, workorder, approval, approved,
        # dispatch, walking, working, verifying, rework, closing, done (drives the camera and the Process tab)
        self.phase = "idle"
        self.cleared: list[str] = []  # what that was, in words
        self.error: str | None = None
        self.log: list[dict[str, Any]] = []
        self.results: dict[int, dict[str, Any]] = {}
        self.marks: dict[int, float] = {}  # stage → seconds on the clock when it finished
        self.normal: dict[str, float] = {}  # metric → value before the wear began
        self.escalation: list[dict[str, Any]] = []
        self.sim_minutes = 0
        self._extra = 0.0  # seconds added to the clock by rework rounds
        self._watching = False
        self._health = "NORMAL"
        self._severity = "NONE"
        self.pace = get_settings().demo_pace  # >1 slows the pacing, 0 = as fast as possible
        self._thread: threading.Thread | None = None
        self._api: Api | None = None
        self._cancel = threading.Event()
        self._t0: float | None = None
        self._t_end: float | None = None
        self._slot = 0
        self._deadline: float | None = None
        # narration: lines said at even intervals between ``_lines_from`` and ``_lines_to`` (wall clock)
        self._lines: list[str] = []
        self._lines_n = 0
        self._lines_from = 0.0
        self._lines_to = 0.0
        self._left = 0

    # ------------------------------------------------------------------ public
    def state(self) -> dict[str, Any]:
        return {"asset_id": self.asset_id, "started": self.started, "stage": self.stage, "total": len(STEPS),
                "busy": self.busy, "auto": self.auto, "phase": self.phase, "preparing": self.preparing, "cleared": self.cleared, "error": self.error, "steps": STEPS, "results": self.results,
                "log": self.log[-40:], "marks": self.marks, "normal": self.normal, "escalation": self.escalation,
                "elapsed_s": round(self._elapsed(), 1),
                "budget_s": (BUDGET_SECONDS + self._extra) * (self.pace if self.pace > 0 else 1.0),
                "sim_minutes": self.sim_minutes, "simulated": True}

    def begin(self, asset_id: str) -> dict[str, Any]:
        """Step by step: choose the machine, switch the autopilot off, pause the clock and start the wear."""
        if self.busy:
            return self.state()
        self._reset_run(asset_id, auto=False)
        return self._spawn(self._start)

    def begin_auto(self, asset_id: str, cleared: list[str] | None = None) -> dict[str, Any]:
        """Automatic: play every stage, from the first worn bearing to the closed work order, in two and a half minutes.

        ``cleared`` lists what earlier runs left behind (open jobs, wearing machines, technicians still out):
        when it is not empty the building is first reset to its seed state, before the clock starts, so the
        run can never trip over leftovers.
        """
        if self.busy:
            return self.state()
        self._reset_run(asset_id, auto=True)
        self.cleared = list(cleared or [])
        return self._spawn(self._play)

    def next_step(self) -> dict[str, Any]:
        if self.busy or not self.started or self.stage >= len(STEPS):
            return self.state()
        return self._spawn(lambda: self._exec(self.stage + 1))

    def clear(self) -> dict[str, Any]:
        """Forget the walkthrough (the caller resets the simulated world itself)."""
        self._cancel.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=60)
        self._cancel.clear()
        self._reset_run(None, auto=False)
        self.busy = False
        self._api = None
        return self.state()

    # ------------------------------------------------------------------ internals
    def api(self) -> Api:
        if self._api is None:
            self._api = Api()
        return self._api

    def _reset_run(self, asset_id: str | None, auto: bool) -> None:
        self.asset_id, self.auto, self.started, self.stage, self.error = asset_id, auto, False, 0, None
        self.preparing, self.cleared = False, []
        self.phase = "idle" if asset_id is None else "starting"
        self._deadline = None
        self.results, self.log, self.marks, self.sim_minutes = {}, [], {}, 0
        self.normal, self.escalation = {}, []
        self._extra = 0.0
        self._watching, self._health, self._severity = False, "NORMAL", "NONE"
        self._t0, self._t_end, self._slot, self._left = None, None, 0, 0

    def _spawn(self, fn: Callable[[], None]) -> dict[str, Any]:
        self.busy = True
        self.error = None
        self._cancel.clear()

        def run() -> None:
            try:
                fn()
            except _Cancelled:
                pass
            except Exception as exc:  # noqa: BLE001 — surface any failure in the UI instead of dying silently
                self.error = f"{type(exc).__name__}: {exc}"
                if self.auto:
                    self._leave_running()
            finally:
                self.preparing = False
                if self.auto and self._t0 is not None and not self._cancel.is_set():
                    self._t_end = time.monotonic()
                self.busy = False

        self._thread = threading.Thread(target=run, daemon=True, name="walkthrough")
        self._thread.start()
        return self.state()

    def _leave_running(self) -> None:
        """After a failed run the building must not stay paused: set the clock running again (best effort).

        Whatever the failed run left open is cleared by the next automatic run before it starts.
        """
        try:
            self.api().call("operator", "post", "/api/simulation/start")
        except Exception:  # noqa: BLE001 — never mask the original error
            pass

    def _fresh_world(self) -> None:
        """Reset the building to its seed state (what *Start over* does) and keep the clock paused."""
        from app.modules.autopilot.operations import autopilot

        autopilot.configure(enabled=False)
        api = self.api()
        api.ok("admin", "post", "/api/simulation/reset", json={})
        api.ok("operator", "post", "/api/simulation/pause")

    def _elapsed(self) -> float:
        if self._t0 is None:
            return 0.0
        return (self._t_end or time.monotonic()) - self._t0

    def _say(self, text: str) -> None:
        self.log.append({"stage": self.stage, "text": text, "t": round(self._elapsed(), 1)})

    def _escalate(self, level: str, text: str) -> None:
        """One more rung on the escalation ladder (also told in the live feed)."""
        self.escalation.append({"level": level, "text": text, "t": round(self._elapsed(), 1)})
        self._say(text)

    def _watch(self) -> None:
        """Read the machine's health (and the warning's severity) and record every change as a rung."""
        api = self.api()
        health = api.get(f"/api/assets/{self.asset_id}")["health_state"]
        if health != self._health:
            self._health = health
            self._escalate(health, HEALTH_TEXT.get(health, health))
        if health == "ANOMALY":
            items = api.get(f"/api/anomalies?state=ACTIVE&asset_id={self.asset_id}")["items"]
            sev = items[0]["severity"] if items else "NONE"
            if SEVERITY_RANK.get(sev, 0) > SEVERITY_RANK.get(self._severity, 0):
                before, self._severity = self._severity, sev
                self._escalate(f"SEVERITY_{sev}", f"Severity {sev.lower()}" if before == "NONE"
                               else f"Severity rises: {before.lower()} → {sev.lower()}")

    def _name(self, username: str) -> str:
        """Display name of a simulated person (e.g. "Kishore" for the supervisor)."""
        return next((u["display_name"] for u in self.api().get("/api/auth/demo-users") if u["username"] == username), username)

    # -- pacing --------------------------------------------------------------------
    def _nap(self, seconds: float) -> None:
        """Sleep (cancellable); raises ``_Cancelled`` as soon as the viewer starts over."""
        if self._cancel.wait(max(0.0, seconds)):
            raise _Cancelled()

    def _enter(self, key: int, minutes: int, lines: list[str] | tuple[str, ...] = ()) -> None:
        """Begin slot ``key``, which is expected to need ``minutes`` simulated minutes.

        ``lines`` are explained to the viewer at even intervals across the slot: line k of n is said at
        start + (k + 1)/(n + 1) · (end − start), so the screen never sits silent for long.
        """
        self._slot, self._left = key, minutes
        self._deadline = None
        self._queue_lines(list(lines), None)

    def _queue_lines(self, lines: list[str], until: float | None) -> None:
        self._lines, self._lines_n = lines, len(lines)
        if self.auto and self.pace > 0 and self._t0 is not None and lines:
            self._lines_from = time.monotonic()
            self._lines_to = until if until is not None else self._slot_end(self._slot)
        else:
            self._lines, self._lines_n = [], 0

    def _next_due(self) -> float | None:
        if not self._lines:
            return None
        k = self._lines_n - len(self._lines)
        return self._lines_from + (k + 1) / (self._lines_n + 1) * (self._lines_to - self._lines_from)

    def _drip(self) -> None:
        while self._lines and time.monotonic() >= (self._next_due() or 0.0):
            self._say(self._lines.pop(0))

    def _nap_to(self, target: float) -> None:
        """Sleep until the wall-clock ``target``, saying each queued narration line when it falls due on the way."""
        while True:
            due = self._next_due()
            if due is not None and due <= target:
                self._nap(due - time.monotonic())
                self._drip()
                continue
            self._nap(target - time.monotonic())
            self._drip()
            return

    def _slot_at(self, frac: float) -> float:
        """Wall-clock time ``frac`` (0..1) of the way through the current slot."""
        assert self._t0 is not None
        start = self._slot_end(self._slot - 1) if self._slot > 0 else self._t0
        return start + frac * (self._slot_end(self._slot) - start)

    def _hold_until(self, frac: float) -> None:
        """Let the screen stay on what has just been said until ``frac`` of the current slot (automatic runs only)."""
        if self.auto and self.pace > 0:
            self._nap_to(self._slot_at(frac))

    def _enter_part(self, minutes: int, share: float | None, lines: list[str] | tuple[str, ...] = ()) -> None:
        """Pace the next ``minutes`` simulated minutes to end at ``share`` of the current slot (None: at its end).

        deadline = start_k + share · (end_k − start_k), start_k = end_(k−1); the remaining minutes are spread
        over the time left before it with the same nap formula as a whole slot.
        """
        self._left = minutes
        if share is None or self._t0 is None:
            self._deadline = None
            self._queue_lines(list(lines), None)
            return
        start = self._slot_end(self._slot - 1) if self._slot > 0 else self._t0
        self._deadline = start + share * (self._slot_end(self._slot) - start)
        self._queue_lines(list(lines), self._deadline)

    def _slot_end(self, key: int) -> float:
        """Wall-clock end of slot ``key``; slots above 7 are rework rounds of ``REWORK_SECONDS`` each."""
        assert self._t0 is not None
        base = sum(v for k, v in SLOTS.items() if k <= min(key, 7))
        return self._t0 + self.pace * (base + REWORK_SECONDS * max(0, key - 7))

    def _tick(self, key: str, minutes: int) -> None:
        """Called after every call to the simulator: pace the run (see the module docstring for the formula)."""
        self.sim_minutes += minutes
        if self._cancel.is_set():
            raise _Cancelled()
        if self._watching:
            self._watch()
        if self.pace <= 0:
            return
        if not self.auto:
            self._nap(PACE[key] * self.pace)
            return
        self._left = max(0, self._left - minutes)
        calls_left = math.ceil(self._left / minutes)
        end = self._deadline if self._deadline is not None else self._slot_end(self._slot)
        now = time.monotonic()
        self._nap_to(now + (end - now) / (calls_left + 1))

    def _finish_slot(self) -> None:
        """An automatic stage that finished early waits for the end of its slot, so the clock stays on schedule."""
        if self.auto and self.pace > 0:
            self._nap_to(self._slot_end(self._slot))

    def _advance(self, minutes: int, pace: str, chunk: int = 1) -> None:
        done = 0
        while done < minutes:
            n = min(chunk, minutes - done)
            self.api().ok("operator", "post", "/api/simulation/step", params={"minutes": n})
            done += n
            self._tick(pace, n)

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
    def _play(self) -> None:
        """The automatic run: wear, then stages 1–7 back to back on the 150-second schedule."""
        if self.cleared:
            self.phase = "preparing"
            self.preparing = True
            self._say("Clearing what earlier runs left behind (" + ", ".join(self.cleared) + ") so this one starts clean")
            self._fresh_world()
            self.preparing = False
        self._t0 = time.monotonic()
        self._start()
        for n in range(1, len(STEPS) + 1):
            self._exec(n)
        self._t_end = time.monotonic()
        self.phase = "done"
        self._say(f"All done in {self._elapsed():.0f} s of real time — about {self.sim_minutes} minutes of building time were simulated")

    def _start(self) -> None:
        from app.modules.autopilot.operations import autopilot

        api = self.api()
        autopilot.configure(enabled=False)  # the crew only moves when this walkthrough moves it
        api.ok("operator", "post", "/api/simulation/pause")
        asset = api.get(f"/api/assets/{self.asset_id}")
        self.normal = {s["metric"]: s["last_value"] for s in asset["sensors"] if s["last_value"] is not None}
        self._health = asset["health_state"]
        self.escalation.append({"level": "NORMAL", "text": "Normal: every reading is inside its normal band", "t": 0.0})
        api.ok("operator", "post", "/api/simulation/faults", json={"asset_id": self.asset_id, "fault_type": "bearing_wear"})
        self.phase = "wear"
        self._say("A bearing starts to wear. The detector is not told.")
        self._watching = True
        self._enter(0, 6, ["Vibration creeps up slowly, still far below any alarm: nobody would notice yet"])
        self._advance(6, "readings")
        self.started = True
        self._finish_slot()

    def _exec(self, n: int) -> None:
        self.stage = n
        self.phase = {1: "readings", 2: "prediction", 3: "workorder", 4: "approval", 5: "dispatch", 6: "walking", 7: "verifying"}[n]
        self._say(STEPS[n - 1]["title"])
        try:
            self.results[n] = (self._s1, self._s2, self._s3, self._s4, self._s5, self._s6, self._s7)[n - 1]()
            self._finish_slot()
            self.marks[n] = round(self._elapsed(), 1)
        except Exception:
            self.stage = n - 1  # the click can be repeated
            raise

    def _s1(self) -> dict[str, Any]:
        api = self.api()
        asset = api.get(f"/api/assets/{self.asset_id}")
        names = ", ".join(sn["metric"].replace("_", " ") for sn in asset["sensors"])
        self._enter(1, 3, [f"{asset['name']} has {len(asset['sensors'])} sensors ({names}), each sending one reading per minute",
                           "Every reading is checked on arrival: a copy is dropped, a wrong unit or unknown sensor is rejected"])
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
        self._enter(2, 16, ["Comparing the vibration with what is normal for this machine at this load",
                            "It keeps rising: the other sensors are checked for the same pattern",
                            "Projecting the trend forward to see when the alarm limit would be reached"])
        self._until(lambda: bool(api.get(f"/api/anomalies?state=ACTIVE&asset_id={self.asset_id}")["items"]), 240, "detect")
        a = api.get(f"/api/anomalies?state=ACTIVE&asset_id={self.asset_id}")["items"][0]
        self._say(a["explanation"])
        asset = api.get(f"/api/assets/{self.asset_id}")
        if a["projection_hours"] is not None:
            self._say(f"Prediction: at this trend the alarm limit ({asset['limits']['alarm']} {asset['limits']['unit']}, demo value) "
                      f"is reached in about {a['projection_hours'] * 60:.0f} minutes. Inspection recommended.")
        return {"anomaly_id": a["id"], "metric": a["metric"], "z": a["z"], "severity": a["severity"],
                "observed": a["observed_value"], "baseline": a["baseline_mean"], "slope": a["slope"],
                "projection_hours": a["projection_hours"], "projection_note": a["projection_note"],
                "limits": asset["limits"],
                "at_detection": {s["metric"]: s["last_value"] for s in asset["sensors"] if s["last_value"] is not None}}

    def _s3(self) -> dict[str, Any]:
        self._enter(3, 10, ["Scoring the risk: how severe, how critical the machine is, how long it has lasted, how fast it rises",
                            "Creating ONE work order; further alerts for the same problem are attached to it as evidence, never a second one"])
        self._until(lambda: bool(self._wos()), 120, "detect")
        self._advance(10, "detect")  # later alerts arrive and are attached as evidence
        wos = self._wos()
        wo = self.api().get(f"/api/work-orders/{wos[0]['id']}")
        ra = wo["risk_assessment"] or {}
        self._escalate(f"WORK_ORDER_{wo['priority']}", f"Work order {wo['number']} raised at priority {wo['priority']}"
                       + (f" (risk {ra['risk_score']:.0f}/100)" if ra.get("risk_score") is not None else ""))
        return {"work_order": wo["number"], "open_work_orders": len(wos), "evidence": len(wo["evidence"]),
                "priority": wo["priority"], "proposed_priority": wo["proposed_priority"],
                "risk": round(float(ra["risk_score"])) if ra.get("risk_score") is not None else None}

    def _s4(self) -> dict[str, Any]:
        """The request goes to Kishore; the best technician is lined up and waits; Kishore approves by himself."""
        api = self.api()
        self._enter(4, 2)
        wo = self._wo()
        wid = wo["id"]
        boss = self._name("supervisor")
        cands = api.get(f"/api/work-orders/{wid}/dispatch-candidates")["candidates"]
        standby = next((c["name"] for c in cands if c["eligible"]), None)
        self._escalate("SUPERVISOR", f"Escalated to {boss} (supervisor) for approval, with the evidence")
        if standby:
            self._say(f"{standby} is the best match and is on standby, waiting for {boss}'s approval")
        # Kishore takes his time: the approval lands at the end of his slot, after he has read the request
        # the review ends at 55 % of his slot, he then weighs it until 80 %, the last fifth shows the approval
        self._enter_part(2, 0.55)
        self._say(f"{boss} opens the request: the vibration trend, the prediction and the risk score")
        self._advance(1, "detect")
        self._say(f"{boss} checks the machine's history and who can do the job")
        self._advance(1, "detect")  # more alerts may arrive meanwhile
        self._say(f"{boss} weighs the priority against the risk and decides")
        self._hold_until(0.80)
        wo = self._wo()
        escalated: dict[str, str] | None = None
        if wo.get("proposed_priority"):
            api.ok("supervisor", "post", f"/api/work-orders/{wid}/acknowledge-escalation",
                   json={"accept": True, "note": "Escalation accepted after reviewing the new evidence"})
            escalated = {"from": wo["priority"], "to": wo["proposed_priority"]}
            self._escalate(f"PRIORITY_{wo['proposed_priority']}",
                           f"New evidence raised the priority {wo['priority']} → {wo['proposed_priority']}; {boss} accepted it")
        ok = api.ok("supervisor", "post", f"/api/work-orders/{wid}/approve", json={"note": "Evidence reviewed — approved"})
        self.phase = "approved"
        self._escalate("APPROVED", f"{boss} approved {ok['number']}")
        self._watching = False
        return {"requested_to": boss, "approved_by": boss, "standby": standby, "waited_minutes": 2,
                "status": ok["status"], "priority": ok["priority"], "escalated": escalated}

    def _s5(self) -> dict[str, Any]:
        api = self.api()
        self._enter(5, 1)
        self._say("Ranking the technicians by skill, distance from the machine and current workload")
        self._hold_until(0.28)
        wo = self._wo()
        cands = api.get(f"/api/work-orders/{wo['id']}/dispatch-candidates")["candidates"]
        best = next((c for c in cands if c["eligible"]), None)
        if best is None:
            raise RuntimeError("no eligible technician right now")
        res = api.ok("supervisor", "post", f"/api/work-orders/{wo['id']}/assign", json={"technician_id": best["technician_id"]})
        self._say(f"{best['name']} allocated (best match, score {best['score']:.2f}); the job appears on the crew-room screen")
        parts_ordered = self._restock(res)  # spare parts short → the job waits until a delivery arrives
        # No simulated time passes here: the technician only starts to walk in the next step, so the whole walk
        # (travel_minutes of it) is shown from the crew room door to the machine. The slot is narration.
        self._queue_lines(["The job and the reserved spare parts appear on the crew-room screen",
                           f"{best['name'].split()[0]} reads the job and gets up from the table"], None)
        res = api.get(f"/api/work-orders/{wo['id']}")
        return {"technician": best["name"], "technician_id": best["technician_id"], "status": res["status"],
                "parts_ordered": parts_ordered, "travel_minutes": best["travel_minutes"], "priority": res["priority"],
                "candidates": [{"name": c["name"], "score": c["score"], "eligible": c["eligible"],
                                "reasons": c["ineligible_reasons"], "travel_minutes": c["travel_minutes"]} for c in cands]}

    def _restock(self, wo: dict[str, Any]) -> list[dict[str, Any]]:
        """If ``wo`` is on hold awaiting spare parts, do what the store would: order, receive, resume.

        The shortage is real (stock left by earlier jobs), so nothing is faked: Kishore raises the purchase
        order, ``DELIVERY_MINUTES`` of building time pass, the delivery is booked in as stock
        (``max(reorder_quantity, short_by)`` of each short part) and the work order is resumed by the same
        call. Returns what was received (empty when no parts were short).
        """
        api = self.api()
        if wo["status"] != "ON_HOLD" or wo.get("hold_reason") != "AWAITING_PARTS":
            return []
        boss = self._name("supervisor")
        stock = {i["sku"]: i for i in api.get("/api/inventory")["items"]}
        # reservation is all-or-nothing, so "not reserved" is not "not in stock": order only what is really short
        short = {p["sku"]: p["planned"] - p["reserved"] for p in api.get(f"/api/work-orders/{wo['id']}")["parts"]
                 if p["reserved"] < p["planned"] and stock[p["sku"]]["available"] < p["planned"] - p["reserved"]}
        self._escalate("PARTS", f"Spare parts short ({', '.join(short)}): the job waits. {boss} raises a purchase order")
        self._advance(DELIVERY_MINUTES, "detect")
        got = self._receive(short)
        after = api.get(f"/api/work-orders/{wo['id']}")
        if after["status"] == "ON_HOLD":
            raise RuntimeError(f"{after['number']} is still waiting for spare parts after the delivery")
        self._say("Delivery received ({}): the job resumes".format(", ".join("{} ×{}".format(g["sku"], g["quantity"]) for g in got)))
        return got

    def _receive(self, short: dict[str, int]) -> list[dict[str, Any]]:
        """Book a delivery into stock for each short part (``sku → short_by``): ``max(reorder_quantity, short_by)`` of each.

        Receiving as the supervisor also resumes any job that was on hold awaiting those parts.
        """
        api = self.api()
        stock = {i["sku"]: i for i in api.get("/api/inventory")["items"]}
        got: list[dict[str, Any]] = []
        for sku, short_by in short.items():
            qty = max(int(stock[sku]["reorder_quantity"]), int(short_by))
            api.ok("supervisor", "post", "/api/inventory/receive", json={"sku": sku, "quantity": qty, "note": "Purchase order delivered"})
            got.append({"sku": sku, "quantity": qty})
        return got

    def _s6(self) -> dict[str, Any]:
        api = self.api()
        wo = self._wo()
        if wo["status"] == "ON_HOLD":  # e.g. stock was taken meanwhile: never start a job that is on hold
            self._restock(wo)
            wo = self._wo()
        tid = wo["assigned_technician"]["id"]
        user = TECH_USER[tid]
        first = wo["assigned_technician"]["name"].split()[0]
        asset_type = api.get(f"/api/assets/{self.asset_id}")["asset_type"]
        plan = procedures.steps(asset_type, False)
        travel = int(self.results.get(5, {}).get("travel_minutes", 5))
        self._enter(6, travel + sum(m for _, _, m in plan) + 1)
        info = api.get(f"/api/assets/{self.asset_id}")
        legs = [f"{first} leaves the crew room and heads for the glass lift", ]
        if info["floor_level"] != 0:
            legs.append(f"{first} rides the lift to {info['floor_name']}")
        legs.append(f"{first} walks along the corridor to {info['name']}")
        self._enter_part(travel, WALK_SHARE, legs)
        self.phase = "walking"
        self._say(f"{first} picks up the tool kit from the cabinet")
        self._until(lambda: next(t for t in api.get("/api/technicians") if t["id"] == tid)["status"] == "ON_SITE", 90, "walk")
        api.ok(user, "post", f"/api/work-orders/{wo['id']}/start", json={"note": "On site, starting work"})
        self._enter_part(sum(m for _, _, m in plan), None)
        self.phase = "working"
        self._say(f"{first} is on site, permit signed, work started")
        for _, label, minutes in plan:
            self._say(label)
            self._advance(minutes, "work")
        parts = [{"sku": p["sku"], "quantity": p["planned"]} for p in api.get(f"/api/work-orders/{wo['id']}")["parts"] if p["planned"] > 0]
        done = api.ok(user, "post", f"/api/work-orders/{wo['id']}/complete", json={
            "findings": procedures.findings(asset_type, False),
            "photo_data": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>",
            "checklist": {k: True for k, _, _ in procedures.steps(asset_type, False)}, "parts_used": parts})
        self._say("Repair done and signed off")
        return {"status": done["status"], "findings": procedures.findings(asset_type, False)}

    def _await_window(self, wid: int) -> None:
        """Advance until the post-repair window of fresh readings is full (the check cannot run before)."""
        api = self.api()
        for _ in range(40):
            if api.get(f"/api/work-orders/{wid}/verification")["ready"]:
                return
            if self.auto:
                self._advance(4, "verify", chunk=4)
            else:
                self._advance(5, "verify")
        raise RuntimeError("the post-repair window of fresh readings was not completed in time")

    @staticmethod
    def _failed_checks(wo: dict[str, Any]) -> list[str]:
        """The failed criteria of the latest independent check, with their value and limit."""
        crit = wo["verifications"][-1]["criteria"]["criteria"] if wo.get("verifications") else []
        return [f"{c['label']}: {c['value']} (limit {c['threshold']})" for c in crit if not c["passed"]]

    def _rework(self, wo: dict[str, Any], tech_user: str, n: int, failed: list[str]) -> None:
        """Round ``n`` of rework after a failed check: the technician returns, repairs again, signs off again."""
        api = self.api()
        first = wo["assigned_technician"]["name"].split()[0]
        asset_type = api.get(f"/api/assets/{self.asset_id}")["asset_type"]
        plan = procedures.steps(asset_type, True)
        self._extra += REWORK_SECONDS
        self._enter(7 + n, 3 + sum(m for _, _, m in plan) + 64)
        self.phase = "rework"
        self._escalate("REWORK", f"The independent check failed ({'; '.join(failed)}): the job goes back to {first} for rework")
        wid = wo["id"]
        r = api.call(tech_user, "post", f"/api/work-orders/{wid}/restart", json={"note": "Returning for rework"})
        err = r.json().get("error", {}) if r.status_code >= 400 and "json" in r.headers.get("content-type", "") else {}
        if r.status_code == 409 and err.get("code") == "insufficient_stock":  # the rework needs parts that are gone
            short = {x["sku"]: x["short_by"] for x in err.get("details", {}).get("shortages", [])}
            self._escalate("PARTS", f"Spare parts short for the rework ({', '.join(short)}): a purchase order is raised")
            self._advance(DELIVERY_MINUTES, "detect")
            got = self._receive(short)
            self._say("Delivery received ({}): the rework can start".format(", ".join("{} ×{}".format(g["sku"], g["quantity"]) for g in got)))
            r = api.call(tech_user, "post", f"/api/work-orders/{wid}/restart", json={"note": "Returning for rework"})
        if r.status_code >= 400:
            raise RuntimeError(f"rework could not start: HTTP {r.status_code} {r.text[:200]}")
        arrives = datetime.fromisoformat(str(r.json()["arrives_at"]).rstrip("Z"))
        now = datetime.fromisoformat(str(api.get("/api/simulation")["sim_now"]).rstrip("Z"))
        self._say(f"{first} heads back to {self.asset_id} for the rework")
        self._advance(max(0, math.ceil((arrives - now).total_seconds() / 60)), "walk")
        for _, label, minutes in plan:
            self._say(label)
            self._advance(minutes, "work")
        parts = [{"sku": p["sku"], "quantity": p["planned"]} for p in api.get(f"/api/work-orders/{wid}")["parts"] if p["planned"] > 0]
        api.ok(tech_user, "post", f"/api/work-orders/{wid}/complete", json={
            "findings": procedures.findings(asset_type, True),
            "photo_data": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>",
            "checklist": {k: True for k, _, _ in plan}, "parts_used": parts})
        self._say("Rework done and signed off")

    def _s7(self) -> dict[str, Any]:
        api = self.api()
        self._enter(7, 64, ["The machine needs about 30 minutes to settle after the repair before it can be judged",
                            "Collecting 30 fresh readings after the repair",
                            "Comparing them with normal: vibration, temperature and current, independently of the technician"])
        wo = self._wo()
        wid = wo["id"]
        boss = self._name("supervisor")
        tech_user = TECH_USER[wo["assigned_technician"]["id"]]
        failed_checks: list[str] = []
        reworks = 0
        self._say("The independent check waits for a full window of fresh readings after the repair")
        while True:
            self._await_window(wid)
            res = api.ok("verifier", "post", f"/api/work-orders/{wid}/verify", json={"outcome": "auto", "note": "Fresh readings back to normal"})
            if res["status"] == "VERIFIED":
                break
            failed = self._failed_checks(res)
            failed_checks.extend(failed)
            if reworks >= MAX_REWORK:
                raise RuntimeError("the independent check still fails after %d reworks: %s" % (reworks, "; ".join(failed)))
            reworks += 1
            self._rework(wo, tech_user, reworks, failed)
            self.phase = "verifying"
            self._say("The independent check waits again for a full window of fresh readings")
        out: dict[str, Any] = {"outcome": res["status"], "verified_by": "independent check", "closed_by": boss,
                               "reworks": reworks, "failed_checks": failed_checks}
        self._say("Independent check passed: fresh readings are back inside the normal band")
        self.phase = "closing"
        closed = api.ok("supervisor", "post", f"/api/work-orders/{wid}/close", json={"checklist": CLOSURE, "note": "Closed after verification"})
        self._advance(2, "verify")
        api.ok("operator", "post", "/api/simulation/start")  # the demo is over: the building runs live again
        out["outcome"] = closed["status"]
        self._say(f"{boss} closed {closed['number']}: work order closed")
        self._watch()  # the last rung: the machine is back to normal
        return out


walkthrough = Walkthrough()
