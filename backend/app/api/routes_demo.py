"""Guided Demo director endpoints (the director itself only calls the public API)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.errors import AuditInfo, Forbidden
from app.modules.audit import service as audit
from app.modules.demo.director import director
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
