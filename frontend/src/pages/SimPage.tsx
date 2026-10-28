import { Suspense, lazy, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWalkthrough } from "../api/queries";
import DemoDirector from "../components/DemoDirector";
import LayerRibbon from "../components/LayerRibbon";
import LeftPanel from "../components/LeftPanel";
import PlayerHud from "../components/PlayerHud";
import RightPanel from "../components/RightPanel";
import WalkthroughBridge from "../components/WalkthroughBridge";
import { Loading } from "../components/ui";
import { GOLDEN_ASSET } from "../config";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import WebGLGuard from "../components/WebGLGuard";

const TwinScene = lazy(() => import("../three/Scene"));

/** Main screen: full-viewport 3D twin, building tree (left), operations / job / telemetry (right), layer ribbon (bottom). */
export default function SimPage() {
  const [params, setParams] = useSearchParams();
  const demo = params.get("demo") === "1";
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const selected = useUi((s) => s.selectedAssetId);
  const [leftOpen, setLeftOpen] = useState(true);
  const { data: wt } = useWalkthrough();
  const controlling = usePlayer((s) => s.active);

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

      <PlayerHud />
      <WalkthroughBridge />

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
      {!demo && !wt?.asset_id && !controlling && (
        <button
          className="btn btn-primary absolute bottom-24 left-1/2 z-30 hidden -translate-x-1/2 shadow-sm sm:inline-flex"
          onClick={() => {
            const ui = useUi.getState();
            ui.selectAsset(GOLDEN_ASSET);
            ui.set({ rightPanelOpen: true, rightTab: "process" });
          }}
          data-testid="watch-demo"
        >
          ▶ 1-minute anomaly demo
        </button>
      )}
    </div>
  );
}
