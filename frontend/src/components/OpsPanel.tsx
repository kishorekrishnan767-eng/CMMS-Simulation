import { useMemo } from "react";
import { api } from "../api/client";
import { useAssets, useAutopilot, useProcedures, useTechnicians, useWorkOrders } from "../api/queries";
import type { AutopilotState, Health } from "../api/types";
import { useLive } from "../store/live";
import { useSession } from "../store/session";
import { useUi } from "../store/ui";
import { floorLabel } from "../three/constants";
import { techPose } from "../three/techPath";
import { StatusBadge, useAct, useSimNow } from "./ui";

const RATE_LABEL: Record<string, string> = { off: "Off", low: "Low", normal: "Normal", high: "High" };

/** One switch: let the building run itself (random wear, crew handles every job), or keep it manual. */
function AutopilotCard({ ap }: { ap: AutopilotState | undefined }) {
  const { run, busy } = useAct();
  const me = useSession((s) => s.me);
  const can = !!me && ["ADMIN", "OPERATOR", "SUPERVISOR"].includes(me.role);
  const patch = (body: Partial<{ enabled: boolean; fault_rate: string }>) => run(() => api.patch<AutopilotState>("/api/autopilot", body));
  if (!ap) return null;
  return (
    <section className="rounded-md border border-line p-3" data-testid="autopilot-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold">Automatic mode</div>
        <button
          role="switch"
          aria-checked={ap.enabled}
          disabled={busy || !can}
          onClick={() => patch({ enabled: !ap.enabled })}
          title={can ? "" : "Operator, Supervisor or Admin only"}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${ap.enabled ? "bg-accent" : "bg-line"} disabled:opacity-50`}
          data-testid="autopilot-toggle"
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${ap.enabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
      </div>
      {ap.enabled && (
        <div className="mt-2.5">
          <div className="mb-1 text-[11px] text-muted">How often machines wear</div>
          <div className="seg" role="group" aria-label="Fault frequency">
            {ap.fault_rates.map((r) => (
              <button key={r} aria-pressed={ap.fault_rate === r} disabled={busy || !can} onClick={() => patch({ fault_rate: r })} data-testid={`fault-rate-${r}`}>
                {RATE_LABEL[r] ?? r}
              </button>
            ))}
          </div>
        </div>
      )}
      {ap.error && <div className="mt-1 text-[11px] text-bad">{ap.error}</div>}
    </section>
  );
}

function BuildingHealth() {
  const { data: assets } = useAssets();
  const health = useLive((s) => s.health);
  const counts = useMemo(() => {
    const c: Record<string, number> = { NORMAL: 0, WATCH: 0, ANOMALY: 0 };
    for (const a of assets ?? []) {
      const h: Health = health[a.id] ?? a.health_state;
      c[h === "CLEARED" ? "NORMAL" : h]++;
    }
    return c;
  }, [assets, health]);
  const cell = (label: string, n: number, cls: string) => (
    <div className="rounded-md border border-line px-2.5 py-1.5">
      <div className={`text-lg font-semibold tabular-nums ${n ? cls : "text-muted"}`}>{n}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="building-health">
      {cell("normal", counts.NORMAL, "text-ok")}
      {cell("watch", counts.WATCH, "text-watch")}
      {cell("anomaly", counts.ANOMALY, "text-bad")}
    </div>
  );
}

function Crew() {
  const now = useSimNow(500);
  const { data: techs } = useTechnicians();
  const { data: wos } = useWorkOrders();
  const { data: assets } = useAssets();
  const { data: catalogue } = useProcedures();
  const assetMap = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  const byTech = useMemo(() => {
    const m = new Map<string, NonNullable<typeof wos>["items"][number]>();
    for (const w of [...(wos?.items ?? [])].sort((a, b) => a.id - b.id)) if (w.assigned_technician) m.set(w.assigned_technician.id, w);
    return m;
  }, [wos]);
  return (
    <ul className="space-y-1.5" data-testid="crew-list">
      {(techs ?? []).map((t) => {
        const wo = byTech.get(t.id) ?? null;
        const asset = wo ? assetMap.get(wo.asset_id) ?? null : null;
        const steps = asset && catalogue ? (wo && wo.repair_count >= 1 ? catalogue.rework : catalogue.procedures[asset.asset_type] ?? null) : null;
        const p = techPose(t, wo, asset, now, steps);
        const busyNow = p.phase !== "idle";
        return (
          <li key={t.id}>
            <button
              className="flex w-full items-center gap-2.5 rounded-md border border-line px-2.5 py-2 text-left hover:bg-panel2"
              onClick={() => (asset && busyNow ? useUi.getState().fly({ preset: "follow", assetId: asset.id }) : useUi.getState().fly({ preset: "crew" }))}
              title={busyNow ? "Follow with the camera" : "Show the crew room"}
            >
              <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: t.color }} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold">{t.name}</span>
                  <span className={`text-[11px] font-medium ${busyNow ? "text-accent" : t.on_shift ? "text-ok" : "text-muted"}`}>
                    {p.phase === "idle" ? (t.on_shift ? "available" : "off shift") : p.phase}
                  </span>
                </span>
                <span className="block truncate text-[11.5px] text-muted">
                  {busyNow && wo ? `${wo.number} · ${p.text}` : "in the crew room"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ActiveJobs() {
  const { data } = useWorkOrders("&active=true");
  const items = data?.items ?? [];
  if (!items.length) return <p className="rounded-md border border-dashed border-line p-3 text-center text-[12px] text-muted">No open work.</p>;
  return (
    <ul className="space-y-1.5" data-testid="active-jobs">
      {items.map((w) => (
        <li key={w.id}>
          <button
            className="w-full rounded-md border border-line px-2.5 py-2 text-left hover:bg-panel2"
            onClick={() => {
              const ui = useUi.getState();
              ui.selectAsset(w.asset_id);
              ui.set({ rightTab: "job" });
            }}
            data-testid={`job-${w.number}`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="mono font-semibold">{w.number}</span>
              <StatusBadge status={w.status} />
            </span>
            <span className="mt-0.5 block truncate text-[12px]">{w.asset_name} · {floorLabel(w.floor_level)}</span>
            <span className="block truncate text-[11px] text-muted">{w.priority} · {w.assigned_technician ? w.assigned_technician.name : "unassigned"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Right-panel overview: equipment health, open work and the crew. */
export default function OpsPanel() {
  const { data: ap } = useAutopilot();
  return (
    <div className="space-y-4 p-4" data-testid="ops-panel">
      <AutopilotCard ap={ap} />
      <section>
        <div className="h-section mb-1.5">Equipment health</div>
        <BuildingHealth />
      </section>
      <section>
        <div className="h-section mb-1.5">Crew</div>
        <Crew />
      </section>
      <section>
        <div className="h-section mb-1.5">Open work</div>
        <ActiveJobs />
      </section>
    </div>
  );
}
