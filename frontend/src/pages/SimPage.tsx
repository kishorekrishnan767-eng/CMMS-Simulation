import { Suspense, lazy, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AssetPanel from "../components/AssetPanel";
import DemoDirector from "../components/DemoDirector";
import LayerRibbon from "../components/LayerRibbon";
import LeftPanel from "../components/LeftPanel";
import { Loading } from "../components/ui";
import { useUi } from "../store/ui";
import WebGLGuard from "../components/WebGLGuard";

const TwinScene = lazy(() => import("../three/Scene"));

/** Main screen: full-viewport 3D twin, building tree (left), asset detail (right), layer ribbon (bottom). */
export default function SimPage() {
  const [params, setParams] = useSearchParams();
  const demo = params.get("demo") === "1";
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const selected = useUi((s) => s.selectedAssetId);
  const [leftOpen, setLeftOpen] = useState(true);

  useEffect(() => {
    const a = params.get("asset");
    if (a) useUi.getState().selectAsset(a);
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

      <aside className={`glass scroll-thin absolute bottom-24 left-2 top-16 z-10 w-64 overflow-y-auto rounded-xl border border-line transition-transform ${leftOpen ? "" : "-translate-x-[110%]"}`} aria-label="Building and view controls">
        <LeftPanel />
      </aside>
      <button className="btn btn-sm absolute left-2 top-[4.2rem] z-20" style={{ left: leftOpen ? "16.5rem" : "0.5rem" }} onClick={() => setLeftOpen((o) => !o)} aria-label="Toggle left panel">
        {leftOpen ? "‹" : "›"}
      </button>

      {rightOpen && (
        <aside className="glass scroll-thin absolute bottom-24 right-2 top-16 z-10 w-[min(94vw,400px)] overflow-y-auto rounded-xl border border-line" aria-label="Asset detail" data-selected={selected ?? ""}>
          <AssetPanel />
        </aside>
      )}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex flex-col items-center gap-2">
        {demo && (
          <DemoDirector onExit={() => { const p = new URLSearchParams(params); p.delete("demo"); setParams(p, { replace: true }); }} />
        )}
        <div className="pointer-events-auto w-full max-w-5xl">
          <LayerRibbon />
        </div>
      </div>
      {!demo && (
        <button className="btn btn-primary absolute bottom-24 left-1/2 z-10 hidden -translate-x-1/2 sm:inline-flex" onClick={() => setParams({ demo: "1" })} data-testid="watch-demo">
          ▶ Watch guided demo
        </button>
      )}
    </div>
  );
}
