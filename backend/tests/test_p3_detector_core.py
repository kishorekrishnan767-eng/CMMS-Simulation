"""Pure detector tests: no database. Physics → detector, 72 h × 5 seeds and the fault scenario."""
from datetime import datetime, timedelta

import pytest

from app.modules.assets.seed import ASSETS, FAN_SIM, SIM_EPOCH
from app.modules.monitoring.detector import (
    Baseline, ResidualTracker, VibrationDetector, severity, severity_abs, severity_stat,
)
from app.modules.simulation.physics import NoiseSource, WearFault, sample_asset


def _params(asset):
    return {**FAN_SIM, **asset["sim"]}


def run_asset(seed, asset_index, params, minutes, fault=None, start=SIM_EPOCH, limits=(4.5, 7.1, 11.0)):
    """Feed the detector minute by minute. Returns (detector, list of step results)."""
    noise = NoiseSource(seed)
    det = VibrationDetector(limits=limits)
    steps = []
    for i in range(1, minutes + 1):
        t = start + timedelta(minutes=i)
        s = sample_asset(t, asset_index, params, noise, fault)
        res = det.update((t - SIM_EPOCH).total_seconds() / 3600.0, s["vibration_velocity"], s["speed_command"] / 100.0)
        steps.append((t, s, res))
    return det, steps


@pytest.mark.parametrize("seed", [1, 7, 42, 123, 2026])
def test_healthy_72h_has_no_anomaly_on_any_asset(seed):
    for idx, asset in enumerate(sorted(ASSETS, key=lambda a: a["id"]), start=1):
        _, steps = run_asset(seed, idx, _params(asset), 72 * 60)
        anomalies = [t for t, _, r in steps if r.state == "ANOMALY"]
        assert not anomalies, f"false ANOMALY seed={seed} asset={asset['id']} at {anomalies[:1]}"


def test_healthy_watch_is_rare():
    watch = total = 0
    for seed in (1, 7, 42):
        for idx, asset in enumerate(sorted(ASSETS, key=lambda a: a["id"]), start=1):
            _, steps = run_asset(seed, idx, _params(asset), 72 * 60)
            watch += sum(1 for _, _, r in steps if r.state == "WATCH")
            total += len(steps)
    assert watch / total < 0.02, watch / total


@pytest.mark.parametrize("seed", [1, 7, 42, 123, 2026])
def test_fault_detected_before_alarm_limit_with_lead_time(seed):
    asset = next(a for a in ASSETS if a["id"] == "AHU-02-FAN-01")
    t0 = SIM_EPOCH + timedelta(hours=8)
    fault = WearFault(t0=t0, amplitude=7.0, exponent=2.0, duration_h=1.5)
    _, steps = run_asset(seed, 1, _params(asset), 8 * 60 + 150, fault=fault)
    detect = next((t for t, _, r in steps if r.state == "ANOMALY"), None)
    crossing = next((t for t, s, _ in steps if t > t0 and s["vibration_velocity"] >= 7.1), None)
    assert detect is not None and crossing is not None
    assert detect < crossing
    horizon = (crossing - t0).total_seconds()
    lead = (crossing - detect).total_seconds()
    assert lead >= 0.30 * horizon, f"lead {lead/60:.0f} min of {horizon/60:.0f} min horizon"


def test_state_machine_transitions_and_hysteresis():
    asset = next(a for a in ASSETS if a["id"] == "AHU-02-FAN-01")
    t0 = SIM_EPOCH + timedelta(hours=8)
    fault = WearFault(t0=t0)
    det, steps = run_asset(5, 1, _params(asset), 8 * 60 + 150, fault=fault)
    seq = [r.state for _, _, r in steps]
    first_watch = seq.index("WATCH")
    first_anom = seq.index("ANOMALY")
    assert first_watch < first_anom
    assert all(s == "NORMAL" for s in seq[:first_watch])
    # once ANOMALY, it stays ANOMALY until cleared explicitly
    assert set(seq[first_anom:]) == {"ANOMALY"}
    assert any("ESCALATED" in r.transitions for _, _, r in steps)
    det.clear()
    assert det.state == "CLEARED"


def test_anomaly_baseline_is_frozen_while_not_normal():
    asset = next(a for a in ASSETS if a["id"] == "AHU-02-FAN-01")
    t0 = SIM_EPOCH + timedelta(hours=8)
    det, steps = run_asset(3, 1, _params(asset), 8 * 60 + 20, fault=WearFault(t0=t0))
    before = list(det.baseline.window)
    noise = NoiseSource(3)
    start = SIM_EPOCH + timedelta(minutes=8 * 60 + 20)
    for i in range(1, 30):
        t = start + timedelta(minutes=i)
        s = sample_asset(t, 1, _params(asset), noise, WearFault(t0=t0))
        det.update((t - SIM_EPOCH).total_seconds() / 3600.0, s["vibration_velocity"], s["speed_command"] / 100.0)
    assert det.state in ("WATCH", "ANOMALY")
    assert list(det.baseline.window) == before


def test_single_spike_does_not_trigger_anomaly():
    asset = next(a for a in ASSETS if a["id"] == "AHU-02-FAN-01")
    noise = NoiseSource(11)
    det = VibrationDetector()
    states = set()
    for i in range(1, 600):
        t = SIM_EPOCH + timedelta(minutes=i)
        s = sample_asset(t, 1, _params(asset), noise, None)
        v = s["vibration_velocity"] + (20.0 if i == 400 else 0.0)
        states.add(det.update(i / 60.0, v, s["speed_command"] / 100.0).state)
    assert "ANOMALY" not in states


def test_load_compensation_normal_load_steps_do_not_alert():
    """Large legitimate load changes are explained by the baseline (v rises with load)."""
    params = _params(ASSETS[0])
    det = VibrationDetector()
    import numpy as np
    rng = np.random.default_rng(0)
    states = set()
    for i in range(1, 900):
        load = 0.62 + 0.38 * (0.5 + 0.5 * np.sin(i / 90.0))
        v = params["vib_base"] + params["vib_gain"] * load + rng.normal(0, 0.08)
        states.add(det.update(i / 60.0, float(v), float(load)).state)
    assert "ANOMALY" not in states


def test_severity_rules():
    assert severity_stat(3.4) == "NONE" and severity_stat(3.5) == "LOW"
    assert severity_stat(6) == "MEDIUM" and severity_stat(10) == "HIGH"
    lim = (4.5, 7.1, 11.0)
    assert severity_abs(4.4, *lim) == "NONE" and severity_abs(4.5, *lim) == "MEDIUM"
    assert severity_abs(7.1, *lim) == "HIGH" and severity_abs(11.0, *lim) == "CRITICAL"
    assert severity(3.6, 11.5, lim) == "CRITICAL"          # max of the two rules
    assert severity(12.0, 2.0, lim) == "HIGH"


def test_baseline_robust_sigma_has_floor_and_ignores_outliers():
    b = Baseline()
    for i in range(120):
        load = 0.7 + 0.002 * i
        b.add(load, 0.5 + 1.5 * load + (50.0 if i == 60 else 0.0))
    b.fit()
    assert b.sigma == 0.05  # MAD of a near-perfect fit is below the floor
    assert abs(b.b - 1.5) < 0.6


def test_corroboration_tracker_flags_shift():
    tr = ResidualTracker()
    import numpy as np
    rng = np.random.default_rng(1)
    for i in range(150):
        load = 0.7 + 0.1 * np.sin(i / 20)
        tr.update(float(load), float(42 + 12 * load + rng.normal(0, 0.4)), True)
    assert not tr.corroborates()
    for i in range(6):
        tr.update(0.75, 42 + 12 * 0.75 + 3.0, False)
    assert tr.corroborates()


def test_projection_is_indicative_and_handles_edge_cases():
    assert VibrationDetector.projection_hours(5.0, 2.0, 7.1) == pytest.approx(1.05)
    assert VibrationDetector.projection_hours(8.0, 2.0, 7.1) == 0.0
    assert VibrationDetector.projection_hours(3.0, 0.0, 7.1) is None
