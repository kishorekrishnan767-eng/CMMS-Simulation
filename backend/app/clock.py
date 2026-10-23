"""The simulation clock — the only source of domain time.

Every domain timestamp derives from ``simulation_state.sim_now`` (naive UTC). Wall-clock time is
never used for domain data, so pausing, resetting or changing speed keeps history consistent.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import SimulationState

SAMPLE_INTERVAL_MIN = 1


def sim_now(session: Session) -> datetime:
    state = session.get(SimulationState, 1)
    if state is None:
        raise RuntimeError("simulation_state is not initialised — run `python -m app.cli init`")
    return state.sim_now


def iso(dt: datetime | None) -> str | None:
    """Serialise a naive-UTC datetime as ISO-8601 with a Z suffix."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt.isoformat(timespec="seconds") + "Z"


def parse_iso(value: str) -> datetime:
    """Parse ISO-8601 (with or without Z/offset) into naive UTC."""
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def minutes_between(a: datetime | None, b: datetime | None) -> float | None:
    if a is None or b is None:
        return None
    return (b - a).total_seconds() / 60.0
