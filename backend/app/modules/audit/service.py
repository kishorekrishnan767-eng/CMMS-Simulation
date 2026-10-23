"""Audit trail. ALLOWED rows are written inside the caller's transaction (atomic with the change).
DENIED rows are written in their own transaction after the failed unit of work rolled back, so a
rejected command can never erase its own audit record."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import write_session
from app.errors import AuditInfo
from app.models import AuditLog
from app.security import Actor


def record(
    session: Session,
    actor: Actor,
    action: str,
    target_type: str,
    target_id: str | None,
    outcome: str,
    reason: str | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> AuditLog:
    row = AuditLog(
        user_id=actor.user_id,
        username=actor.username,
        role=actor.role,
        action=action,
        target_type=target_type,
        target_id=target_id,
        outcome=outcome,
        reason=reason,
        before=before,
        after=after,
        correlation_id=correlation_id,
        occurred_at=clock.sim_now(session),
    )
    session.add(row)
    return row


def record_denied(actor: Actor, info: AuditInfo, reason: str) -> None:
    """Write a DENIED row in a fresh transaction (best effort — never masks the original error)."""
    try:
        with write_session() as s:
            record(s, actor, info.action, info.target_type, info.target_id, "DENIED",
                   reason=reason, before=info.before, correlation_id=info.correlation_id)
    except Exception:  # pragma: no cover - audit must not mask the real error
        pass


def query(session: Session, outcome: str | None = None, username: str | None = None,
          action: str | None = None, correlation_id: str | None = None,
          limit: int = 100, offset: int = 0) -> tuple[list[AuditLog], int]:
    stmt = select(AuditLog)
    if outcome:
        stmt = stmt.where(AuditLog.outcome == outcome)
    if username:
        stmt = stmt.where(AuditLog.username == username)
    if action:
        stmt = stmt.where(AuditLog.action.contains(action))
    if correlation_id:
        stmt = stmt.where(AuditLog.correlation_id == correlation_id)
    from sqlalchemy import func
    total = session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = session.scalars(stmt.order_by(AuditLog.id.desc()).limit(limit).offset(offset)).all()
    return list(rows), total
