"""Pure, seeded physics of the simulated building (Layer 2). No database, no other modules.

Formulae (t in sim hours, load in 0..1):

    load(t)    = clip(0.80 + 0.15*sin(2π(hour(t) − 7)/24) + step(t), 0.55, 1.0)
    speed_pct  = 100*load + N(0, 0.1)                 # small measurement noise (see ASSUMPTIONS)
    v_healthy  = vib_base + vib_gain*load + N(0, vib_noise)          # mm/s
    D(t)       = 0                                     t < t0
               = A*((t − t0)/T)^p                      t0 ≤ t < t0+T   (then clamped at 1.15*A)
    vibration  = v_healthy + D(t)
    bearing_T  = temp_base + temp_gain*load + 0.9*D(t) + N(0, temp_noise)     # °C
    current    = cur_gain*load + 0.12*D(t) + N(0, cur_noise)                  # A

Repair at t_r with effectiveness e:  target = D(t_r)*(1−e);
    D(t) = target + (D(t_r) − target)*exp(−(t − t_r)/τ),  τ = 5 min.

``step(t)`` is a piecewise-constant random load step redrawn every 3 sim hours.
All randomness is derived from ``numpy.random.default_rng`` with (seed, asset, block) keys, so the
same seed reproduces an identical run regardless of speed, pauses or restarts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np

SETTLE_TAU_MIN = 5.0
STEP_BLOCK_HOURS = 3.0
STEP_AMPLITUDE = 0.05
CLAMP_FACTOR = 1.15
CHUNK_MINUTES = 1440

_EPOCH = datetime(2000, 1, 1)


def _minute_index(t: datetime) -> int:
    return int((t - _EPOCH).total_seconds() // 60)


@dataclass
class WearFault:
    """Bearing-wear degradation D(t) with optional repairs. ``t0`` is a sim datetime."""

    t0: datetime
    amplitude: float = 7.0       # A  (mm/s)
    exponent: float = 2.0        # p  (accelerating)
    duration_h: float = 1.5      # T  (sim hours; 4 in the "realistic" profile)
    repairs: list[tuple[datetime, float]] = field(default_factory=list)  # (t_r, effectiveness)

    def _wear(self, t: datetime) -> float:
        h = (t - self.t0).total_seconds() / 3600.0
        if h <= 0:
            return 0.0
        if h >= self.duration_h:
            return self.amplitude * CLAMP_FACTOR
        return min(self.amplitude * (h / self.duration_h) ** self.exponent, self.amplitude * CLAMP_FACTOR)

    def d(self, t: datetime, upto: int | None = None) -> float:
        """Degradation at ``t`` considering the first ``upto`` repairs (default all that precede t)."""
        repairs = [r for r in sorted(self.repairs) if r[0] <= t]
        if upto is not None:
            repairs = repairs[:upto]
        if not repairs:
            return self._wear(t)
        t_r, eff = repairs[-1]
        before = self.d(t_r, upto=len(repairs) - 1)
        target = before * (1.0 - eff)
        minutes = (t - t_r).total_seconds() / 60.0
        return target + (before - target) * math.exp(-minutes / SETTLE_TAU_MIN)

    def to_params(self) -> dict[str, Any]:
        return {"amplitude": self.amplitude, "exponent": self.exponent, "duration_h": self.duration_h}


class NoiseSource:
    """Stateless-looking, chunk-cached deterministic noise: N(0,1) per (asset, minute, channel)."""

    CHANNELS = 4  # vib, temp, current, speed

    def __init__(self, seed: int) -> None:
        self.seed = seed
        self._cache: dict[tuple[int, int], np.ndarray] = {}

    def get(self, asset_index: int, t: datetime) -> np.ndarray:
        m = _minute_index(t)
        chunk, offset = divmod(m, CHUNK_MINUTES)
        key = (asset_index, chunk)
        arr = self._cache.get(key)
        if arr is None:
            rng = np.random.default_rng([self.seed, asset_index, chunk])
            arr = rng.standard_normal((CHUNK_MINUTES, self.CHANNELS))
            if len(self._cache) > 64:
                self._cache.clear()
            self._cache[key] = arr
        return arr[offset]

    def load_step(self, asset_index: int, t: datetime) -> float:
        block = int((t - _EPOCH).total_seconds() // (STEP_BLOCK_HOURS * 3600))
        rng = np.random.default_rng([self.seed, asset_index, 7_000_000 + block])
        return float(rng.uniform(-STEP_AMPLITUDE, STEP_AMPLITUDE))


def load_at(t: datetime, step: float) -> float:
    hour = t.hour + t.minute / 60.0 + t.second / 3600.0
    raw = 0.80 + 0.15 * math.sin(2 * math.pi * (hour - 7.0) / 24.0) + step
    return float(min(1.0, max(0.55, raw)))


def sample_asset(
    t: datetime,
    asset_index: int,
    params: dict[str, Any],
    noise: NoiseSource,
    fault: WearFault | None,
) -> dict[str, float]:
    """Return the true (pre-transport) readings of one asset at sim time ``t``."""
    n = noise.get(asset_index, t)
    load = load_at(t, noise.load_step(asset_index, t))
    d = fault.d(t) if fault else 0.0
    vib = params["vib_base"] + params["vib_gain"] * load + params["vib_noise"] * n[0] + d
    temp = params["temp_base"] + params["temp_gain"] * load + params["fault_vib_to_temp"] * d + params["temp_noise"] * n[1]
    cur = params["cur_gain"] * load + params["fault_vib_to_cur"] * d + params["cur_noise"] * n[2]
    spd = 100.0 * load + 0.1 * n[3]
    return {
        "vibration_velocity": max(0.0, round(vib, 4)),
        "bearing_temperature": round(temp, 3),
        "motor_current": max(0.0, round(cur, 4)),
        "speed_command": round(spd, 3),
        "_load": load,
        "_degradation": d,
    }
