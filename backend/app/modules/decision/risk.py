"""Layer 5 — risk score and decision table. Pure functions driven by the versioned policy.

    S = severity weight          {LOW .25, MEDIUM .5, HIGH .75, CRITICAL 1.0}
    C = criticality weight       {LOW .3, MEDIUM .6, HIGH 1.0}
    P = min(1, consecutive_anomalous_samples / 20)
    R = min(1, slope / slope_critical)              slope_critical = 6 mm/s/h
    Q = data-quality multiplier  1.0 good, 0.7 if any corroborating sensor is stale/suspect
    risk = 100 * (0.40*S + 0.25*C + 0.20*P + 0.15*R) * (0.5 + 0.5*Q)

Decision table (first match wins): risk ≥ 75 or severity CRITICAL → URGENT_HUMAN_REVIEW (P1);
55–75 → INSPECT_URGENT (P2); 30–55 → INSPECT (P3); < 30 → MONITOR (no work order).
The system never stops equipment automatically. Demo values — not taken from any standard.
"""
from __future__ import annotations

from typing import Any


def compute_risk(policy: dict[str, Any], severity: str, criticality: str, consecutive_anomalous: int,
                 slope: float, quality_degraded: bool) -> dict[str, Any]:
    w = policy["weights"]
    s = policy["severity_weight"][severity]
    c = policy["criticality_weight"][criticality]
    p = min(1.0, consecutive_anomalous / policy["persistence_samples"])
    r = min(1.0, max(0.0, slope) / policy["slope_critical"])
    q = policy["quality_multiplier"]["degraded" if quality_degraded else "good"]
    raw = w["severity"] * s + w["criticality"] * c + w["persistence"] * p + w["rate"] * r
    score = 100.0 * raw * (0.5 + 0.5 * q)
    terms = {
        "S": {"value": s, "weight": w["severity"], "contribution": round(100 * w["severity"] * s * (0.5 + 0.5 * q), 2),
              "label": f"severity {severity}"},
        "C": {"value": c, "weight": w["criticality"], "contribution": round(100 * w["criticality"] * c * (0.5 + 0.5 * q), 2),
              "label": f"asset criticality {criticality}"},
        "P": {"value": round(p, 3), "weight": w["persistence"], "contribution": round(100 * w["persistence"] * p * (0.5 + 0.5 * q), 2),
              "label": f"{consecutive_anomalous} consecutive anomalous samples / {policy['persistence_samples']}"},
        "R": {"value": round(r, 3), "weight": w["rate"], "contribution": round(100 * w["rate"] * r * (0.5 + 0.5 * q), 2),
              "label": f"slope {slope:.2f} mm/s/h / {policy['slope_critical']}"},
        "Q": {"value": q, "label": "data quality " + ("degraded" if quality_degraded else "good"),
              "multiplier": round(0.5 + 0.5 * q, 3)},
    }
    return {"score": round(min(100.0, score), 2), "terms": terms,
            "formula": "100 × (0.40·S + 0.25·C + 0.20·P + 0.15·R) × (0.5 + 0.5·Q)"}


def decide(policy: dict[str, Any], score: float, severity: str) -> dict[str, Any]:
    """Apply the decision table top-down."""
    for row in policy["decision_table"]:
        if score >= row["min_risk"] or row.get("or_severity") == severity:
            return {"action": row["name"], "priority": row["priority"], "approval": row["approval"]}
    raise ValueError("decision table has no matching row")


def priority_rank(policy: dict[str, Any], priority: str | None) -> int:
    return policy["priority_rank"].get(priority, 99) if priority else 99


def reason_text(asset_id: str, severity: str, score: float, action: str, priority: str | None) -> str:
    if action == "MONITOR":
        return (f"Risk score {score:.0f}/100 on {asset_id} is below the work-order threshold. "
                f"Continue monitoring; no work order is created.")
    label = {"INSPECT": "Inspection recommended", "INSPECT_URGENT": "Urgent inspection recommended",
             "URGENT_HUMAN_REVIEW": "Urgent human review required"}[action]
    return (f"{label} for {asset_id}: {severity.lower()}-severity vibration anomaly, risk score {score:.0f}/100 "
            f"(priority {priority}). This is an inspection recommendation, not a confirmed diagnosis.")
