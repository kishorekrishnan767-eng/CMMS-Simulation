"""The load baseline must learn each metric's real slope: vibration is capped (mm/s), temperature and current are not.

Regression: temperature and motor current shared the vibration cap of 6.0 per unit load. A fan draws ~10 A per
unit load and a chiller ~60 A, so their baselines were wrong as soon as the load left the range they were learned
in, and a healthy, repaired machine could look 3σ "abnormal" on current at higher load and fail verification.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.modules.monitoring.detector import Baseline, ResidualTracker, VibrationDetector, VIBRATION_B_MAX


def _learn(gain: float, base: float, noise: float, b_max: float | None, *, lo: float = 0.55, hi: float = 0.95) -> Baseline:
    """Feed a healthy day (load swinging between ``lo`` and ``hi``) to a baseline and return it, fitted."""
    rng = np.random.default_rng(7)
    b = Baseline(b_max=b_max)
    for i in range(600):
        load = lo + (hi - lo) * (0.5 + 0.5 * np.sin(i / 40.0))
        b.add(float(load), base + gain * float(load) + float(rng.normal(0, noise)))
    b.fit()
    return b


@pytest.mark.parametrize("gain,noise", [(10.0, 0.15), (60.0, 0.6), (18.0, 0.25)])  # fan, chiller, pump motor current (A)
def test_current_baseline_learns_slopes_above_the_vibration_cap(gain: float, noise: float):
    b = _learn(gain, 0.0, noise, b_max=None)
    assert b.b == pytest.approx(gain, rel=0.05)
    # and it predicts a load it was not trained on, within a sigma or two (it was 3σ off with the cap)
    assert abs(b.residual(0.97, gain * 0.97)) < 2.5 * b.sigma


def test_the_old_cap_really_was_the_problem():
    """At a load it was not trained on, the capped baseline is off by several times the noise; the uncapped one is not."""
    capped = _learn(10.0, 0.0, 0.15, b_max=VIBRATION_B_MAX)
    free = _learn(10.0, 0.0, 0.15, b_max=None)
    assert capped.b == VIBRATION_B_MAX
    miss_capped = abs(capped.residual(0.97, 10.0 * 0.97))
    miss_free = abs(free.residual(0.97, 10.0 * 0.97))
    assert miss_capped > 2 * 0.15  # more than two noise-sigmas of a healthy machine's current, from the slope alone
    assert miss_capped > 5 * miss_free


def test_vibration_keeps_its_cap_and_its_normal_slopes():
    assert _learn(30.0, 0.5, 0.08, b_max=VIBRATION_B_MAX).b == VIBRATION_B_MAX  # an implausible vibration slope is still capped
    assert _learn(1.5, 0.5, 0.08, b_max=VIBRATION_B_MAX).b == pytest.approx(1.5, rel=0.1)  # a normal one is untouched


def test_each_detector_gets_the_limit_for_its_unit():
    assert VibrationDetector().baseline.b_max == VIBRATION_B_MAX
    assert ResidualTracker().baseline.b_max is None  # temperature (°C) and current (A) per unit load: not capped like mm/s
    # a restored memory keeps the same rule
    assert ResidualTracker(ResidualTracker().to_dict()).baseline.b_max is None
    assert VibrationDetector(VibrationDetector().to_dict()).baseline.b_max == VIBRATION_B_MAX


def test_the_slope_is_never_negative():
    b = _learn(-5.0, 20.0, 0.1, b_max=None)
    assert b.b == 0.0
