"""Process-pool workers for run_e2e_demo.py (must be importable, so they live in their own module)."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))


def healthy_run(seed: int, hours: int = 72) -> dict:
    """Full pipeline (simulator → ingestion → detector → decision) on a healthy building for `hours`."""
    from sqlalchemy import func, select

    from app import bootstrap, db, wiring
    from app.db import read_session
    from app.models import AnomalyEvent, Asset, OutboxEvent, WorkOrder
    from app.modules.simulation import engine

    tmp = tempfile.mkdtemp(prefix=f"twin-seed{seed}-").replace("\\", "/")
    db.configure(f"sqlite:///{tmp}/healthy.db")
    bootstrap.migrate()
    bootstrap.seed()
    wiring.configure()
    wiring.reset_world(seed=seed)           # applies the seed and backfills 6 h of healthy history
    for _ in range(hours):
        engine.step_minutes(60)
    with read_session() as s:
        anomalies = s.scalar(select(func.count()).select_from(AnomalyEvent)) or 0
        work_orders = s.scalar(select(func.count()).select_from(WorkOrder)) or 0
        watch = s.scalar(select(func.count()).select_from(OutboxEvent).where(OutboxEvent.event_type == "AnomalyWatch")) or 0
        health = {a.id: a.health_state for a in s.scalars(select(Asset))}
    return {"seed": seed, "hours": hours, "anomalies": anomalies, "work_orders": work_orders, "watch_events": watch,
            "final_health": health}
