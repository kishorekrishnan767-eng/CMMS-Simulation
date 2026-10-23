"""Deterministic, template-based explanations. No model, no randomness.

Wording rule (CLAUDE.md #7): an anomaly is not a diagnosis. Never write that something "failed";
say "consistent with possible …" and recommend inspection.
"""
from __future__ import annotations

CORROBORATION_LABELS = {"bearing_temperature": "Bearing temperature", "motor_current": "Motor current"}


def explain_vibration(asset_id: str, z: float, slope: float, minutes: float, corroborating: list[str]) -> str:
    rising = f"kept rising for {max(1, round(minutes))} min (slope {slope:.1f} mm/s/h)" if slope > 0 \
        else f"stayed elevated for {max(1, round(minutes))} min"
    if corroborating:
        names = [CORROBORATION_LABELS.get(m, m) for m in corroborating]
        corr = (" and ".join(names) + (" corroborates. " if len(names) == 1 else " corroborate. "))
    else:
        corr = "No corroborating sensor deviation yet. "
    return (f"Vibration on {asset_id} has risen {z:.1f}σ above its load-adjusted baseline and {rising}. "
            f"{corr}This pattern is consistent with possible bearing degradation. Recommended: inspection.")
