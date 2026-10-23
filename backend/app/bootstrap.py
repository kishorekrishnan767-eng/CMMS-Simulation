"""Schema migration and seeding helpers shared by the CLI, the app lifespan and tests."""
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from app import db
from app.config import BACKEND_DIR
from app.db import write_session
from app.models import SimulationState
from app.modules.assets.seed import seed_reference_data
from app.modules.decision.policy import register_policy


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(BACKEND_DIR / "alembic")))
    cfg.attributes["url"] = db.database_url()
    return cfg


def migrate() -> None:
    command.upgrade(alembic_config(), "head")


def drop_all() -> None:
    """Remove every table (used by `reset`)."""
    from app.db import Base
    eng = db.engine()
    with eng.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF") if db.is_sqlite() else None
        Base.metadata.drop_all(conn)
        if "alembic_version" in inspect(conn).get_table_names():
            conn.exec_driver_sql("DROP TABLE alembic_version")


def seed() -> None:
    with write_session() as s:
        seed_reference_data(s)
        state = s.get(SimulationState, 1)
        assert state is not None
        register_policy(s, state.sim_now)


DYNAMIC_TABLES_DELETE_ORDER = [
    "evaluations", "verification_records", "inspection_records", "approvals", "work_order_parts",
    "stock_reservations", "stock_movements", "work_order_events", "work_orders", "risk_assessments",
    "anomaly_evidence", "detector_state", "anomaly_events", "fault_injections", "rejected_telemetry",
    "telemetry_readings", "processed_events", "dead_letters", "outbox_events", "audit_logs",
]


def reset_dynamic(session) -> None:  # type: ignore[no-untyped-def]
    """Return every non-reference table to its seeded state (used by reset-to-seed)."""
    from sqlalchemy import delete, update

    from app.models import Asset, InventoryItem, Sensor, StockMovement, Technician
    from app.modules.assets.seed import INVENTORY, SIM_EPOCH

    table_by_name = {t.name: t for t in __import__("app.db", fromlist=["Base"]).Base.metadata.sorted_tables}
    for name in DYNAMIC_TABLES_DELETE_ORDER:
        session.execute(delete(table_by_name[name]))
    session.execute(update(Asset).values(health_state="NORMAL", status="OPERATIONAL", watermark=None))
    session.execute(update(Sensor).values(quality="GOOD", last_value=None, last_timestamp=None, flat_count=0))
    for t in session.query(Technician):
        t.current_floor = t.home_floor
        t.status = "AVAILABLE"
        t.performance = t.seeded_performance
        t.jobs_completed = 0
        t.first_time_fixes = 0
    session.execute(update(InventoryItem).values(version=0))
    for sku, *_rest, qty in INVENTORY:
        session.add(StockMovement(sku=sku, quantity=qty, movement_type="INITIAL", balance_after=qty,
                                  note="Opening stock", occurred_at=SIM_EPOCH))
    session.flush()
