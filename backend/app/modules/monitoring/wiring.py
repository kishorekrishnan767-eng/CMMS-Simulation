"""Registers monitoring consumers on the event bus (called from app.wiring)."""
from typing import Any

from sqlalchemy.orm import Session

from app.errors import Conflict
from app.modules.events import bus
from app.modules.monitoring import service


def _clear_on_close(session: Session, envelope: dict[str, Any]) -> None:
    """Layer 7 → 4: a closed (verified) work order clears the anomaly and unfreezes the baseline."""
    try:
        service.clear_asset(session, envelope["asset_id"], f"Work order {envelope['payload']['work_order']} verified and closed",
                            correlation_id=envelope.get("correlation_id"), source="verification")
    except Conflict:
        pass  # already cleared (e.g. by a supervisor)


def register() -> None:
    bus.subscribe("monitoring.detector", ["TelemetryAccepted"])(service.on_telemetry)
    bus.subscribe("monitoring.clear_on_close", ["WorkOrderClosed"])(_clear_on_close)
