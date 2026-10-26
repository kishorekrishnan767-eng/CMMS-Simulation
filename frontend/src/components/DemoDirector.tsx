import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { GOLDEN_ASSET } from "../config";
import { useUi } from "../store/ui";
import { useAct } from "./ui";

interface DemoStep { id: number; layer: number; title: string; narration: string; camera: { view: string; asset?: string; close?: boolean } }
interface DemoState {
  step: number; total: number; busy: boolean; autoplay: boolean; error: string | null; steps: DemoStep[];
  current: DemoStep | null; results: Record<string, any>; log: { step: number; text: string; kind?: string }[];
}

function applyCamera(cam: DemoStep["camera"]) {
  const ui = useUi.getState();
  if (cam.view === "overview") {
    ui.selectAsset(null, false);
    ui.fly({ preset: "overview" });
  } else if (cam.view === "follow") {
    ui.selectAsset(cam.asset ?? GOLDEN_ASSET, false);
    ui.fly({ preset: "follow", assetId: cam.asset ?? GOLDEN_ASSET });
  } else {
    ui.selectAsset(cam.asset ?? GOLDEN_ASSET, false);
    ui.fly({ preset: "asset", assetId: cam.asset ?? GOLDEN_ASSET, close: cam.close });
  }
}

/** Guided Demo: narration + camera moves on top of the REAL backend (the server-side director only calls the public API). */
export default function DemoDirector({ onExit }: { onExit: () => void }) {
  const qc = useQueryClient();
  const { run, busy: acting } = useAct();
  const [preparing, setPreparing] = useState(false);
  const { data } = useQuery({ queryKey: ["demo"], queryFn: () => api.get<DemoState>("/api/demo/state"), refetchInterval: 900 });
  const lastStep = useRef(-1);

  useEffect(() => {
    if (data && data.step !== lastStep.current) {
      lastStep.current = data.step;
      if (data.current) applyCamera(data.current.camera);
    }
  }, [data]);

  if (!data) return null;
  const working = data.busy || preparing || acting;
  const nextMeta = data.steps[data.step];
  const finished = data.step >= data.total && !data.busy;

  const start = async () => {
    setPreparing(true);
    await run(() => api.post("/api/demo/reset"));
    setPreparing(false);
    await next();
  };
  const next = async () => {
    const meta = data.steps[Math.min(data.step, data.total - 1)];
    if (meta) applyCamera(meta.camera);
    await run(() => api.post("/api/demo/step"));
    qc.invalidateQueries({ queryKey: ["demo"] });
  };
  const autoplay = async () => {
    if (data.step === 0) {
      setPreparing(true);
      await run(() => api.post("/api/demo/reset"));
      setPreparing(false);
    }
    await run(() => api.post("/api/demo/autoplay"));
    qc.invalidateQueries({ queryKey: ["demo"] });
  };
  const stop = async () => {
    await run(() => api.post("/api/demo/stop"));
  };

  const cur = data.current;
  const lastLog = data.log.slice(-4);
  return (
    <div className="glass pointer-events-auto w-[min(94vw,560px)] rounded-md border border-accent/50 p-4 shadow-lg" data-testid="demo-director" role="region" aria-label="Guided demo">
      <div className="mb-1 flex items-center justify-between">
        <span className="badge badge-ok">Guided demo · {data.step}/{data.total}</span>
        <button className="btn btn-sm" onClick={() => { void stop(); onExit(); }} data-testid="demo-exit">Exit</button>
      </div>
      <div className="mb-2 flex gap-0.5" aria-hidden>
        {data.steps.map((s) => (
          <i key={s.id} className={`h-1 flex-1 rounded ${s.id <= data.step ? "bg-accent" : "bg-line"}`} />
        ))}
      </div>
      {cur ? (
        <>
          <div className="text-base font-semibold" data-testid="demo-title">{cur.id}. {cur.title} <span className="badge badge-muted ml-1">Layer {cur.layer}</span></div>
          <p className="mt-1 text-sm text-muted" data-testid="demo-narration">{cur.narration}</p>
        </>
      ) : (
        <>
          <div className="text-base font-semibold">Follow one incident through all seven layers</div>
          <p className="mt-1 text-sm text-muted">A fan bearing slowly degrades in the simulation. The system detects it, scores the risk, opens a work order, a supervisor approves, a technician walks to the roof, repairs it, and a verifier confirms recovery. Every step calls the real backend — including actions it will deny.</p>
        </>
      )}
      {lastLog.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded border border-line bg-bg/60 p-2 text-[11px] text-muted" data-testid="demo-log">
          {lastLog.map((l, i) => <li key={i}>› {l.text}</li>)}
        </ul>
      )}
      {data.error && <p className="mt-2 text-xs text-bad" role="alert">{data.error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {data.step === 0 && !working && <button className="btn btn-primary" onClick={start} data-testid="demo-start">Start (reset to seed)</button>}
        {data.step > 0 && !finished && <button className="btn btn-primary" disabled={working} onClick={next} data-testid="demo-next">{working ? "Running…" : `Next: ${nextMeta?.title ?? ""}`}</button>}
        {!working && !finished && <button className="btn" onClick={autoplay} data-testid="demo-autoplay">Autoplay</button>}
        {data.autoplay && <button className="btn" onClick={stop}>Pause autoplay</button>}
        {working && <span className="text-xs text-muted" role="status">{preparing ? "Resetting and backfilling 6 h of healthy history…" : "Running against the real backend…"}</span>}
        {finished && <button className="btn btn-primary" onClick={onExit} data-testid="demo-finish">Finish — explore the twin</button>}
      </div>
    </div>
  );
}
