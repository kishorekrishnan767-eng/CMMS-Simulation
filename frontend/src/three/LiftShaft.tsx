import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useUi } from "../store/ui";
import { LIFT, ROOF_LEVEL, floorY } from "./constants";
import { liftRiders } from "./Technicians";

const BOTTOM = floorY(-1);
const TOP = floorY(ROOF_LEVEL) + 3.2;
const H = TOP - BOTTOM;

/**
 * Glass lift in the front light-well. The cab follows whichever technician is riding (the rider's
 * height comes from their path pose), otherwise it waits where it last stopped. World space, so it is
 * hidden in the exploded view where floors no longer line up with the shaft.
 */
export function LiftShaft() {
  const group = useRef<THREE.Group>(null);
  const cab = useRef<THREE.Group>(null);
  const parked = useRef(floorY(0));
  const m = useMemo(() => ({
    post: new THREE.MeshStandardMaterial({ color: "#3a4148", metalness: 0.6, roughness: 0.4 }),
    glass: new THREE.MeshStandardMaterial({ color: "#c4d4e0", roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.16, depthWrite: false }),
    cab: new THREE.MeshStandardMaterial({ color: "#d9dde1", metalness: 0.5, roughness: 0.35 }),
    floor: new THREE.MeshStandardMaterial({ color: "#4a525a", roughness: 0.7 }),
  }), []);
  const w = LIFT.w;

  useFrame((_, delta) => {
    const ui = useUi.getState();
    if (group.current) group.current.visible = ui.explode < 0.02;
    let y: number | null = null;
    for (const v of liftRiders.values()) {
      y = v;
      break;
    }
    if (y !== null) parked.current = y;
    if (cab.current) cab.current.position.y = THREE.MathUtils.damp(cab.current.position.y, parked.current, y !== null ? 30 : 4, Math.min(delta, 0.05));
  });

  const posts: [number, number][] = [[-w / 2, -w / 2], [w / 2, -w / 2], [-w / 2, w / 2], [w / 2, w / 2]];
  return (
    <group ref={group} position={[LIFT.x, 0, LIFT.z]}>
      {posts.map(([x, z], i) => (
        <mesh key={i} position={[x, BOTTOM + H / 2, z]} material={m.post} castShadow>
          <boxGeometry args={[0.1, H, 0.1]} />
        </mesh>
      ))}
      {/* glass on the three outward faces; the face towards the building is the landing side */}
      <mesh position={[0, BOTTOM + H / 2, w / 2]} material={m.glass} renderOrder={5}>
        <boxGeometry args={[w, H, 0.03]} />
      </mesh>
      {[-w / 2, w / 2].map((x) => (
        <mesh key={x} position={[x, BOTTOM + H / 2, 0]} material={m.glass} renderOrder={5}>
          <boxGeometry args={[0.03, H, w]} />
        </mesh>
      ))}
      {/* landing sills at each floor */}
      {Array.from({ length: ROOF_LEVEL + 2 }, (_, i) => i - 1).map((l) => (
        <mesh key={l} position={[0, floorY(l) - 0.05, -w / 2 - 0.35]} material={m.floor}>
          <boxGeometry args={[w, 0.1, 0.7]} />
        </mesh>
      ))}
      <mesh position={[0, TOP + 0.25, 0]} material={m.post}>
        <boxGeometry args={[w + 0.3, 0.5, w + 0.3]} />
      </mesh>
      <group ref={cab} position={[0, parked.current, 0]}>
        <mesh position={[0, 0.04, 0]} material={m.floor} receiveShadow>
          <boxGeometry args={[w - 0.16, 0.08, w - 0.16]} />
        </mesh>
        <mesh position={[0, 2.35, 0]} material={m.cab}>
          <boxGeometry args={[w - 0.16, 0.1, w - 0.16]} />
        </mesh>
        <mesh position={[0, 1.2, (w - 0.2) / 2]} material={m.cab}>
          <boxGeometry args={[w - 0.16, 2.3, 0.04]} />
        </mesh>
        {[-(w - 0.2) / 2, (w - 0.2) / 2].map((x) => (
          <mesh key={x} position={[x, 1.0, 0]} material={m.cab}>
            <boxGeometry args={[0.04, 0.06, w - 0.2]} />
          </mesh>
        ))}
        <mesh position={[0, 2.29, 0]} rotation-x={Math.PI / 2}>
          <planeGeometry args={[w * 0.5, w * 0.5]} />
          <meshBasicMaterial color="#fff6e4" side={THREE.DoubleSide} />
        </mesh>
      </group>
      <mesh position={[0, BOTTOM + 0.02, 0]} material={m.floor}>
        <boxGeometry args={[w, 0.04, w]} />
      </mesh>
    </group>
  );
}
