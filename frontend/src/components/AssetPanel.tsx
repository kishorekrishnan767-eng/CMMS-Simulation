import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAnomaly, useAnomalies, useAsset, useAutopilot, useSim, useWalkthrough, useWorkOrders } from "../api/queries";
import { useLive } from "../store/live";
import { useSession } from "../store/session";
import { useUi } from "../store/ui";
import TelemetryChart, { METRIC_LABEL } from "./TelemetryChart";
import { startWalkthrough } from "./walkthroughApi";
import { Empty, HealthBadge, Loading, Simulated, StatusBadge, useAct } from "./ui";

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

/** Per-asset demo actions: start a (simulated) bearing-wear anomaly, or have the crew repair it.
 *  Both go through the normal API, so permissions, audit and the work-order workflow all apply. */
function AssetActions({ assetId, hasAnomaly, hasWorkOrder }: { assetId: string; hasAnomaly: boolean; hasWorkOrder: boolean }) {
  const { data: sim } = useSim();
  const me = useSession((s) => s.me);
  const { run, busy } = useAct();
  const can = !!me && ["ADMIN", "OPERATOR", "SUPERVISOR"].includes(me.role);
  const wearing = !!sim?.active_faults.some((f) => f.asset_id === assetId && f.fault_type === "BEARING_WEAR");
  const { data: ap } = useAutopilot();
  const { data: wt } = useWalkthrough();
  const repairing = !!ap?.expedited?.includes(assetId);
  const why = can ? "" : "Sign in as Operator, Supervisor or Admin";
  const canRepair = wearing || hasAnomaly || hasWorkOrder;
  if (wt?.asset_id === assetId) {
    return (
      <section className="rounded-md border border-line p-3 text-[12.5px]" data-testid="asset-actions">
        This machine is in the step-by-step demo. <button className="text-accent hover:underline" onClick={() => useUi.getState().set({ rightTab: "process" })}>Open Process</button>
      </section>
    );
  }
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3" data-testid="asset-actions">
      <button className="btn btn-sm" disabled={!can || busy || wearing || hasAnomaly || hasWorkOrder} title={why || "Start a simulated bearing wear on this machine and watch it being found and fixed"}
        onClick={() => run(() => startWalkthrough(assetId)).then((r) => { if (r) useUi.getState().set({ rightPanelOpen: true, rightTab: "process" }); })} data-testid="asset-inject">
        ⚠ Inject anomaly
      </button>
      <button className="btn btn-sm btn-primary" disabled={!can || busy || !canRepair || repairing} title={why || (canRepair ? "The crew repairs it through the normal work-order workflow" : "Nothing to repair on this asset")}
        onClick={() => run(() => api.post("/api/autopilot/repair", { asset_id: assetId }), `Repair of ${assetId} started`)} data-testid="asset-repair">
        {repairing ? "Repairing…" : "🔧 Repair"}
      </button>
      {repairing && <span className="basis-full text-[11px] text-muted">The crew is on it. Keep the clock running.</span>}
    </section>
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
        <Empty title="Select a machine" hint="Click one in the 3D view or in the list." />
      </div>
    );
  }
  if (isLoading) return <Loading />;
  if (error || !asset) return <Empty title="Asset unavailable" />;
  const h = health ?? asset.health_state;

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

      <AssetActions assetId={asset.id} hasAnomaly={anomaly?.state === "ACTIVE"} hasWorkOrder={!!wo} />

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
      </div>

      {anomaly && anomaly.state === "ACTIVE" ? (
        <section className="rounded-md border border-bad/40 bg-bad/5 p-3" data-testid="evidence-card">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{anomaly.incident_id} · {anomaly.severity}</div>
            <span className="badge badge-muted">confidence {(anomaly.confidence * 100).toFixed(0)}%</span>
          </div>
          <p className="mt-1 text-sm" data-testid="anomaly-explanation">{anomaly.explanation}</p>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted">above normal</dt><dd className="tabular-nums">{anomaly.z.toFixed(1)}σ</dd></div>
            <div><dt className="text-muted">alarm limit in</dt><dd className="tabular-nums">{anomaly.projection_hours == null ? "—" : `${(anomaly.projection_hours * 60).toFixed(0)} min`}</dd></div>
          </dl>
        </section>
      ) : (
        <section className="rounded-md border border-line p-3 text-sm text-muted">
          {h === "WATCH" ? "Being watched. Not an anomaly yet." : "No anomaly. Readings are normal."}
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
              <span>{s.metric.replaceAll("_", " ")}</span>
              <span className={s.quality === "GOOD" ? "text-ok" : "text-watch"}>{s.quality}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 text-[11px] text-muted">Alarm limit {asset.limits.alarm} {asset.limits.unit} (demo value)</div>
      </section>
    </div>
  );
}
