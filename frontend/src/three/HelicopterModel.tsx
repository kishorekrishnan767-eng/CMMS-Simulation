import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { helicopter } from "./helicopter";

export default function Helicopter() {
  const root = useRef<THREE.Group>(null);
  const rotor = useRef<THREE.Group>(null);
  const tailRotor = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    const g = root.current;
    if (!g) return;

    g.position.set(helicopter.x, helicopter.y, helicopter.z);
    g.rotation.order = "YXZ";
    g.rotation.set(helicopter.pitch, helicopter.yaw, helicopter.roll);

    if (rotor.current) rotor.current.rotation.y += delta * (helicopter.rotor * 2.7);
    if (tailRotor.current) tailRotor.current.rotation.x += delta * (helicopter.rotor * 7.5);
  });

  return (
    <group ref={root}>
      <group position={[0, 0.75, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[2.2, 0.55, 3.8]} />
          <meshStandardMaterial color="#dfe7ea" metalness={0.6} roughness={0.28} />
        </mesh>

        <mesh position={[0, 0.72, -0.3]} castShadow>
          <boxGeometry args={[1.5, 0.8, 1.9]} />
          <meshStandardMaterial color="#c9d3d7" metalness={0.6} roughness={0.3} />
        </mesh>

        <mesh position={[0.65, 0.3, 0.3]} castShadow>
          <boxGeometry args={[0.9, 0.16, 1.3]} />
          <meshStandardMaterial color="#a4afbb" metalness={0.8} roughness={0.25} />
        </mesh>

        <mesh position={[-1.7, 0.15, 0.2]} castShadow>
          <boxGeometry args={[1.6, 0.12, 0.16]} />
          <meshStandardMaterial color="#8c98a1" metalness={0.7} roughness={0.28} />
        </mesh>

        <mesh position={[-2.3, 0.22, 0.2]} castShadow>
          <boxGeometry args={[0.6, 0.18, 0.18]} />
          <meshStandardMaterial color="#e2e7ea" metalness={0.4} roughness={0.25} />
        </mesh>

        <mesh position={[0, 0.5, 2.1]} castShadow>
          <boxGeometry args={[0.5, 0.18, 0.5]} />
          <meshStandardMaterial color="#181f26" metalness={0.25} roughness={0.7} />
        </mesh>

        <group position={[0, 0.7, 0]}>
          <mesh position={[-0.3, 0.2, 0]} castShadow>
            <boxGeometry args={[0.42, 0.1, 0.2]} />
            <meshStandardMaterial color="#fef6c8" emissive="#fff1a7" emissiveIntensity={0.3} />
          </mesh>
          <mesh position={[0.3, 0.2, 0]} castShadow>
            <boxGeometry args={[0.42, 0.1, 0.2]} />
            <meshStandardMaterial color="#fef6c8" emissive="#fff1a7" emissiveIntensity={0.3} />
          </mesh>
        </group>

        <group position={[0, 0.2, 2.2]}>
          <mesh castShadow>
            <boxGeometry args={[0.14, 0.08, 0.7]} />
            <meshStandardMaterial color="#d2d9de" metalness={0.85} roughness={0.2} />
          </mesh>
          <mesh position={[0, -0.8, 0]} castShadow>
            <boxGeometry args={[0.14, 0.08, 0.7]} />
            <meshStandardMaterial color="#d2d9de" metalness={0.85} roughness={0.2} />
          </mesh>
          <mesh position={[0.9, -0.4, 0]} castShadow>
            <boxGeometry args={[0.14, 0.08, 0.7]} />
            <meshStandardMaterial color="#d2d9de" metalness={0.85} roughness={0.2} />
          </mesh>
          <mesh position={[-0.9, -0.4, 0]} castShadow>
            <boxGeometry args={[0.14, 0.08, 0.7]} />
            <meshStandardMaterial color="#d2d9de" metalness={0.85} roughness={0.2} />
          </mesh>
        </group>

        <group ref={rotor} position={[0, 1.25, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.12, 0.12, 0.08, 20]} />
            <meshStandardMaterial color="#323b42" metalness={0.7} roughness={0.35} />
          </mesh>
          {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((a) => (
            <mesh key={a} rotation={[0, a, 0]} castShadow>
              <boxGeometry args={[0.14, 0.04, 3.2]} />
              <meshStandardMaterial color="#f0f2f5" metalness={0.7} roughness={0.25} />
            </mesh>
          ))}
        </group>

        <group ref={tailRotor} position={[-3.4, 0.35, 0.2]}>
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.08, 0.08, 0.1, 20]} />
            <meshStandardMaterial color="#2c343d" metalness={0.7} roughness={0.4} />
          </mesh>
          {[0, Math.PI / 2].map((a) => (
            <mesh key={a} rotation={[0, 0, a]} castShadow>
              <boxGeometry args={[0.08, 0.02, 1.25]} />
              <meshStandardMaterial color="#edf1f2" metalness={0.7} roughness={0.25} />
            </mesh>
          ))}
        </group>
      </group>
    </group>
  );
}
