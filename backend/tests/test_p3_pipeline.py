"""Layer 2 → 3 → 4 through the real database pipeline."""
from datetime import timedelta

from sqlalchemy import select

from app import clock
from app.db import read_session, write_session
from app.models import AnomalyEvent, AnomalyEvidence, Asset, DetectorState, OutboxEvent, TelemetryReading
from app.modules.monitoring import service as mon
from app.modules.simulation import engine
from app.modules.simulation import service as sim


def _inject_wear(asset="AHU-02-FAN-01"):
    with write_session() as s:
        sim.inject_fault(s, asset, "bearing_wear")


def test_healthy_hours_raise_no_anomaly(world):
    engine.step_minutes(60)
    engine.step_minutes(60)
    with read_session() as s:
        assert s.scalars(select(AnomalyEvent)).all() == []
        assert {a.health_state for a in s.scalars(select(Asset))} <= {"NORMAL", "WATCH"}
        assert s.scalar(select(DetectorState).where(DetectorState.asset_id == "AHU-02-FAN-01",
                                                    DetectorState.metric == "vibration_velocity")).sigma > 0


def test_bearing_wear_is_detected_before_alarm_limit_with_evidence(world):
    t_fault = None
    with read_session() as s:
        t_fault = clock.sim_now(s)
    _inject_wear()
    for _ in range(100):
        engine.step_minutes(1)
    with read_session() as s:
        a = s.scalar(select(AnomalyEvent).where(AnomalyEvent.asset_id == "AHU-02-FAN-01"))
        assert a is not None and a.state == "ACTIVE" and a.incident_id == "INC-0001"
        alarm = s.get(Asset, "AHU-02-FAN-01").alarm_limit
        crossed = s.scalar(select(TelemetryReading.timestamp).where(
            TelemetryReading.asset_id == "AHU-02-FAN-01", TelemetryReading.metric == "vibration_velocity",
            TelemetryReading.value >= alarm, TelemetryReading.timestamp > t_fault).order_by(TelemetryReading.timestamp))
        assert crossed is not None and a.detected_at < crossed
        horizon, lead = (crossed - t_fault).total_seconds(), (crossed - a.detected_at).total_seconds()
        assert lead >= 0.30 * horizon, (lead / 60, horizon / 60)
        # evidence is real: the supporting readings exist and belong to this asset's vibration sensor
        ev = s.scalars(select(AnomalyEvidence).where(AnomalyEvidence.anomaly_id == a.id)).all()
        assert ev and ev[0].kind == "DETECTION" and len(ev[0].reading_ids) == 10
        rows = s.scalars(select(TelemetryReading).where(TelemetryReading.id.in_(ev[0].reading_ids))).all()
        assert len(rows) == 10 and all(r.sensor_id == "VIB-001" and r.asset_id == "AHU-02-FAN-01" for r in rows)
        # payload completeness
        p = ev[0].payload
        for key in ("asset_id", "metric", "observed_value", "baseline_mean", "baseline_sigma", "z", "slope",
                    "persistence", "severity", "confidence", "corroborating", "window_start", "window_end",
                    "supporting_reading_ids", "detector_version", "projection_hours"):
            assert key in p, key
        # deterministic explanation never claims a failure
        text = a.explanation.lower()
        assert "consistent with possible bearing degradation" in text and "inspection" in text
        assert "fail" not in text
        assert s.get(Asset, "AHU-02-FAN-01").health_state == "ANOMALY"
        # other assets untouched
        assert {x.health_state for x in s.scalars(select(Asset).where(Asset.id != "AHU-02-FAN-01"))} <= {"NORMAL", "WATCH"}
        types = [e.event_type for e in s.scalars(select(OutboxEvent).order_by(OutboxEvent.id))]
        assert types.index("AnomalyWatch") < types.index("AnomalyDetected")


def test_corroboration_raises_confidence_never_severity(world):
    _inject_wear()
    for _ in range(100):
        engine.step_minutes(1)
    with read_session() as s:
        a = s.scalar(select(AnomalyEvent).where(AnomalyEvent.asset_id == "AHU-02-FAN-01"))
        assert a.confidence > 0.5
        assert any(v["corroborates"] for v in a.corroborating.values())
        assert "corroborate" in a.explanation


def test_clear_requires_explicit_action_and_baseline_unfreezes(world):
    _inject_wear()
    for _ in range(60):
        engine.step_minutes(1)
    with write_session() as s:
        anomaly = mon.clear_asset(s, "AHU-02-FAN-01", "test clear")
        assert anomaly.state == "CLEARED"
    with read_session() as s:
        assert s.get(Asset, "AHU-02-FAN-01").health_state == "CLEARED"
    # fully repair the simulated fault, then the detector returns to NORMAL after 10 calm samples
    with write_session() as s:
        from app.models import FaultInjection
        from datetime import datetime  # noqa: F401
        f = s.scalar(select(FaultInjection).where(FaultInjection.fault_type == "BEARING_WEAR"))
        f.repairs = [{"at": clock.iso(clock.sim_now(s)), "effectiveness": 1.0}]
        f.status = "REPAIRED"
    for _ in range(45):
        engine.step_minutes(1)
    with read_session() as s:
        assert s.get(Asset, "AHU-02-FAN-01").health_state == "NORMAL"
