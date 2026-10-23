"""Layer 1 — building and asset model."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, CheckConstraint, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

CRITICALITIES = ("LOW", "MEDIUM", "HIGH")
ASSET_STATUSES = ("OPERATIONAL", "UNDER_MAINTENANCE", "OFFLINE")
HEALTH_STATES = ("NORMAL", "WATCH", "ANOMALY", "CLEARED")
SENSOR_QUALITIES = ("GOOD", "STALE", "SUSPECT_FLATLINE")


class Building(Base):
    __tablename__ = "buildings"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    address: Mapped[str] = mapped_column(String(200), default="")
    floors: Mapped[list[Floor]] = relationship(back_populates="building", order_by="Floor.level")


class Floor(Base):
    __tablename__ = "floors"
    __table_args__ = (UniqueConstraint("building_id", "level"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    building_id: Mapped[str] = mapped_column(ForeignKey("buildings.id"))
    level: Mapped[int] = mapped_column(Integer)  # -1 basement, 0 lobby, 1..5 office, 6 roof
    name: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(20))  # BASEMENT | LOBBY | OFFICE | ROOF
    elevation_m: Mapped[float] = mapped_column(Float)
    building: Mapped[Building] = relationship(back_populates="floors")


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint(f"criticality IN {CRITICALITIES}", name="criticality"),
        CheckConstraint(f"status IN {ASSET_STATUSES}", name="status"),
        CheckConstraint(f"health_state IN {HEALTH_STATES}", name="health_state"),
        CheckConstraint("warn_limit < alarm_limit AND alarm_limit < critical_limit", name="limits_order"),
    )
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    building_id: Mapped[str] = mapped_column(ForeignKey("buildings.id"))
    floor_id: Mapped[int] = mapped_column(ForeignKey("floors.id"))
    name: Mapped[str] = mapped_column(String(120))
    asset_type: Mapped[str] = mapped_column(String(30))  # SUPPLY_FAN | EXHAUST_FAN | CHILLER | PUMP | FCU
    criticality: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20), default="OPERATIONAL")
    health_state: Mapped[str] = mapped_column(String(10), default="NORMAL")
    required_skills: Mapped[list[str]] = mapped_column(JSON, default=list)
    install_date: Mapped[date] = mapped_column(Date)
    last_maintenance: Mapped[date | None] = mapped_column(Date, nullable=True)
    runtime_hours: Mapped[float] = mapped_column(Float, default=0.0)
    manufacturer: Mapped[str] = mapped_column(String(80), default="")
    model: Mapped[str] = mapped_column(String(80), default="")
    # Demo vibration limits (mm/s), configurable per asset — NOT taken from any standard.
    warn_limit: Mapped[float] = mapped_column(Float, default=4.5)
    alarm_limit: Mapped[float] = mapped_column(Float, default=7.1)
    critical_limit: Mapped[float] = mapped_column(Float, default=11.0)
    # Simulation coefficients for this asset (physics only; never read by detection logic).
    sim_params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 3D placement in the scene (metres, building local frame).
    pos_x: Mapped[float] = mapped_column(Float, default=0.0)
    pos_y: Mapped[float] = mapped_column(Float, default=0.0)
    pos_z: Mapped[float] = mapped_column(Float, default=0.0)
    watermark: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    sensors: Mapped[list[Sensor]] = relationship(back_populates="asset", order_by="Sensor.id")
    floor: Mapped[Floor] = relationship()


class Sensor(Base):
    __tablename__ = "sensors"
    __table_args__ = (
        CheckConstraint("range_min < range_max", name="range"),
        CheckConstraint(f"quality IN {SENSOR_QUALITIES}", name="quality"),
        CheckConstraint("flat_count >= 0", name="flat_count"),
    )
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True)
    kind: Mapped[str] = mapped_column(String(8))  # VIB | TMP | CUR | SPD
    metric: Mapped[str] = mapped_column(String(40))
    unit: Mapped[str] = mapped_column(String(12))
    label: Mapped[str] = mapped_column(String(80))
    range_min: Mapped[float] = mapped_column(Float)
    range_max: Mapped[float] = mapped_column(Float)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    quality: Mapped[str] = mapped_column(String(20), default="GOOD")
    last_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_timestamp: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    flat_count: Mapped[int] = mapped_column(Integer, default=0)
    asset: Mapped[Asset] = relationship(back_populates="sensors")
