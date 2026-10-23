"""The only door out of the simulator.

The simulator publishes telemetry through a ``TelemetrySink`` — the same interface a real device
adapter (BACnet/Modbus gateway, MQTT bridge) would use. ``app.wiring`` binds the sink to the
ingestion service (the function behind ``POST /api/ingest/telemetry``). The simulator therefore never
imports ingestion, monitoring, decision or cmms code.
"""
from __future__ import annotations

from typing import Any, Protocol


class TelemetrySink(Protocol):
    def __call__(self, readings: list[dict[str, Any]], source: str) -> dict[str, Any]: ...


class MqttAdapter:
    """Stub for a real MQTT bridge (unused by default). A production adapter would subscribe to
    ``building/+/asset/+/sensor/+`` topics, map payloads to the telemetry event schema and call the
    sink in batches — exactly what the simulator does."""

    def __init__(self, broker_url: str, sink: TelemetrySink) -> None:
        self.broker_url = broker_url
        self.sink = sink

    def start(self) -> None:  # pragma: no cover - interface stub
        raise NotImplementedError("MQTT adapter is an interface stub in this demo")

    def stop(self) -> None:  # pragma: no cover - interface stub
        raise NotImplementedError("MQTT adapter is an interface stub in this demo")
