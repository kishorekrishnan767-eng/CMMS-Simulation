import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { GOLDEN_ASSET } from "../config";
import { useUi } from "../store/ui";
import { useAct } from "./ui";

interface DemoStep { id: number; layer: number; short: string; title: string; narration: string; camera: { view: string; asset?: string; close?: boolean } }
interface DemoState {
  step: number; total: number; busy: boolean; autoplay: boolean; error: string | null; steps: DemoStep[];
  current: DemoStep | null; results: Record<string, any>; log: { step: number; text: string; kind?: string }[];
}

function applyCamera(cam: DemoStep["camera"]) {
  const ui = useUi.getState();
  const asset = cam.asset ?? GOLDEN_ASSET;
  switch (cam.view) {
    case "overview":
      ui.selectAsset(null, false);
      ui.fly({ preset: "overview" });
      break;
    case "bms":
      ui.selectAsset(null, false);
      ui.fly({ preset: "bms" });
      break;
    case "crew":
      ui.selectAsset(null, false);
      ui.fly({ preset: "crew" });
      break;
    case "follow":
      ui.selectAsset(asset, false);
      ui.set({ rightTab: "job" });
      ui.fly({ preset: "follow", assetId: asset });
      break;
    default:
      ui.selectAsset(asset, false);
      ui.set({ rightTab: "job" });
      ui.fly({ preset: "asset", assetId: asset, close: cam.close });
  }
}

/** Guided demo: plain-language narration and camera moves on top of the REAL backend. */
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

  const reset = async () => {
    setPreparing(true);
    await run(() => api.post("/api/demo/reset"));
    setPreparing(false);
  };
  const next = async () => {
    const meta = data.steps[Math.min(data.step, data.total - 1)];
    if (meta) applyCamera(meta.camera);
    await run(() => api.post("/api/demo/step"));
    qc.invalidateQueries({ queryKey: ["demo"] });
  };
  const start = async () => {
    await reset();
    await next();
  };
  const play = async () => {
    if (data.step === 0) await reset();
    await run(() => api.post("/api/demo/autoplay"));
    qc.invalidateQueries({ queryKey: ["demo"] });
  };
  const stop = async () => {
    await run(() => api.post("/api/demo/stop"));
  };

  const cur = data.current;
  const live = data.log.length ? data.log[data.log.length - 1].text : null;
  return (
    <div className="glass fade-in pointer-events-auto w-[min(94vw,640px)] rounded-md border border-line" data-testid="demo-director" role="region" aria-label="Guided demo">
      <div className="flex gap-px overflow-hidden rounded-t-md" aria-hidden>
        {data.steps.map((s) => (
          <i key={s.id} title={s.short} className={`h-1 flex-1 ${s.id < data.step ? "bg-ok" : s.id === data.step ? "bg-accent" : "bg-line"}`} />
        ))}
      </div>
      <div className="p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
            {data.step === 0 ? "Guided demo" : `Step ${data.step} of ${data.total} · ${cur?.short ?? ""}`}
          </span>
          <button className="btn btn-sm" onClick={() => { void stop(); onExit(); }} data-testid="demo-exit">Close</button>
        </div>
        {cur ? (
          <>
            <div className="text-[17px] font-semibold leading-snug" data-testid="demo-title">{cur.title}</div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted" data-testid="demo-narration">{cur.narration}</p>
          </>
        ) : (
          <>
            <div className="text-[17px] font-semibold leading-snug">See how a problem is found, fixed and proved, before it becomes a breakdown</div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
              In about four minutes you will watch a fan bearing start to wear on the roof of the Livewire Digital Solutions building. The system spots it early,
              raises one work order, a supervisor approves it, a technician walks to the fan and repairs it, and an independent check proves it worked.
            </p>
          </>
        )}
        {live && data.step > 0 && <div className="mt-2 truncate text-[12px] text-muted" data-testid="demo-log">› {live}</div>}
        {data.error && <p className="mt-2 text-xs text-bad" role="alert">{data.error}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data.step === 0 && !working && <button className="btn btn-primary" onClick={play} data-testid="demo-autoplay">▶ Play the whole demo</button>}
          {data.step === 0 && !working && <button className="btn" onClick={start} data-testid="demo-start">Go step by step</button>}
          {data.step > 0 && !finished && !data.autoplay && <button className="btn btn-primary" disabled={working} onClick={next} data-testid="demo-next">{working ? "Working…" : `Next: ${nextMeta?.short ?? ""}`}</button>}
          {data.step > 0 && !working && !finished && !data.autoplay && <button className="btn" onClick={play} data-testid="demo-autoplay">Play the rest</button>}
          {data.autoplay && <button className="btn" onClick={stop}>Pause</button>}
          {working && <span className="text-xs text-muted" role="status">{preparing ? "Preparing the building…" : data.autoplay ? "Playing…" : "Running…"}</span>}
          {finished && <button className="btn btn-primary" onClick={onExit} data-testid="demo-finish">Finish and explore the building</button>}
        </div>
      </div>
    </div>
  );
}
