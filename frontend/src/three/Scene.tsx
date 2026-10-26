import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import { useAssets } from "../api/queries";
import type { Asset } from "../api/types";
import { useUi, type Quality } from "../store/ui";
import { Building } from "./Building";
import { CameraRig } from "./CameraRig";
import { DuctRiser, FcuBranch, PipeNetwork, RoofCollector } from "./Equipment/Distribution";
import { ExhaustFan, SupplyFan } from "./Equipment/FanModels";
import { Chiller, FanCoilUnit, Pump } from "./Equipment/PlantModels";
import { LiftShaft } from "./LiftShaft";
import { FloorBadges, HeatOverlay } from "./Overlays";
import { City } from "./City";
import { Ground, QUALITY, SkyAndLight } from "./SceneEnvironment";
import { Employees } from "./People";
import { Technicians } from "./Technicians";
import { WorkOrderPins } from "./WorkOrderPins";

function AssetModel({ asset }: { asset: Asset }) {
  switch (asset.asset_type) {
    case "SUPPLY_FAN": return <SupplyFan asset={asset} />;
    case "EXHAUST_FAN": return <ExhaustFan asset={asset} />;
    case "CHILLER": return <Chiller asset={asset} />;
    case "PUMP": return <Pump asset={asset} />;
    case "FCU": return <FanCoilUnit asset={asset} />;
    default: return null;
  }
}

/** Distribution (ducts/pipes) is drawn in world space, so it hides while the building is exploded. */
function StaticPlant() {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const ui = useUi.getState();
    if (g.current) g.current.visible = ui.explode < 0.02 && ui.cutaway === null;
  });
  return (
    <group ref={g}>
      <DuctRiser />
      <PipeNetwork />
      <FcuBranch />
      <RoofCollector />
    </group>
  );
}

const ORDER: Quality[] = ["low", "medium", "high"];

/** Measures FPS and (optionally) steps the quality down when the machine cannot keep up.
 *  Ignores the first 12 s (shader compilation, first data load) and only reacts to 5 consecutive
 *  seconds under 30 fps, so a momentary hitch never triggers a canvas rebuild. */
function FpsMonitor() {
  const frames = useRef(0);
  const last = useRef(performance.now());
  const slow = useRef(0);
  const warm = useRef(0);
  useFrame(() => {
    frames.current++;
    const now = performance.now();
    if (now - last.current >= 1000) {
      const fps = Math.round((frames.current * 1000) / (now - last.current));
      frames.current = 0;
      last.current = now;
      if (document.hidden) return;
      const ui = useUi.getState();
      ui.set({ fps });
      warm.current++;
      if (ui.autoQuality && warm.current > 12) {
        slow.current = fps < 30 ? slow.current + 1 : 0;
        if (slow.current >= 5 && ui.quality !== "low") {
          ui.setQuality(ORDER[Math.max(0, ORDER.indexOf(ui.quality) - 1)]);
          slow.current = 0;
          warm.current = 0;
        }
      }
    }
  });
  return null;
}

function Content({ orbit, interactive }: { orbit: boolean; interactive: boolean }) {
  const quality = useUi((s) => s.quality);
  const q = QUALITY[quality];
  const { data: assets } = useAssets();
  const byLevel = useMemo(() => {
    const m = new Map<number, Asset[]>();
    for (const a of assets ?? []) m.set(a.floor_level, [...(m.get(a.floor_level) ?? []), a]);
    return m;
  }, [assets]);
  return (
    <>
      <SkyAndLight />
      <Ground />
      <City />
      <Building renderLevel={(level) => (byLevel.get(level) ?? []).map((a) => <AssetModel key={a.id} asset={a} />)} />
      <StaticPlant />
      <LiftShaft />
      <HeatOverlay />
      <FloorBadges />
      <WorkOrderPins />
      <Technicians />
      <Employees />
      <CameraRig orbit={orbit} />
      {interactive && <FpsMonitor />}
      {q.bloom && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={0.45} luminanceThreshold={0.85} luminanceSmoothing={0.2} mipmapBlur />
        </EffectComposer>
      )}
    </>
  );
}

/** The 3D digital twin of Tower A. `orbit` auto-rotates (landing page); `interactive` enables the FPS monitor. */
export default function TwinScene({ orbit = false, interactive = true }: { orbit?: boolean; interactive?: boolean }) {
  const quality = useUi((s) => s.quality);
  const q = QUALITY[quality];
  const dpr = Math.min(q.dpr, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  useEffect(() => {
    document.body.dataset.quality = quality;
  }, [quality]);
  return (
    <Canvas
      key={quality === "low" ? "low" : "std"}
      shadows={q.shadow > 0}
      dpr={dpr}
      camera={{ position: [78, 52, 92], fov: 42, near: 0.5, far: 1200 }}
      gl={{ antialias: quality === "high", powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      onPointerMissed={() => useUi.getState().selectAsset(null, false)}
      data-testid="twin-canvas"
    >
      <Suspense fallback={null}>
        <Content orbit={orbit} interactive={interactive} />
      </Suspense>
    </Canvas>
  );
}
