import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useAssets, useWorkOrders } from "../api/queries";
import type { Asset, WorkOrderSummary } from "../api/types";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { ASSET_LAYOUT, WO_COLOR, explodeOffset, floorY } from "./constants";

const CLOSED_VISIBLE_MS = 45 * 60 * 1000;

function Pin({ wo, asset }: { wo: WorkOrderSummary; asset: Asset }) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const scale = useRef(0);
  const layout = ASSET_LAYOUT[asset.asset_type] ?? ASSET_LAYOUT.PUMP;
  const target = useMemo(() => new THREE.Color(WO_COLOR[wo.status] ?? "#8aa4b8"), [wo.status]);
  const closed = wo.status === "CLOSED";
  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const ui = useUi.getState();
    const y = floorY(asset.floor_level) + explodeOffset(asset.floor_level, ui.explode) + asset.position.y * 0 + layout.pinY + 0.6;
    const bob = ui.reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 2 + wo.id) * 0.12;
    g.position.set(asset.position.x, y + bob, asset.position.z);
    const closedAgo = closed && wo.closed_at ? simNowMs() - Date.parse(wo.closed_at.endsWith("Z") ? wo.closed_at : wo.closed_at + "Z") : 0;
    const goal = closed ? Math.max(0, 1 - closedAgo / CLOSED_VISIBLE_MS) * 0.7 : 1;
    scale.current = THREE.MathUtils.damp(scale.current, goal, 5, delta);
    g.scale.setScalar(Math.max(0.0001, scale.current));
    g.visible = scale.current > 0.02 && ui.showPins;
    if (mat.current) {
      mat.current.color.lerp(target, 1 - Math.exp(-delta * 6));
      mat.current.emissive.copy(mat.current.color);
    }
    g.rotation.y += delta * 0.8;
  });
  return (
    <group ref={group}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <sphereGeometry args={[0.32, 20, 14]} />
        <meshStandardMaterial ref={mat} color="#8aa4b8" emissive="#8aa4b8" emissiveIntensity={0.9} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.0, 0]} rotation-x={Math.PI}>
        <coneGeometry args={[0.22, 0.55, 14]} />
        <meshStandardMaterial color={target} emissive={target} emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <torusGeometry args={[0.2, 0.035, 8, 20]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <Html position={[0, 1.15, 0]} center distanceFactor={18} zIndexRange={[21, 0]} style={{ pointerEvents: "none" }}>
        <div className="wo-pin-chip" style={{ borderColor: WO_COLOR[wo.status] }} data-testid={`pin-${wo.number}`} data-status={wo.status}>
          <b>{wo.number}</b> {wo.status.replace("_", " ")}
        </div>
      </Html>
    </group>
  );
}

/** Work-order pins floating above assets; colour/state follow the live work-order status. */
export function WorkOrderPins() {
  const { data: wos } = useWorkOrders();
  const { data: assets } = useAssets();
  const assetMap = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  const pins = useMemo(() => {
    const byAsset = new Map<string, WorkOrderSummary>();
    for (const w of [...(wos?.items ?? [])].sort((a, b) => a.id - b.id)) {
      if (["REJECTED", "CANCELLED"].includes(w.status)) continue;
      byAsset.set(w.asset_id, w);
    }
    return [...byAsset.values()];
  }, [wos]);
  return (
    <group>
      {pins.map((w) => {
        const a = assetMap.get(w.asset_id);
        return a ? <Pin key={w.asset_id} wo={w} asset={a} /> : null;
      })}
    </group>
  );
}
