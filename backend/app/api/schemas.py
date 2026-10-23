"""Request bodies (Pydantic v2). Responses are plain dicts built by serializers next to the routes."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class TelemetryReadingIn(BaseModel):
    event_id: str
    asset_id: str
    sensor_id: str
    metric: str
    value: float
    unit: str
    timestamp: str
    source: str = "api"
    quality: str = "good"


class IngestIn(BaseModel):
    # Raw dicts so malformed readings reach the validator (and are recorded) instead of a 422.
    readings: list[dict[str, Any]] = Field(max_length=5000)
    source: str = "api"


class SimPatchIn(BaseModel):
    speed: float | None = None
    seed: int | None = None
    profile: str | None = None


class SimResetIn(BaseModel):
    seed: int | None = None
    profile: str | None = None


class FaultIn(BaseModel):
    asset_id: str
    fault_type: str
    sensor_id: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class RepairEffectivenessIn(BaseModel):
    effectiveness: float
