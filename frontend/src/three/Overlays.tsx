import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useAssets } from "../api/queries";
import type { Asset, Health } from "../api/types";
import { useLive } from "../store/live";
import { useUi } from "../store/ui";
import { BUILD_D, BUILD_W, LEVELS, explodeOffset, floorY } from "./constants";

const RANK: Record<Health, number> = { NORMAL: 0, CLEARED: 0, WATCH: 1, ANOMALY: 2 };
const HEAT_RGB: Record<number, string> = { 0: "47,224,160", 1: "255,176,32", 2: "255,77,79" };

function useFloorHealth() {
  const { data: assets } = useAssets();
  const health = useLive((s) => s.health);
  return useMemo(() => {
    const out = new Map<number, { worst: number; anomalies: number; watches: number; assets: Asset[] }>();
    for (const a of assets ?? []) {
      const h = health[a.id] ?? a.health_state;
      const e = out.get(a.floor_level) ?? { worst: 0, anomalies: 0, watches: 0, assets: [] };
      e.assets.push(a);
      e.worst = Math.max(e.worst, RANK[h]);
      if (h === "ANOMALY") e.anomalies++;
      if (h === "WATCH") e.watches++;
      out.set(a.floor_level, e);
    }
    return out;
  }, [assets, health]);
}

/** Condition heat overlay: a translucent gradient on each floor slab, hot where assets are alarmed. */
export function HeatOverlay() {
  const on = useUi((s) => s.heat);
  const floors = useFloorHealth();
  const health = useLive((s) => s.health);
  const textures = useRef(new Map<number, THREE.CanvasTexture>());
  const meshes = useRef(new Map<number, THREE.Mesh>());

  useEffect(() => {
    for (const [level, f] of floors) {
      let tex = textures.current.get(level);
      if (!tex) {
        const c = document.createElement("canvas");
        c.width = 256;
        c.height = 154;
        tex = new THREE.CanvasTexture(c);
        textures.current.set(level, tex);
      }
      const g = (tex.image as HTMLCanvasElement).getContext("2d")!;
      g.clearRect(0, 0, 256, 154);
      for (const a of f.assets) {
        const h = health[a.id] ?? a.health_state;
        const px = ((a.position.x + BUILD_W / 2) / BUILD_W) * 256;
        const pz = ((a.position.z + BUILD_D / 2) / BUILD_D) * 154;
        const rgb = HEAT_RGB[RANK[h]];
        const grad = g.createRadialGradient(px, pz, 2, px, pz, RANK[h] === 0 ? 34 : 70);
        grad.addColorStop(0, `rgba(${rgb},${RANK[h] === 0 ? 0.35 : 0.85})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 154);
      }
      tex.needsUpdate = true;
      const m = meshes.current.get(level);
      if (m) (m.material as THREE.MeshBasicMaterial).map = tex;
    }
  }, [floors, health]);

  useFrame(() => {
    const ex = useUi.getState().explode;
    for (const [level, m] of meshes.current) m.position.y = floorY(level) + explodeOffset(level, ex) + 0.05;
  });

  if (!on) return null;
  return (
    <group>
      {LEVELS.filter((l) => floors.has(l)).map((level) => (
        <mesh key={level} ref={(m) => { if (m) meshes.current.set(level, m); }} rotation-x={-Math.PI / 2} position={[0, floorY(level) + 0.05, 0]} renderOrder={4}>
          <planeGeometry args={[BUILD_W, BUILD_D]} />
          <meshBasicMaterial transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} map={textures.current.get(level) ?? null} />
        </mesh>
      ))}
    </group>
  );
}

/** Per-floor alarm badges at the front-left corner of every floor with an active alarm. */
export function FloorBadges() {
  const floors = useFloorHealth();
  const ex = useUi((s) => s.explode);
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const e = useUi.getState().explode;
    group.current?.children.forEach((c) => {
      const lvl = c.userData.level as number;
      c.position.y = floorY(lvl) + explodeOffset(lvl, e) + 2.2;
    });
  });
  void ex;
  return (
    <group ref={group}>
      {[...floors.entries()]
        .filter(([, f]) => f.anomalies + f.watches > 0)
        .map(([level, f]) => (
          <group key={level} userData={{ level }} position={[-BUILD_W / 2 - 1.2, floorY(level) + 2.2, BUILD_D / 2 + 1.2]}>
            <Html center zIndexRange={[22, 0]} style={{ pointerEvents: "none" }}>
              <div className={`floor-badge ${f.anomalies ? "bad" : "warn"}`} data-testid={`floor-badge-${level}`}>
                {level === 6 ? "Roof" : level === -1 ? "B1" : level === 0 ? "G" : `F${level}`} · {f.anomalies ? `${f.anomalies} anomaly` : `${f.watches} watch`}
              </div>
            </Html>
          </group>
        ))}
    </group>
  );
}
