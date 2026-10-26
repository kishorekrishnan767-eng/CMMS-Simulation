import { useMemo } from "react";
import { api } from "../api/client";
import { useAssets, useAutopilot, useProcedures, useTechnicians, useWorkOrders } from "../api/queries";
import type { AutopilotState, Health } from "../api/types";
import { toastFor, useLive } from "../store/live";
import { useSession } from "../store/session";
import { useUi } from "../store/ui";
import { floorLabel } from "../three/constants";
import { techPose } from "../three/techPath";
import { StatusBadge, fmtHM, useAct, useSimNow } from "./ui";

const RATE_LABEL: Record<string, string> = { off: "Off", low: "Low", normal: "Normal", high: "High" };
const RATE_HINT: Record<string, string> = {
  off: "no new wear — only what you inject",
  low: "about one fault every 8 sim hours",
  normal: "about one fault every 4 sim hours",
  high: "about one fault every 1.5 sim hours",
};
const KIND_DOT: Record<string, string> = { action: "bg-accent", wait: "bg-line", warn: "bg-watch", fault: "bg-bad", info: "bg-muted", ok: "bg-ok", bad: "bg-bad" };

function AutopilotCard({ ap }: { ap: AutopilotState | undefined }) {
  const { run, busy } = useAct();
  const me = useSession((s) => s.me);
  const running = useLive((s) => s.clock.running);
  const can = !!me && ["ADMIN", "OPERATOR", "SUPERVISOR"].includes(me.role);
  const patch = (body: Partial<{ enabled: boolean; fault_rate: string }>) => run(() => api.patch<AutopilotState>("/api/autopilot", body));
  if (!ap) return null;
  return (
    <section className="rounded-md border border-line p-3" data-testid="autopilot-card">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold">Operations autopilot</div>
          <div className="text-[11.5px] text-muted">Equipment wears at random and the crew works every job through the real workflow.</div>
        </div>
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
      <div className="mt-2.5">
        <div className="mb-1 text-[11px] text-muted">Random equipment wear</div>
        <div className="seg" role="group" aria-label="Fault frequency">
          {ap.fault_rates.map((r) => (
            <button key={r} aria-pressed={ap.fault_rate === r} disabled={busy || !can} onClick={() => patch({ fault_rate: r })} data-testid={`fault-rate-${r}`}>
              {RATE_LABEL[r] ?? r}
            </button>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-muted">{RATE_HINT[ap.fault_rate]}</div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11.5px]">
        <i className={`h-1.5 w-1.5 rounded-full ${ap.enabled && running ? "live-dot bg-ok" : "bg-muted"}`} />
        <span className="text-muted">
          {!ap.enabled ? "Manual mode — do every step yourself from Work orders" : !running ? "Press Run in the header to start the clock" : ap.status}
          {ap.enabled && running && ap.next_fault_at && ap.fault_rate !== "off" ? ` · next wear event due ≈ ${fmtHM(ap.next_fault_at)}` : ""}
        </span>
      </div>
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
                  {busyNow && wo ? `${wo.number} · ${p.text}` : `${floorLabel(0)} crew room · ${t.skills.map((s) => s.toLowerCase().replace("_", " ")).join(", ")}`}
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
  if (!items.length) return <p className="rounded-md border border-dashed border-line p-3 text-center text-[12px] text-muted">No open work. Everything is running normally.</p>;
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

function Log({ ap }: { ap: AutopilotState | undefined }) {
  const events = useLive((s) => s.recentEvents);
  // the autopilot narrates what the crew does (and why they wait); without it, fall back to the event stream
  const rows = useMemo(() => {
    if (ap?.enabled && ap.log.length) {
      return [...ap.log].reverse().slice(0, 40).map((l, i) => ({ key: `a${i}`, t: l.t, kind: l.kind, who: l.actor, text: l.text, asset: l.asset_id }));
    }
    return events.slice(0, 40).flatMap((e) => {
      const t = toastFor(e);
      return t ? [{ key: e.event_id, t: e.occurred_at, kind: t.kind, who: e.asset_id ?? "", text: `${t.title}${t.body ? ` — ${t.body}` : ""}`, asset: e.asset_id }] : [];
    });
  }, [ap, events]);
  if (!rows.length) return <p className="text-[12px] text-muted">Nothing has happened yet. Start the clock to bring the building to life.</p>;
  return (
    <ul className="space-y-2" data-testid="ops-log">
      {rows.map((r) => (
        <li key={r.key} className="fade-in flex gap-2 text-[12px] leading-snug">
          <span className="mono w-10 shrink-0 pt-px text-muted">{r.t ? fmtHM(r.t) : ""}</span>
          <i className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[r.kind] ?? "bg-muted"}`} />
          <span className="min-w-0">
            {r.who && <b className="font-semibold">{r.who}: </b>}
            <span className={r.kind === "wait" ? "text-muted" : ""}>{r.text}</span>
            {r.asset && (
              <button className="ml-1 text-accent hover:underline" onClick={() => useUi.getState().selectAsset(r.asset)}>view</button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Right-panel overview: how the building, the crew and the open work stand right now. */
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
      <section>
        <div className="h-section mb-1.5">Operations log</div>
        <Log ap={ap} />
      </section>
    </div>
  );
}
