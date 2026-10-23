"""Composition root: the only place that connects modules to each other.

The simulator publishes into ``ingestion`` only through the ``TelemetrySink`` bound here; consumers
register themselves on the event bus here. Every other module stays unaware of its neighbours.
"""
from __future__ import annotations

from sqlalchemy import func, select

from app import bootstrap
from app.db import read_session, write_session
from app.modules.events import bus
from app.modules.ingestion import service as ingestion
from app.modules.simulation import engine
from app.modules.simulation import service as sim_service

_configured = False


def configure() -> None:
    """Idempotently bind sink, consumers and tick hooks."""
    global _configured
    engine.set_sink(ingestion.ingest_batch)
    bus.subscribe("simulation.apply_repair", ["WorkCompleted"])(sim_service.apply_repair)
    engine.add_tick_hook(ingestion.sweep_stale)
    _register_optional()
    _configured = True


def _register_optional() -> None:
    """Modules that exist in later phases register themselves here when importable."""
    for mod in ("app.modules.monitoring.wiring", "app.modules.decision.wiring", "app.modules.cmms.wiring",
                "app.modules.verification.wiring", "app.modules.analytics.wiring"):
        try:
            module = __import__(mod, fromlist=["register"])
        except ModuleNotFoundError as e:
            if e.name != mod:
                raise
            continue
        module.register()


def warm_start(hours: int = 6) -> None:
    """Backfill healthy history through the normal ingestion path (Layer 2 → 3 → 4)."""
    for _ in range(hours):
        engine.step_minutes(60)


def ensure_warm_start() -> None:
    configure()
    with read_session() as s:
        has = s.scalar(select(func.count()).select_from(__import__("app.models", fromlist=["TelemetryReading"]).TelemetryReading))
    if not has:
        warm_start()


def reset_world(seed: int | None = None, profile: str | None = None) -> None:
    """Reset-to-seed: wipe dynamic data, restart the clock at the epoch and warm-start."""
    from app.models import SimulationState
    from app.modules.assets.seed import SIM_EPOCH

    configure()
    with bus.pipeline_lock:
        with write_session() as s:
            st = s.get(SimulationState, 1)
            assert st is not None
            new_seed = st.seed if seed is None else seed
            new_profile = st.profile if profile is None else profile
            bootstrap.reset_dynamic(s)
            engine.reset_clock(s, new_seed, new_profile, SIM_EPOCH)
            bus.publish(s, "SimulationReset", payload={"seed": new_seed, "profile": new_profile})
        warm_start()
        bus.drain()
