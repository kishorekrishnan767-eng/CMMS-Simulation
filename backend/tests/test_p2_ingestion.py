"""Layer 3 validation: every rejection is recorded with a reason, nothing is silently dropped."""
from datetime import timedelta

from sqlalchemy import func, select

from app import clock
from app.db import read_session, write_session
from app.models import OutboxEvent, RejectedTelemetry, Sensor, TelemetryReading
from app.modules.simulation import service as sim


def _now(client):
    return client.get("/api/simulation").json()["sim_now"]


def _reading(client, **over):
    base = {"event_id": "evt-test-1", "asset_id": "AHU-02-FAN-01", "sensor_id": "VIB-001",
            "metric": "vibration_velocity", "value": 1.8, "unit": "mm/s", "timestamp": _now(client), "source": "test"}
    base.update(over)
    return base


def _post(client, auth, *readings):
    r = client.post("/api/ingest/telemetry", headers=auth("operator"), json={"readings": list(readings)})
    assert r.status_code == 200, r.text
    return r.json()


def _reasons():
    with read_session() as s:
        return [r.reason for r in s.scalars(select(RejectedTelemetry).order_by(RejectedTelemetry.id))]


def test_good_reading_is_stored(client, auth):
    out = _post(client, auth, _reading(client))
    assert out["accepted"] == 1 and out["rejected"] == 0
    with read_session() as s:
        row = s.scalar(select(TelemetryReading).where(TelemetryReading.event_id == "evt-test-1"))
        assert row.status == "ACCEPTED" and row.quality == "GOOD" and row.fed_to_detector


def test_duplicate_has_no_side_effects(client, auth):
    _post(client, auth, _reading(client))
    with read_session() as s:
        before = s.scalar(select(func.count()).select_from(TelemetryReading))
    out = _post(client, auth, _reading(client))
    assert out["results"][0]["status"] == "DUPLICATE"
    with read_session() as s:
        assert s.scalar(select(func.count()).select_from(TelemetryReading)) == before
    assert _reasons() == ["DUPLICATE"]


def test_all_rejection_reasons_are_recorded(client, auth):
    _post(client, auth,
          _reading(client, event_id="e1", unit="mph"),
          _reading(client, event_id="e2", sensor_id="XXX-999"),
          _reading(client, event_id="e3", sensor_id="VIB-002"),  # belongs to another asset
          _reading(client, event_id="e4", metric="motor_current"),
          _reading(client, event_id="e5", value=500.0),
          _reading(client, event_id="e6", timestamp="2026-03-02T23:59:00Z"),
          {"event_id": "e7", "value": "oops"})
    assert sorted(_reasons()) == sorted(["UNIT_MISMATCH", "UNKNOWN_SENSOR", "SENSOR_ASSET_MISMATCH",
                                         "METRIC_MISMATCH", "OUT_OF_RANGE", "FUTURE_TIMESTAMP", "SCHEMA"])
    with read_session() as s:
        stored = s.scalar(select(func.count()).select_from(TelemetryReading).where(
            TelemetryReading.event_id.in_(["e1", "e2", "e3", "e4", "e5", "e6", "e7"])))
        assert stored == 0
        assert all(r.detail and r.raw for r in s.scalars(select(RejectedTelemetry)))


def test_late_event_is_stored_but_not_fed_to_detector(client, auth):
    old = clock.iso(clock.parse_iso(_now(client)) - timedelta(minutes=25))
    out = _post(client, auth, _reading(client, event_id="late-1", timestamp=old))
    assert out["late"] == 1
    with read_session() as s:
        row = s.scalar(select(TelemetryReading).where(TelemetryReading.event_id == "late-1"))
        assert row.status == "LATE" and row.fed_to_detector is False
    assert "LATE_EVENT" in _reasons()


def test_flatline_detected_after_15_identical_values(client, auth):
    t0 = clock.parse_iso(_now(client))
    for i in range(16):
        _post(client, auth, _reading(client, event_id=f"flat-{i}", value=1.234,
                                     timestamp=clock.iso(t0 + timedelta(seconds=i * 3))))
    with read_session() as s:
        assert s.get(Sensor, "VIB-001").quality == "SUSPECT_FLATLINE"
        flagged = s.scalars(select(TelemetryReading).where(TelemetryReading.quality == "SUSPECT_FLATLINE")).all()
        assert flagged and all(not r.fed_to_detector for r in flagged)


def test_gap_raises_data_quality_warning(client, auth):
    with write_session() as s:
        sim.inject_fault(s, "AHU-02-FAN-01", "dropout", "VIB-001", {"minutes": 6})
    client.post("/api/simulation/step?minutes=9", headers=auth("operator"))
    with read_session() as s:
        warns = s.scalars(select(OutboxEvent).where(OutboxEvent.event_type == "DataQualityWarning")).all()
        assert any(w.payload.get("sensor_id") == "VIB-001" for w in warns)


def test_simulator_faults_flow_through_the_real_pipeline(client, auth):
    with write_session() as s:
        sim.inject_fault(s, "AHU-02-FAN-01", "duplicate", "VIB-001")
        sim.inject_fault(s, "AHU-02-FAN-01", "bad_unit", "TMP-001")
        sim.inject_fault(s, "AHU-02-FAN-01", "unknown_sensor")
        sim.inject_fault(s, "AHU-02-FAN-01", "late_event", "CUR-001")
    client.post("/api/simulation/step?minutes=2", headers=auth("operator"))
    reasons = _reasons()
    for expected in ("DUPLICATE", "UNIT_MISMATCH", "UNKNOWN_SENSOR", "LATE_EVENT"):
        assert expected in reasons, (expected, reasons)
