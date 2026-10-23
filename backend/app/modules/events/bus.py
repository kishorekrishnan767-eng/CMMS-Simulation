"""Transactional outbox, in-process dispatcher and WebSocket hub.

* ``publish`` adds an ``outbox_events`` row **inside the caller's transaction**, so a domain change
  and its event commit (or roll back) together.
* ``drain`` delivers pending events, in id order, to registered consumers. Each consumer's work and
  its ``(event_id, consumer)`` row in ``processed_events`` commit atomically, so redelivery/replay
  produces no duplicate side effects.
* Failures are retried with exponential backoff (max 5 attempts) and then dead-lettered.
* Every dispatched event is pushed to browsers through the hub.
"""
from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import read_session, write_session
from app.models import DeadLetter, OutboxEvent, ProcessedEvent

SCHEMA_VERSION = 1
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 0.5  # attempt n waits BASE * 2^(n-1); tests set this to 0

# Event type -> pipeline layer (1..7) used for the ribbon, feeds and the envelope.
EVENT_LAYERS: dict[str, int] = {
    "AssetRegistered": 1,
    "SimulationReset": 2, "SimulationControl": 2, "FaultInjected": 2, "RepairApplied": 2,
    "TelemetryAccepted": 3, "TelemetryRejected": 3, "DataQualityWarning": 3,
    "AnomalyWatch": 4, "AnomalyDetected": 4, "AnomalyEscalated": 4, "AnomalyCleared": 4,
    "RiskAssessed": 5, "WorkOrderDrafted": 5, "EvidenceAttached": 5, "PriorityEscalationProposed": 5,
    "PriorityEscalationAcknowledged": 6,
    "WorkOrderApproved": 6, "WorkOrderRejected": 6, "WorkOrderCancelled": 6, "TechnicianAssigned": 6,
    "PartsReserved": 6, "PartsShortage": 6, "StockReceived": 6, "WorkOrderOnHold": 6,
    "WorkOrderResumed": 6, "WorkStarted": 6, "WorkCompleted": 6, "ReworkStarted": 6,
    "VerificationPassed": 7, "VerificationFailed": 7, "ReworkRequired": 7, "WorkOrderClosed": 7,
    "EvaluationRecorded": 7,
}

Handler = Callable[[Session, dict[str, Any]], None]


@dataclass
class _Consumer:
    name: str
    types: frozenset[str] | None  # None = all
    fn: Handler


_consumers: list[_Consumer] = []
pipeline_lock = threading.RLock()  # serialises sim ticks, commands and drains


def subscribe(name: str, event_types: list[str] | None = None) -> Callable[[Handler], Handler]:
    """Register a consumer. Registering the same name twice replaces it (idempotent wiring)."""
    def deco(fn: Handler) -> Handler:
        _consumers[:] = [c for c in _consumers if c.name != name]
        _consumers.append(_Consumer(name, frozenset(event_types) if event_types else None, fn))
        return fn
    return deco


def clear_consumers() -> None:
    _consumers.clear()


def to_envelope(row: OutboxEvent) -> dict[str, Any]:
    return {
        "event_id": row.event_id,
        "event_type": row.event_type,
        "layer": row.layer,
        "occurred_at": clock.iso(row.occurred_at),
        "asset_id": row.asset_id,
        "correlation_id": row.correlation_id,
        "schema_version": row.schema_version,
        "payload": row.payload,
    }


def publish(
    session: Session,
    event_type: str,
    *,
    payload: dict[str, Any],
    asset_id: str | None = None,
    correlation_id: str | None = None,
    occurred_at: datetime | None = None,
    event_id: str | None = None,
) -> OutboxEvent:
    """Add an outbox row to the caller's transaction (commit happens with the domain change)."""
    if event_type not in EVENT_LAYERS:
        raise ValueError(f"unknown event type {event_type}")
    row = OutboxEvent(
        event_id=event_id or str(uuid.uuid4()),
        event_type=event_type,
        layer=EVENT_LAYERS[event_type],
        occurred_at=occurred_at or clock.sim_now(session),
        asset_id=asset_id,
        correlation_id=correlation_id,
        schema_version=SCHEMA_VERSION,
        payload=payload,
        status="PENDING",
        attempts=0,
        next_attempt_at=0.0,
    )
    session.add(row)
    return row


# --------------------------------------------------------------------------- WebSocket hub
class Hub:
    def __init__(self) -> None:
        self._clients: set[Any] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def add(self, ws: Any) -> None:
        with self._lock:
            self._clients.add(ws)

    def remove(self, ws: Any) -> None:
        with self._lock:
            self._clients.discard(ws)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def broadcast(self, message: dict[str, Any]) -> None:
        """Thread-safe: callable from the sim thread or request threads."""
        loop = self._loop
        if loop is None or not self._clients:
            return
        with self._lock:
            clients = list(self._clients)
        for ws in clients:
            try:
                asyncio.run_coroutine_threadsafe(self._send(ws, message), loop)
            except RuntimeError:  # loop closed
                return

    async def _send(self, ws: Any, message: dict[str, Any]) -> None:
        try:
            await ws.send_json(message)
        except Exception:
            self.remove(ws)


hub = Hub()


# --------------------------------------------------------------------------- dispatcher
def _matching(event_type: str) -> list[_Consumer]:
    return [c for c in _consumers if c.types is None or event_type in c.types]


def _deliver(event_id: str, consumer: _Consumer, envelope: dict[str, Any]) -> None:
    """Run one consumer exactly once: work + processed marker in one transaction."""
    with write_session() as s:
        already = s.scalar(select(ProcessedEvent.id).where(
            ProcessedEvent.event_id == event_id, ProcessedEvent.consumer == consumer.name))
        if already:
            return
        consumer.fn(s, envelope)
        s.add(ProcessedEvent(event_id=event_id, consumer=consumer.name, processed_at=clock.sim_now(s)))


def _dispatch_one(row_id: int) -> bool:
    """Deliver a single outbox row. Returns True when it reached a terminal status."""
    with read_session() as s:
        row = s.get(OutboxEvent, row_id)
        if row is None or row.status != "PENDING":
            return True
        envelope = to_envelope(row)
        attempts = row.attempts
    failed: tuple[str, Exception] | None = None
    for consumer in _matching(envelope["event_type"]):
        try:
            _deliver(envelope["event_id"], consumer, envelope)
        except Exception as exc:  # noqa: BLE001 - consumer failures are retried, not fatal
            failed = (consumer.name, exc)
            break
    with write_session() as s:
        row = s.get(OutboxEvent, row_id)
        assert row is not None
        if failed is None:
            row.status = "DISPATCHED"
        else:
            row.attempts = attempts + 1
            row.last_error = f"{failed[0]}: {failed[1]}"
            if row.attempts >= MAX_ATTEMPTS:
                row.status = "DEAD"
                s.add(DeadLetter(
                    event_id=row.event_id, event_type=row.event_type, consumer=failed[0],
                    attempts=row.attempts, error=str(failed[1]), payload=envelope,
                    created_at=clock.sim_now(s)))
            else:
                row.next_attempt_at = time.time() + BACKOFF_BASE_SECONDS * (2 ** (row.attempts - 1))
        terminal = row.status in ("DISPATCHED", "DEAD")
    if terminal:
        hub.broadcast({"type": "event", "event": envelope})
    return terminal


def drain(max_events: int = 5000) -> int:
    """Deliver pending events (including ones produced by consumers) until quiescent.

    Events whose backoff has not elapsed are left for a later drain. Returns events delivered.
    """
    delivered = 0
    with pipeline_lock:
        while delivered < max_events:
            with read_session() as s:
                ids = list(s.scalars(
                    select(OutboxEvent.id)
                    .where(OutboxEvent.status == "PENDING", OutboxEvent.next_attempt_at <= time.time())
                    .order_by(OutboxEvent.id).limit(200)))
            if not ids:
                break
            progressed = False
            for row_id in ids:
                if _dispatch_one(row_id):
                    delivered += 1
                    progressed = True
            if not progressed:
                break
    return delivered


def redeliver(event_id: str) -> int:
    """Replay an already-dispatched event through all consumers (idempotency demonstration).

    Consumers that already processed it are skipped via ``processed_events``. Returns the number of
    consumers that actually ran (0 when everything was already processed).
    """
    ran = 0
    with pipeline_lock:
        with read_session() as s:
            row = s.scalar(select(OutboxEvent).where(OutboxEvent.event_id == event_id))
            if row is None:
                raise KeyError(event_id)
            envelope = to_envelope(row)
        for consumer in _matching(envelope["event_type"]):
            with read_session() as s:
                done = s.scalar(select(ProcessedEvent.id).where(
                    ProcessedEvent.event_id == event_id, ProcessedEvent.consumer == consumer.name))
            if not done:
                ran += 1
            _deliver(event_id, consumer, envelope)
    return ran
