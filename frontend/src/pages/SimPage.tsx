import { Suspense, lazy, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import DemoDirector from "../components/DemoDirector";
import LayerRibbon from "../components/LayerRibbon";
import LeftPanel from "../components/LeftPanel";
import RightPanel from "../components/RightPanel";
import { Loading, useAct } from "../components/ui";
import { useLive } from "../store/live";
import { useSession } from "../store/session";
import { useUi } from "../store/ui";
import WebGLGuard from "../components/WebGLGuard";

const TwinScene = lazy(() => import("../three/Scene"));

/** Shown while the sim clock is stopped, so it is obvious why nothing moves. */
function PausedBanner() {
  const running = useLive((s) => s.clock.running);
  const connected = useLive((s) => s.connected);
  const me = useSession((s) => s.me);
  const { run, busy } = useAct();
  const can = !!me && ["ADMIN", "OPERATOR", "SUPERVISOR"].includes(me.role);
  if (running || !connected) return null;
  return (
    <div className="glass fade-in pointer-events-auto absolute left-1/2 top-[4.4rem] z-30 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line px-3 py-2 text-[12.5px]" data-testid="paused-banner">
      <span className="h-2 w-2 rounded-full bg-watch" />
      <span>Simulation clock is paused — equipment, detector and crew are frozen.</span>
      <button className="btn btn-primary btn-sm" disabled={busy || !can} onClick={() => run(() => api.post("/api/simulation/start"))}>Run</button>
    </div>
  );
}

/** Main screen: full-viewport 3D twin, building tree (left), operations / job / telemetry (right), layer ribbon (bottom). */
export default function SimPage() {
  const [params, setParams] = useSearchParams();
  const demo = params.get("demo") === "1";
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const selected = useUi((s) => s.selectedAssetId);
  const [leftOpen, setLeftOpen] = useState(true);

  useEffect(() => {
    const a = params.get("asset");
    if (a) {
      useUi.getState().selectAsset(a);
      useUi.getState().set({ rightTab: "asset" });
    }
  }, [params]);

  return (
    <div className="fixed inset-0 pt-14" data-testid="sim-page">
      <div className="absolute inset-0 top-14">
        <WebGLGuard>
          <Suspense fallback={<Loading label="Loading 3D scene…" />}>
            <TwinScene />
          </Suspense>
        </WebGLGuard>
      </div>

      <aside className={`glass scroll-thin absolute bottom-24 left-2 top-16 z-30 w-64 overflow-y-auto rounded-md border border-line transition-transform duration-300 ease-out ${leftOpen ? "" : "-translate-x-[110%]"}`} aria-label="Building and view controls">
        <LeftPanel />
      </aside>
      <button className="btn btn-sm absolute top-[4.2rem] z-30 transition-[left] duration-300 ease-out" style={{ left: leftOpen ? "16.75rem" : "0.5rem" }} onClick={() => setLeftOpen((o) => !o)} aria-label="Toggle left panel">
        {leftOpen ? "‹" : "›"}
      </button>

      <PausedBanner />

      {rightOpen && (
        <aside className="glass absolute bottom-24 right-2 top-16 z-30 w-[min(94vw,410px)] overflow-hidden rounded-md border border-line" aria-label="Operations and asset detail" data-selected={selected ?? ""}>
          <RightPanel />
        </aside>
      )}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 flex flex-col items-center gap-2">
        {demo && (
          <DemoDirector onExit={() => { const p = new URLSearchParams(params); p.delete("demo"); setParams(p, { replace: true }); }} />
        )}
        <div className="pointer-events-auto w-full max-w-5xl">
          <LayerRibbon />
        </div>
      </div>
      {!demo && (
        <button className="btn absolute bottom-24 left-1/2 z-30 hidden -translate-x-1/2 shadow-sm sm:inline-flex" onClick={() => setParams({ demo: "1" })} data-testid="watch-demo">
          ▶ Guided demo
        </button>
      )}
    </div>
  );
}
