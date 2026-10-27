import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { vehicle } from "./vehicle";

const WHEEL_R = 0.32;

/**
 * Kishore's car. Local +z is forward (the same convention as the heading ψ: forward = (sin ψ, cos ψ)),
 * +x is the driver's left. It always stands where the physics left it, so it stays parked where he gets out.
 * The body leans with the forces on it: pitch = −ax·0.012, roll = ay·0.01 (rad), the front wheels follow
 * the steering angle, all four spin with the distance driven, and the tail lights glow while braking.
 */
export default function PlayerCar() {
  const root = useRef<THREE.Group>(null);
  const tilt = useRef<THREE.Group>(null);
  const steerL = useRef<THREE.Group>(null);
  const steerR = useRef<THREE.Group>(null);
  const spin = useRef<(THREE.Group | null)[]>([]);
  const wheelGeo = useMemo(() => new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.24, 20).rotateZ(Math.PI / 2), []);
  const mats = useMemo(() => ({
    paint: new THREE.MeshStandardMaterial({ color: "#1f4f8a", metalness: 0.55, roughness: 0.28 }),
    glass: new THREE.MeshStandardMaterial({ color: "#16212c", metalness: 0.2, roughness: 0.08 }),
    trim: new THREE.MeshStandardMaterial({ color: "#14171b", roughness: 0.7 }),
    tyre: new THREE.MeshStandardMaterial({ color: "#121416", roughness: 0.9 }),
    rim: new THREE.MeshStandardMaterial({ color: "#c7ccd1", metalness: 0.8, roughness: 0.3 }),
    head: new THREE.MeshBasicMaterial({ color: "#fff4c2", toneMapped: false }),
    tail: new THREE.MeshBasicMaterial({ color: "#7a1c18", toneMapped: false }),
  }), []);
  const shake = useRef(0);

  useFrame((state, delta) => {
    const g = root.current;
    if (!g) return;
    const dt = Math.min(delta, 0.05);
    g.position.set(vehicle.x, 0.03, vehicle.z);
    g.rotation.y = vehicle.yaw;
    shake.current = THREE.MathUtils.damp(shake.current, vehicle.hit, 12, dt);
    if (tilt.current) {
      const k = Math.min(1, dt * 8);
      tilt.current.rotation.x += (THREE.MathUtils.clamp(-vehicle.ax * 0.012, -0.06, 0.06) - tilt.current.rotation.x) * k;
      tilt.current.rotation.z += (THREE.MathUtils.clamp(vehicle.ay * 0.01, -0.09, 0.09) - tilt.current.rotation.z) * k;
      tilt.current.position.y = 0.34 + Math.sin(state.clock.elapsedTime * 46) * 0.01 * shake.current;
    }
    for (const s of [steerL.current, steerR.current]) if (s) s.rotation.y = -vehicle.steer;
    for (const w of spin.current) if (w) w.rotation.x = vehicle.wheel;
    mats.tail.color.set(vehicle.braking ? "#ff3b2f" : "#7a1c18");
  });

  const wheel = (key: string, x: number, z: number, front: boolean, side: React.RefObject<THREE.Group> | null) => (
    <group key={key} position={[x, WHEEL_R, z]} ref={side ?? undefined}>
      <group ref={(el) => { spin.current[front ? (x > 0 ? 0 : 1) : x > 0 ? 2 : 3] = el; }}>
        <mesh geometry={wheelGeo} material={mats.tyre} castShadow />
        <mesh position={[Math.sign(x) * 0.02, 0, 0]} geometry={wheelGeo} material={mats.rim} scale={[0.5, 0.7, 0.7]} />
        <mesh position={[0, WHEEL_R * 0.6, 0]} material={mats.trim}>
          <boxGeometry args={[0.26, 0.08, 0.06]} />
        </mesh>
      </group>
    </group>
  );

  return (
    <group ref={root}>
      {wheel("fl", 0.84, 1.3, true, steerL)}
      {wheel("fr", -0.84, 1.3, true, steerR)}
      {wheel("rl", 0.84, -1.3, false, null)}
      {wheel("rr", -0.84, -1.3, false, null)}
      <group ref={tilt} position={[0, 0.34, 0]}>
        {/* lower body */}
        <mesh position={[0, 0.36, 0]} material={mats.paint} castShadow>
          <boxGeometry args={[1.78, 0.5, 4.2]} />
        </mesh>
        {/* bonnet and boot taper */}
        <mesh position={[0, 0.66, 1.35]} rotation-x={-0.12} material={mats.paint} castShadow>
          <boxGeometry args={[1.7, 0.12, 1.5]} />
        </mesh>
        <mesh position={[0, 0.66, -1.5]} rotation-x={0.1} material={mats.paint} castShadow>
          <boxGeometry args={[1.7, 0.12, 1.1]} />
        </mesh>
        {/* cabin */}
        <mesh position={[0, 0.98, -0.2]} material={mats.glass} castShadow>
          <boxGeometry args={[1.52, 0.5, 2.1]} />
        </mesh>
        <mesh position={[0, 1.25, -0.2]} material={mats.paint} castShadow>
          <boxGeometry args={[1.5, 0.06, 1.9]} />
        </mesh>
        {/* bumpers */}
        <mesh position={[0, 0.2, 2.12]} material={mats.trim}>
          <boxGeometry args={[1.8, 0.2, 0.12]} />
        </mesh>
        <mesh position={[0, 0.2, -2.12]} material={mats.trim}>
          <boxGeometry args={[1.8, 0.2, 0.12]} />
        </mesh>
        {/* lights: headlamps front (+z), tail lamps rear */}
        {[-0.6, 0.6].map((x) => (
          <mesh key={`h${x}`} position={[x, 0.46, 2.12]} material={mats.head}>
            <boxGeometry args={[0.4, 0.14, 0.05]} />
          </mesh>
        ))}
        {[-0.6, 0.6].map((x) => (
          <mesh key={`t${x}`} position={[x, 0.46, -2.12]} material={mats.tail}>
            <boxGeometry args={[0.42, 0.14, 0.05]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
