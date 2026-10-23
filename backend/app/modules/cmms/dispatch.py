"""Technician dispatch ranking (Layer 6) — transparent and explainable.

    eligible = required_skills ⊆ tech.skills  AND  on_shift(sim_now)  AND  active_jobs < max_jobs
    score    = 0.35·skill_fit + 0.25·proximity + 0.20·(1 − workload) + 0.20·performance
      skill_fit   = min(1, |required ∩ skills| / |required| + 0.2 bonus when certification level ≥ 3)
      proximity   = 1 − |tech.current_floor − asset.floor| / max_floors
      workload    = active_jobs / max_jobs
      performance = first-time-fix rate (seeded 0.6–0.95, updated from real outcomes)

The system returns ranked candidates WITH the score breakdown (and the reasons for ineligibility);
a supervisor confirms the assignment — the system never assigns silently.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.models import Asset, Floor, Technician, TechnicianShift, WorkOrder

W_SKILL, W_PROX, W_LOAD, W_PERF = 0.35, 0.25, 0.20, 0.20
CERT_BONUS = 0.2
ACTIVE_JOB_STATUSES = ("ASSIGNED", "IN_PROGRESS", "REWORK_REQUIRED", "ON_HOLD")


def on_shift(session: Session, tech_id: str, now: datetime) -> bool:
    hour = now.hour + now.minute / 60.0
    return session.scalar(select(func.count()).select_from(TechnicianShift).where(
        TechnicianShift.technician_id == tech_id, TechnicianShift.weekday == now.weekday(),
        TechnicianShift.start_hour <= hour, TechnicianShift.end_hour > hour)) > 0


def active_jobs(session: Session, tech_id: str, exclude_wo: int | None = None) -> int:
    stmt = select(func.count()).select_from(WorkOrder).where(
        WorkOrder.assigned_technician_id == tech_id, WorkOrder.status.in_(ACTIVE_JOB_STATUSES))
    if exclude_wo is not None:
        stmt = stmt.where(WorkOrder.id != exclude_wo)
    return int(session.scalar(stmt) or 0)


def floor_levels(session: Session) -> tuple[int, int]:
    lo, hi = session.execute(select(func.min(Floor.level), func.max(Floor.level))).one()
    return int(lo), int(hi)


def travel_minutes(from_floor: int, to_floor: int) -> int:
    """Sim minutes to walk between floors: 3 min to the lift core + 2 min per floor (ASSUMPTIONS #13)."""
    return 3 + 2 * abs(from_floor - to_floor)


def score_technician(session: Session, tech: Technician, asset: Asset, required: list[str], now: datetime,
                     wo_id: int | None = None) -> dict[str, Any]:
    lo, hi = floor_levels(session)
    max_floors = max(1, hi - lo)
    missing = sorted(set(required) - set(tech.skills))
    jobs = active_jobs(session, tech.id, exclude_wo=wo_id)
    shift = on_shift(session, tech.id, now)
    reasons: list[str] = []
    if missing:
        reasons.append(f"missing required skill(s): {', '.join(missing)}")
    if not shift:
        reasons.append("not on shift at the current simulation time")
    if jobs >= tech.max_jobs:
        reasons.append(f"at maximum workload ({jobs}/{tech.max_jobs} active jobs)")
    fit = len(set(required) & set(tech.skills)) / len(required) if required else 1.0
    fit_bonus = CERT_BONUS if tech.certification_level >= 3 else 0.0
    skill_fit = min(1.0, fit + fit_bonus)
    distance = abs(tech.current_floor - asset.floor.level)
    proximity = 1.0 - distance / max_floors
    workload = jobs / tech.max_jobs
    parts = {
        "skill_fit": {"value": round(skill_fit, 3), "weight": W_SKILL, "contribution": round(W_SKILL * skill_fit, 4),
                      "detail": f"{len(set(required) & set(tech.skills))}/{len(required)} required skills"
                                + (f", +{CERT_BONUS} certification bonus" if fit_bonus else "")},
        "proximity": {"value": round(proximity, 3), "weight": W_PROX, "contribution": round(W_PROX * proximity, 4),
                      "detail": f"{distance} floor(s) away (currently floor {tech.current_floor})"},
        "availability": {"value": round(1 - workload, 3), "weight": W_LOAD, "contribution": round(W_LOAD * (1 - workload), 4),
                         "detail": f"{jobs}/{tech.max_jobs} active jobs"},
        "performance": {"value": round(tech.performance, 3), "weight": W_PERF, "contribution": round(W_PERF * tech.performance, 4),
                        "detail": f"first-time-fix rate {tech.performance:.0%}"},
    }
    total = sum(p["contribution"] for p in parts.values())
    return {
        "technician_id": tech.id, "name": tech.name, "skills": tech.skills, "certification_level": tech.certification_level,
        "current_floor": tech.current_floor, "eligible": not reasons, "ineligible_reasons": reasons,
        "score": round(total, 4), "breakdown": parts, "active_jobs": jobs, "on_shift": shift,
        "travel_minutes": travel_minutes(tech.current_floor, asset.floor.level),
        "formula": "0.35·skill_fit + 0.25·proximity + 0.20·(1 − workload) + 0.20·performance",
    }


def rank_candidates(session: Session, wo: WorkOrder) -> list[dict[str, Any]]:
    asset = session.get(Asset, wo.asset_id)
    assert asset is not None
    now = clock.sim_now(session)
    rows = [score_technician(session, t, asset, wo.required_skills, now, wo.id)
            for t in session.scalars(select(Technician).order_by(Technician.id))]
    rows.sort(key=lambda r: (not r["eligible"], -r["score"]))
    for i, r in enumerate(rows, start=1):
        r["rank"] = i if r["eligible"] else None
    return rows
