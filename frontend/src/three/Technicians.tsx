import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useAssets, useTechnicians, useWorkOrders } from "../api/queries";
import type { Asset, Technician, WorkOrderSummary } from "../api/types";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { explodeOffset, floorY } from "./constants";
import { techPose, type Pose } from "./techPath";

/** World positions of technicians, refreshed every frame (used by the follow camera). */
export const techWorld = new Map<string, THREE.Vector3>();

const SKIN = "#e0b090";

function Avatar({ tech, wo, asset }: { tech: Technician; wo: WorkOrderSummary | null; asset: Asset | null }) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const label = useRef<HTMLDivElement>(null);
  const yaw = useRef(0);
  const pose = useRef<Pose | null>(null);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const visible = useUi((s) => s.showTechnicians);
  const colorHex = tech.color;

  useFrame((state, delta) => {
    const g = root.current;
    if (!g) return;
    const ui = useUi.getState();
    const p = techPose(tech, wo, asset, simNowMs());
    pose.current = p;
    const y = floorY(p.level) + explodeOffset(p.level, ui.explode);
    g.position.set(p.x, y, p.z);
    pos.set(p.x, y + 1, p.z);
    techWorld.set(tech.id, pos.clone());
    // face the walking direction (shortest-arc smoothing)
    let d = p.yaw - yaw.current;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw.current += d * Math.min(1, delta * 8);
    const facing = p.phase === "working" && asset ? Math.atan2(asset.position.x - p.x, asset.position.z - p.z) : yaw.current;
    g.rotation.y = facing;
    g.visible = visible && !p.inLift;

    const t = state.clock.elapsedTime;
    const walk = p.phase === "walking" || p.phase === "returning";
    const swing = walk ? Math.sin(p.distance * 2.4) * 0.7 : 0;
    if (legL.current && legR.current && armL.current && armR.current && body.current) {
      legL.current.rotation.x = swing;
      legR.current.rotation.x = -swing;
      armL.current.rotation.x = -swing * 0.8;
      armR.current.rotation.x = swing * 0.8;
      body.current.position.y = walk ? Math.abs(Math.sin(p.distance * 2.4)) * 0.05 : Math.sin(t * 1.4) * 0.008;
      body.current.rotation.x = p.phase === "working" ? 0.35 : 0;
      if (p.phase === "working") {
        armR.current.rotation.x = -1.2 + Math.sin(t * 7) * 0.5;
        armL.current.rotation.x = -0.9 + Math.sin(t * 7 + 1.2) * 0.35;
      }
    }
    if (label.current) {
      const text = p.phase === "walking" ? `walking to ${p.assetId}` : p.phase === "working" ? `repairing ${p.assetId}` : p.phase === "returning" ? "returning" : "standing by";
      if (label.current.dataset.text !== text) {
        label.current.dataset.text = text;
        label.current.textContent = `${tech.name.split(" ")[0]} · ${text}`;
      }
      label.current.dataset.phase = p.phase;
    }
  });

  return (
    <group ref={root}>
      <group ref={body}>
        <mesh position={[0, 1.0, 0]} castShadow>
          <capsuleGeometry args={[0.2, 0.42, 4, 10]} />
          <meshStandardMaterial color={colorHex} roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.9, 0.0]}>
          <boxGeometry args={[0.42, 0.06, 0.3]} />
          <meshStandardMaterial color="#1c2a33" />
        </mesh>
        <mesh position={[0, 1.55, 0]} castShadow>
          <sphereGeometry args={[0.15, 14, 12]} />
          <meshStandardMaterial color={SKIN} roughness={0.8} />
        </mesh>
        {/* hard hat */}
        <mesh position={[0, 1.63, 0]} castShadow>
          <sphereGeometry args={[0.17, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#ffd23f" roughness={0.45} />
        </mesh>
        <mesh position={[0, 1.62, 0.1]}>
          <boxGeometry args={[0.3, 0.025, 0.18]} />
          <meshStandardMaterial color="#ffd23f" roughness={0.45} />
        </mesh>
        <group ref={armL} position={[-0.27, 1.25, 0]}>
          <mesh position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.055, 0.34, 3, 8]} />
            <meshStandardMaterial color={colorHex} />
          </mesh>
        </group>
        <group ref={armR} position={[0.27, 1.25, 0]}>
          <mesh position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.055, 0.34, 3, 8]} />
            <meshStandardMaterial color={colorHex} />
          </mesh>
          <mesh position={[0, -0.5, 0.05]} rotation-x={0.4}>
            <boxGeometry args={[0.04, 0.04, 0.26]} />
            <meshStandardMaterial color="#9aa8b1" metalness={0.8} roughness={0.3} />
          </mesh>
        </group>
      </group>
      <group ref={legL} position={[-0.1, 0.72, 0]}>
        <mesh position={[0, -0.34, 0]} castShadow>
          <capsuleGeometry args={[0.075, 0.5, 3, 8]} />
          <meshStandardMaterial color="#2b3a46" />
        </mesh>
      </group>
      <group ref={legR} position={[0.1, 0.72, 0]}>
        <mesh position={[0, -0.34, 0]} castShadow>
          <capsuleGeometry args={[0.075, 0.5, 3, 8]} />
          <meshStandardMaterial color="#2b3a46" />
        </mesh>
      </group>
      <Html position={[0, 2.25, 0]} center distanceFactor={22} zIndexRange={[18, 0]} style={{ pointerEvents: "none" }}>
        <div className="tech-tag" style={{ borderColor: colorHex }} data-testid={`tech-${tech.id}`}>
          <div ref={label} className="tech-tag-text" data-phase="idle" />
        </div>
      </Html>
    </group>
  );
}

/** Technician avatars: pose is derived from work-order timestamps and the sim clock, so walking
 *  speeds up, slows down and pauses exactly with the simulation. */
export function Technicians() {
  const { data: techs } = useTechnicians();
  const { data: wos } = useWorkOrders();
  const { data: assets } = useAssets();
  const byTech = useMemo(() => {
    const m = new Map<string, WorkOrderSummary>();
    for (const w of [...(wos?.items ?? [])].sort((a, b) => a.id - b.id)) if (w.assigned_technician) m.set(w.assigned_technician.id, w);
    return m;
  }, [wos]);
  const assetMap = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  return (
    <group>
      {(techs ?? []).map((t) => {
        const wo = byTech.get(t.id) ?? null;
        return <Avatar key={t.id} tech={t} wo={wo} asset={wo ? assetMap.get(wo.asset_id) ?? null : null} />;
      })}
    </group>
  );
}
