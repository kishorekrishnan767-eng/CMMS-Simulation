import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAsset, useProcedures, useWalkthrough, useWorkOrder, useWorkOrders } from "../api/queries";
import type { Asset, WalkPhase, WalkthroughState } from "../api/types";
import { GOLDEN_ASSET } from "../config";
import { useLive } from "../store/live";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { floorLabel } from "../three/constants";
import { stepAt, workBegan } from "../three/techPath";
import { fmtSensor, sensorName } from "./sensors";
import { Empty, Loading, Progress, Simulated, parseIso, useAct, useSimNow } from "./ui";
import { resetWalkthrough, startWalkthrough } from "./walkthroughApi";

/** m:ss on the one-minute clock. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** Plain words for the work-order priorities of the demo policy (P1 is the highest). */
const PRIORITY_LABEL: Record<string, string> = { P1: "urgent", P2: "high", P3: "medium", P4: "low" };
const priority = (p: unknown) => (typeof p === "string" && p ? `${p} (${PRIORITY_LABEL[p] ?? ""})` : "—");
/** Seconds a finished run stays on screen before the tab is ready for the next one. */
const BACK_TO_IDLE_MS = 10_000;

/** The card a phase belongs to: 0 = the wear begins, 1–7 = the seven steps, 8 = back to normal. */
const PHASE_CARD: Record<WalkPhase, number> = {
  idle: -1, starting: 0, preparing: 0, wear: 0, readings: 1, prediction: 2, workorder: 3, approval: 4, approved: 4,
  dispatch: 5, walking: 6, working: 6, rework: 7, verifying: 7, closing: 7, done: 8,
};

type CardState = "done" | "now" | "todo";
interface CardDef { n: number; icon: string; title: string; layer: string; at: number | null }

const chip = (text: ReactNode, tone: "ok" | "bad" | "watch" | "muted" | "info" = "muted") => <span className={`badge badge-${tone}`}>{text}</span>;

/** Live value of every sensor of the machine: shown before a run, so you can see what is normal. */
function SensorStrip({ asset }: { asset: Asset }) {
  const vals = useLive((s) => s.values[asset.id]) ?? {};
  return (
    <div className="grid grid-cols-4 gap-1.5" data-testid="sensor-strip">
      {asset.sensors.map((s) => (
        <div key={s.id} className="rounded-md border border-line bg-panel2 px-2 py-1.5">
          <div className="truncate text-[10px] uppercase tracking-wide text-muted">{sensorName(s.metric)}</div>
          <div className="text-[13px] font-semibold tabular-nums">{fmtSensor(s.metric, vals[s.metric])}</div>
        </div>
      ))}
    </div>
  );
}

/** The one-minute clock, ticking smoothly between polls. */
function RunClock({ wt }: { wt: WalkthroughState }) {
  const base = useRef({ at: performance.now(), s: wt.elapsed_s });
  const [, tick] = useState(0);
  useEffect(() => {
    base.current = { at: performance.now(), s: wt.elapsed_s };
  }, [wt.elapsed_s]);
  useEffect(() => {
    if (!wt.busy) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [wt.busy]);
  const s = wt.busy ? Math.min(wt.budget_s * 1.2, base.current.s + (performance.now() - base.current.at) / 1000) : wt.elapsed_s;
  const finished = wt.phase === "done" && !wt.busy;
  return (
    <section className="rounded-md border border-line px-3 py-2" data-testid="wt-clock" data-finished={finished}>
      <div className="flex items-baseline justify-between">
        <span className="text-[22px] font-semibold tabular-nums" data-testid="wt-elapsed">
          {clock(s)}<span className="ml-1 text-[12px] font-normal text-muted">/ {clock(wt.budget_s)}</span>
        </span>
        <span className="text-[12px] text-muted">
          {finished ? "✓ Finished" : wt.preparing ? "Getting ready…" : wt.busy ? <><i className="live-dot mr-1.5 inline-block h-2 w-2 rounded-full bg-accent" />Playing</> : wt.error ? "Stopped" : ""}
        </span>
      </div>
      <div className="mt-1.5"><Progress value={s / Math.max(1, wt.budget_s)} tone={finished ? "ok" : "accent"} /></div>
    </section>
  );
}

/** Walking to the machine (and the lift), then the repair checklist, live from the work order. */
function CrewLive({ asset }: { asset: Asset }) {
  const now = useSimNow(300);
  const { data: list } = useWorkOrders(`&asset_id=${asset.id}`);
  const id = [...(list?.items ?? [])].sort((a, b) => b.id - a.id)[0]?.id ?? null;
  const { data: wo } = useWorkOrder(id);
  const { data: cat } = useProcedures();
  if (!wo?.assigned_technician) return null;
  const first = wo.assigned_technician.name.split(" ")[0];
  const arrives = parseIso(wo.arrives_at);
  const steps = cat?.procedures[asset.asset_type] ?? [];
  if ((wo.status === "ASSIGNED" || wo.status === "IN_PROGRESS") && !Number.isNaN(arrives) && now < arrives) {
    const from = parseIso(wo.assigned_at);
    const f = (now - from) / Math.max(1, arrives - from);
    const leg = f < 0.18 ? "collecting the tool kit" : f < 0.45 ? "walking to the glass lift" : asset.floor_level !== 0 && f < 0.7 ? `in the lift to ${floorLabel(asset.floor_level)}` : `walking to ${asset.name}`;
    return (
      <div className="mt-1.5 rounded-md bg-panel2 p-2 text-[12px]" data-testid="wt-live">
        <div><b>{first}</b> is {leg}</div>
        <div className="mt-0.5 text-[11px] text-muted">crew room → tools → {asset.floor_level === 0 ? "" : `lift → ${floorLabel(asset.floor_level)} → `}{asset.name}</div>
        <div className="mt-1"><Progress value={f} /></div>
      </div>
    );
  }
  if (wo.status === "IN_PROGRESS" && steps.length) {
    const current = stepAt(steps, (now - workBegan(wo)) / 60000);
    return (
      <ol className="mt-1.5 space-y-0.5 rounded-md bg-panel2 p-2 text-[12px]" data-testid="wt-live">
        {steps.map((s, i) => (
          <li key={s.key} className={i > current ? "text-muted" : i === current ? "font-semibold" : ""}>
            {i < current ? "✓" : i === current ? "▶" : "·"} {s.label}
          </li>
        ))}
      </ol>
    );
  }
  return <div className="mt-1.5 text-[12px] text-muted" data-testid="wt-live">{first} is on site: toolbox talk and permit to work</div>;
}

/** What a card says: its data (chips) and, while it is the live step, what is happening right now. */
function CardBody({ n, wt, asset, state }: { n: number; wt: WalkthroughState; asset: Asset; state: CardState }) {
  const r = (k: number) => wt.results[String(k)] ?? {};
  const vib = useLive((s) => s.values[asset.id]?.vibration_velocity);
  const lines = wt.log.filter((l) => (n === 0 ? l.stage === 0 : l.stage === n)).slice(-2).map((l) => l.text);
  const live = state === "now" && lines.length > 0 && <div className="mt-1 text-[12px] text-accent" role="status">{lines[lines.length - 1]}</div>;
  const row = (children: ReactNode) => <div className="mt-1 flex flex-wrap gap-1">{children}</div>;
  const desc = (text: ReactNode) => state !== "done" && <p className="text-[12px] text-muted">{text}</p>;
  switch (n) {
    case 0:
      return (
        <>
          {desc("Hidden from the detector: the bearing starts to wear and vibration creeps up.")}
          {state !== "todo" && row(<>{wt.normal.vibration_velocity != null && chip(`normal ${fmtSensor("vibration_velocity", wt.normal.vibration_velocity)}`, "ok")}{vib != null && chip(`now ${fmtSensor("vibration_velocity", vib)}`, state === "now" ? "watch" : "muted")}</>)}
        </>
      );
    case 1: {
      const dups = Object.values((r(1).duplicates ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
      return (
        <>
          {desc(`${asset.sensors.length} sensors report every minute. Copies of a reading are dropped, bad data never counts.`)}
          {state === "done" && row(<>{chip(`${dups} duplicate${dups === 1 ? "" : "s"} dropped`, "ok")}{chip("one copy kept")}</>)}
          {live}
        </>
      );
    }
    case 2: {
      const d = r(2);
      const sev = wt.escalation.filter((e) => e.level.startsWith("SEVERITY_")).map((e) => e.level.slice(9).toLowerCase());
      return (
        <>
          {desc("Each reading is compared with what is normal for this machine at this load; the trend is projected forward.")}
          {state === "done" && d.z != null && (
            <>
              {row(<>{chip(`${Number(d.z).toFixed(1)}σ above normal`, "bad")}{chip(`normal ${Number(d.baseline).toFixed(2)} → ${Number(d.observed).toFixed(2)} mm/s`)}</>)}
              {d.projection_hours != null && row(chip(`alarm limit (demo value) in ~${Math.round(Number(d.projection_hours) * 60)} min`, "watch"))}
              <p className="mt-1 text-[11.5px] text-muted">Consistent with possible bearing wear: inspection recommended.</p>
            </>
          )}
          {state !== "todo" && sev.length > 0 && row(<><span className="text-[11px] text-muted">severity</span>{sev.map((s, i) => <span key={s} className="text-[11px]">{i > 0 && "→ "}{chip(s, s === "low" ? "watch" : "bad")}</span>)}</>)}
          {live}
        </>
      );
    }
    case 3: {
      const d = r(3);
      return (
        <>
          {desc("The risk sets the priority. Repeat alerts are added to the same work order, never a duplicate.")}
          {state === "done" && row(<>{chip(String(d.work_order), "info")}{chip(priority(d.priority), "watch")}{d.risk != null && chip(`risk ${d.risk}/100`)}{chip(`${d.evidence} alerts as evidence · 0 duplicates`)}</>)}
          {live}
        </>
      );
    }
    case 4: {
      const d = r(4);
      const reviewing = wt.phase === "approval";
      const approved = wt.phase === "approved" || state === "done";
      if (state === "todo") return desc("The request goes to Kishore, the supervisor, with the evidence. He reviews it and approves.");
      const standby = wt.log.find((l) => l.stage === 4 && l.text.includes("on standby"))?.text.split(" is the best match")[0];
      return (
        <>
          <ul className="space-y-0.5 text-[12px]">
            <li>📨 Request sent to <b>Kishore</b> (supervisor) with the evidence</li>
            {standby && <li>🧰 <b>{standby}</b> is lined up and waits for the approval</li>}
            {(reviewing || approved) && <li className={approved ? "" : "text-accent"}>{approved ? "✓" : "…"} Kishore reviews the trend, the risk and the crew</li>}
            {d.escalated && <li>⬆ Priority raised {d.escalated.from} → {d.escalated.to} by new evidence; Kishore accepted</li>}
            {approved && <li className="font-semibold text-ok">✓ Approved by Kishore</li>}
          </ul>
          {reviewing && <div className="mt-1.5"><div className="kishore-review-bar h-1 overflow-hidden rounded bg-line"><i className="block h-full bg-accent" style={{ animation: "kc-review 5s linear forwards", transformOrigin: "left" }} /></div></div>}
        </>
      );
    }
    case 5: {
      const d = r(5);
      const ordered = (d.parts_ordered ?? []) as { sku: string; quantity: number }[];
      return (
        <>
          {desc("Technicians are ranked by skill, distance and workload. The job and the reserved parts reach the crew room.")}
          {state === "done" && (
            <div data-testid="wt-job-message">
              {row(<>{chip(`👷 ${d.technician}`, "info")}{chip(`ETA ${d.travel_minutes} min`)}{chip(priority(d.priority), "watch")}</>)}
              {ordered.length > 0 && <div className="mt-1 text-[12px] text-watch" data-testid="wt-parts-ordered">Parts were short: ordered {ordered.map((o) => `${o.sku} × ${o.quantity}`).join(", ")}, delivered, job resumed.</div>}
            </div>
          )}
          {live}
        </>
      );
    }
    case 6:
      return (
        <>
          {state !== "done" && <p className="text-[12px] text-muted">Tools from the crew room, the glass lift to {floorLabel(asset.floor_level)}, then the repair step by step.</p>}
          {state === "now" && <CrewLive asset={asset} />}
          {state === "done" && <p className="text-[12px]">{String(r(6).findings ?? "")}</p>}
        </>
      );
    case 7: {
      const d = r(7);
      const failed = (d.failed_checks ?? []) as string[];
      return (
        <>
          {desc("A full window of fresh readings is compared with normal, independently of the technician. Then Kishore closes the job.")}
          {failed.length > 0 && <div className="mt-1 text-[12px] text-bad" data-testid="wt-rework">First check failed ({failed.join("; ")}): reworked, then passed.</div>}
          {state === "done" && row(<>{chip("✓ check passed", "ok")}{chip(`closed by ${d.closed_by ?? "Kishore"}`, "ok")}</>)}
          {live}
        </>
      );
    }
    default:
      return state === "done" ? (
        <p className="text-[12px]">{asset.name} is healthy again. {Math.round(wt.sim_minutes / 6) / 10} h of building time played in {clock(wt.elapsed_s)}.</p>
      ) : (
        <p className="text-[12px] text-muted">The machine is back to normal and the work order is closed.</p>
      );
  }
}

function Marker({ state, n }: { state: CardState; n: number }) {
  const cls = { done: "border-ok bg-ok text-white", now: "border-accent bg-accent text-white", todo: "border-line text-muted" }[state];
  return (
    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold transition-colors duration-500 ${cls}`}>
      {state === "done" ? "✓" : state === "now" ? <i className="live-dot h-2 w-2 rounded-full bg-white" /> : n}
    </span>
  );
}

/** The whole story as cards joined by arrows: done ✓, the live one highlighted, the rest still to come. */
function Flow({ wt, asset, preview }: { wt: WalkthroughState; asset: Asset; preview: boolean }) {
  const cards: CardDef[] = [
    { n: 0, icon: "⚙", title: "A bearing starts to wear", layer: "L1", at: 0 },
    ...wt.steps.map((s) => ({ n: s.id, icon: ["", "📡", "📈", "📋", "✍", "👷", "🔧", "✅"][s.id], title: s.short === "Approval" ? "Kishore reviews and approves" : s.short === "Dispatch" ? "Technician assigned" : s.short === "Repair" ? "Walk, lift and repair" : s.short === "Prediction" ? "Early warning and prediction" : s.short === "Duplicate check" ? "Sensors send their data" : s.short, layer: s.layers, at: s.at })),
    { n: 8, icon: "🟢", title: "Back to normal", layer: "L7", at: null },
  ];
  const nowCard = preview || !wt.busy ? -1 : PHASE_CARD[wt.phase] ?? -1;
  const nowRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (nowCard >= 0) nowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [nowCard]);
  const finished = wt.phase === "done" && !wt.busy;
  const stateOf = (n: number): CardState => {
    if (preview) return "todo";
    if (n === nowCard) return "now";
    if (n === 0) return wt.started ? "done" : "todo";
    if (n === 8) return finished ? "done" : "todo";
    return wt.results[String(n)] && n !== nowCard ? "done" : "todo";
  };
  return (
    <ol data-testid={preview ? "wt-plan" : "wt-steps"}>
      {cards.map((c, i) => {
        const state = stateOf(c.n);
        const mark = c.n >= 1 && c.n <= 7 ? wt.marks[String(c.n)] : undefined;
        const time = preview ? (c.at != null ? clock(c.at) : "1:00") : mark != null ? clock(mark) : c.n === 0 && wt.started ? "0:00" : "";
        const next = cards[i + 1];
        const arrow = next ? (stateOf(next.n) === "now" ? "live" : state === "done" ? "done" : "") : null;
        return (
          <li key={c.n} ref={state === "now" ? nowRef : undefined} data-testid={c.n >= 1 && c.n <= 7 ? `wt-step-${c.n}` : `wt-flow-${c.n}`} data-state={state}>
            <div className={`rounded-md border px-2.5 py-2 transition-all duration-500 ${state === "now" ? "border-accent bg-accent/5 shadow-sm" : state === "done" ? "border-line" : "border-line opacity-70"}`}>
              <div className="flex items-center gap-2">
                <Marker state={state} n={c.n} />
                <span className="text-[14px]" aria-hidden>{c.icon}</span>
                <span className={`flex-1 text-[13px] font-semibold ${state === "todo" ? "text-muted" : ""}`}>{c.title}</span>
                <span className="mono text-[10.5px] text-muted">{time || c.layer}</span>
              </div>
              {(state !== "todo" || preview) && (
                <div className="mt-1 pl-8">
                  <CardBody n={c.n} wt={wt} asset={asset} state={state} />
                </div>
              )}
            </div>
            {arrow !== null && <div className={`flow-arrow ${arrow}`} aria-hidden><i /><b>▼</b></div>}
          </li>
        );
      })}
    </ol>
  );
}

export default function ProcessPanel() {
  const qc = useQueryClient();
  const { run, busy: acting } = useAct();
  const { data: wt, isError } = useWalkthrough();
  const selected = useUi((s) => s.selectedAssetId);
  const finished = !!wt && wt.phase === "done" && !wt.busy;
  // after step 7 the finished run stays on screen for a moment, then the tab is ready for the next machine
  const [idleAgain, setIdleAgain] = useState(false);
  useEffect(() => {
    if (!finished) {
      setIdleAgain(false);
      return;
    }
    const t = window.setTimeout(() => setIdleAgain(true), BACK_TO_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [finished]);
  const live = !!wt?.asset_id && (wt.busy || !!wt.error || (finished && !idleAgain));
  const assetId = live ? wt!.asset_id : selected ?? wt?.asset_id ?? GOLDEN_ASSET;
  const { data: asset } = useAsset(assetId);

  if (isError) {
    return (
      <div className="p-4" data-testid="process-error">
        <Empty title="The demo service is not running" hint="The backend is older than this screen. Stop the app and start it again (python scripts/tasks.py dev)." />
      </div>
    );
  }
  if (!wt || !asset) return <Loading />;
  const refresh = () => qc.invalidateQueries({ queryKey: ["walkthrough"] });
  const start = () => run(() => startWalkthrough(asset.id), "").then(refresh);
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
    const last = finished && wt.asset_id;
    return (
      <div className="space-y-3 p-4" data-testid="process-panel">
        {header}
        {last && (
          <p className="rounded-md border border-ok/40 bg-ok/5 p-2 text-[12px]" data-testid="wt-last">
            ✓ Last simulation: {wt.asset_id} found, repaired, checked and closed in {clock(wt.elapsed_s)}. Ready for the next one.
          </p>
        )}
        <SensorStrip asset={asset} />
        <button className="btn btn-primary w-full py-2.5 text-[14px]" disabled={wt.busy || acting} onClick={start} data-testid="wt-start">
          ⚠ Inject anomaly on {asset.name}
        </button>
        <p className="text-[12px] text-muted">Plays by itself in about one minute, in the building and here, step by step. No sign-in, no clicks; approvals happen automatically. One simulation at a time.</p>
        {!!wt.leftovers?.length && (
          <p className="rounded-md border border-watch/40 bg-watch/5 p-2 text-[12px]" data-testid="wt-leftovers">
            Earlier runs left {wt.leftovers.join(", ")}. A new simulation clears them first, so it always starts clean.
          </p>
        )}
        <div className="h-section">What happens</div>
        <Flow wt={wt} asset={asset} preview />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4" data-testid="process-panel">
      {header}
      <RunClock wt={wt} />
      {wt.preparing && (
        <div className="rounded-md border border-line p-2.5 text-[12.5px]" role="status" data-testid="wt-preparing">
          <i className="live-dot mr-2 inline-block h-2 w-2 rounded-full bg-accent" />Getting the building ready: clearing {wt.cleared.join(", ")} left by earlier runs…
        </div>
      )}
      <Flow wt={wt} asset={asset} preview={false} />
      {wt.error && <p className="rounded-md border border-bad/40 bg-bad/5 p-2 text-[12px] text-bad" role="alert">{wt.error}</p>}
      {finished && <p className="text-center text-[12px] text-muted" data-testid="wt-done">Done. Ready for the next machine in a few seconds…</p>}
      <div className="flex items-center justify-end">
        <button className="btn btn-sm" disabled={acting} onClick={reset} data-testid="wt-reset">Start over</button>
      </div>
    </div>
  );
}
