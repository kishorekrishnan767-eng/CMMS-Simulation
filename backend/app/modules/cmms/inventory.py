"""Inventory ledger, reservations and consumption (Layer 6).

``stock_movements`` is the source of truth: ``quantity_on_hand = Σ movements``. Reservations are a
soft claim; availability = on_hand − active reservations. Every mutation first LOCKS the item row —
on PostgreSQL via ``SELECT … FOR UPDATE``, on SQLite via the ``BEGIN IMMEDIATE`` write engine, which
serialises writers — and re-reads the ledger inside the transaction, so two concurrent completions
can never drive stock negative.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock, db
from app.errors import Conflict, Invalid, NotFound
from app.models import InventoryItem, StockMovement, StockReservation, WorkOrder
from app.modules.events import bus


def _lock_item(session: Session, sku: str) -> InventoryItem:
    stmt = select(InventoryItem).where(InventoryItem.sku == sku)
    if not db.is_sqlite():
        stmt = stmt.with_for_update()
    item = session.scalar(stmt)
    if item is None:
        raise NotFound(f"Inventory item {sku} not found")
    item.version += 1  # also forces a write so optimistic readers can notice contention
    return item


def on_hand(session: Session, sku: str) -> int:
    return int(session.scalar(select(func.coalesce(func.sum(StockMovement.quantity), 0)).where(StockMovement.sku == sku)) or 0)


def reserved(session: Session, sku: str, exclude_wo: int | None = None) -> int:
    stmt = select(func.coalesce(func.sum(StockReservation.quantity), 0)).where(
        StockReservation.sku == sku, StockReservation.status == "ACTIVE")
    if exclude_wo is not None:
        stmt = stmt.where(StockReservation.work_order_id != exclude_wo)
    return int(session.scalar(stmt) or 0)


def available(session: Session, sku: str) -> int:
    return on_hand(session, sku) - reserved(session, sku)


def _movement(session: Session, sku: str, qty: int, mtype: str, wo_id: int | None, user_id: int | None,
              note: str | None) -> StockMovement:
    balance = on_hand(session, sku) + qty
    if balance < 0:
        raise Conflict(f"Stock of {sku} cannot go negative (on hand {balance - qty}, requested {-qty})",
                       code="insufficient_stock")
    m = StockMovement(sku=sku, quantity=qty, movement_type=mtype, work_order_id=wo_id, user_id=user_id,
                      balance_after=balance, note=note, occurred_at=clock.sim_now(session))
    session.add(m)
    session.flush()
    return m


def reserve_parts(session: Session, wo: WorkOrder, parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reserve planned parts. Returns shortages ([] when everything was reserved). All-or-nothing."""
    now = clock.sim_now(session)
    shortages: list[dict[str, Any]] = []
    plan: list[tuple[str, int]] = []
    for p in sorted(parts, key=lambda x: x["sku"]):  # stable lock order avoids deadlocks on Postgres
        _lock_item(session, p["sku"])
        have = available(session, p["sku"])
        already = int(session.scalar(select(func.coalesce(func.sum(StockReservation.quantity), 0)).where(
            StockReservation.sku == p["sku"], StockReservation.work_order_id == wo.id,
            StockReservation.status == "ACTIVE")) or 0)
        need = p["quantity"] - already
        if need > have:
            shortages.append({"sku": p["sku"], "needed": need, "available": have, "short_by": need - have})
        elif need > 0:
            plan.append((p["sku"], need))
    if shortages:
        return shortages
    for sku, qty in plan:
        session.add(StockReservation(sku=sku, work_order_id=wo.id, quantity=qty, status="ACTIVE",
                                     created_at=now, updated_at=now))
    session.flush()
    return []


def release_reservations(session: Session, wo: WorkOrder) -> None:
    now = clock.sim_now(session)
    for r in session.scalars(select(StockReservation).where(
            StockReservation.work_order_id == wo.id, StockReservation.status == "ACTIVE")):
        r.status = "RELEASED"
        r.updated_at = now


def consume_parts(session: Session, wo: WorkOrder, used: list[dict[str, Any]], user_id: int | None) -> list[dict[str, Any]]:
    """Consume the parts actually used; reservations become CONSUMED (any remainder is released)."""
    now = clock.sim_now(session)
    out: list[dict[str, Any]] = []
    for u in sorted(used, key=lambda x: x["sku"]):
        qty = int(u["quantity"])
        if qty < 0:
            raise Invalid("quantity used cannot be negative")
        if qty == 0:
            continue
        _lock_item(session, u["sku"])
        mine = int(session.scalar(select(func.coalesce(func.sum(StockReservation.quantity), 0)).where(
            StockReservation.sku == u["sku"], StockReservation.work_order_id == wo.id,
            StockReservation.status == "ACTIVE")) or 0)
        extra = max(0, qty - mine)
        if extra > on_hand(session, u["sku"]) - reserved(session, u["sku"]):
            raise Conflict(f"Not enough free stock of {u['sku']} for the extra {extra} used", code="insufficient_stock")
        m = _movement(session, u["sku"], -qty, "CONSUME", wo.id, user_id, f"Consumed on {wo.number}")
        out.append({"sku": u["sku"], "quantity": qty, "balance_after": m.balance_after})
    for r in session.scalars(select(StockReservation).where(
            StockReservation.work_order_id == wo.id, StockReservation.status == "ACTIVE")):
        r.status = "CONSUMED"
        r.updated_at = now
    return out


def receive(session: Session, sku: str, qty: int, user_id: int | None, note: str | None = None) -> StockMovement:
    if qty <= 0:
        raise Invalid("received quantity must be positive")
    _lock_item(session, sku)
    m = _movement(session, sku, qty, "RECEIVE", None, user_id, note or "Goods received")
    bus.publish(session, "StockReceived", payload={"sku": sku, "quantity": qty, "balance_after": m.balance_after})
    return m


def adjust(session: Session, sku: str, delta: int, user_id: int | None, note: str) -> StockMovement:
    if delta == 0:
        raise Invalid("adjustment cannot be zero")
    _lock_item(session, sku)
    return _movement(session, sku, delta, "ADJUST", None, user_id, note or "Cycle count adjustment")


def item_dict(session: Session, item: InventoryItem) -> dict[str, Any]:
    oh, rs = on_hand(session, item.sku), reserved(session, item.sku)
    return {"sku": item.sku, "name": item.name, "unit": item.unit, "unit_cost": item.unit_cost,
            "location": item.location, "reorder_level": item.reorder_level, "reorder_quantity": item.reorder_quantity,
            "on_hand": oh, "reserved": rs, "available": oh - rs, "low_stock": oh <= item.reorder_level}
