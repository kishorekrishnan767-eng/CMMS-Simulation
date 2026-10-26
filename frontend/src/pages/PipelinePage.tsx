import { useEffect, useState } from "react";
import { useEvents, useIncidents, useTimeline } from "../api/queries";
import { Empty, Loading, PageShell, fmtTime } from "../components/ui";
import { LAYERS } from "../config";

const DOC: Record<number, { purpose: string; inputs: string; algo: string[]; outputs: string; tables: string }> = {
  1: {
    purpose: "Describe what exists: the building, floors, assets, sensors, criticality and the skills needed to maintain each asset.",
    inputs: "Seed data / asset registry (a real deployment would import a BMS point list — BACnet objects or Modbus registers).",
    algo: ["Each sensor belongs to exactly one asset (foreign key)", "Per-asset demo limits (warn 4.5 / alarm 7.1 / critical 11.0 mm/s) — not from any standard"],
    outputs: "Asset tree, sensor catalogue, expected units and plausibility ranges used by Layer 3.",
    tables: "buildings, floors, assets, sensors",
  },
  2: {
    purpose: "A seeded, deterministic simulator stands in for field devices and publishes telemetry through the same ingestion interface a real adapter would use.",
    inputs: "Simulation clock, seed, profile, injected faults.",
    algo: [
      "load(t) = clip(0.80 + 0.15·sin(2π(hour−7)/24) + step, 0.55, 1.0)",
      "vibration = 0.5 + 1.5·load + N(0, 0.08) + D(t)",
      "D(t) = A·((t−t₀)/T)^p, clamped at 1.15·A (bearing wear)",
      "bearing °C = 42 + 12·load + 0.9·D + noise · current A = 10·load + 0.12·D + noise",
    ],
    outputs: "Telemetry events (event_id, asset, sensor, metric, value, unit, timestamp, source).",
    tables: "simulation_runs, simulation_state, fault_injections",
  },
  3: {
    purpose: "Validate and store every reading. Bad data is never silently dropped.",
    inputs: "Raw telemetry batches (POST /api/ingest/telemetry).",
    algo: [
      "1 schema · 2 idempotency (duplicate event_id) · 3 sensor/asset/metric references · 4 unit",
      "5 timestamp: future → reject; >5 min behind the asset watermark → LATE (stored, not fed to the detector)",
      "6 plausibility range · 7 flatline (15 identical values) · 8 gap > 3 intervals → STALE + warning",
    ],
    outputs: "TelemetryAccepted (good readings), TelemetryRejected, DataQualityWarning.",
    tables: "telemetry_readings (raw, with quality/status), rejected_telemetry (with reason)",
  },
  4: {
    purpose: "Transparent statistics decide whether a metric deviates persistently from its load-adjusted baseline. An anomaly is not a diagnosis.",
    inputs: "Accepted telemetry.",
    algo: [
      "baseline: v ≈ a + b·load over healthy samples; r = v − (a + b·load); σ = max(1.4826·MAD(r), 0.05); z = r/σ",
      "slope = OLS slope of r over 15 samples (mm/s per h); persistence = samples with z ≥ 3.5 among the last 10",
      "NORMAL→WATCH: z ≥ 2.5 ×3 or slope ≥ 0.5 · WATCH→ANOMALY: persistence ≥ 6/10 and slope > 0 · clear only via verification",
      "severity = max(statistical z, absolute limits); corroboration raises confidence, never severity",
    ],
    outputs: "AnomalyDetected / AnomalyEscalated / AnomalyCleared with evidence, z, slope, corroboration and a template explanation.",
    tables: "detector_state, anomaly_events, anomaly_evidence",
  },
  5: {
    purpose: "Turn an anomaly into a recommendation under a versioned policy. One active work order per asset and failure mode.",
    inputs: "Anomaly events + asset criticality + data quality.",
    algo: [
      "risk = 100·(0.40·S + 0.25·C + 0.20·P + 0.15·R)·(0.5 + 0.5·Q)",
      "< 30 MONITOR · 30–55 INSPECT (P3) · 55–75 INSPECT_URGENT (P2) · ≥ 75 or CRITICAL URGENT_HUMAN_REVIEW (P1)",
      "dedup: partial unique index on active (asset, failure_mode) + in-transaction check; repeats attach evidence",
    ],
    outputs: "RiskAssessed, WorkOrderDrafted, EvidenceAttached, PriorityEscalationProposed.",
    tables: "risk_assessments, policy_versions, work_orders (draft)",
  },
  6: {
    purpose: "Run the maintenance workflow with enforced roles, explainable dispatch and a transactional parts ledger.",
    inputs: "Work orders, user commands, inventory.",
    algo: [
      "one transition() service: DRAFT→OPEN→ASSIGNED→IN_PROGRESS→COMPLETED→VERIFIED→CLOSED (+ ON_HOLD, REWORK_REQUIRED)",
      "dispatch score = 0.35·skill_fit + 0.25·proximity + 0.20·(1−workload) + 0.20·first-time-fix rate",
      "reserve parts on assignment; shortage → ON_HOLD (AWAITING_PARTS); consume on completion under row locks",
    ],
    outputs: "WorkOrderApproved, TechnicianAssigned, PartsReserved/PartsShortage, WorkStarted, WorkCompleted, WorkOrderClosed.",
    tables: "work_orders, work_order_events, approvals, inspection_records, technicians, inventory_items, stock_movements, stock_reservations, audit_logs",
  },
  7: {
    purpose: "Check that the repair worked, independently, and learn from ground truth — without auto-tuning anything.",
    inputs: "Post-repair telemetry, frozen baseline, verifier identity.",
    algo: [
      "30 post-repair samples (after a 30 min settle): |mean residual| ≤ 2σ, max z < 3, |slope| < 0.3, no anomaly raised, temperature/current normal",
      "verifier ≠ technician (separation of duties)",
      "metrics: detection latency, lead time before the alarm limit, MTTA, MTTR, precision, cost",
    ],
    outputs: "VerificationPassed / VerificationFailed / ReworkRequired, evaluation records.",
    tables: "verification_records, evaluations, fault_injections",
  },
};

const LAYER_COLOR = ["", "#6b7785", "#3b82c4", "#5a8fa8", "#d08a1a", "#c9661a", "#1f5fbf", "#2f9e5a"];

function Feed({ layer }: { layer: number }) {
  const { data } = useEvents(`layer=${layer}&limit=6`);
  const items = (data?.items ?? []).filter((e) => e.event_type !== "TelemetryAccepted" || layer === 3).slice(0, 6);
  return (
    <ul className="space-y-1 text-xs" data-testid={`feed-${layer}`} aria-label={`Live events for layer ${layer}`}>
      {items.length === 0 && <li className="text-muted">No events yet.</li>}
      {items.map((e) => (
        <li key={e.event_id} className="flex justify-between gap-2 rounded border border-line px-2 py-1">
          <span className="font-medium">{e.event_type}</span>
          <span className="truncate text-muted">{e.asset_id ?? ""} {e.correlation_id ?? ""}</span>
          <span className="tabular-nums text-muted">{fmtTime(e.occurred_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Timeline() {
  const { data: incidents } = useIncidents();
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (!sel && incidents?.length) setSel(incidents[0].incident_id); }, [incidents, sel]);
  const { data, isLoading } = useTimeline(sel);
  return (
    <section className="card p-4" id="timeline" data-testid="incident-timeline">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Incident timeline</h2>
          <p className="text-xs text-muted">Every record of one incident, linked by its correlation id — from the first deviating reading to closure.</p>
        </div>
        <select className="input w-auto" value={sel ?? ""} onChange={(e) => setSel(e.target.value)} aria-label="Incident" data-testid="incident-select">
          {(incidents ?? []).map((i) => <option key={i.incident_id} value={i.incident_id}>{i.incident_id} · {i.asset_id} · {i.work_order ?? "no WO"} {i.work_order_status ?? ""}</option>)}
        </select>
      </div>
      {(incidents?.length ?? 0) === 0 && <Empty title="No incidents yet" hint="Inject bearing wear on the Control page or run the guided demo." />}
      {sel && isLoading && <Loading />}
      {data && (
        <ol className="relative ml-2 space-y-2 border-l border-line pl-5" data-testid="timeline-items">
          {data.items.map((i, idx) => (
            <li key={idx} className="relative text-sm" data-layer={i.layer} data-type={i.type}>
              <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-bg" style={{ background: i.type === "ActionDenied" ? "#c4302b" : LAYER_COLOR[i.layer] }} />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular-nums text-xs text-muted">{fmtTime(i.t)}</span>
                <span className="badge badge-muted">L{i.layer}</span>
                <b className={i.type === "ActionDenied" ? "text-bad" : ""}>{i.title}</b>
                {i.work_order && <span className="text-xs text-muted">{i.work_order}</span>}
              </div>
              {i.detail && <div className="text-xs text-muted">{i.detail}</div>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function PipelinePage() {
  return (
    <PageShell title="Layer explorer" subtitle="Sensor data → validation → anomaly detection → risk decision → work order → approval → dispatch → repair → verification → learning. Each layer below shows what it does and a live feed of the events passing through it.">
      <div className="grid gap-4 lg:grid-cols-2">
        {LAYERS.map((l) => {
          const d = DOC[l.n];
          return (
            <section key={l.n} className="card p-4" id={`layer-${l.n}`} data-testid={`layer-section-${l.n}`}>
              <div className="mb-2 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-md text-sm font-bold text-white" style={{ background: LAYER_COLOR[l.n] }}>{l.n}</span>
                <h2 className="text-lg font-semibold">{l.name}</h2>
              </div>
              <p className="text-sm">{d.purpose}</p>
              <dl className="mt-3 space-y-2 text-xs">
                <div><dt className="h-section">Inputs</dt><dd className="text-muted">{d.inputs}</dd></div>
                <div><dt className="h-section">Algorithm</dt><dd><ul className="list-disc space-y-0.5 pl-4 text-muted">{d.algo.map((a) => <li key={a}><code className="text-[11px] text-ink">{a}</code></li>)}</ul></dd></div>
                <div><dt className="h-section">Outputs</dt><dd className="text-muted">{d.outputs}</dd></div>
                <div><dt className="h-section">Stored in</dt><dd className="text-muted">{d.tables}</dd></div>
              </dl>
              <div className="h-section mb-1 mt-3">Live event feed</div>
              <Feed layer={l.n} />
            </section>
          );
        })}
      </div>
      <div className="mt-6"><Timeline /></div>
      <p className="mt-4 text-[11px] text-muted">All data is simulated. Thresholds and weights are demo values, not taken from any standard.</p>
    </PageShell>
  );
}
