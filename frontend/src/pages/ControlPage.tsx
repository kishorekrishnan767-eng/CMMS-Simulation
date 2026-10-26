import { useState } from "react";
import { api } from "../api/client";
import { useAssets, useRejected, useSim } from "../api/queries";
import type { SimState } from "../api/types";
import { PageShell, fmtTime, useAct, Disclaimer } from "../components/ui";
import { SIM_SPEEDS } from "../config";
import { useLive } from "../store/live";
import { useSession } from "../store/session";

const SENSOR_FAULTS: [string, string][] = [
  ["flatline", "Flatline (sensor stuck)"], ["spike", "Spike (single outlier)"], ["dropout", "Dropout (missing samples)"],
  ["duplicate", "Duplicate event id"], ["late_event", "Late event (25 min old)"], ["bad_unit", "Bad unit string"], ["unknown_sensor", "Unknown sensor"],
];

export default function ControlPage() {
  const { data: sim } = useSim();
  const { data: assets } = useAssets();
  const { data: rej } = useRejected();
  const clock = useLive((s) => s.clock);
  const me = useSession((s) => s.me);
  const { run, busy } = useAct();
  const [asset, setAsset] = useState("AHU-02-FAN-01");
  const [sensorFault, setSensorFault] = useState("duplicate");
  const [sensorAsset, setSensorAsset] = useState("AHU-02-FAN-01");
  const [effectiveness, setEffectiveness] = useState(1);
  const [seed, setSeed] = useState<number | "">("");
  const [profile, setProfile] = useState("demo");
  const [minutes, setMinutes] = useState(30);
  const fans = (assets ?? []).filter((a) => a.asset_type.includes("FAN") || a.asset_type === "PUMP" || a.asset_type === "CHILLER" || a.asset_type === "FCU");

  return (
    <PageShell title="Simulation control" subtitle="Drive the simulated world. Everything here goes through the same API the rest of the product uses; the simulator only publishes telemetry — it never creates alerts or work orders.">
      <div className="mb-4 flex items-center gap-2">
        <span className="badge badge-watch">Simulated</span>
        {!me && <span className="text-xs text-bad">Sign in (Operator / Supervisor / Admin) to change the simulation.</span>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <div className="h-section mb-3">Clock</div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.post(clock.running ? "/api/simulation/pause" : "/api/simulation/start"))} data-testid="ctl-toggle">
              {clock.running ? "❚❚ Pause" : "▶ Run"}
            </button>
            <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="Speed">
              {SIM_SPEEDS.map((s) => (
                <button key={s} onClick={() => run(() => api.patch("/api/simulation", { speed: s }))} aria-pressed={clock.speed === s}
                  className={`px-3 py-1.5 text-sm tabular-nums ${clock.speed === s ? "bg-accent text-white" : "bg-panel2 text-muted"}`} data-testid={`ctl-speed-${s}`}>{s}×</button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">Sampling is one simulated minute per sensor. 60× = one real second is one simulated minute.</p>
          <div className="mt-4 flex items-end gap-2">
            <label className="text-xs">Advance by (sim minutes)<input className="input mt-1 w-28" type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
            <button className="btn" disabled={busy} onClick={() => run(() => api.post(`/api/simulation/step?minutes=${minutes}`), `Advanced ${minutes} min`)} data-testid="ctl-step">Step</button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-xs text-muted">Seed</div><div className="tabular-nums">{sim?.seed}</div></div>
            <div><div className="text-xs text-muted">Profile</div><div>{sim?.profile} <span className="text-xs text-muted">({sim?.profile === "demo" ? "1.5 h to alarm" : "4 h"})</span></div></div>
            <div><div className="text-xs text-muted">Samples generated</div><div className="tabular-nums">{sim?.samples_generated.toLocaleString()}</div></div>
            <div><div className="text-xs text-muted">Next repair effectiveness</div><div className="tabular-nums">{sim?.repair_effectiveness}</div></div>
          </div>
        </section>

        <section className="card p-4">
          <div className="h-section mb-3">Reset to seed</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs">Seed<input className="input mt-1" type="number" placeholder={String(sim?.seed ?? 42)} value={seed} onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))} data-testid="ctl-seed" /></label>
            <label className="text-xs">Profile
              <select className="input mt-1" value={profile} onChange={(e) => setProfile(e.target.value)}><option value="demo">demo (fault matures in 1.5 h)</option><option value="realistic">realistic (4 h)</option></select>
            </label>
          </div>
          <button className="btn btn-danger mt-3" disabled={busy || me?.role !== "ADMIN"} onClick={() => run(() => api.post("/api/simulation/reset", { seed: seed === "" ? undefined : seed, profile }), "Simulation reset and 6 h of healthy history backfilled")} data-testid="ctl-reset">
            Reset (Admin only)
          </button>
          <p className="mt-2 text-xs text-muted">Wipes work orders, anomalies, events and audit records, restarts the clock at the seed epoch and backfills six hours of healthy telemetry through the normal ingestion path. Same seed → identical run.{me?.role !== "ADMIN" && " Switch to the Admin user to enable this."}</p>
        </section>

        <section className="card p-4">
          <div className="h-section mb-3">Inject bearing wear</div>
          <select className="input mb-2" value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Asset">{fans.map((a) => <option key={a.id} value={a.id}>{a.id} — {a.name}</option>)}</select>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.post("/api/simulation/faults", { asset_id: asset, fault_type: "bearing_wear" }), `Bearing wear injected on ${asset}`)} data-testid="ctl-wear">Inject bearing wear</button>
          <p className="mt-2 text-xs text-muted">D(t) = A·((t−t₀)/T)^p with A = 7 mm/s, p = 2, T = 1.5 h (demo). The detector is never told — it must find it. Run the simulation at 60× and watch the asset.</p>
          <div className="mt-3 text-xs">
            <div className="h-section mb-1">Active faults (ground truth)</div>
            {(sim as SimState | undefined)?.active_faults.length ? sim!.active_faults.map((f) => <div key={f.id} className="rounded border border-line px-2 py-1">{f.fault_type} on {f.asset_id} since {fmtTime(f.started_at)}</div>) : <div className="text-muted">none</div>}
          </div>
        </section>

        <section className="card p-4">
          <div className="h-section mb-3">Repair effectiveness (next repair only)</div>
          <input type="range" min={0} max={1} step={0.1} value={effectiveness} onChange={(e) => setEffectiveness(Number(e.target.value))} className="w-full accent-[rgb(var(--accent))]" aria-label="Repair effectiveness" data-testid="ctl-eff" />
          <div className="flex items-center justify-between text-sm"><span className="tabular-nums">{effectiveness.toFixed(1)}</span><span className="text-xs text-muted">1.0 = full repair · 0.4 = partial (fails verification)</span></div>
          <button className="btn mt-2" disabled={busy} onClick={() => run(() => api.post("/api/simulation/repair-effectiveness", { effectiveness }), `Next repair will be ${Math.round(effectiveness * 100)}% effective`)} data-testid="ctl-eff-apply">Apply</button>
        </section>

        <section className="card p-4 lg:col-span-2">
          <div className="h-section mb-3">Inject sensor / data-quality faults</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">Asset<select className="input mt-1" value={sensorAsset} onChange={(e) => setSensorAsset(e.target.value)}>{(assets ?? []).map((a) => <option key={a.id}>{a.id}</option>)}</select></label>
            <label className="text-xs">Fault<select className="input mt-1" value={sensorFault} onChange={(e) => setSensorFault(e.target.value)} data-testid="ctl-fault-type">{SENSOR_FAULTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <button className="btn" disabled={busy} onClick={() => run(() => api.post("/api/simulation/faults", { asset_id: sensorAsset, fault_type: sensorFault }), `${sensorFault} scheduled on ${sensorAsset}`)} data-testid="ctl-fault">Inject</button>
          </div>
          <p className="mt-2 text-xs text-muted">Faults are applied to the telemetry transport at the next simulated minute. Layer 3 must store every rejected reading with a reason:</p>
          <div className="scroll-thin mt-2 max-h-56 overflow-auto rounded-md border border-line">
            <table className="w-full text-xs" data-testid="rejected-table">
              <thead><tr><th className="th">When</th><th className="th">Sensor</th><th className="th">Reason</th><th className="th">Detail</th></tr></thead>
              <tbody>
                {(rej?.items ?? []).length === 0 && <tr><td className="td text-muted" colSpan={4}>Nothing rejected yet.</td></tr>}
                {(rej?.items ?? []).map((r) => (<tr key={r.id} className="tr"><td className="td">{fmtTime(r.received_at)}</td><td className="td">{r.sensor_id ?? "—"}</td><td className="td"><span className="badge badge-watch">{r.reason}</span></td><td className="td text-muted">{r.detail}</td></tr>))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <Disclaimer className="mt-4" />
    </PageShell>
  );
}
