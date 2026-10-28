"""Layer 4 — transparent condition-monitoring statistics. Pure Python/numpy, no database.

Load-compensated baseline (so normal load changes do not trigger alerts)::

    W      = last 120 samples recorded while the asset state was NORMAL (frozen otherwise)
    fit      v ≈ a + b*load            (ordinary least squares; load = speed_pct/100)
    r_t    = v_t − (a + b*load_t)      residual
    σ      = max(1.4826 * MAD(residuals in W), σ_min = 0.05)     robust standard deviation
    z_t    = r_t / σ
    slope  = OLS slope of r over the last K = 15 samples, in mm/s per hour
    persistence = number of the last N = 10 samples with z ≥ 3.5

State machine with hysteresis::

    NORMAL  → WATCH    z ≥ 2.5 for 3 consecutive samples, OR (slope ≥ 0.5 mm/s/h AND mean z of the last 3 samples ≥ 1.5)
    WATCH   → NORMAL   z < 2.0 for 5 consecutive samples
    WATCH   → ANOMALY  persistence ≥ M = 6 (of N = 10) AND slope > 0
    ANOMALY → CLEARED  only through ``clear()`` (verification pass or supervisor)
    CLEARED → NORMAL   z < 1.5 for 10 consecutive samples

The extra 3-sample ``mean z ≥ 1.5`` guard on the slope trigger (documented in ASSUMPTIONS) stops pure sensor noise
from producing a WATCH about 4 % of the time: a 15-sample slope of noise alone has σ≈0.29 mm/s/h.

Severity = max(statistical, absolute)::

    z ≥ 3.5 → LOW, z ≥ 6 → MEDIUM, z ≥ 10 → HIGH              (statistical)
    v ≥ 4.5 → MEDIUM, v ≥ 7.1 → HIGH, v ≥ 11.0 → CRITICAL     (absolute, per-asset DEMO limits)

All numbers are demo values, not taken from any standard. An anomaly is not a diagnosis.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np

DETECTOR_VERSION = "det-1.0"
WINDOW = 120
MIN_SAMPLES = 30
SIGMA_MIN = 0.05
SLOPE_K = 15
PERSIST_N = 10
PERSIST_M = 6
Z_PERSIST = 3.5
Z_WATCH = 2.5
Z_WATCH_EXIT = 2.0
Z_CLEAR = 1.5
SLOPE_WATCH = 0.5          # mm/s per hour
WATCH_CONSEC = 3
WATCH_EXIT_CONSEC = 5
CLEAR_CONSEC = 10
LOAD_STD_MIN = 0.02        # load spread (std) below which the slope b is shrunk toward its prior
GENERIC_B_PRIOR = 1.0      # mm/s per unit load: vibration generally rises with speed
VIBRATION_B_MAX = 6.0      # mm/s per unit load: the largest believable vibration-vs-load slope (vibration only)
SEVERITY_RANK = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}
SEVERITY_BY_RANK = {v: k for k, v in SEVERITY_RANK.items()}


def mad(x: np.ndarray) -> float:
    return float(np.median(np.abs(x - np.median(x))))


def severity_stat(z: float) -> str:
    return "HIGH" if z >= 10 else "MEDIUM" if z >= 6 else "LOW" if z >= Z_PERSIST else "NONE"


def severity_abs(v: float, warn: float, alarm: float, critical: float) -> str:
    return "CRITICAL" if v >= critical else "HIGH" if v >= alarm else "MEDIUM" if v >= warn else "NONE"


def severity(z: float, v: float, limits: tuple[float, float, float]) -> str:
    rank = max(SEVERITY_RANK[severity_stat(z)], SEVERITY_RANK[severity_abs(v, *limits)])
    return SEVERITY_BY_RANK[rank]


def ols_slope(ts_h: list[float], ys: list[float]) -> float:
    """OLS slope of ys against ts_h (hours). 0.0 if undefined."""
    n = len(ts_h)
    if n < 3:
        return 0.0
    x = np.asarray(ts_h)
    y = np.asarray(ys)
    xm = x - x.mean()
    denom = float((xm * xm).sum())
    return float((xm * (y - y.mean())).sum() / denom) if denom > 1e-12 else 0.0


class Baseline:
    """Rolling healthy window (120 samples) with an OLS(load) fit and a robust sigma.

    Deviation from the plain 120-sample OLS (documented in ASSUMPTIONS #21): within a 2-hour window
    the load barely varies, so the slope b is poorly identified and the baseline drifts as soon as the
    window freezes during WATCH. b is therefore fitted on a longer healthy history (up to 24 h, one
    sample in five) while the intercept a and σ still come from the 120-sample window.

    The fitted slope is kept in ``[0, b_max]``. ``b_max`` is metric-specific: vibration is in mm/s and
    never rises faster than ``VIBRATION_B_MAX`` per unit load, so it is capped there. Temperature (°C) and
    motor current (A) have no such physical cap in these units (a chiller draws ~60 A per unit load, a fan
    ~10 A, a fan's bearing temperature rises ~12 °C): capping them at the vibration limit gave a baseline that
    was wrong as soon as the load left the range it was learned in, so a healthy, repaired machine could be
    3σ "abnormal" on current at higher load and fail verification. Those channels therefore use
    ``b_max=None`` (only ``b ≥ 0``); the ridge shrinkage (see ``_ridge_b``) still guards a flat load.
    """

    LONG = 288          # 24 h at one stored sample per 5 minutes
    LONG_STRIDE = 5
    LONG_MIN = 40

    def __init__(self, mem: dict[str, Any] | None = None, b_max: float | None = VIBRATION_B_MAX) -> None:
        mem = mem or {}
        self.b_max = b_max
        self.window: deque[tuple[float, float]] = deque(((float(a), float(b)) for a, b in mem.get("window", [])), maxlen=WINDOW)
        self.long: deque[tuple[float, float]] = deque(((float(a), float(b)) for a, b in mem.get("long", [])), maxlen=self.LONG)
        self.n_added: int = int(mem.get("n_added", 0))
        self.a = 0.0
        self.b = float(mem.get("b", GENERIC_B_PRIOR))
        self.sigma = SIGMA_MIN
        self._dirty = True
        self.fit()

    @property
    def ready(self) -> bool:
        return len(self.window) >= MIN_SAMPLES

    @staticmethod
    def _ridge_b(pts: deque[tuple[float, float]], prior: float) -> float:
        """OLS slope shrunk toward ``prior`` when the load spread is small:
        b = (Sxy + λ·prior) / (Sxx + λ),  λ = n·0.02²  (≈ n pseudo-points with a 0.02 load spread).
        With a healthy load range the shrinkage is negligible; with a flat load b simply keeps its prior."""
        arr = np.asarray(pts)
        load, v = arr[:, 0], arr[:, 1]
        lm, vm = load.mean(), v.mean()
        sxx = float(((load - lm) ** 2).sum())
        sxy = float(((load - lm) * (v - vm)).sum())
        lam = len(arr) * LOAD_STD_MIN ** 2
        return (sxy + lam * prior) / (sxx + lam)

    def fit(self) -> None:
        if len(self.window) < 3:
            self._dirty = False
            return
        src = self.long if len(self.long) >= self.LONG_MIN else self.window
        b = self._ridge_b(src, self.b)
        self.b = max(0.0, b if self.b_max is None else min(self.b_max, b))
        arr = np.asarray(self.window)
        load, v = arr[:, 0], arr[:, 1]
        a = float(v.mean() - self.b * load.mean())
        resid = v - (a + self.b * load)
        self.a = a
        self.sigma = max(1.4826 * mad(resid), SIGMA_MIN)
        self._dirty = False

    def expected(self, load: float) -> float:
        return self.a + self.b * load

    def residual(self, load: float, value: float) -> float:
        return value - self.expected(load)

    def add(self, load: float, value: float) -> None:
        self.window.append((load, value))
        self.n_added += 1
        if self.n_added % self.LONG_STRIDE == 0:
            self.long.append((load, value))
        self._dirty = True

    def refit_if_needed(self) -> None:
        if self._dirty:
            self.fit()

    def to_dict(self) -> dict[str, Any]:
        return {"window": [[round(a, 5), round(b, 5)] for a, b in self.window],
                "long": [[round(a, 4), round(b, 4)] for a, b in self.long],
                "n_added": self.n_added, "b": round(self.b, 5)}


@dataclass
class StepResult:
    ts_h: float
    value: float
    load: float
    expected: float
    residual: float
    z: float
    slope: float
    persistence: int
    consecutive_anomalous: int
    sigma: float
    state: str
    prev_state: str
    severity: str
    transitions: list[str] = field(default_factory=list)


class ResidualTracker:
    """Corroborating channel (temperature, current): residual z against its own load baseline."""

    def __init__(self, memory: dict[str, Any] | None = None) -> None:
        mem = memory or {}
        self.baseline = Baseline(mem.get("baseline"), b_max=None)  # °C / A per unit load: not capped like mm/s
        self.recent_z: deque[float] = deque((float(x) for x in mem.get("recent_z", [])), maxlen=5)
        self.last_z: float = float(mem.get("last_z", 0.0))

    def update(self, load: float, value: float, allow_update: bool) -> float:
        self.baseline.refit_if_needed()
        if not self.baseline.ready:
            self.baseline.add(load, value)
            self.last_z = 0.0
            return 0.0
        z = self.baseline.residual(load, value) / self.baseline.sigma
        self.recent_z.append(z)
        self.last_z = z
        if allow_update:
            self.baseline.add(load, value)
        return z

    def corroborates(self, threshold: float = 3.0) -> bool:
        """Mean z of the last 5 samples ≥ threshold (damps single-sample noise)."""
        return len(self.recent_z) >= 3 and float(np.mean(self.recent_z)) >= threshold

    def to_dict(self) -> dict[str, Any]:
        return {"baseline": self.baseline.to_dict(), "recent_z": [round(z, 3) for z in self.recent_z],
                "last_z": round(self.last_z, 3)}


class VibrationDetector:
    """Primary-metric detector with the NORMAL/WATCH/ANOMALY/CLEARED state machine."""

    def __init__(self, memory: dict[str, Any] | None = None, limits: tuple[float, float, float] = (4.5, 7.1, 11.0)) -> None:
        mem = memory or {}
        self.limits = limits
        self.baseline = Baseline(mem.get("baseline"))
        self.state: str = mem.get("state", "NORMAL")
        self.recent: deque[tuple[float, float]] = deque(((float(a), float(b)) for a, b in mem.get("recent", [])), maxlen=SLOPE_K)
        self.zs: deque[float] = deque((float(x) for x in mem.get("zs", [])), maxlen=3)
        self.flags: deque[bool] = deque((bool(x) for x in mem.get("flags", [])), maxlen=PERSIST_N)
        self.watch_run: int = mem.get("watch_run", 0)
        self.calm_run: int = mem.get("calm_run", 0)
        self.clear_run: int = mem.get("clear_run", 0)
        self.consec_anom: int = mem.get("consec_anom", 0)
        self.severity: str = mem.get("severity", "NONE")
        self.onset_h: float | None = mem.get("onset_h")
        self.last_load: float = mem.get("last_load", 0.8)

    # ------------------------------------------------------------------ evaluation
    def update(self, ts_h: float, value: float, load: float) -> StepResult:
        self.last_load = load
        b = self.baseline
        b.refit_if_needed()
        prev_state = self.state
        transitions: list[str] = []
        if not b.ready:
            b.add(load, value)
            return StepResult(ts_h, value, load, b.expected(load), 0.0, 0.0, 0.0, 0, 0, b.sigma, self.state,
                              prev_state, self.severity, transitions)

        resid = b.residual(load, value)
        z = resid / b.sigma
        self.recent.append((ts_h, resid))
        slope = ols_slope([t for t, _ in self.recent], [r for _, r in self.recent])
        self.flags.append(z >= Z_PERSIST)
        self.zs.append(z)
        persistence = sum(self.flags)
        self.consec_anom = self.consec_anom + 1 if z >= Z_PERSIST else 0

        self.watch_run = self.watch_run + 1 if z >= Z_WATCH else 0
        self.calm_run = self.calm_run + 1 if z < Z_WATCH_EXIT else 0
        self.clear_run = self.clear_run + 1 if z < Z_CLEAR else 0

        if self.state in ("NORMAL", "CLEARED"):
            if self.state == "CLEARED" and self.clear_run >= CLEAR_CONSEC:
                self._to("NORMAL", transitions)
            elif self.watch_run >= WATCH_CONSEC or (slope >= SLOPE_WATCH and len(self.zs) == 3 and sum(self.zs) / 3 >= Z_CLEAR):
                if self.onset_h is None:
                    self.onset_h = self._onset(ts_h)
                self._to("WATCH", transitions)
        elif self.state == "WATCH":
            if persistence >= PERSIST_M and slope > 0:
                self._to("ANOMALY", transitions)
                self.severity = severity(z, value, self.limits)
                transitions.append("ANOMALY_DETECTED")
            elif self.calm_run >= WATCH_EXIT_CONSEC:
                self.onset_h = None
                self._to("NORMAL", transitions)
        elif self.state == "ANOMALY":
            sev = severity(z, value, self.limits)
            if SEVERITY_RANK[sev] > SEVERITY_RANK[self.severity]:
                self.severity = sev
                transitions.append("ESCALATED")

        if self.state == "NORMAL":
            self.severity = "NONE"
            b.add(load, value)  # healthy window only grows while NORMAL (frozen otherwise)
        return StepResult(ts_h, value, load, b.expected(load), resid, z, slope, persistence, self.consec_anom,
                          b.sigma, self.state, prev_state, self.severity, transitions)

    def _onset(self, ts_h: float) -> float:
        """Start of the current deviation: first of the recent samples that was already elevated."""
        sig = max(self.baseline.sigma, SIGMA_MIN)
        for t, r in self.recent:
            if r / sig >= 1.5:
                return t
        return ts_h

    def _to(self, new: str, transitions: list[str]) -> None:
        if new != self.state:
            transitions.append(f"{self.state}->{new}")
            self.state = new
            if new == "NORMAL":
                self.severity = "NONE"
                self.onset_h = None

    def clear(self) -> None:
        """Layer 7 verification pass or supervisor action: ANOMALY → CLEARED (baseline stays frozen)."""
        if self.state in ("ANOMALY", "WATCH"):
            self.state = "CLEARED"
            self.severity = "NONE"
            self.clear_run = 0
            self.watch_run = 0
            self.flags.clear()
            self.consec_anom = 0
            self.onset_h = None

    # ------------------------------------------------------------------ projection
    @staticmethod
    def projection_hours(v_now: float, slope: float, alarm_limit: float) -> float | None:
        """Indicative linear trend extrapolation: hours until the alarm limit. Not a prediction."""
        if v_now >= alarm_limit:
            return 0.0
        if slope <= 1e-9:
            return None
        return (alarm_limit - v_now) / slope

    def to_dict(self) -> dict[str, Any]:
        return {
            "baseline": self.baseline.to_dict(), "state": self.state,
            "recent": [[round(t, 6), round(r, 5)] for t, r in self.recent], "flags": [bool(f) for f in self.flags], "zs": [round(x, 3) for x in self.zs],
            "watch_run": self.watch_run, "calm_run": self.calm_run, "clear_run": self.clear_run,
            "consec_anom": self.consec_anom, "severity": self.severity, "onset_h": self.onset_h,
            "last_load": self.last_load,
        }
