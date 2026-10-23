import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Asset } from "../../api/types";
import { AssetFrame, BearingHotspot, StatusBar, mat, useVisual } from "./common";

/** Rotating axial rotor: hub + blades. Angular velocity follows the VFD speed; wobble follows vibration. */
function Rotor({ radius, blades, hubRadius = 0.28, wobbleScale = 1 }: { radius: number; blades: number; hubRadius?: number; wobbleScale?: number }) {
  const v = useVisual();
  const spin = useRef<THREE.Group>(null);
  const shake = useRef<THREE.Group>(null);
  const bladeGeo = useMemo(() => new THREE.BoxGeometry(radius * 0.86, 0.045, radius * 0.3), [radius]);
  useFrame((state, delta) => {
    if (spin.current) spin.current.rotation.y += v.current.omega * delta;
    if (shake.current) {
      const a = v.current.wobble * wobbleScale;
      const t = state.clock.elapsedTime;
      shake.current.position.set(Math.sin(t * 61) * a, Math.sin(t * 47 + 1.3) * a * 0.5, Math.cos(t * 53 + 0.4) * a);
      shake.current.rotation.set(Math.sin(t * 43) * a * 0.6, 0, Math.cos(t * 39 + 2) * a * 0.6);
    }
  });
  return (
    <group ref={shake}>
      <group ref={spin}>
        <mesh material={mat.steelDark}>
          <cylinderGeometry args={[hubRadius, hubRadius, 0.26, 20]} />
        </mesh>
        {Array.from({ length: blades }, (_, i) => (
          <group key={i} rotation-y={(i / blades) * Math.PI * 2}>
            <mesh geometry={bladeGeo} material={mat.blade} position={[radius * 0.5 + hubRadius * 0.4, 0, 0]} rotation-x={0.32} />
          </group>
        ))}
      </group>
    </group>
  );
}

function GuardGrille({ radius }: { radius: number }) {
  return (
    <group>
      <mesh rotation-x={Math.PI / 2}>
        <torusGeometry args={[radius, 0.04, 8, 40]} />
        <meshStandardMaterial color="#c3ced6" metalness={0.7} roughness={0.35} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} scale={0.55}>
        <torusGeometry args={[radius, 0.025, 6, 32]} />
        <meshStandardMaterial color="#c3ced6" metalness={0.7} roughness={0.35} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} rotation-y={(i * Math.PI) / 4}>
          <boxGeometry args={[radius * 2, 0.025, 0.03]} />
          <meshStandardMaterial color="#c3ced6" metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

const SUPPLY_SENSORS: [number, number, number][] = [
  [-0.6, 2.95, 0.55], // vibration — at the fan bearing
  [-0.6, 3.15, -0.5], // bearing temperature
  [2.55, 1.6, 1.0], // motor current — at the starter / VFD cabinet
  [2.55, 0.9, 1.0], // speed command
];

/** Roof air-handling unit with a rotating supply fan (the golden-scenario asset type). */
export function SupplyFan({ asset }: { asset: Asset }) {
  return (
    <AssetFrame asset={asset} radius={3.4} sensors={SUPPLY_SENSORS}>
      <SupplyFanBody />
    </AssetFrame>
  );
}

function SupplyFanBody() {
  const v = useVisual();
  const housing = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!housing.current) return;
    const a = v.current.wobble * 0.18;
    const t = state.clock.elapsedTime;
    housing.current.position.set(Math.sin(t * 57) * a, 0, Math.cos(t * 51) * a);
  });
  return (
    <group>
      <mesh position={[0, 0.12, 0]} material={mat.plinth} receiveShadow castShadow>
        <boxGeometry args={[5.3, 0.24, 3.3]} />
      </mesh>
      <group ref={housing}>
        <mesh position={[0, 1.3, 0]} material={mat.housing} castShadow receiveShadow>
          <boxGeometry args={[4.9, 2.1, 2.9]} />
        </mesh>
        {/* louvres on the intake face */}
        {Array.from({ length: 9 }, (_, i) => (
          <mesh key={i} position={[-0.9, 0.55 + i * 0.19, 1.47]} rotation-x={-0.35} material={mat.steelDark}>
            <boxGeometry args={[2.6, 0.06, 0.12]} />
          </mesh>
        ))}
        {/* access doors and handles */}
        <mesh position={[1.45, 1.2, 1.46]} material={mat.steel}>
          <boxGeometry args={[1.4, 1.5, 0.05]} />
        </mesh>
        <mesh position={[0.86, 1.2, 1.5]} material={mat.rubber}>
          <boxGeometry args={[0.05, 0.4, 0.06]} />
        </mesh>
        <StatusBar position={[0, 0.5, 1.47]} size={[4.6, 0.07, 0.03]} />
        {/* electrical / VFD cabinet */}
        <mesh position={[2.72, 1.2, 1.0]} material={mat.steel}>
          <boxGeometry args={[0.38, 1.5, 0.9]} />
        </mesh>
        <mesh position={[2.92, 1.5, 1.0]}>
          <boxGeometry args={[0.02, 0.18, 0.5]} />
          <meshBasicMaterial color="#1fd1b6" />
        </mesh>
        {/* fan stack on top */}
        <mesh position={[-0.6, 2.7, 0]} material={mat.steel} castShadow>
          <cylinderGeometry args={[1.28, 1.34, 0.7, 36, 1, true]} />
        </mesh>
        <mesh position={[-0.6, 2.36, 0]} material={mat.steelDark}>
          <cylinderGeometry args={[1.3, 1.3, 0.04, 36]} />
        </mesh>
        <group position={[-0.6, 2.75, 0]}>
          <Rotor radius={1.15} blades={7} />
          <BearingHotspot position={[0, 0.2, 0]} radius={0.19} />
        </group>
        <group position={[-0.6, 3.1, 0]}>
          <GuardGrille radius={1.3} />
        </group>
        {/* discharge duct towards the roof collector */}
        <mesh position={[0, 1.15, -2.2]} material={mat.housing} castShadow>
          <boxGeometry args={[1.8, 1.5, 1.6]} />
        </mesh>
      </group>
    </group>
  );
}

const EXH_SENSORS: [number, number, number][] = [[0, 2.05, 0.7], [0.7, 2.05, 0], [1.3, 0.8, 0.4], [1.3, 0.4, 0.4]];

export function ExhaustFan({ asset }: { asset: Asset }) {
  return (
    <AssetFrame asset={asset} radius={2.1} sensors={EXH_SENSORS}>
      <mesh position={[0, 0.12, 0]} material={mat.plinth} receiveShadow>
        <boxGeometry args={[2.8, 0.24, 2.8]} />
      </mesh>
      <mesh position={[0, 0.8, 0]} material={mat.housing} castShadow>
        <cylinderGeometry args={[0.9, 1.05, 1.1, 24]} />
      </mesh>
      <mesh position={[0, 1.55, 0]} material={mat.steel} castShadow>
        <cylinderGeometry args={[1.25, 0.9, 0.5, 28, 1, true]} />
      </mesh>
      <group position={[0, 1.6, 0]}>
        <Rotor radius={0.95} blades={5} hubRadius={0.2} />
        <BearingHotspot position={[0, 0.15, 0]} radius={0.14} />
      </group>
      <group position={[0, 1.95, 0]}>
        <GuardGrille radius={1.2} />
      </group>
      <StatusBar position={[0, 0.45, 1.06]} size={[1.4, 0.06, 0.03]} />
      <mesh position={[1.3, 0.7, 0.4]} material={mat.steel}>
        <boxGeometry args={[0.3, 1.1, 0.5]} />
      </mesh>
    </AssetFrame>
  );
}
