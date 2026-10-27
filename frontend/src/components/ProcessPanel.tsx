import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAnomaly, useAnomalies, useAsset, useProcedures, useRejected, useWalkthrough, useWorkOrder, useWorkOrders } from "../api/queries";
import type { Asset, WalkthroughState } from "../api/types";
import { GOLDEN_ASSET } from "../config";
import { useDemoMode } from "../store/demoMode";
import { useLive } from "../store/live";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { floorLabel } from "../three/constants";
import { stepAt, workBegan } from "../three/techPath";
import { fmtSensor, sensorName } from "./sensors";
import { Empty, Loading, Progress, Simulated, parseIso, useAct, useSimNow } from "./ui";
import { nextWalkthroughStep, resetWalkthrough, startWalkthrough } from "./walkthroughApi";

const chip = (tone: "ok" | "bad" | "watch" | "muted", text: ReactNode) => <span className={`badge badge-${tone}`}>{text}</span>;

/** Live value of every sensor of the machine (layer 1–2): always visible so each sensor can be followed. */
function SensorStrip({ asset }: { asset: Asset }) {
  const vals = useLive((s) => s.values[asset.id]) ?? {};
  return (
    <div className="grid grid-cols-2 gap-1.5" data-testid="sensor-strip">
      {asset.sensors.map((s) => (
        <div key={s.id} className="rounded-md border border-line bg-panel2 px-2.5 py-1.5">
          <div className="text-[10.5px] uppercase tracking-wide text-muted">{sensorName(s.metric)}</div>
          <div className="text-[15px] font-semibold tabular-nums">{fmtSensor(s.metric, vals[s.metric])}</div>
        </div>
      ))}
    </div>
  );
}

/** What each finished step produced, per sensor where it applies. */
function useStepData(asset: Asset, wt: WalkthroughState) {
  const vals = useLive((s) => s.values[asset.id]) ?? {};
  const { data: rej } = useRejected(asset.id);
  const { data: anoms } = useAnomalies(undefined, asset.id);
  const anomalyId = [...(anoms?.items ?? [])].sort((a, b) => b.id - a.id)[0]?.id ?? null;
  const { data: anomaly } = useAnomaly(wt.stage >= 2 ? anomalyId : null);
  const { data: list } = useWorkOrders(`&asset_id=${asset.id}`);
  const woId = wt.stage >= 3 ? [...(list?.items ?? [])].sort((a, b) => b.id - a.id)[0]?.id ?? null : null;
  const { data: wo } = useWorkOrder(woId);
  const dups = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rej?.items ?? []) if (r.reason === "DUPLICATE" && r.sensor_id) m[r.sensor_id] = (m[r.sensor_id] ?? 0) + 1;
    return m;
  }, [rej]);
  return { vals, dups, anomaly, wo };
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="mt-2 divide-y divide-line rounded-md border border-line text-[12.5px]">{children}</ul>;
}
function Row({ left, mid, right }: { left: ReactNode; mid?: ReactNode; right?: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-2 px-2.5 py-1.5">
      <span className="font-medium">{left}</span>
      <span className="tabular-nums text-muted">{mid}</span>
      <span className="min-w-[96px] text-right">{right}</span>
    </li>
  );
}

function Result({ n, asset, wt }: { n: number; asset: Asset; wt: WalkthroughState }) {
  const { vals, dups, anomaly, wo } = useStepData(asset, wt);
  const r = wt.results[String(n)] ?? {};
  if (n === 1) {
    const total = Object.values(dups).reduce((a, b) => a + b, 0);
    return (
      <>
        <Rows>
          {asset.sensors.map((s) => (
            <Row key={s.id} left={sensorName(s.metric)} mid={fmtSensor(s.metric, vals[s.metric])}
              right={dups[s.id] ? chip("ok", `${dups[s.id]} copy dropped`) : chip("muted", "no copies")} />
          ))}
        </Rows>
        <p className="mt-1.5 text-[12px] text-muted">{total} repeated reading{total === 1 ? "" : "s"} dropped. One copy of each is kept.</p>
      </>
    );
  }
  if (n === 2 && anomaly) {
    return (
      <>
        <Rows>
          {asset.sensors.map((s) => {
            const main = s.metric === anomaly.metric;
            const also = anomaly.corroborating[s.metric]?.corroborates;
            return (
              <Row key={s.id} left={sensorName(s.metric)} mid={fmtSensor(s.metric, vals[s.metric])}
                right={main ? chip("bad", `${anomaly.z.toFixed(1)}σ above normal`) : also ? chip("watch", "also off") : chip("ok", "normal")} />
            );
          })}
        </Rows>
        <p className="mt-1.5 text-[12px] text-muted" data-testid="wt-explanation">{anomaly.explanation}</p>
      </>
    );
  }
  if (n === 3 && wo) {
    const ra = wo.risk_assessment;
    return (
      <div className="mt-2 rounded-md border border-line p-2.5 text-[12.5px]">
        <div className="flex items-center justify-between">
          <b className="mono">{wo.number}</b>
          <span className="flex gap-1">{chip("watch", wo.priority)}{chip("muted", wo.status)}</span>
        </div>
        {ra && <div className="mt-1">Risk <b>{Math.round(ra.risk_score)}/100</b></div>}
        <div className="mt-1 text-muted">
          {Number(r.open_work_orders ?? 1)} work order · {wo.events.filter((e) => e.action === "EVIDENCE_ATTACHED").length} later alerts added to it · 0 duplicates
        </div>
      </div>
    );
  }
  if (n === 4) {
    return (
      <Rows>
        <Row left="Operator tries to approve" right={chip("bad", `refused (${r.operator_denied ?? 403})`)} />
        <Row left="Kishore (supervisor) approves" right={chip("ok", "approved")} />
      </Rows>
    );
  }
  if (n === 5 && wo) {
    return (
      <div className="mt-2 rounded-md border border-line p-2.5 text-[12.5px]">
        <div><b>{String(r.technician ?? wo.assigned_technician?.name ?? "")}</b> is on the way · about {String(r.travel_minutes ?? "?")} min</div>
        <div className="mt-1 text-muted">Parts reserved: {wo.parts.map((p) => `${p.sku} × ${p.planned}`).join(", ") || "none"}</div>
      </div>
    );
  }
  if (n === 6) {
    const ins = wo?.inspections[wo.inspections.length - 1];
    return (
      <div className="mt-2 rounded-md border border-line p-2.5 text-[12.5px]">
        <div>{String(r.findings ?? ins?.findings ?? "")}</div>
        {ins && <div className="mt-1 text-muted">Parts used: {ins.parts_used.map((p) => `${p.sku} × ${p.quantity}`).join(", ") || "none"}</div>}
      </div>
    );
  }
  if (n === 7) {
    const v = wo?.verifications[wo.verifications.length - 1];
    return (
      <>
        <Rows>
          {(v?.criteria.criteria ?? []).map((c) => (
            <Row key={c.name} left={c.label} mid={c.value == null ? "—" : c.value.toFixed(2)} right={chip(c.passed ? "ok" : "bad", c.passed ? "pass" : "fail")} />
          ))}
          <Row left="Technician verifies own work" right={chip("bad", `refused (${r.own_work_denied ?? 403})`)} />
        </Rows>
        <p className="mt-1.5 text-[12px] text-muted">{r.outcome === "CLOSED" ? "Verified by an independent check. Work order closed. The machine is back to normal." : "Verification failed. The job goes back for rework."}</p>
      </>
    );
  }
  return <Loading label="Loading…" />;
}

/** Step 4 needs Kishore: in automatic mode he approves by himself; or take control and walk him to his desk. */
function KishoreControls({ onApprove, disabled, auto }: { onApprove: () => void; disabled: boolean; auto: boolean }) {
  const active = usePlayer((s) => s.active);
  return (
    <div className="mt-2 space-y-1.5">
      {active ? (
        <>
          <p className="text-[12.5px]">You are Kishore. Look with the mouse, walk with <b>W A S D</b>, take the glass lift (<b>R</b>) to Floor 3, then to his desk and press <b>E</b>.</p>
          <button className="btn btn-sm" onClick={() => usePlayer.getState().set({ active: false })}>Stop controlling</button>
        </>
      ) : (
        <button className={`btn w-full py-2 ${auto ? "" : "btn-primary"}`} onClick={() => usePlayer.getState().set({ active: true })} data-testid="wt-control-kishore">
          🎮 {auto ? "Take over: walk Kishore to his desk" : "Control Kishore (W A S D)"}
        </button>
      )}
      {!auto && (
        <button className="text-[12px] text-accent hover:underline disabled:opacity-50" disabled={disabled} onClick={onApprove} data-testid="wt-approve-here">
          or approve from here
        </button>
      )}
      {auto && !active && <p className="text-[11.5px] text-muted">Kishore approves in a moment.</p>}
    </div>
  );
}

/** What the crew is doing right now: walking to the machine, then working through the repair checklist. */
function LiveNow({ asset }: { asset: Asset }) {
  const now = useSimNow(400);
  const { data: list } = useWorkOrders(`&asset_id=${asset.id}`);
  const id = [...(list?.items ?? [])].sort((a, b) => b.id - a.id)[0]?.id ?? null;
  const { data: wo } = useWorkOrder(id);
  const { data: cat } = useProcedures();
  if (!wo?.assigned_technician) return null;
  const first = wo.assigned_technician.name.split(" ")[0];
  const arrives = parseIso(wo.arrives_at);
  const steps = cat?.procedures[asset.asset_type] ?? [];
  if (wo.status === "ASSIGNED" && !Number.isNaN(arrives) && now < arrives) {
    const from = parseIso(wo.assigned_at);
    return (
      <div className="mt-2 rounded-md border border-line bg-panel2 p-2.5 text-[12.5px]" data-testid="wt-live">
        <div className="font-semibold">{first} is walking to {asset.name}</div>
        <div className="mt-0.5 text-muted">crew room → tools → {wo.floor_level === 0 ? "" : `lift to ${floorLabel(wo.floor_level)} → `}machine</div>
        <div className="mt-1.5"><Progress value={(now - from) / Math.max(1, arrives - from)} /></div>
      </div>
    );
  }
  if (wo.status === "IN_PROGRESS" && steps.length) {
    const current = stepAt(steps, (now - workBegan(wo)) / 60000);
    return (
      <div className="mt-2 rounded-md border border-line bg-panel2 p-2.5 text-[12.5px]" data-testid="wt-live">
        <div className="mb-1 font-semibold">{first} is repairing it</div>
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li key={s.key} className={`flex items-start gap-2 ${i > current ? "text-muted" : ""}`}>
              <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border text-[9px] ${i < current ? "border-ok bg-ok text-white" : i === current ? "border-accent" : "border-line"}`}>
                {i < current ? "✓" : i === current ? <i className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
              </span>
              <span className={i === current ? "font-semibold" : ""}>{s.label}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return null;
}

function Marker({ state, n }: { state: "done" | "now" | "next" | "todo"; n: number }) {
  const cls = { done: "border-ok bg-ok text-white", now: "border-accent bg-accent text-white", next: "border-accent text-accent", todo: "border-line text-muted" }[state];
  return <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${cls}`}>{state === "done" ? "✓" : state === "now" ? <i className="live-dot h-2 w-2 rounded-full bg-white" /> : n}</span>;
}

/** Play the demonstration by itself, or advance it one click at a time. */
function ModeSwitch() {
  const auto = useDemoMode((s) => s.auto);
  return (
    <div className="seg w-full" role="group" aria-label="How the demo runs">
      <button className="flex-1" aria-pressed={auto} onClick={() => useDemoMode.getState().set(true)} data-testid="wt-mode-auto">Play automatically</button>
      <button className="flex-1" aria-pressed={!auto} onClick={() => useDemoMode.getState().set(false)} data-testid="wt-mode-manual">Step by step</button>
    </div>
  );
}

export default function ProcessPanel() {
  const qc = useQueryClient();
  const { run, busy: acting } = useAct();
  const { data: wt, isError } = useWalkthrough();
  const auto = useDemoMode((s) => s.auto);
  const selected = useUi((s) => s.selectedAssetId);
  const assetId = wt?.asset_id ?? selected ?? GOLDEN_ASSET;
  const { data: asset } = useAsset(assetId);
  const [open, setOpen] = useState<number | null>(null);
  const stage = wt?.stage ?? 0;
  useEffect(() => setOpen(stage || null), [stage]);

  if (isError) {
    return (
      <div className="p-4" data-testid="process-error">
        <Empty title="The demo service is not running" hint="The backend is older than this screen. Stop the app and start it again (python scripts/tasks.py dev)." />
      </div>
    );
  }
  if (!wt || !asset) return <Loading />;
  const live = !!wt.asset_id;
  const working = wt.busy || acting;
  const refresh = () => qc.invalidateQueries({ queryKey: ["walkthrough"] });
  const start = () => run(() => startWalkthrough(asset.id), "").then(refresh);
  const next = () => run(() => nextWalkthroughStep()).then(refresh);
  const reset = async () => {
    usePlayer.getState().set({ active: false });
    await run(() => resetWalkthrough());
    useUi.getState().selectAsset(null, false);
    useUi.getState().fly({ preset: "overview" });
    refresh();
  };
  const header = (
    <div className="flex items-start justify-between gap-2">
      <div>
        <div className="text-[15px] font-semibold leading-tight">{asset.name}</div>
        <div className="mono text-muted">{asset.id} · {floorLabel(asset.floor_level)}</div>
      </div>
      <Simulated />
    </div>
  );

  if (!live) {
    return (
      <div className="space-y-4 p-4" data-testid="process-panel">
        {header}
        <SensorStrip asset={asset} />
        <ModeSwitch />
        <button className="btn btn-primary w-full py-2.5 text-[14px]" disabled={working} onClick={start} data-testid="wt-start">
          ⚠ Start anomaly on this machine
        </button>
        <p className="text-[12px] text-muted">
          {auto ? "The whole process plays by itself. You see every step here, and in the building." : <>Press <b>Next</b> for every step.</>} Click another machine to choose it.
        </p>
      </div>
    );
  }

  const finished = stage >= wt.total && !wt.busy;
  const lastLog = wt.log.length ? wt.log[wt.log.length - 1].text : null;
  return (
    <div className="space-y-4 p-4" data-testid="process-panel">
      {header}
      <SensorStrip asset={asset} />
      <ModeSwitch />

      {!wt.started ? (
        <div className="rounded-md border border-line p-3 text-[13px]" role="status">
          <i className="live-dot mr-2 inline-block h-2 w-2 rounded-full bg-accent" />A bearing starts to wear…
        </div>
      ) : (
        <ol className="space-y-1.5" data-testid="wt-steps">
          {wt.steps.map((s) => {
            const executing = wt.busy && stage === s.id;
            const done = stage >= s.id && !executing && !!wt.results[String(s.id)];
            const isNext = !wt.busy && stage + 1 === s.id;
            const state = done ? "done" : executing ? "now" : isNext ? "next" : "todo";
            const expanded = isNext || executing || (done && open === s.id);
            return (
              <li key={s.id} className={`rounded-md border px-2.5 py-2 ${isNext ? "border-accent bg-accent/5" : "border-line"}`} data-testid={`wt-step-${s.id}`} data-state={state}>
                <button className="flex w-full items-center gap-2 text-left" disabled={!done} onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={expanded}>
                  <Marker state={state} n={s.id} />
                  <span className={`flex-1 text-[13px] font-semibold ${state === "todo" ? "text-muted" : ""}`}>{s.short}</span>
                  <span className="mono text-[10.5px] text-muted">{s.layers}</span>
                </button>
                {expanded && (
                  <div className="mt-1.5 pl-8">
                    <div className="text-[13px] font-medium leading-snug">{s.title}</div>
                    {!done && <p className="mt-0.5 text-[12px] text-muted">{s.text}</p>}
                    {executing && <p className="mt-1 text-[12px] text-accent" role="status">{lastLog ?? "Working…"}</p>}
                    {executing && s.id === 6 && <LiveNow asset={asset} />}
                    {done && <Result n={s.id} asset={asset} wt={wt} />}
                    {isNext && s.id === 4 && <KishoreControls onApprove={next} disabled={working} auto={auto} />}
                    {isNext && s.id !== 4 && !auto && (
                      <button className="btn btn-primary mt-2 w-full py-2" disabled={working} onClick={next} data-testid="wt-next">
                        Next ▶
                      </button>
                    )}
                    {isNext && auto && s.id !== 4 && <p className="mt-1 text-[11.5px] text-muted">Starting in a moment…</p>}
                    {done && s.id === 6 && (
                      <button className="btn btn-sm mt-2" onClick={() => useUi.getState().fly({ preset: "follow", assetId: asset.id })}>Watch the technician</button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {wt.error && <p className="rounded-md border border-bad/40 bg-bad/5 p-2 text-[12px] text-bad" role="alert">{wt.error}</p>}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-muted">{finished ? "All done." : wt.started ? `Step ${Math.min(stage + 1, wt.total)} of ${wt.total}` : ""}</span>
        <button className="btn btn-sm" disabled={wt.busy || acting} onClick={reset} data-testid="wt-reset">Start over</button>
      </div>
    </div>
  );
}
