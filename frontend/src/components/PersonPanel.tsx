import { useMemo } from "react";
import { useAssets, useAutopilot, useTechnicians, useWorkOrders } from "../api/queries";
import { useLive } from "../store/live";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { floorLabel } from "../three/constants";
import { EMPLOYEES, KISHORE } from "../three/office";
import { staffPose } from "../three/staff";
import { Empty, StatusBadge, fmtHM, useSimNow } from "./ui";

const PHASE_LABEL: Record<string, string> = { away: "Not at work", arriving: "Arriving", seated: "At the desk", leaving: "Going home" };

/** Kishore's supervisor view: exactly what the BMS shows him, from live data. */
function SupervisorDesk() {
  const { data: assets } = useAssets();
  const { data: wos } = useWorkOrders("&active=true");
  const { data: techs } = useTechnicians();
  const { data: ap } = useAutopilot();
  const health = useLive((s) => s.health);
  const counts = useMemo(() => {
    const c = { normal: 0, watch: 0, anomaly: 0 };
    for (const a of assets ?? []) {
      const h = health[a.id] ?? a.health_state;
      if (h === "ANOMALY") c.anomaly++;
      else if (h === "WATCH") c.watch++;
      else c.normal++;
    }
    return c;
  }, [assets, health]);
  const mine = (ap?.log ?? []).filter((l) => l.role === "SUPERVISOR" && l.kind !== "wait").slice(-4).reverse();
  return (
    <section className="space-y-3">
      <div className="h-section">On his screens right now</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {([["normal", counts.normal, "text-ok"], ["watch", counts.watch, "text-watch"], ["early warning", counts.anomaly, "text-bad"]] as const).map(([l, n, c]) => (
          <div key={l} className="rounded-md border border-line px-2 py-1.5">
            <div className={`text-lg font-semibold tabular-nums ${n ? c : "text-muted"}`}>{n}</div>
            <div className="text-[11px] text-muted">{l}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 text-[11px] text-muted">Work he is responsible for</div>
        {(wos?.items ?? []).length === 0 ? (
          <p className="text-[12.5px] text-muted">No open work orders.</p>
        ) : (
          <ul className="space-y-1">
            {wos!.items.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-2 py-1 text-[12.5px]">
                <span><span className="mono font-semibold">{w.number}</span> · {w.asset_name}</span>
                <StatusBadge status={w.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-1 text-[11px] text-muted">His crew</div>
        <ul className="space-y-1 text-[12.5px]">
          {(techs ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-md border border-line px-2 py-1">
              <span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full" style={{ background: t.color }} />{t.name}</span>
              <span className="text-muted">{t.on_shift ? (t.status === "AVAILABLE" ? "in crew room" : t.status.toLowerCase().replace("_", " ")) : "off shift"}</span>
            </li>
          ))}
        </ul>
      </div>
      {mine.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-muted">What he did recently</div>
          <ul className="space-y-1 text-[12.5px]">
            {mine.map((l, i) => (
              <li key={i} className="flex gap-2"><span className="mono w-10 shrink-0 text-muted">{fmtHM(l.t)}</span><span>{l.text}</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Right-panel card for the selected employee: where they are, their day, and (for Kishore) the BMS desk. */
export default function PersonPanel() {
  const id = useUi((s) => s.selectedPersonId);
  const now = useSimNow(500);
  const emp = EMPLOYEES.find((e) => e.id === id);
  if (!emp) return <Empty title="Select a person" hint="Click a person in the 3D view or pick one from the list." />;
  const p = staffPose(emp, now);
  const isSupervisor = emp.id === KISHORE.id;
  return (
    <div className="space-y-4 p-4" data-testid="person-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[17px] font-semibold leading-tight">{emp.name}</div>
          <div className="text-[12.5px] text-muted">{emp.role} · {emp.team}</div>
        </div>
        <button className="btn btn-sm" aria-label="Close" onClick={() => useUi.getState().selectPerson(null)}>✕</button>
      </div>
      <section className="rounded-md border border-line bg-panel2 p-3">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
          <i className="live-dot h-1.5 w-1.5 rounded-full bg-ok" /> Now
        </div>
        <div className="text-[14px] font-semibold">{PHASE_LABEL[p.phase]} · {p.text}</div>
        <div className="mt-1 text-[12px] text-muted">Desk on {floorLabel(emp.seat.level)}{isSupervisor ? " (BMS room)" : ""}</div>
      </section>
      {emp.collaboration && (
        <section className="rounded-md border border-accent/30 bg-accent/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent">Shared workspace</div>
          <div className="text-[13px] font-semibold">
            With {EMPLOYEES.find((p) => p.id === emp.collaboration?.partnerId)?.name}
          </div>
          <div className="mt-1 text-[12px] text-muted">{emp.collaboration.activity}</div>
        </section>
      )}
      <div className="flex gap-2">
        <button className="btn btn-sm" onClick={() => useUi.getState().fly({ preset: "person", personId: emp.id })} >Follow {emp.name}</button>
        {isSupervisor && <button className="btn btn-sm" onClick={() => useUi.getState().fly({ preset: "bms" })}>Show the BMS room</button>}
        {isSupervisor && <button className="btn btn-sm btn-primary" onClick={() => usePlayer.getState().set({ active: true })} data-testid="control-kishore">🎮 Control Kishore</button>}
      </div>
      {isSupervisor && <SupervisorDesk />}
    </div>
  );
}
