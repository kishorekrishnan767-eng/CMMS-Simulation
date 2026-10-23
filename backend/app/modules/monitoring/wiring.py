"""Registers the monitoring consumer on the event bus (called from app.wiring)."""
from app.modules.events import bus
from app.modules.monitoring import service


def register() -> None:
    bus.subscribe("monitoring.detector", ["TelemetryAccepted"])(service.on_telemetry)
