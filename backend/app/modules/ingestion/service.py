"""Layer 3 — telemetry validation and processing.

Per reading, in this order (the first failure stops processing and is stored in
``rejected_telemetry`` with a reason; nothing is silently dropped):

 1. SCHEMA            required fields and types
 2. DUPLICATE         event_id already stored / processed → no side effects
 3. UNKNOWN_SENSOR / SENSOR_ASSET_MISMATCH / METRIC_MISMATCH   referential checks
 4. UNIT_MISMATCH     unit must equal the sensor's expected unit
 5. FUTURE_TIMESTAMP  timestamp > sim_now + 1 min
    LATE              timestamp older than the asset watermark by > 5 min → stored (status LATE),
                      NOT fed to the detector, flagged in rejected_telemetry for review
 6. OUT_OF_RANGE      outside the sensor's plausibility range → quarantined
 7. FLATLINE          last 15 values identical (ε = 1e-9) → quality SUSPECT_FLATLINE, not fed
 8. GAP               gap > 3 sample intervals → DataQualityWarning, sensor quality STALE

The raw reading is stored first; ``TelemetryAccepted`` carries good readings only (one event per
batch, see ASSUMPTIONS #5).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import write_session
from app.models import Asset, ProcessedEvent, RejectedTelemetry, Sensor, TelemetryReading
from app.modules.events import bus

FLATLINE_WINDOW = 15
FLATLINE_EPS = 1e-9
LATE_AFTER = timedelta(minutes=5)
FUTURE_TOLERANCE = timedelta(minutes=1)
GAP_INTERVALS = 3
REQUIRED = {"event_id": str, "asset_id": str, "sensor_id": str, "metric": str, "unit": str, "timestamp": str}


def _schema_error(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return "reading must be an object"
    for key, typ in REQUIRED.items():
        if key not in raw or not isinstance(raw[key], typ) or not raw[key]:
            return f"missing or invalid '{key}'"
    v = raw.get("value")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return "missing or invalid 'value'"
    try:
        clock.parse_iso(raw["timestamp"])
    except ValueError:
        return "timestamp is not ISO-8601"
    return None


def ingest_batch(readings: list[dict[str, Any]], source: str = "api") -> dict[str, Any]:
    """Validate and store a batch in one transaction, then publish events. Returns a summary."""
    results: list[dict[str, Any]] = []
    with write_session() as s:
        now = clock.sim_now(s)
        sensors = {x.id: x for x in s.scalars(select(Sensor))}
        assets = {a.id: a for a in s.scalars(select(Asset))}
        ids = [r["event_id"] for r in readings if isinstance(r, dict) and isinstance(r.get("event_id"), str)]
        known: set[str] = set()
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            known |= set(s.scalars(select(TelemetryReading.event_id).where(TelemetryReading.event_id.in_(chunk))))
            known |= set(s.scalars(select(ProcessedEvent.event_id).where(ProcessedEvent.event_id.in_(chunk))))
        accepted: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []
        late = suspect = 0

        def reject(raw: Any, reason: str, detail: str, status: str = "REJECTED") -> None:
            sid = raw.get("sensor_id") if isinstance(raw, dict) else None
            eid = raw.get("event_id") if isinstance(raw, dict) else None
            aid = raw.get("asset_id") if isinstance(raw, dict) else None
            s.add(RejectedTelemetry(event_id=eid if isinstance(eid, str) else None,
                                    asset_id=aid if isinstance(aid, str) else None,
                                    sensor_id=sid if isinstance(sid, str) else None,
                                    reason=reason, detail=detail,
                                    raw=raw if isinstance(raw, dict) else {"value": repr(raw)}, received_at=now))
            rejected.append({"event_id": eid, "sensor_id": sid, "asset_id": aid, "reason": reason, "detail": detail})
            results.append({"event_id": eid, "status": status, "reason": reason})

        for raw in sorted((r for r in readings), key=lambda r: r.get("timestamp", "") if isinstance(r, dict) else ""):
            err = _schema_error(raw)
            if err:
                reject(raw, "SCHEMA", err)
                continue
            eid = raw["event_id"]
            if eid in known:
                reject(raw, "DUPLICATE", "event_id already processed — ignored without side effects", "DUPLICATE")
                continue
            sensor = sensors.get(raw["sensor_id"])
            if sensor is None:
                reject(raw, "UNKNOWN_SENSOR", f"sensor '{raw['sensor_id']}' is not registered")
                continue
            if sensor.asset_id != raw["asset_id"]:
                reject(raw, "SENSOR_ASSET_MISMATCH", f"sensor {sensor.id} belongs to {sensor.asset_id}, not {raw['asset_id']}")
                continue
            if sensor.metric != raw["metric"]:
                reject(raw, "METRIC_MISMATCH", f"sensor {sensor.id} measures {sensor.metric}, not {raw['metric']}")
                continue
            if sensor.unit != raw["unit"]:
                reject(raw, "UNIT_MISMATCH", f"expected unit '{sensor.unit}', received '{raw['unit']}'")
                continue
            ts = clock.parse_iso(raw["timestamp"])
            if ts > now + FUTURE_TOLERANCE:
                reject(raw, "FUTURE_TIMESTAMP", f"timestamp {raw['timestamp']} is ahead of simulation time")
                continue
            value = float(raw["value"])
            if not sensor.range_min <= value <= sensor.range_max:
                reject(raw, "OUT_OF_RANGE", f"{value} {sensor.unit} outside plausible range "
                                            f"[{sensor.range_min}, {sensor.range_max}]", "QUARANTINED")
                continue
            asset = assets[sensor.asset_id]
            known.add(eid)

            is_late = asset.watermark is not None and ts < asset.watermark - LATE_AFTER
            quality, status, feed = "GOOD", "ACCEPTED", True
            if is_late:
                quality, status, feed = "LATE", "LATE", False
                late += 1
            else:
                prev, prev_ts = sensor.last_value, sensor.last_timestamp
                if prev is not None and abs(value - prev) < FLATLINE_EPS:
                    sensor.flat_count += 1
                else:
                    sensor.flat_count = 0
                if sensor.flat_count >= FLATLINE_WINDOW - 1:
                    quality, status, feed = "SUSPECT_FLATLINE", "SUSPECT", False
                    suspect += 1
                    sensor.quality = "SUSPECT_FLATLINE"
                else:
                    if prev_ts is not None and ts - prev_ts > timedelta(minutes=GAP_INTERVALS * clock.SAMPLE_INTERVAL_MIN):
                        warnings.append({"sensor_id": sensor.id, "asset_id": asset.id, "kind": "GAP",
                                         "gap_minutes": (ts - prev_ts).total_seconds() / 60.0,
                                         "message": f"No data from {sensor.id} for {(ts - prev_ts).total_seconds() / 60:.0f} min"})
                    sensor.quality = "GOOD"
                sensor.last_value = value
                sensor.last_timestamp = ts
                if asset.watermark is None or ts > asset.watermark:
                    asset.watermark = ts
            row = TelemetryReading(event_id=eid, asset_id=asset.id, sensor_id=sensor.id, metric=sensor.metric,
                                   value=value, unit=sensor.unit, timestamp=ts, received_at=now,
                                   source=source, quality=quality, status=status, fed_to_detector=feed)
            s.add(row)
            s.flush()
            if is_late:
                s.add(RejectedTelemetry(event_id=eid, asset_id=asset.id, sensor_id=sensor.id, reason="LATE_EVENT",
                                        detail=f"timestamp {raw['timestamp']} is more than 5 min behind the asset watermark "
                                               f"— stored for review, not fed to the detector",
                                        raw=raw, received_at=now))
                rejected.append({"event_id": eid, "sensor_id": sensor.id, "asset_id": asset.id, "reason": "LATE_EVENT",
                                 "detail": "stored for review, not fed to the detector"})
            elif quality == "SUSPECT_FLATLINE":
                warnings.append({"sensor_id": sensor.id, "asset_id": asset.id, "kind": "FLATLINE",
                                 "message": f"{sensor.id} reported an identical value {FLATLINE_WINDOW} times in a row"})
            if feed:
                accepted.append({"id": row.id, "sensor_id": sensor.id, "asset_id": asset.id, "metric": sensor.metric,
                                 "value": value, "ts": clock.iso(ts), "event_id": eid})
            results.append({"event_id": eid, "status": status, "reason": None if feed else quality})

        if accepted:
            bus.publish(s, "TelemetryAccepted", occurred_at=now, payload={
                "count": len(accepted), "late": late, "suspect": suspect, "readings": accepted,
                "source": source, "from": accepted[0]["ts"], "to": accepted[-1]["ts"]})
        if rejected:
            reasons: dict[str, int] = {}
            for r in rejected:
                reasons[r["reason"]] = reasons.get(r["reason"], 0) + 1
            bus.publish(s, "TelemetryRejected", occurred_at=now, payload={
                "count": len(rejected), "reasons": reasons, "items": rejected[:20]})
        for w in warnings:
            bus.publish(s, "DataQualityWarning", asset_id=w["asset_id"], occurred_at=now, payload=w)
    return {"received": len(readings), "accepted": len(accepted), "rejected": len(rejected),
            "late": late, "suspect": suspect, "warnings": len(warnings), "results": results}


def sweep_stale(now: datetime) -> None:
    """Tick hook: flag sensors that have gone silent for more than 3 sample intervals as STALE."""
    cutoff = now - timedelta(minutes=GAP_INTERVALS * clock.SAMPLE_INTERVAL_MIN)
    with write_session() as s:
        for sensor in s.scalars(select(Sensor).where(Sensor.quality == "GOOD", Sensor.last_timestamp < cutoff)):
            sensor.quality = "STALE"
            bus.publish(s, "DataQualityWarning", asset_id=sensor.asset_id, occurred_at=now, payload={
                "sensor_id": sensor.id, "asset_id": sensor.asset_id, "kind": "STALE",
                "message": f"{sensor.id} has not reported since {clock.iso(sensor.last_timestamp)}"})


def quality_summary(session: Session, asset_id: str) -> dict[str, str]:
    return {s.metric: s.quality for s in session.scalars(select(Sensor).where(Sensor.asset_id == asset_id))}
