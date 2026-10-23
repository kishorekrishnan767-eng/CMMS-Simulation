"""Core HTTP + WebSocket routes: auth, assets, telemetry, simulation, ingestion, audit, events."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock, wiring
from app.api import schemas
from app.commands import Ctx, execute
from app.db import get_read_db, read_session, write_session
from app.errors import Forbidden, NotFound, Unauthorized
from app.models import (
    Asset, Building, DeadLetter, Floor, OutboxEvent, RejectedTelemetry, Sensor, SimulationState,
    TelemetryReading, User,
)
from app.modules.audit import service as audit
from app.modules.events import bus
from app.modules.ingestion import service as ingestion
from app.modules.simulation import service as sim
from app.security import Actor, check_permission, create_token, current_actor, verify_password

router = APIRouter(prefix="/api")
ws_router = APIRouter()


# --------------------------------------------------------------------------- serializers
def sensor_dict(s: Sensor) -> dict[str, Any]:
    return {"id": s.id, "asset_id": s.asset_id, "kind": s.kind, "metric": s.metric, "unit": s.unit, "label": s.label,
            "is_primary": s.is_primary, "quality": s.quality, "last_value": s.last_value,
            "last_timestamp": clock.iso(s.last_timestamp), "range": [s.range_min, s.range_max]}


def asset_dict(a: Asset) -> dict[str, Any]:
    return {
        "id": a.id, "name": a.name, "asset_type": a.asset_type, "criticality": a.criticality, "status": a.status,
        "health_state": a.health_state, "floor_level": a.floor.level, "floor_name": a.floor.name,
        "required_skills": a.required_skills, "install_date": a.install_date.isoformat(),
        "last_maintenance": a.last_maintenance.isoformat() if a.last_maintenance else None,
        "runtime_hours": a.runtime_hours, "manufacturer": a.manufacturer, "model": a.model,
        "limits": {"warn": a.warn_limit, "alarm": a.alarm_limit, "critical": a.critical_limit, "unit": "mm/s",
                   "note": "Demo values, configurable per asset — not taken from any standard"},
        "position": {"x": a.pos_x, "y": a.pos_y, "z": a.pos_z},
        "sensors": [sensor_dict(s) for s in a.sensors], "simulated": True,
    }


def paginate(limit: int, offset: int) -> tuple[int, int]:
    return max(1, min(limit, 500)), max(0, offset)


# --------------------------------------------------------------------------- auth
@router.post("/auth/login")
def login(body: schemas.LoginIn) -> dict[str, Any]:
    with write_session() as s:
        user = s.scalar(select(User).where(User.username == body.username))
        ok = user is not None and user.active and verify_password(body.password, user.password_hash)
        actor = Actor(user.id, user.username, user.display_name, user.role, user.technician_id) if user \
            else Actor(None, body.username[:40], body.username[:40], "UNKNOWN")
        audit.record(s, actor, "auth.login", "user", body.username[:40], "ALLOWED" if ok else "DENIED",
                     reason=None if ok else "Invalid credentials")
        token = create_token(user) if ok and user else None
    if not ok or user is None or token is None:
        raise Unauthorized("Invalid username or password", code="invalid_credentials")
    return {"access_token": token, "token_type": "bearer", "user": me_dict(actor)}


def me_dict(a: Actor) -> dict[str, Any]:
    from app.security import PERMISSIONS
    return {"id": a.user_id, "username": a.username, "display_name": a.display_name, "role": a.role,
            "technician_id": a.technician_id,
            "permissions": sorted(p for p, roles in PERMISSIONS.items() if a.role in roles)}


@router.get("/me")
def me(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    return me_dict(actor)


@router.get("/auth/demo-users")
def demo_users(db: Session = Depends(get_read_db)) -> list[dict[str, Any]]:
    """Seeded demo accounts for the role-switcher panel (demo only; password is public)."""
    from app.modules.assets.seed import DEMO_PASSWORD
    users = db.scalars(select(User).order_by(User.id)).all()
    return [{"username": u.username, "display_name": u.display_name, "role": u.role,
             "technician_id": u.technician_id, "password": DEMO_PASSWORD} for u in users]


# --------------------------------------------------------------------------- assets
@router.get("/buildings/{building_id}/tree")
def building_tree(building_id: str, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    b = db.get(Building, building_id)
    if b is None:
        raise NotFound(f"Building {building_id} not found")
    floors = db.scalars(select(Floor).where(Floor.building_id == b.id).order_by(Floor.level)).all()
    assets = db.scalars(select(Asset).where(Asset.building_id == b.id).order_by(Asset.id)).all()
    return {
        "id": b.id, "name": b.name, "description": b.description, "address": b.address,
        "floors": [{"level": f.level, "name": f.name, "kind": f.kind, "elevation_m": f.elevation_m,
                    "assets": [{"id": a.id, "name": a.name, "asset_type": a.asset_type, "criticality": a.criticality,
                                "health_state": a.health_state, "status": a.status}
                               for a in assets if a.floor_id == f.id]} for f in floors],
    }


@router.get("/assets")
def list_assets(db: Session = Depends(get_read_db)) -> list[dict[str, Any]]:
    return [asset_dict(a) for a in db.scalars(select(Asset).order_by(Asset.id))]


@router.get("/assets/{asset_id}")
def get_asset(asset_id: str, db: Session = Depends(get_read_db)) -> dict[str, Any]:
    a = db.get(Asset, asset_id)
    if a is None:
        raise NotFound(f"Asset {asset_id} not found")
    return asset_dict(a)


@router.get("/assets/{asset_id}/telemetry")
def asset_telemetry(
    asset_id: str,
    metric: str = "vibration_velocity",
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    hours: float = Query(default=3.0, gt=0, le=72),
    max_points: int = Query(default=600, ge=10, le=5000),
    db: Session = Depends(get_read_db),
) -> dict[str, Any]:
    sensor = db.scalar(select(Sensor).where(Sensor.asset_id == asset_id, Sensor.metric == metric))
    if sensor is None:
        raise NotFound(f"No sensor for metric '{metric}' on {asset_id}")
    end = clock.parse_iso(to) if to else clock.sim_now(db)
    start = clock.parse_iso(from_) if from_ else end - timedelta(hours=hours)
    rows = db.execute(
        select(TelemetryReading.id, TelemetryReading.timestamp, TelemetryReading.value, TelemetryReading.quality,
               TelemetryReading.status)
        .where(TelemetryReading.sensor_id == sensor.id, TelemetryReading.timestamp >= start,
               TelemetryReading.timestamp <= end)
        .order_by(TelemetryReading.timestamp)).all()
    stride = max(1, len(rows) // max_points)
    pts = [{"id": r.id, "t": clock.iso(r.timestamp), "v": r.value, "q": r.quality, "status": r.status}
           for i, r in enumerate(rows) if i % stride == 0 or r.quality != "GOOD" or i == len(rows) - 1]
    return {"asset_id": asset_id, "sensor_id": sensor.id, "metric": metric, "unit": sensor.unit,
            "from": clock.iso(start), "to": clock.iso(end), "count": len(rows), "points": pts, "simulated": True}


@router.get("/telemetry/rejected")
def rejected_telemetry(limit: int = 50, offset: int = 0, reason: str | None = None,
                       db: Session = Depends(get_read_db)) -> dict[str, Any]:
    limit, offset = paginate(limit, offset)
    stmt = select(RejectedTelemetry)
    if reason:
        stmt = stmt.where(RejectedTelemetry.reason == reason)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(RejectedTelemetry.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [{"id": r.id, "event_id": r.event_id, "asset_id": r.asset_id,
                                       "sensor_id": r.sensor_id, "reason": r.reason, "detail": r.detail,
                                       "received_at": clock.iso(r.received_at), "raw": r.raw} for r in rows]}


@router.get("/telemetry/stats")
def telemetry_stats(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    stored = db.scalar(select(func.count()).select_from(TelemetryReading)) or 0
    rej = db.execute(select(RejectedTelemetry.reason, func.count()).group_by(RejectedTelemetry.reason)).all()
    return {"stored": stored, "rejected_by_reason": {r: c for r, c in rej}, "rejected_total": sum(c for _, c in rej)}


# --------------------------------------------------------------------------- simulation
@router.get("/simulation")
def simulation_state(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    return sim.state_dict(db)


def _sim_command(actor: Actor, permission: str, action: str, fn: Any, target: str = "simulation") -> Any:
    return execute(actor, permission, action, "simulation", target, fn)


@router.post("/simulation/start")
@router.post("/simulation/resume")
def sim_start(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    return _sim_command(actor, "sim.control", "sim.start", lambda c: sim.set_running(c.session, True))


@router.post("/simulation/pause")
def sim_pause(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    return _sim_command(actor, "sim.control", "sim.pause", lambda c: sim.set_running(c.session, False))


@router.patch("/simulation")
def sim_patch(body: schemas.SimPatchIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        c.after = body.model_dump(exclude_none=True)
        return sim.patch(c.session, body.speed, body.seed, body.profile)
    return _sim_command(actor, "sim.control", "sim.patch", run)


@router.post("/simulation/reset")
def sim_reset(body: schemas.SimResetIn | None = None, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    from app.errors import AuditInfo
    body = body or schemas.SimResetIn()
    try:
        check_permission(actor, "sim.reset")
    except Forbidden as e:
        audit.record_denied(actor, AuditInfo("sim.reset", "simulation", "simulation"), e.message)
        raise
    wiring.reset_world(body.seed, body.profile)
    with write_session() as s:  # audit table was wiped by the reset; record the reset itself afterwards
        audit.record(s, actor, "sim.reset", "simulation", "simulation", "ALLOWED", after=body.model_dump())
        return sim.state_dict(s)


@router.post("/simulation/faults")
def sim_fault(body: schemas.FaultIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        row = sim.inject_fault(c.session, body.asset_id, body.fault_type, body.sensor_id, body.params,
                               created_by=c.actor.username)
        c.after = sim.fault_dict(row)
        c.target_id = body.asset_id
        return sim.fault_dict(row)
    return execute(actor, "sim.fault", f"sim.fault.{body.fault_type.lower()}", "asset", body.asset_id, run)


@router.post("/simulation/repair-effectiveness")
def sim_repair_eff(body: schemas.RepairEffectivenessIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        c.after = {"effectiveness": body.effectiveness}
        return sim.set_repair_effectiveness(c.session, body.effectiveness)
    return _sim_command(actor, "sim.control", "sim.repair_effectiveness", run)


@router.post("/simulation/step")
def sim_step(minutes: int = Query(default=1, ge=1, le=240), actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    """Advance the clock by N sample minutes synchronously (used by tests and the demo director)."""
    from app.modules.simulation import engine
    check_permission(actor, "sim.control")
    done = 0
    while done < minutes:
        chunk = min(60, minutes - done)
        engine.step_minutes(chunk)
        done += chunk
    with read_session() as s:
        return sim.state_dict(s)


# --------------------------------------------------------------------------- ingestion
@router.post("/ingest/telemetry")
def ingest(body: schemas.IngestIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    check_permission(actor, "ingest")
    with bus.pipeline_lock:
        result = ingestion.ingest_batch(body.readings, body.source)
        bus.drain()
    return result


# --------------------------------------------------------------------------- audit, events, admin
@router.get("/audit-logs")
def audit_logs(outcome: str | None = None, username: str | None = None, action: str | None = None,
               correlation_id: str | None = None, limit: int = 100, offset: int = 0,
               db: Session = Depends(get_read_db), _: Actor = Depends(current_actor)) -> dict[str, Any]:
    limit, offset = paginate(limit, offset)
    rows, total = audit.query(db, outcome, username, action, correlation_id, limit, offset)
    return {"total": total, "items": [{
        "id": r.id, "username": r.username, "role": r.role, "action": r.action, "target_type": r.target_type,
        "target_id": r.target_id, "outcome": r.outcome, "reason": r.reason, "before": r.before, "after": r.after,
        "correlation_id": r.correlation_id, "occurred_at": clock.iso(r.occurred_at)} for r in rows]}


@router.get("/events")
def list_events(correlation_id: str | None = None, layer: int | None = None, event_type: str | None = None,
                asset_id: str | None = None, after_id: int | None = None, limit: int = 100, offset: int = 0,
                order: str = "desc", db: Session = Depends(get_read_db)) -> dict[str, Any]:
    limit, offset = paginate(limit, offset)
    stmt = select(OutboxEvent)
    if correlation_id:
        stmt = stmt.where(OutboxEvent.correlation_id == correlation_id)
    if layer:
        stmt = stmt.where(OutboxEvent.layer == layer)
    if event_type:
        stmt = stmt.where(OutboxEvent.event_type == event_type)
    if asset_id:
        stmt = stmt.where(OutboxEvent.asset_id == asset_id)
    if after_id:
        stmt = stmt.where(OutboxEvent.id > after_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    ordering = OutboxEvent.id.asc() if order == "asc" else OutboxEvent.id.desc()
    rows = db.scalars(stmt.order_by(ordering).limit(limit).offset(offset)).all()
    return {"total": total, "items": [{**bus.to_envelope(r), "id": r.id, "status": r.status} for r in rows]}


@router.get("/events/counters")
def event_counters(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    """Per-layer and per-type counts for the pipeline ribbon (computed from the outbox)."""
    by_layer = {layer: n for layer, n in db.execute(
        select(OutboxEvent.layer, func.count()).group_by(OutboxEvent.layer)).all()}
    by_type = {t: n for t, n in db.execute(
        select(OutboxEvent.event_type, func.count()).group_by(OutboxEvent.event_type)).all()}
    last = db.scalar(select(func.max(OutboxEvent.id))) or 0
    return {"by_layer": {str(k): by_layer.get(k, 0) for k in range(1, 8)}, "by_type": by_type, "last_event_id": last}


@router.get("/dead-letters")
def dead_letters(limit: int = 100, offset: int = 0, db: Session = Depends(get_read_db),
                 _: Actor = Depends(current_actor)) -> dict[str, Any]:
    limit, offset = paginate(limit, offset)
    total = db.scalar(select(func.count()).select_from(DeadLetter)) or 0
    rows = db.scalars(select(DeadLetter).order_by(DeadLetter.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [{"id": r.id, "event_id": r.event_id, "event_type": r.event_type,
                                       "consumer": r.consumer, "attempts": r.attempts, "error": r.error,
                                       "created_at": clock.iso(r.created_at), "payload": r.payload} for r in rows]}


# --------------------------------------------------------------------------- websocket
@ws_router.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    await ws.accept()
    bus.hub.add(ws)
    try:
        with read_session() as s:
            state = s.get(SimulationState, 1)
            hello = {"type": "hello", "sim_now": clock.iso(state.sim_now) if state else None,
                     "speed": state.speed if state else None, "running": state.running if state else None}
        await ws.send_json(hello)
        while True:
            await ws.receive_text()  # keep-alive; clients may send "ping"
    except WebSocketDisconnect:
        pass
    finally:
        bus.hub.remove(ws)
