"""Guided Demo director endpoints (the director itself only calls the public API)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.commands import Ctx, execute
from app.db import get_read_db
from app.errors import AuditInfo, Conflict, Forbidden, NotFound
from app.models import Asset, FaultInjection, SimulationState, Technician, WorkOrder
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
    # True: play every stage by itself in one minute. False (default): one stage per /next call.
    auto: bool = False


def _leftovers(session: Any) -> list[str]:
    """What earlier runs (or a failed one) left behind in the building, in words; empty when it is clean.

    A new automatic run starts from a clean building, so it never trips over a job that is still open, a
    machine that is still wearing, a technician who is still out, or spare parts that are still reserved.
    """
    out: list[str] = []
    n_jobs = session.scalar(select(func.count()).select_from(WorkOrder).where(
        WorkOrder.status.notin_(("CLOSED", "REJECTED", "CANCELLED")))) or 0
    if n_jobs:
        out.append(f"{n_jobs} unfinished job{'s' if n_jobs != 1 else ''}")
    n_wear = session.scalar(select(func.count()).select_from(FaultInjection).where(
        FaultInjection.status == "ACTIVE", FaultInjection.fault_type == "BEARING_WEAR")) or 0
    if n_wear:
        out.append(f"{n_wear} machine{'s' if n_wear != 1 else ''} still wearing")
    n_busy = session.scalar(select(func.count()).select_from(Technician).where(Technician.status != "AVAILABLE")) or 0
    if n_busy:
        out.append(f"{n_busy} technician{'s' if n_busy != 1 else ''} still out")
    return out


@walkthrough_router.get("/state")
def walkthrough_state(db: Session = Depends(get_read_db)) -> dict[str, Any]:
    """The run so far, plus what an earlier run left behind (a new run clears it first)."""
    return {**walkthrough.state(), "leftovers": [] if walkthrough.busy else _leftovers(db)}


@walkthrough_router.post("/start")
def walkthrough_start(body: StartIn, actor: Actor = Depends(current_actor)) -> dict[str, Any]:
    """Pick the machine and start the wear.

    Only one simulation runs at a time (409 ``run_in_progress`` while one is playing). An automatic run never
    fails because of an earlier run's leftovers: it clears them first, exactly like *Start over*. The
    step-by-step form is still refused while that machine has an open problem.
    """
    def run(c: Ctx) -> dict[str, Any]:
        if walkthrough.busy:
            raise Conflict("A simulation is already running. Only one runs at a time: wait for it to finish "
                           "(about a minute) or press Start over.", code="run_in_progress")
        st = c.session.get(SimulationState, 1)
        assert st is not None
        if c.session.get(Asset, body.asset_id) is None:
            raise NotFound(f"Asset {body.asset_id} not found")
        if body.auto:
            stale = _leftovers(c.session)
            c.after = {"asset_id": body.asset_id, "auto": True, "cleared": stale}
            return walkthrough.begin_auto(body.asset_id, cleared=stale)
        wear = c.session.scalar(select(FaultInjection).where(
            FaultInjection.asset_id == body.asset_id, FaultInjection.status == "ACTIVE",
            FaultInjection.run_id == st.run_id, FaultInjection.fault_type == "BEARING_WEAR"))
        wo = c.session.scalar(select(WorkOrder).where(
            WorkOrder.asset_id == body.asset_id, WorkOrder.status.notin_(("CLOSED", "REJECTED", "CANCELLED"))))
        if wear is not None or wo is not None:
            raise Conflict(f"{body.asset_id} already has an open problem. Press Start over first.", code="asset_busy")
        c.after = {"asset_id": body.asset_id, "auto": False}
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
