"""Job procedures (Layer 6) — the planned steps a technician follows on site, per asset type.

A procedure is an ordered list of steps ``(key, label, minutes)``. It is reference data, not a model:

    planned_minutes(asset_type, rework) = Σ step.minutes          (rework uses the shorter REWORK plan)
    step_at(elapsed)                    = first step i with Σ_{j≤i} minutes_j > elapsed

The UI uses it to show which step the technician is on (elapsed sim time since work began); the
operations autopilot uses the same plan to decide when the technician signs the job off, and records
the step keys as the inspection checklist. Durations are demo values in simulated minutes.
"""
from __future__ import annotations

from typing import Any

Step = tuple[str, str, int]

_FAN: list[Step] = [
    ("permit", "Permit-to-work, lock-out / tag-out of the fan isolator", 2),
    ("inspect", "Open access panel; inspect bearing housing, belt and pulleys", 3),
    ("measure", "Hand-held vibration and IR temperature check at both bearings", 2),
    ("replace", "Replace drive-end bearing set and re-grease", 8),
    ("align", "Check belt tension and shaft / pulley alignment", 3),
    ("test", "Remove LOTO, test run and observe vibration trend", 2),
]
_PUMP: list[Step] = [
    ("permit", "Permit-to-work; isolate pump electrically and hydraulically", 3),
    ("inspect", "Inspect coupling, motor bearings and mechanical seal for leaks", 3),
    ("measure", "Hand-held vibration and temperature at the motor bearings", 2),
    ("replace", "Replace motor bearing set and re-grease", 9),
    ("align", "Laser-align pump to motor coupling", 4),
    ("test", "Re-open valves, remove LOTO, test run", 2),
]
_CHILLER: list[Step] = [
    ("permit", "Permit-to-work; shut down chiller via BMS and isolate", 3),
    ("inspect", "Inspect compressor motor bearing area and oil level", 4),
    ("measure", "Vibration and temperature survey around the compressor", 3),
    ("replace", "Replace compressor motor bearing and re-lubricate", 12),
    ("align", "Check mounts and anti-vibration isolators", 3),
    ("test", "Restart under supervision; check pressures and vibration", 4),
]
_FCU: list[Step] = [
    ("permit", "Isolate the fan coil unit at the local switch", 1),
    ("inspect", "Drop the ceiling tile; inspect fan deck and motor", 2),
    ("measure", "Check fan for imbalance and bearing noise", 2),
    ("replace", "Replace fan motor bearing; clean fan wheel", 6),
    ("test", "Re-energise and test at all speeds", 2),
]
_REWORK: list[Step] = [
    ("permit", "Re-apply lock-out / tag-out", 2),
    ("inspect", "Re-inspect: check alignment, soft-foot and mounting bolts", 3),
    ("replace", "Correct alignment / fit replacement bearing set", 6),
    ("test", "Remove LOTO, test run and observe vibration trend", 2),
]

PROCEDURES: dict[str, list[Step]] = {
    "SUPPLY_FAN": _FAN, "EXHAUST_FAN": _FAN, "PUMP": _PUMP, "CHILLER": _CHILLER, "FCU": _FCU,
}

FINDINGS: dict[str, str] = {
    "SUPPLY_FAN": "Drive-end bearing showed inner-race spalling and dry grease; bearing set replaced, re-greased, belt re-tensioned.",
    "EXHAUST_FAN": "Bearing running rough with discoloured grease; bearing set replaced and re-greased, fan wheel balanced.",
    "PUMP": "Motor drive-end bearing noisy; bearing replaced, coupling re-aligned, seal checked — no leak.",
    "CHILLER": "Compressor motor bearing wear confirmed by survey; bearing replaced and re-lubricated, mounts checked.",
    "FCU": "Fan motor bearing dry and noisy; bearing replaced and fan wheel cleaned.",
}
REWORK_FINDINGS = "Rework: residual vibration traced to misalignment / soft-foot; corrected and second bearing set fitted."


def steps(asset_type: str, rework: bool = False) -> list[Step]:
    """Planned steps for an asset type (the shorter rework plan on a second visit)."""
    return _REWORK if rework else PROCEDURES.get(asset_type, _FAN)


def planned_minutes(asset_type: str, rework: bool = False) -> int:
    """Total planned on-site minutes = Σ step minutes."""
    return sum(m for _, _, m in steps(asset_type, rework))


def findings(asset_type: str, rework: bool = False) -> str:
    return REWORK_FINDINGS if rework else FINDINGS.get(asset_type, FINDINGS["SUPPLY_FAN"])


def catalogue() -> dict[str, Any]:
    """Serialisable catalogue for the API."""
    def ser(plan: list[Step]) -> list[dict[str, Any]]:
        return [{"key": k, "label": label, "minutes": m} for k, label, m in plan]
    return {"procedures": {t: ser(p) for t, p in PROCEDURES.items()}, "rework": ser(_REWORK),
            "note": "Planned steps and durations are demo values in simulated minutes."}
