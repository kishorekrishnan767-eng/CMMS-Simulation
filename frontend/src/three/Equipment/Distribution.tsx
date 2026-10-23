import { useMemo } from "react";
import * as THREE from "three";
import { FLOOR_H, RISER, floorY } from "../constants";
import { mat } from "./common";

/** Straight pipe between two points (cylinder oriented along the segment). */
export function Pipe({ from, to, radius = 0.12, material }: { from: [number, number, number]; to: [number, number, number]; radius?: number; material: THREE.Material }) {
  const { pos, quat, len } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return { pos: a.clone().add(b).multiplyScalar(0.5), quat, len };
  }, [from, to]);
  return (
    <mesh position={pos} quaternion={quat} material={material} castShadow>
      <cylinderGeometry args={[radius, radius, len, 10]} />
    </mesh>
  );
}

/** Vertical riser for supply air, running from the basement to the roof, plus per-floor branch ducts. */
export function DuctRiser() {
  const levels = [0, 1, 2, 3, 4, 5];
  return (
    <group>
      <mesh position={[RISER.x, (floorY(-1) + floorY(6)) / 2 + 0.2, RISER.z]} material={mat.housing}>
        <boxGeometry args={[1.6, floorY(6) - floorY(-1), 1.6]} />
      </mesh>
      {levels.map((l) => (
        <group key={l} position={[0, floorY(l) + FLOOR_H - 1.1, RISER.z + 0.1]}>
          <mesh material={mat.steelDark}>
            <boxGeometry args={[34, 0.5, 0.9]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Roof-level collector duct that links the three AHUs to the riser. */
export function RoofCollector() {
  const y = floorY(6);
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, 1.15, -8.0]} material={mat.housing} castShadow>
        <boxGeometry args={[23, 1.1, 1.4]} />
      </mesh>
      {[-10, 0, 10].map((x) => (
        <mesh key={x} position={[x, 1.15, -5.9]} material={mat.housing} castShadow>
          <boxGeometry args={[1.8, 1.1, 3.0]} />
        </mesh>
      ))}
      <mesh position={[RISER.x, 0.9, RISER.z]} material={mat.steelDark}>
        <boxGeometry args={[1.9, 1.8, 1.9]} />
      </mesh>
    </group>
  );
}

/** Chilled-water loop: supply (blue) and return (red) from the chiller and pumps up to the roof coils. */
export function PipeNetwork() {
  const roof = floorY(6) + 1.1;
  const b = floorY(-1);
  const xc = -17.2; // hot riser
  const xb = -16.6; // cold riser
  const zr = -10.4;
  return (
    <group>
      {/* chiller connections (cold top, hot bottom) to the risers */}
      <Pipe from={[-11.4, b + 3.5, 0.75]} to={[xb, b + 3.5, 0.75]} material={mat.cold} />
      <Pipe from={[xb, b + 3.5, 0.75]} to={[xb, b + 3.5, zr]} material={mat.cold} />
      <Pipe from={[-11.4, b + 3.0, -0.85]} to={[xc, b + 3.0, -0.85]} material={mat.hot} />
      <Pipe from={[xc, b + 3.0, -0.85]} to={[xc, b + 3.0, zr]} material={mat.hot} />
      {/* pump header feeding the cold main */}
      <Pipe from={[4.85, b + 2.0, -3]} to={[4.85, b + 2.9, -3]} material={mat.cold} />
      <Pipe from={[4.85, b + 2.0, 3]} to={[4.85, b + 2.9, 3]} material={mat.cold} />
      <Pipe from={[4.85, b + 2.9, -3]} to={[4.85, b + 2.9, 3]} material={mat.cold} />
      <Pipe from={[4.85, b + 2.9, 0]} to={[-5.0, b + 2.9, 0]} material={mat.cold} />
      <Pipe from={[-5.0, b + 2.9, 0]} to={[-5.0, b + 3.5, 0.75]} material={mat.cold} />
      {/* risers to the roof */}
      <Pipe from={[xc, b + 3.0, zr]} to={[xc, roof, zr]} radius={0.16} material={mat.hot} />
      <Pipe from={[xb, b + 3.5, zr]} to={[xb, roof + 0.5, zr]} radius={0.16} material={mat.cold} />
      {/* roof distribution to the AHU coils */}
      <Pipe from={[xc, roof, zr]} to={[11.5, roof, zr]} material={mat.hot} />
      <Pipe from={[xb, roof + 0.5, zr]} to={[11.5, roof + 0.5, zr]} material={mat.cold} />
    </group>
  );
}

/** Floor-3 branch from the riser to the fan-coil unit. */
export function FcuBranch() {
  const y = floorY(3) + FLOOR_H - 1.0;
  return (
    <group>
      <mesh position={[4, y, -2.4]} material={mat.steelDark}>
        <boxGeometry args={[8.2, 0.34, 0.5]} />
      </mesh>
      <mesh position={[8, y, 1.4]} material={mat.steelDark}>
        <boxGeometry args={[0.5, 0.34, 7.4]} />
      </mesh>
    </group>
  );
}

