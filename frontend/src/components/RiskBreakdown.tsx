import type { Decision } from "../api/types";

const NAMES: Record<string, string> = { S: "Severity", C: "Criticality", P: "Persistence", R: "Rate of change" };

/** Risk score with every term of the formula shown (no hidden numbers). */
export default function RiskBreakdown({ decision }: { decision: Decision }) {
  const t = decision.breakdown.terms;
  const q = t.Q;
  return (
    <div className="space-y-2" data-testid="risk-breakdown">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-3xl font-semibold tabular-nums">{Math.round(decision.risk_score)}<span className="text-base text-muted"> / 100</span></div>
          <div className="text-xs text-muted">{decision.action.replaceAll("_", " ")} · priority {decision.priority ?? "—"} · approval: {decision.required_approval}</div>
        </div>
        <span className="badge badge-muted">{decision.policy_version}</span>
      </div>
      {(["S", "C", "P", "R"] as const).map((k) => (
        <div key={k} className="text-xs">
          <div className="mb-0.5 flex justify-between">
            <span>{NAMES[k]} <span className="text-muted">({t[k].label})</span></span>
            <span className="tabular-nums text-muted">
              {t[k].value} × {t[k].weight} → <b className="text-ink">{t[k].contribution?.toFixed(1)}</b>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-panel2">
            <div className="h-full rounded bg-accent" style={{ width: `${Math.min(100, ((t[k].contribution ?? 0) / 40) * 100)}%` }} />
          </div>
        </div>
      ))}
      <div className="text-xs text-muted">
        Data quality: {q.label} (× {q.multiplier}) · <code>{decision.breakdown.formula}</code>
      </div>
      <p className="text-xs text-muted">{decision.reason}</p>
      {decision.safety_note && <p className="rounded border border-watch/40 bg-watch/10 p-2 text-xs text-watch">{decision.safety_note}</p>}
      <p className="text-[11px] text-muted">Demo policy values — not taken from any standard.</p>
    </div>
  );
}
