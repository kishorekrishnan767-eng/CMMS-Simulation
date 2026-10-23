"""Command executor — the single path for every state-changing action.

``execute`` = permission check → unit of work → ALLOWED audit row (same transaction) → drain events.
Any ``DomainError`` (permission or workflow guard) yields a DENIED audit row written in a fresh
transaction, because the failed unit of work rolls back. This is what makes denials auditable.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from sqlalchemy.orm import Session

from app.db import write_session
from app.errors import AuditInfo, DomainError, Forbidden
from app.modules.audit import service as audit
from app.modules.events import bus
from app.security import Actor, check_permission

T = TypeVar("T")


@dataclass
class Ctx:
    """Passed to the unit of work so it can describe what happened for the audit trail."""

    session: Session
    actor: Actor
    target_id: str | None = None
    correlation_id: str | None = None
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def execute(
    actor: Actor,
    permission: str | None,
    action: str,
    target_type: str,
    target_id: str | None,
    fn: Callable[[Ctx], T],
    *,
    correlation_id: str | None = None,
    drain: bool = True,
) -> T:
    info = AuditInfo(action=action, target_type=target_type, target_id=target_id, correlation_id=correlation_id)
    try:
        if permission:
            check_permission(actor, permission)
    except Forbidden as e:
        audit.record_denied(actor, info, e.message)
        raise
    with bus.pipeline_lock:
        try:
            with write_session() as s:
                ctx = Ctx(session=s, actor=actor, target_id=target_id, correlation_id=correlation_id)
                result = fn(ctx)
                audit.record(s, actor, action, target_type, ctx.target_id, "ALLOWED",
                             before=ctx.before, after=ctx.after, correlation_id=ctx.correlation_id)
        except DomainError as e:
            info.target_id = info.target_id or (ctx.target_id if "ctx" in locals() else None)
            if "ctx" in locals():
                info.correlation_id = ctx.correlation_id or info.correlation_id
                info.before = ctx.before
            audit.record_denied(actor, info, e.message)
            raise
        if drain:
            bus.drain()
    return result
