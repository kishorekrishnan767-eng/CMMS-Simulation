"""Operations autopilot + job procedure endpoints (the autopilot itself only calls the public API)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.commands import Ctx, execute
from app.errors import Invalid
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


@router.get("/procedures")
def procedure_catalogue() -> dict[str, Any]:
    return procedures.catalogue()
