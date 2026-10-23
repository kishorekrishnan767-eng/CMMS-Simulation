"""Simulation control and fault injection (commands run inside the caller's transaction)."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.errors import Conflict, Invalid, NotFound
from app.models import Asset, FaultInjection, Sensor, SimulationState
from app.modules.events import bus
from app.modules.simulation import engine

SENSOR_FAULTS = ("FLATLINE", "SPIKE", "DROPOUT", "DUPLICATE", "LATE_EVENT", "BAD_UNIT", "UNKNOWN_SENSOR")
DEFAULT_FAULT_MINUTES = {"FLATLINE": 25, "DROPOUT": 8}
FAULT_ALIASES = {"late": "LATE_EVENT", "late_event": "LATE_EVENT", "bad_unit": "BAD_UNIT",
                 "unknown_sensor": "UNKNOWN_SENSOR", "bearing_wear": "BEARING_WEAR"}


def state_dict(session: Session) -> dict[str, Any]:
    st = session.get(SimulationState, 1)
    assert st is not None
    active = session.scalars(select(FaultInjection).where(
        FaultInjection.run_id == st.run_id, FaultInjection.status == "ACTIVE")).all()
    return {
        "sim_now": clock.iso(st.sim_now), "epoch": clock.iso(st.epoch), "running": st.running, "speed": st.speed,
        "seed": st.seed, "profile": st.profile, "repair_effectiveness": st.repair_effectiveness,
        "samples_generated": st.samples_generated, "run_id": st.run_id, "simulated": True,
        "allowed_speeds": list(engine.ALLOWED_SPEEDS),
        "active_faults": [fault_dict(f) for f in active],
    }


def fault_dict(f: FaultInjection) -> dict[str, Any]:
    return {"id": f.id, "asset_id": f.asset_id, "sensor_id": f.sensor_id, "fault_type": f.fault_type,
            "status": f.status, "started_at": clock.iso(f.started_at), "ends_at": clock.iso(f.ends_at),
            "params": f.params, "repairs": f.repairs}


def set_running(session: Session, running: bool) -> dict[str, Any]:
    st = session.get(SimulationState, 1)
    assert st is not None
    st.running = running
    bus.publish(session, "SimulationControl", payload={"running": running, "speed": st.speed})
    return state_dict(session)


def patch(session: Session, speed: float | None, seed: int | None, profile: str | None) -> dict[str, Any]:
    st = session.get(SimulationState, 1)
    assert st is not None
    if speed is not None:
        if speed not in engine.ALLOWED_SPEEDS:
            raise Invalid(f"speed must be one of {list(engine.ALLOWED_SPEEDS)}")
        st.speed = speed
    if profile is not None:
        if profile not in engine.PROFILE_DURATION_H:
            raise Invalid("profile must be 'demo' or 'realistic'")
        st.profile = profile
    if seed is not None:
        # A seed change only takes effect on the next reset (history must stay reproducible).
        st.seed = seed
    bus.publish(session, "SimulationControl", payload={"running": st.running, "speed": st.speed,
                                                       "profile": st.profile, "seed": st.seed})
    return state_dict(session)


def inject_fault(session: Session, asset_id: str, fault_type: str, sensor_id: str | None = None,
                 params: dict[str, Any] | None = None, created_by: str = "user") -> FaultInjection:
    ftype = FAULT_ALIASES.get(fault_type.lower(), fault_type.upper())
    st = session.get(SimulationState, 1)
    assert st is not None
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise NotFound(f"Asset {asset_id} not found")
    params = dict(params or {})
    if ftype == "BEARING_WEAR":
        existing = session.scalar(select(FaultInjection).where(
            FaultInjection.asset_id == asset_id, FaultInjection.fault_type == "BEARING_WEAR",
            FaultInjection.status == "ACTIVE", FaultInjection.run_id == st.run_id))
        if existing:
            raise Conflict(f"Bearing wear is already active on {asset_id}", code="fault_already_active")
        params.setdefault("amplitude", 7.0)
        params.setdefault("exponent", 2.0)
        params.setdefault("duration_h", engine.PROFILE_DURATION_H[st.profile])
        sensor_id = None
        ends_at = None
    elif ftype in SENSOR_FAULTS:
        if ftype != "UNKNOWN_SENSOR":
            sensor = session.get(Sensor, sensor_id) if sensor_id else session.scalar(
                select(Sensor).where(Sensor.asset_id == asset_id, Sensor.is_primary.is_(True)))
            if sensor is None or sensor.asset_id != asset_id:
                raise Invalid("sensor_id must belong to the asset")
            sensor_id = sensor.id
        else:
            sensor_id = None
        minutes = params.get("minutes", DEFAULT_FAULT_MINUTES.get(ftype))
        ends_at = st.sim_now + timedelta(minutes=minutes) if minutes else None
        if ends_at:
            params["minutes"] = minutes
    else:
        raise Invalid(f"Unknown fault type '{fault_type}'")
    row = FaultInjection(run_id=st.run_id, asset_id=asset_id, sensor_id=sensor_id, fault_type=ftype,
                         status="ACTIVE", started_at=st.sim_now, ends_at=ends_at, params=params,
                         repairs=[], created_by=created_by)
    session.add(row)
    session.flush()
    bus.publish(session, "FaultInjected", asset_id=asset_id, payload=fault_dict(row))
    return row


def set_repair_effectiveness(session: Session, value: float) -> dict[str, Any]:
    if not 0.0 <= value <= 1.0:
        raise Invalid("repair effectiveness must be between 0 and 1")
    st = session.get(SimulationState, 1)
    assert st is not None
    st.repair_effectiveness = value
    return state_dict(session)


def apply_repair(session: Session, envelope: dict[str, Any]) -> None:
    """Consumer of ``WorkCompleted``: the simulated world responds to a physical repair.

    The configured effectiveness applies to the NEXT repair only and then reverts to 1.0 (full) so a
    failed-repair demo can follow up with a proper second repair (ASSUMPTIONS #20).
    """
    st = session.get(SimulationState, 1)
    assert st is not None
    asset_id = envelope["asset_id"]
    eff = st.repair_effectiveness
    fault = session.scalar(select(FaultInjection).where(
        FaultInjection.asset_id == asset_id, FaultInjection.fault_type == "BEARING_WEAR",
        FaultInjection.status == "ACTIVE", FaultInjection.run_id == st.run_id))
    applied = fault is not None
    if fault is not None:
        fault.repairs = [*fault.repairs, {"at": clock.iso(envelope_time(envelope, st)), "effectiveness": eff}]
        if eff >= 0.999:
            fault.status = "REPAIRED"
            fault.ends_at = st.sim_now
    st.repair_effectiveness = 1.0
    bus.publish(session, "RepairApplied", asset_id=asset_id, correlation_id=envelope.get("correlation_id"),
                payload={"effectiveness": eff, "fault_active": applied, "work_order": envelope["payload"].get("work_order")})


def envelope_time(envelope: dict[str, Any], st: SimulationState):  # noqa: ANN201
    """Repairs take effect at the current sim time (the moment the work was completed)."""
    return st.sim_now
