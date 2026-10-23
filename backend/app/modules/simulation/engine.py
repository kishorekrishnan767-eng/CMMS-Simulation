"""Simulation engine: advances the sim clock, generates telemetry and publishes it to the sink.

Layer 2. The engine never decides anything — it has no knowledge of anomalies, work orders or
policies. It only (1) advances the clock, (2) samples the physics model plus any injected faults,
(3) hands a batch to the ``TelemetrySink``, (4) lets the event bus deliver what that produced, and
(5) calls registered per-tick hooks (used by other modules to react to the passage of time).

A call to ``step_minutes(n)`` generates all ``n`` minutes of readings as ONE batch (ordered by
time); downstream consumers process the samples sequentially. This keeps 1800x tractable.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import iso
from app.config import get_settings
from app.db import read_session, write_session
from app.models import Asset, FaultInjection, Sensor, SimulationRun, SimulationState
from app.modules.events import bus
from app.modules.simulation import physics
from app.modules.simulation.physics import NoiseSource, WearFault
from app.modules.simulation.sink import TelemetrySink

ALLOWED_SPEEDS = (1.0, 10.0, 60.0, 300.0, 1800.0)
PROFILE_DURATION_H = {"demo": 1.5, "realistic": 4.0}
ONE_SHOT = ("SPIKE", "DUPLICATE", "LATE_EVENT", "BAD_UNIT", "UNKNOWN_SENSOR")
SPIKE_MAGNITUDE = {"vibration_velocity": 20.0, "bearing_temperature": 45.0, "motor_current": 40.0, "speed_command": 30.0}
LATE_MINUTES = 25

_sink: TelemetrySink | None = None
_tick_hooks: list[Callable[[datetime], None]] = []
_topology: list[dict[str, Any]] | None = None
_noise: NoiseSource | None = None
_flat_values: dict[int, float] = {}
_lock = threading.RLock()


def set_sink(sink: TelemetrySink) -> None:
    global _sink
    _sink = sink


def add_tick_hook(fn: Callable[[datetime], None]) -> None:
    if fn not in _tick_hooks:
        _tick_hooks.append(fn)


def invalidate() -> None:
    """Drop cached topology/noise (after reset or seed change)."""
    global _topology, _noise
    _topology = None
    _noise = None
    _flat_values.clear()


def _get_topology(session: Session) -> list[dict[str, Any]]:
    global _topology
    if _topology is None:
        topo = []
        for idx, a in enumerate(session.scalars(select(Asset).order_by(Asset.id)), start=1):
            topo.append({
                "id": a.id, "index": idx, "params": dict(a.sim_params),
                "sensors": {s.metric: {"id": s.id, "unit": s.unit, "kind": s.kind} for s in a.sensors},
            })
        _topology = topo
    return _topology


def _get_noise(seed: int) -> NoiseSource:
    global _noise
    if _noise is None or _noise.seed != seed:
        _noise = NoiseSource(seed)
    return _noise


_minute_index = physics._minute_index  # timezone-free minute counter (naive UTC)


def _wear_faults(rows: list[FaultInjection]) -> dict[str, WearFault]:
    out: dict[str, WearFault] = {}
    for f in rows:
        if f.fault_type != "BEARING_WEAR":
            continue
        p = f.params
        wf = WearFault(t0=f.started_at, amplitude=p.get("amplitude", 7.0), exponent=p.get("exponent", 2.0),
                       duration_h=p.get("duration_h", 1.5))
        wf.repairs = [(datetime.fromisoformat(r["at"].rstrip("Z")), float(r["effectiveness"])) for r in f.repairs]
        out[f.asset_id] = wf
    return out


def _reading(sensor: dict[str, Any], asset_id: str, metric: str, value: float, t: datetime, **over: Any) -> dict[str, Any]:
    r = {
        "event_id": f"evt-{sensor['id']}-{_minute_index(t)}", "asset_id": asset_id, "sensor_id": sensor["id"],
        "metric": metric, "value": value, "unit": sensor["unit"], "timestamp": iso(t), "source": "simulation",
        "quality": "good",
    }
    r.update(over)
    return r


def _apply_transport_faults(
    readings: list[dict[str, Any]], t: datetime, faults: list[FaultInjection], first_minute: bool,
    consumed: list[int],
) -> list[dict[str, Any]]:
    """Distort the batch the way a flaky device/network would. Returns the new batch."""
    out = list(readings)
    for f in faults:
        if f.fault_type == "BEARING_WEAR" or f.sensor_id is None and f.fault_type != "UNKNOWN_SENSOR":
            continue
        mine = [r for r in readings if r["sensor_id"] == f.sensor_id and r["timestamp"] == iso(t)]
        if f.fault_type == "FLATLINE":
            if t < f.started_at or (f.ends_at and t >= f.ends_at):
                continue
            for r in mine:
                frozen = _flat_values.setdefault(f.id, r["value"])
                r["value"] = frozen
        elif f.fault_type == "DROPOUT":
            if t < f.started_at or (f.ends_at and t >= f.ends_at):
                continue
            out = [r for r in out if r not in mine]
        elif f.fault_type in ONE_SHOT and first_minute and f.status == "ACTIVE":
            consumed.append(f.id)
            if f.fault_type == "SPIKE":
                for r in mine:
                    r["value"] = round(r["value"] + f.params.get("magnitude", SPIKE_MAGNITUDE.get(r["metric"], 20.0)), 4)
            elif f.fault_type == "DUPLICATE":
                out.extend(dict(r) for r in mine)
            elif f.fault_type == "LATE_EVENT":
                for r in mine:
                    late_t = t - timedelta(minutes=LATE_MINUTES)
                    out.append({**r, "event_id": f"evt-late-{r['sensor_id']}-{_minute_index(t)}", "timestamp": iso(late_t)})
            elif f.fault_type == "BAD_UNIT":
                for r in mine:
                    r["unit"] = "mph"
            elif f.fault_type == "UNKNOWN_SENSOR":
                base = mine[0] if mine else readings[0]
                out.append({**base, "event_id": f"evt-unknown-{f.id}-{_minute_index(t)}", "sensor_id": "XXX-999",
                            "asset_id": f.asset_id})
    return out


def step_minutes(n: int = 1) -> int:
    """Generate ``n`` sample minutes, ingest them, deliver events, run tick hooks. Returns minutes done."""
    if _sink is None:
        raise RuntimeError("no telemetry sink bound — call set_sink() (see app.wiring)")
    n = max(1, int(n))
    with bus.pipeline_lock:
        consumed: list[int] = []
        with write_session() as s:
            state = s.get(SimulationState, 1)
            assert state is not None
            topo = _get_topology(s)
            noise = _get_noise(state.seed)
            active = list(s.scalars(select(FaultInjection).where(
                FaultInjection.run_id == state.run_id, FaultInjection.status == "ACTIVE")))
            wear = _wear_faults(active)
            readings: list[dict[str, Any]] = []
            t = state.last_sample_at
            for i in range(n):
                t = t + timedelta(minutes=1)
                batch: list[dict[str, Any]] = []
                for a in topo:
                    vals = physics.sample_asset(t, a["index"], a["params"], noise, wear.get(a["id"]))
                    for metric, sensor in a["sensors"].items():
                        batch.append(_reading(sensor, a["id"], metric, float(vals[metric]), t))
                readings.extend(_apply_transport_faults(batch, t, active, first_minute=(i == 0), consumed=consumed))
            state.last_sample_at = t
            state.sim_now = t
            state.samples_generated += len(readings)
            for fid in consumed:
                row = s.get(FaultInjection, fid)
                if row:
                    row.status = "ENDED"
                    row.ends_at = t
            end = t
        _sink(readings, "simulation")
        bus.drain()
        for hook in list(_tick_hooks):
            hook(end)
        bus.drain()
    return n


# --------------------------------------------------------------------------- clock control
def reset_clock(session: Session, seed: int, profile: str, epoch: datetime) -> SimulationState:
    """Start a fresh run: new run row, clock at the epoch, paused, speed 60x."""
    invalidate()
    state = session.get(SimulationState, 1)
    run = SimulationRun(seed=seed, profile=profile, started_at=epoch, note="reset")
    session.add(run)
    session.flush()
    assert state is not None
    state.run_id = run.id
    state.sim_now = epoch
    state.last_sample_at = epoch
    state.epoch = epoch
    state.seed = seed
    state.profile = profile
    state.running = False
    state.speed = 60.0
    state.repair_effectiveness = 1.0
    state.samples_generated = 0
    return state


class Runner:
    """Background thread that advances the simulation at ``speed`` sim-seconds per real second."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.last_error: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="sim-runner", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        settings = get_settings()
        carry = 0.0
        last = time.monotonic()
        while not self._stop.wait(settings.sim_tick_seconds):
            now = time.monotonic()
            dt, last = now - last, now
            try:
                with read_session() as s:
                    st = s.get(SimulationState, 1)
                    running, speed = (st.running, st.speed) if st else (False, 60.0)
                if not running:
                    carry = 0.0
                    continue
                carry += speed / 60.0 * dt
                whole = int(carry)
                if whole >= 1:
                    todo = min(whole, settings.sim_max_minutes_per_tick)
                    step_minutes(todo)
                    carry = min(carry - todo, float(settings.sim_max_minutes_per_tick))
                self.last_error = None
            except Exception as exc:  # noqa: BLE001 - keep the loop alive, surface in /api/health
                self.last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(0.5)


runner = Runner()
