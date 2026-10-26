import { useState } from "react";
import { Link } from "react-router-dom";
import { useAnomaly, useAnomalies, useAsset, useWorkOrders } from "../api/queries";
import { useLive } from "../store/live";
import { useUi } from "../store/ui";
import TelemetryChart, { METRIC_LABEL } from "./TelemetryChart";
import RiskBreakdown from "./RiskBreakdown";
import { Disclaimer, Empty, HealthBadge, Loading, Simulated, StatusBadge, fmtTime } from "./ui";

const TABS = ["vibration_velocity", "bearing_temperature", "motor_current", "speed_command"];
const UNITS: Record<string, string> = { vibration_velocity: "mm/s", bearing_temperature: "°C", motor_current: "A", speed_command: "%" };

function LiveValues({ assetId }: { assetId: string }) {
  const vals = useLive((s) => s.values[assetId]) ?? {};
  return (
    <div className="grid grid-cols-4 gap-2" data-testid="live-values">
      {TABS.map((m) => (
        <div key={m} className="rounded-md border border-line bg-panel2 p-2">
          <div className="truncate text-[10px] uppercase tracking-wide text-muted">{METRIC_LABEL[m].split(" ")[0]}</div>
          <div className="text-base font-semibold tabular-nums" data-testid={`val-${m}`}>
            {vals[m] === undefined ? "—" : vals[m].toFixed(m === "speed_command" ? 0 : 2)}
            <span className="ml-0.5 text-[10px] font-normal text-muted">{UNITS[m]}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AssetPanel() {
  const id = useUi((s) => s.selectedAssetId);
  const { data: asset, isLoading, error } = useAsset(id);
  const health = useLive((s) => (id ? s.health[id] : undefined));
  const [metric, setMetric] = useState("vibration_velocity");
  const { data: active } = useAnomalies("ACTIVE", id);
  const anomalyId = active?.items[0]?.id ?? null;
  const { data: anomaly } = useAnomaly(anomalyId);
  const { data: wos } = useWorkOrders(id ? `&asset_id=${id}&active=true` : "");
  const wo = wos?.items[0];

  if (!id) {
    return (
      <div className="p-5">
        <div className="h-section mb-2">Asset detail</div>
        <Empty title="Select an asset" hint="Click a machine in the 3D view or in the building tree." />
        <Disclaimer className="mt-4" />
      </div>
    );
  }
  if (isLoading) return <Loading />;
  if (error || !asset) return <Empty title="Asset unavailable" />;
  const h = health ?? asset.health_state;
  const decision = anomaly?.decisions?.[anomaly.decisions.length - 1];

  return (
    <div className="space-y-4 p-4" data-testid="asset-panel">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-lg font-semibold leading-tight">{asset.name}</div>
            <div className="text-xs text-muted">{asset.id} · {asset.floor_name} · {asset.manufacturer} {asset.model}</div>
          </div>
          <button className="btn btn-sm" aria-label="Close panel" onClick={() => useUi.getState().selectAsset(null, false)}>✕</button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <HealthBadge health={h} />
          <span className="badge badge-muted">criticality {asset.criticality}</span>
          {asset.status !== "OPERATIONAL" && <span className="badge badge-info">{asset.status.replace("_", " ")}</span>}
          <Simulated />
        </div>
      </div>

      <LiveValues assetId={asset.id} />

      <div>
        <div className="mb-1 flex gap-1" role="tablist" aria-label="Telemetry metric">
          {TABS.map((m) => (
            <button key={m} role="tab" aria-selected={metric === m} onClick={() => setMetric(m)}
              className={`rounded-md px-2 py-1 text-xs ${metric === m ? "bg-accent text-white" : "bg-panel2 text-muted hover:text-ink"}`}>
              {METRIC_LABEL[m].split(" ")[0]}
            </button>
          ))}
        </div>
        <TelemetryChart asset={asset} metric={metric} />
        <div className="text-[11px] text-muted">Last 3 simulated hours. Band = load-adjusted baseline ±3.5σ. Limits are demo values per asset.</div>
      </div>

      {anomaly && anomaly.state === "ACTIVE" ? (
        <section className="rounded-md border border-bad/40 bg-bad/5 p-3" data-testid="evidence-card">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{anomaly.incident_id} · {anomaly.severity} · confidence {(anomaly.confidence * 100).toFixed(0)}%</div>
            <Link to="/pipeline" className="text-xs text-accent hover:underline">timeline →</Link>
          </div>
          <p className="mt-1 text-sm" data-testid="anomaly-explanation">{anomaly.explanation}</p>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div><dt className="text-muted">z-score</dt><dd className="tabular-nums">{anomaly.z.toFixed(1)}σ</dd></div>
            <div><dt className="text-muted">slope</dt><dd className="tabular-nums">{anomaly.slope.toFixed(2)} mm/s/h</dd></div>
            <div><dt className="text-muted">persistence</dt><dd className="tabular-nums">{anomaly.persistence}/10</dd></div>
            <div><dt className="text-muted">baseline</dt><dd className="tabular-nums">{anomaly.baseline_mean.toFixed(2)} ± {anomaly.baseline_sigma.toFixed(2)}</dd></div>
            <div><dt className="text-muted">corroboration</dt><dd>{Object.entries(anomaly.corroborating).filter(([, v]) => v.corroborates).map(([k]) => k.split("_")[0]).join(", ") || "none yet"}</dd></div>
            <div><dt className="text-muted">to alarm limit*</dt><dd className="tabular-nums">{anomaly.projection_hours == null ? "—" : `${(anomaly.projection_hours * 60).toFixed(0)} min`}</dd></div>
          </dl>
          <div className="mt-1 text-[11px] text-muted">*{anomaly.projection_note}. Evidence: {anomaly.evidence?.[0]?.reading_ids.length ?? 0} supporting readings · detected {fmtTime(anomaly.detected_at)}.</div>
        </section>
      ) : (
        <section className="rounded-md border border-line p-3 text-sm text-muted">
          {h === "WATCH" ? "The detector sees a deviation and is watching it (not yet an anomaly)." : "No active anomaly. Readings follow the load-adjusted baseline."}
        </section>
      )}

      {decision && (
        <section className="rounded-md border border-line p-3">
          <div className="h-section mb-2">Risk decision (Layer 5)</div>
          <RiskBreakdown decision={decision} />
        </section>
      )}

      {wo && (
        <section className="flex items-center justify-between rounded-md border border-line p-3" data-testid="wo-link">
          <div>
            <div className="text-sm font-semibold">{wo.number} <StatusBadge status={wo.status} /></div>
            <div className="text-xs text-muted">{wo.title}</div>
          </div>
          <Link className="btn btn-sm" to={`/cmms?wo=${wo.id}`}>Open</Link>
        </section>
      )}

      <section>
        <div className="h-section mb-1">Sensors</div>
        <ul className="space-y-1 text-xs">
          {asset.sensors.map((s) => (
            <li key={s.id} className="flex justify-between rounded border border-line px-2 py-1">
              <span>{s.id} · {s.metric.replaceAll("_", " ")}</span>
              <span className={s.quality === "GOOD" ? "text-ok" : "text-watch"}>{s.quality}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 text-[11px] text-muted">
          Limits (demo): warn {asset.limits.warn} · alarm {asset.limits.alarm} · critical {asset.limits.critical} {asset.limits.unit}. {asset.limits.note}.
        </div>
      </section>
    </div>
  );
}
