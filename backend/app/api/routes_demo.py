"""Guided Demo director endpoints (the director itself only calls the public API)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from app.commands import Ctx, execute
from app.errors import AuditInfo, Conflict, Forbidden, NotFound
from app.models import Asset, FaultInjection, SimulationState, WorkOrder
from app.modules.audit import service as audit
from app.modules.demo.director import director
from app.modules.demo.walkthrough import walkthrough
from app.security import Actor, check_permission, current_actor

router = APIRouter(prefix="/api/demo")


def _guard(actor: Actor, action: str) -> None:
    try:
        check_permission(actor, "demo.run")
    except Forbidden as e:
        audit.record_denied(actor, AuditInfo(action, "demo", "director"), e.message)
        raise


@router.get("/state")
def demo_state() -> dict[str, Any]:
    return director.state()


@router.post("/step")
def demo_step(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    _guard(actor, "demo.step")
    return director.next_step()


@router.post("/autoplay")
def demo_autoplay(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    _guard(actor, "demo.autoplay")
    return director.start_autoplay()


@router.post("/stop")
def demo_stop(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    _guard(actor, "demo.stop")
    director.stop()
    return director.state()


@router.post("/reset")
def demo_reset(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    _guard(actor, "demo.reset")
    return director.reset()


# ----------------------------------------------------------------------------- walkthrough
walkthrough_router = APIRouter(prefix="/api/walkthrough")


class StartIn(BaseModel):
    asset_id: str


@walkthrough_router.get("/state")
def walkthrough_state() -> dict[str, Any]:
    return walkthrough.state()


@walkthrough_router.post("/start")
def walkthrough_start(body: StartIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    """Pick the machine and start the wear. Refused while that machine already has an open problem."""
    def run(c: Ctx) -> dict[str, Any]:
        st = c.session.get(SimulationState, 1)
        assert st is not None
        if c.session.get(Asset, body.asset_id) is None:
            raise NotFound(f"Asset {body.asset_id} not found")
        wear = c.session.scalar(select(FaultInjection).where(
            FaultInjection.asset_id == body.asset_id, FaultInjection.status == "ACTIVE",
            FaultInjection.run_id == st.run_id, FaultInjection.fault_type == "BEARING_WEAR"))
        wo = c.session.scalar(select(WorkOrder).where(
            WorkOrder.asset_id == body.asset_id, WorkOrder.status.notin_(("CLOSED", "REJECTED", "CANCELLED"))))
        if wear is not None or wo is not None:
            raise Conflict(f"{body.asset_id} already has an open problem. Press Start over first.", code="asset_busy")
        c.after = {"asset_id": body.asset_id}
        return walkthrough.begin(body.asset_id)
    return execute(actor, "demo.run", "walkthrough.start", "asset", body.asset_id, run)


@walkthrough_router.post("/next")
def walkthrough_next(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    _guard(actor, "walkthrough.next")
    return walkthrough.next_step()


@walkthrough_router.post("/reset")
def walkthrough_reset(actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    """Start over: wipe the simulated world back to its seed state and forget the walkthrough."""
    _guard(actor, "walkthrough.reset")
    walkthrough.clear()
    director.reset()  # resets the world (6 h of healthy history) and leaves the clock paused
    director.api().call("operator", "post", "/api/simulation/start")  # the building is live again
    return walkthrough.state()
