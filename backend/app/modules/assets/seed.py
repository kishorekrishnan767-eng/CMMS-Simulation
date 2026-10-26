"""Seed data: the Livewire Digital Solutions building, assets, sensors, users, technicians, shifts, inventory, simulation state.

Seeding is idempotent per table (skips when rows exist). The simulation epoch is a Monday at 02:00
UTC; after the 6 h warm start "now" is 08:00 (start of the working day) — see ASSUMPTIONS #4.
"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Asset, Building, Floor, InventoryItem, Role, Sensor, SimulationRun, SimulationState,
    StockMovement, Technician, TechnicianShift, User,
)
from app.security import hash_password

BUILDING_ID = "TOWER-A"  # internal id kept stable; the display name is BUILDING_NAME
BUILDING_NAME = "Livewire Digital Solutions"
SIM_EPOCH = datetime(2026, 3, 2, 2, 0, 0)  # Monday
DEMO_PASSWORD = "demo1234"
FLOOR_HEIGHT_M = 4.0

FLOORS = [
    (-1, "Basement plant room", "BASEMENT"),
    (0, "Ground lobby", "LOBBY"),
    (1, "Floor 1 · Development", "OFFICE"), (2, "Floor 2 · Development & server room", "OFFICE"),
    (3, "Floor 3 · BMS control room", "OFFICE"), (4, "Floor 4 · Project teams", "OFFICE"),
    (5, "Floor 5 · Management", "OFFICE"),
    (6, "Roof plant deck", "ROOF"),
]

FAN_SIM = {"vib_base": 0.5, "vib_gain": 1.5, "vib_noise": 0.08, "temp_base": 42.0, "temp_gain": 12.0,
           "temp_noise": 0.4, "cur_gain": 10.0, "cur_noise": 0.15, "fault_vib_to_temp": 0.9, "fault_vib_to_cur": 0.12}

_FCU_SIM = dict(vib_base=0.3, vib_gain=0.9, temp_base=34.0, temp_gain=6.0, cur_gain=1.8, cur_noise=0.04)

# id, name, type, level, criticality, skills, manufacturer/model, runtime, pos(x,z), sim overrides
ASSETS: list[dict] = [
    dict(id="AHU-02-FAN-01", name="AHU-02 supply fan", type="SUPPLY_FAN", level=6, crit="HIGH",
         skills=["HVAC_MECHANICAL", "BEARING_SERVICE"], make="AirFlow Dynamics", model="SF-900", hours=31250, x=0.0, z=-4.0, sim={}),
    dict(id="AHU-01-FAN-01", name="AHU-01 supply fan", type="SUPPLY_FAN", level=6, crit="HIGH",
         skills=["HVAC_MECHANICAL", "BEARING_SERVICE"], make="AirFlow Dynamics", model="SF-900", hours=30410, x=-10.0, z=-4.0, sim={}),
    dict(id="AHU-03-FAN-01", name="AHU-03 supply fan", type="SUPPLY_FAN", level=6, crit="MEDIUM",
         skills=["HVAC_MECHANICAL", "BEARING_SERVICE"], make="AirFlow Dynamics", model="SF-700", hours=24800, x=10.0, z=-4.0, sim={}),
    dict(id="CHILLER-01", name="Chiller 01", type="CHILLER", level=-1, crit="HIGH",
         skills=["HVAC_MECHANICAL", "CHILLER"], make="CoolCore", model="CC-450", hours=42100, x=-8.0, z=0.0,
         sim=dict(vib_base=0.8, vib_gain=1.2, temp_base=48.0, temp_gain=10.0, cur_gain=60.0, cur_noise=0.6)),
    dict(id="CHW-PUMP-01", name="Chilled-water pump 01", type="PUMP", level=-1, crit="MEDIUM",
         skills=["HVAC_MECHANICAL", "PUMPS"], make="HydroFlow", model="HP-55", hours=38900, x=4.0, z=-3.0,
         sim=dict(vib_base=0.6, vib_gain=1.3, temp_base=40.0, temp_gain=9.0, cur_gain=18.0, cur_noise=0.25)),
    dict(id="CHW-PUMP-02", name="Chilled-water pump 02", type="PUMP", level=-1, crit="MEDIUM",
         skills=["HVAC_MECHANICAL", "PUMPS"], make="HydroFlow", model="HP-55", hours=21500, x=4.0, z=3.0,
         sim=dict(vib_base=0.6, vib_gain=1.3, temp_base=40.0, temp_gain=9.0, cur_gain=18.0, cur_noise=0.25)),
    dict(id="EXH-FAN-01", name="Exhaust fan 01", type="EXHAUST_FAN", level=6, crit="LOW",
         skills=["HVAC_MECHANICAL", "BEARING_SERVICE"], make="AirFlow Dynamics", model="EF-300", hours=18700, x=14.0, z=6.0,
         sim=dict(vib_base=0.4, vib_gain=1.2, temp_base=38.0, temp_gain=8.0, cur_gain=5.0, cur_noise=0.1)),
    dict(id="FCU-03-01", name="Fan coil unit F3-01", type="FCU", level=3, crit="LOW",
         skills=["HVAC_MECHANICAL"], make="ClimateWorks", model="FC-12", hours=12400, x=8.0, z=5.0,
         sim=dict(vib_base=0.3, vib_gain=0.9, temp_base=34.0, temp_gain=6.0, cur_gain=1.8, cur_noise=0.04)),
    # office air-conditioning (fan coil units) and the server-room precision AC
    dict(id="FCU-01-01", name="AC unit F1 (development)", type="FCU", level=1, crit="LOW",
         skills=["HVAC_MECHANICAL"], make="ClimateWorks", model="FC-12", hours=11800, x=8.0, z=5.0, sim=dict(_FCU_SIM)),
    dict(id="FCU-02-01", name="AC unit F2 (development)", type="FCU", level=2, crit="LOW",
         skills=["HVAC_MECHANICAL"], make="ClimateWorks", model="FC-12", hours=9600, x=8.0, z=-5.0, sim=dict(_FCU_SIM)),
    dict(id="CRAC-02-01", name="Server-room precision AC", type="FCU", level=2, crit="HIGH",
         skills=["HVAC_MECHANICAL"], make="ClimateWorks", model="PX-20", hours=26300, x=-16.0, z=8.0,
         sim=dict(_FCU_SIM, cur_gain=4.5)),
    dict(id="FCU-04-01", name="AC unit F4 (project teams)", type="FCU", level=4, crit="LOW",
         skills=["HVAC_MECHANICAL"], make="ClimateWorks", model="FC-12", hours=10100, x=8.0, z=5.0, sim=dict(_FCU_SIM)),
    dict(id="FCU-05-01", name="AC unit F5 (management)", type="FCU", level=5, crit="MEDIUM",
         skills=["HVAC_MECHANICAL"], make="ClimateWorks", model="FC-12", hours=8700, x=8.0, z=-5.0, sim=dict(_FCU_SIM)),
]

SENSOR_DEFS = [
    ("VIB", "vibration_velocity", "mm/s", "Vibration velocity", 0.0, 50.0, True),
    ("TMP", "bearing_temperature", "°C", "Bearing temperature", -10.0, 150.0, False),
    ("CUR", "motor_current", "A", "Motor current", 0.0, 200.0, False),
    ("SPD", "speed_command", "%", "VFD speed command", 0.0, 110.0, False),
]

ROLE_DESCRIPTIONS = {
    "ADMIN": "Administers the system and the simulation",
    "OPERATOR": "Monitors the building, injects faults, cannot approve work",
    "SUPERVISOR": "Approves, assigns and closes work orders",
    "TECHNICIAN": "Executes assigned work orders",
    "VERIFIER": "Independently verifies completed repairs",
}

# Every technician is based in the maintenance crew room on the ground floor (level 0) and walks out
# from there; colours are hi-vis vest colours so the avatars are easy to tell apart.
TECHNICIANS = [
    dict(id="TECH-01", name="Arjun Mehta", skills=["HVAC_MECHANICAL", "BEARING_SERVICE", "PUMPS"], cert=2,
         home=0, perf=0.88, rate=48.0, color="#f08c00", weekdays=range(7), start=7.0, end=19.0),
    dict(id="TECH-02", name="Priya Nair", skills=["HVAC_MECHANICAL", "BEARING_SERVICE", "CHILLER"], cert=3,
         home=0, perf=0.93, rate=62.0, color="#1c7ed6", weekdays=range(7), start=7.0, end=19.0),
    dict(id="TECH-03", name="Sam Okafor", skills=["HVAC_MECHANICAL", "PUMPS", "ELECTRICAL"], cert=1,
         home=0, perf=0.68, rate=38.0, color="#2f9e44", weekdays=range(5), start=6.0, end=18.0),
]

USERS = [
    ("admin", "Ada Admin", "ADMIN", None),
    ("operator", "Omar Operator", "OPERATOR", None),
    ("supervisor", "Kishore", "SUPERVISOR", None),  # BMS supervisor at the Floor 3 control room
    ("tech1", "Arjun Mehta", "TECHNICIAN", "TECH-01"),
    ("tech2", "Priya Nair", "TECHNICIAN", "TECH-02"),
    ("tech3", "Sam Okafor", "TECHNICIAN", "TECH-03"),
    ("verifier", "Vera Verifier", "VERIFIER", None),
]

INVENTORY = [
    ("BRG-001", "Bearing set (fan shaft)", "set", 185.0, 2, 4, "Store A-1", 4),
    ("GRS-001", "Bearing grease cartridge", "pcs", 14.5, 4, 12, "Store A-2", 12),
    ("BLT-001", "V-belt set", "set", 32.0, 2, 6, "Store A-3", 6),
    ("FLT-001", "Panel air filter", "pcs", 22.0, 6, 20, "Store B-1", 20),
    ("SEAL-001", "Pump mechanical seal kit", "kit", 96.0, 1, 3, "Store B-2", 3),
]


def seed_reference_data(session: Session) -> None:
    """Seed everything except detector/policy rows (created by their own modules)."""
    if session.get(Building, BUILDING_ID) is None:
        session.add(Building(id=BUILDING_ID, name=BUILDING_NAME,
                             description="Office HQ — ground lobby, five office floors, roof plant deck, basement plant room",
                             address="Demo Business Park (fictional)"))
        session.flush()
        for level, name, kind in FLOORS:
            session.add(Floor(building_id=BUILDING_ID, level=level, name=name, kind=kind,
                              elevation_m=level * FLOOR_HEIGHT_M))
        session.flush()
    else:
        # reference data evolves between versions (building / floor names): keep existing databases in sync
        building = session.get(Building, BUILDING_ID)
        assert building is not None
        building.name = BUILDING_NAME
        for f in session.scalars(select(Floor).where(Floor.building_id == BUILDING_ID)):
            f.name = next((n for lvl, n, _ in FLOORS if lvl == f.level), f.name)

    floor_by_level = {f.level: f for f in session.scalars(select(Floor).where(Floor.building_id == BUILDING_ID))}
    for idx, a in enumerate(ASSETS, start=1):
        if session.get(Asset, a["id"]) is None:  # also adds assets introduced after the database was created
            floor = floor_by_level[a["level"]]
            sim = {**FAN_SIM, **a["sim"]}
            session.add(Asset(
                id=a["id"], building_id=BUILDING_ID, floor_id=floor.id, name=a["name"], asset_type=a["type"],
                criticality=a["crit"], required_skills=a["skills"], install_date=date(2019, 6, 1) if idx % 2 else date(2021, 3, 15),
                last_maintenance=date(2025, 11, 12), runtime_hours=a["hours"], manufacturer=a["make"], model=a["model"],
                sim_params=sim, pos_x=a["x"], pos_y=floor.elevation_m, pos_z=a["z"],
            ))
            session.flush()
            for kind, metric, unit, label, lo, hi, primary in SENSOR_DEFS:
                session.add(Sensor(id=f"{kind}-{idx:03d}", asset_id=a["id"], kind=kind, metric=metric, unit=unit,
                                   label=f"{label} — {a['name']}", range_min=lo, range_max=hi, is_primary=primary))

    for name, desc in ROLE_DESCRIPTIONS.items():
        if session.get(Role, name) is None:
            session.add(Role(name=name, description=desc))
    session.flush()

    if not session.scalar(select(Technician.id).limit(1)):
        for t in TECHNICIANS:
            session.add(Technician(
                id=t["id"], name=t["name"], skills=t["skills"], certification_level=t["cert"], home_floor=t["home"],
                current_floor=t["home"], max_jobs=2, performance=t["perf"], seeded_performance=t["perf"],
                hourly_rate=t["rate"], color=t["color"]))
        session.flush()
        for t in TECHNICIANS:
            for wd in t["weekdays"]:
                session.add(TechnicianShift(technician_id=t["id"], weekday=wd, start_hour=t["start"], end_hour=t["end"]))

    else:
        # reference data may change between versions (crew room location, vest colours): keep it in sync
        for t in TECHNICIANS:
            row = session.get(Technician, t["id"])
            if row is not None and (row.home_floor != t["home"] or row.color != t["color"]):
                row.home_floor, row.color = t["home"], t["color"]
                if row.status == "AVAILABLE":
                    row.current_floor = t["home"]

    if session.scalar(select(User.id).limit(1)):
        for username, display, _role, _tech in USERS:
            u = session.scalar(select(User).where(User.username == username))
            if u is not None and u.display_name != display:
                u.display_name = display
    if not session.scalar(select(User.id).limit(1)):
        pw = hash_password(DEMO_PASSWORD)
        for username, display, role, tech in USERS:
            session.add(User(username=username, display_name=display, role=role, password_hash=pw, technician_id=tech))

    if not session.scalar(select(InventoryItem.sku).limit(1)):
        for sku, name, unit, cost, reorder, reorder_qty, loc, qty in INVENTORY:
            session.add(InventoryItem(sku=sku, name=name, unit=unit, unit_cost=cost, reorder_level=reorder,
                                      reorder_quantity=reorder_qty, location=loc))
        session.flush()
        for sku, *_rest, qty in INVENTORY:
            session.add(StockMovement(sku=sku, quantity=qty, movement_type="INITIAL", balance_after=qty,
                                      note="Opening stock", occurred_at=SIM_EPOCH))

    if session.get(SimulationState, 1) is None:
        run = SimulationRun(seed=42, profile="demo", started_at=SIM_EPOCH, note="initial")
        session.add(run)
        session.flush()
        session.add(SimulationState(id=1, run_id=run.id, sim_now=SIM_EPOCH, last_sample_at=SIM_EPOCH, epoch=SIM_EPOCH,
                                    speed=60.0, running=False, seed=42, profile="demo"))
    session.flush()
