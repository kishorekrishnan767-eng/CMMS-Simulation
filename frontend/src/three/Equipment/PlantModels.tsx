import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Asset } from "../../api/types";
import { AssetFrame, BearingHotspot, StatusBar, mat, useVisual } from "./common";

/** Rotating coupling disc that also jitters with vibration. */
function Coupling({ position, radius = 0.32, length = 0.22, axis = "x" }: { position: [number, number, number]; radius?: number; length?: number; axis?: "x" | "z" }) {
  const v = useVisual();
  const g = useRef<THREE.Group>(null);
  const disc = useRef<THREE.Mesh>(null);
  const bar = useRef<THREE.Mesh>(null);
  useFrame((state, delta) => {
    const d = v.current.omega * delta * 0.8;
    if (disc.current) disc.current.rotation.y += d;
    if (bar.current) bar.current.rotation.y += d;
    if (g.current) {
      const a = v.current.wobble * 0.6;
      const t = state.clock.elapsedTime;
      g.current.position.set(position[0] + Math.sin(t * 59) * a, position[1] + Math.sin(t * 44) * a * 0.6, position[2] + Math.cos(t * 49) * a);
    }
  });
  return (
    <group ref={g} position={position} rotation-z={axis === "x" ? Math.PI / 2 : 0} rotation-x={axis === "z" ? Math.PI / 2 : 0}>
      <mesh ref={disc}>
        <cylinderGeometry args={[radius, radius, length, 18]} />
        <meshStandardMaterial color="#e1b84a" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* a keyed bar so the rotation is visible */}
      <mesh ref={bar}>
        <boxGeometry args={[radius * 1.9, length + 0.04, 0.07]} />
        <meshStandardMaterial color="#1b252c" />
      </mesh>
    </group>
  );
}

const CHILLER_SENSORS: [number, number, number][] = [[-3.2, 1.3, 1.1], [3.0, 1.3, 1.1], [3.7, 1.0, 0.0], [-3.7, 0.6, -0.6]];

export function Chiller({ asset }: { asset: Asset }) {
  return (
    <AssetFrame asset={asset} radius={4.4} sensors={CHILLER_SENSORS}>
      <mesh position={[0, 0.2, 0]} material={mat.plinth} receiveShadow castShadow>
        <boxGeometry args={[8.2, 0.4, 3.4]} />
      </mesh>
      {/* evaporator and condenser shells */}
      <mesh position={[-0.4, 1.35, 0.75]} rotation-z={Math.PI / 2} material={mat.steel} castShadow>
        <cylinderGeometry args={[0.8, 0.8, 5.8, 32]} />
      </mesh>
      <mesh position={[-0.4, 1.35, -0.85]} rotation-z={Math.PI / 2} material={mat.housing} castShadow>
        <cylinderGeometry args={[0.8, 0.8, 5.8, 32]} />
      </mesh>
      {/* end caps with bolt rings */}
      {[-3.3, 2.5].map((x) =>
        [0.75, -0.85].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 1.35, z]} rotation-z={Math.PI / 2} material={mat.steelDark}>
            <cylinderGeometry args={[0.86, 0.86, 0.16, 24]} />
          </mesh>
        )),
      )}
      {/* compressor / motor train */}
      <mesh position={[3.4, 1.1, 0]} rotation-z={Math.PI / 2} material={mat.motor} castShadow>
        <cylinderGeometry args={[0.7, 0.7, 1.7, 24]} />
      </mesh>
      <Coupling position={[2.45, 1.1, 0]} radius={0.38} />
      <BearingHotspot position={[3.4, 1.9, 0]} radius={0.16} />
      {/* control panel */}
      <mesh position={[-3.6, 1.2, -1.45]} material={mat.steel}>
        <boxGeometry args={[0.9, 1.6, 0.4]} />
      </mesh>
      <mesh position={[-3.6, 1.5, -1.24]}>
        <boxGeometry args={[0.5, 0.35, 0.02]} />
        <meshBasicMaterial color="#7fb2e8" />
      </mesh>
      <StatusBar position={[-0.4, 0.6, 1.72]} size={[6, 0.07, 0.03]} />
      {/* refrigerant pipes: chilled supply (blue) and return (red) */}
      <mesh position={[-3.4, 2.55, 0.75]} material={mat.cold} castShadow>
        <cylinderGeometry args={[0.13, 0.13, 1.6, 12]} />
      </mesh>
      <mesh position={[-3.4, 2.55, -0.85]} material={mat.hot}>
        <cylinderGeometry args={[0.13, 0.13, 1.6, 12]} />
      </mesh>
    </AssetFrame>
  );
}

const PUMP_SENSORS: [number, number, number][] = [[-0.6, 0.95, 0.35], [-0.6, 0.95, -0.35], [0.9, 0.8, 0.4], [0.9, 0.35, 0.4]];

export function Pump({ asset }: { asset: Asset }) {
  return (
    <AssetFrame asset={asset} radius={2.3} sensors={PUMP_SENSORS}>
      <mesh position={[0, 0.1, 0]} material={mat.plinth} receiveShadow>
        <boxGeometry args={[3.2, 0.2, 1.4]} />
      </mesh>
      <mesh position={[-0.9, 0.62, 0]} rotation-z={Math.PI / 2} material={mat.motor} castShadow>
        <cylinderGeometry args={[0.45, 0.45, 1.5, 24]} />
      </mesh>
      <Coupling position={[0.05, 0.62, 0]} radius={0.24} />
      {/* volute casing + suction / discharge */}
      <mesh position={[0.85, 0.62, 0]} material={mat.steel} castShadow>
        <cylinderGeometry args={[0.55, 0.55, 0.55, 28]} />
      </mesh>
      <mesh position={[0.85, 0.62, 0]} rotation-x={Math.PI / 2} material={mat.steelDark}>
        <cylinderGeometry args={[0.56, 0.56, 0.4, 28]} />
      </mesh>
      <mesh position={[0.85, 1.35, 0]} material={mat.hot}>
        <cylinderGeometry args={[0.16, 0.16, 1.3, 12]} />
      </mesh>
      <mesh position={[1.45, 0.62, 0]} rotation-z={Math.PI / 2} material={mat.cold}>
        <cylinderGeometry args={[0.18, 0.18, 0.9, 12]} />
      </mesh>
      <BearingHotspot position={[-0.6, 1.12, 0]} radius={0.1} />
      <StatusBar position={[0, 0.25, 0.72]} size={[2.6, 0.05, 0.03]} />
    </AssetFrame>
  );
}

const FCU_SENSORS: [number, number, number][] = [[-0.5, -0.3, 0.2], [0.5, -0.3, 0.2], [0.85, -0.1, 0], [0.85, -0.25, 0]];

/** Ceiling-hung fan coil unit on floor 3 (origin at floor surface, unit hangs at ceiling level). */
export function FanCoilUnit({ asset }: { asset: Asset }) {
  return (
    <AssetFrame asset={asset} radius={1.6} sensors={FCU_SENSORS.map(([x, y, z]) => [x, y + 3.5, z] as [number, number, number])}>
      <FcuBody />
    </AssetFrame>
  );
}
function FcuBody() {
  const v = useVisual();
  const rotor = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (rotor.current) rotor.current.rotation.y += v.current.omega * delta;
  });
  return (
    <group position={[0, 3.25, 0]}>
      <mesh material={mat.housing} castShadow>
        <boxGeometry args={[1.9, 0.38, 1.0]} />
      </mesh>
      <mesh position={[0, -0.2, 0]} material={mat.steelDark}>
        <boxGeometry args={[1.7, 0.03, 0.8]} />
      </mesh>
      <group ref={rotor} position={[-0.35, -0.22, 0]}>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh key={i} rotation-y={(i / 6) * Math.PI * 2} position={[0.13, 0, 0]}>
            <boxGeometry args={[0.26, 0.012, 0.06]} />
            <meshStandardMaterial color="#8fa0ab" />
          </mesh>
        ))}
      </group>
      <StatusBar position={[0, -0.12, 0.51]} size={[1.5, 0.04, 0.02]} />
      {/* hangers */}
      {[-0.8, 0.8].map((x) => (
        <mesh key={x} position={[x, 0.3, 0]} material={mat.steelDark}>
          <cylinderGeometry args={[0.02, 0.02, 0.25, 6]} />
        </mesh>
      ))}
      <BearingHotspot position={[-0.35, -0.05, 0]} radius={0.05} />
    </group>
  );
}
