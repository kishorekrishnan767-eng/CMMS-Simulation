"""Operations autopilot + job procedure endpoints (the autopilot itself only calls the public API)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from app.commands import Ctx, execute
from app.errors import Conflict, Invalid, NotFound
from app.models import Asset, FaultInjection, SimulationState, WorkOrder
from app.modules.autopilot.operations import MEAN_GAP_H, autopilot
from app.modules.cmms import procedures
from app.security import Actor, current_actor

router = APIRouter(prefix="/api")


class AutopilotIn(BaseModel):
    enabled: bool | None = None
    fault_rate: str | None = None


@router.get("/autopilot")
def autopilot_state() -> dict[str, Any]:
    return autopilot.state()


@router.patch("/autopilot")
def autopilot_configure(body: AutopilotIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    def run(c: Ctx) -> dict[str, Any]:
        if body.fault_rate is not None and body.fault_rate not in MEAN_GAP_H:
            raise Invalid(f"fault_rate must be one of {', '.join(MEAN_GAP_H)}", code="invalid_fault_rate")
        c.before = {"enabled": autopilot.enabled, "fault_rate": autopilot.fault_rate}
        state = autopilot.configure(body.enabled, body.fault_rate)
        c.after = {"enabled": state["enabled"], "fault_rate": state["fault_rate"]}
        return state
    return execute(actor, "sim.control", "sim.autopilot", "simulation", "autopilot", run)


class RepairIn(BaseModel):
    asset_id: str


@router.post("/autopilot/repair")
def autopilot_repair(body: RepairIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    """Fast-track the repair of one asset: the crew works its work order through the normal workflow."""
    def run(c: Ctx) -> dict[str, Any]:
        st = c.session.get(SimulationState, 1)
        assert st is not None
        if c.session.get(Asset, body.asset_id) is None:
            raise NotFound(f"Asset {body.asset_id} not found")
        fault = c.session.scalar(select(FaultInjection).where(
            FaultInjection.asset_id == body.asset_id, FaultInjection.status == "ACTIVE",
            FaultInjection.run_id == st.run_id, FaultInjection.fault_type == "BEARING_WEAR"))
        wo = c.session.scalar(select(WorkOrder).where(
            WorkOrder.asset_id == body.asset_id, WorkOrder.status.notin_(("CLOSED", "REJECTED", "CANCELLED"))))
        if fault is None and wo is None:
            raise Conflict(f"{body.asset_id} has no active anomaly or open work order to repair", code="nothing_to_repair")
        c.after = {"asset_id": body.asset_id, "work_order": wo.number if wo else None}
        return autopilot.expedite(body.asset_id)
    return execute(actor, "sim.control", "sim.repair_asset", "asset", body.asset_id, run)


@router.get("/procedures")
def procedure_catalogue() -> dict[str, Any]:
    return procedures.catalogue()
