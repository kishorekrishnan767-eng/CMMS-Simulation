import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { BUILD_D, BUILD_W, hourOfDay, mulberry32, occupancyAt, sunElevation } from "./constants";
import { lightingMs } from "./lighting";

export const QUALITY = {
  low: { dpr: 1, shadow: 0, env: false, cityDensity: 0.45, cars: 22, pedestrians: 0, clouds: false, mullions: false, bloom: false, haze: false, shadowMap: 512 },
  medium: { dpr: 1.25, shadow: 1, env: false, cityDensity: 0.8, cars: 46, pedestrians: 14, clouds: true, mullions: true, bloom: false, haze: true, shadowMap: 1024 },
  high: { dpr: 2, shadow: 2, env: true, cityDensity: 1, cars: 70, pedestrians: 28, clouds: true, mullions: true, bloom: true, haze: true, shadowMap: 2048 },
} as const;

const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1));

/** Colours of the sky at a given sun elevation (radians). */
function skyColors(elev: number) {
  const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.35);
  const dusk = 1 - Math.abs(THREE.MathUtils.clamp(elev / 0.28, -1, 1));
  const zenith = mix(new THREE.Color("#050b18"), new THREE.Color("#2f78c9"), day);
  let horizon = mix(new THREE.Color("#0b1626"), new THREE.Color("#a9d4ea"), day);
  horizon = mix(horizon, new THREE.Color("#ff9a5c"), Math.max(0, dusk) * 0.55 * (1 - Math.abs(day - 0.5) * 0.6));
  return { zenith, horizon, day };
}

/** Procedural sky dome, sun/moon lights and fog — all driven by the simulation clock. */
export function SkyAndLight() {
  const q = QUALITY[useUi((s) => s.quality)];
  const { scene, gl } = useThree();
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const dome = useRef<THREE.Mesh>(null);
  const stars = useRef<THREE.Points>(null);
  const sunDisc = useRef<THREE.Group>(null);
  const moonDisc = useRef<THREE.Group>(null);

  const domeMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { zenith: { value: new THREE.Color("#2f78c9") }, horizon: { value: new THREE.Color("#a9d4ea") } },
        vertexShader: "varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} ",
        fragmentShader:
          "uniform vec3 zenith; uniform vec3 horizon; varying vec3 vPos; void main(){ float h = clamp(normalize(vPos).y, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, zenith, pow(h, 0.55)), 1.0);} ",
      }),
    [],
  );
  const starGeo = useMemo(() => {
    const rnd = mulberry32(11);
    const pts: number[] = [];
    for (let i = 0; i < 700; i++) {
      const u = rnd() * Math.PI * 2;
      const v = Math.acos(rnd() * 0.95 + 0.05);
      pts.push(Math.cos(u) * Math.sin(v) * 380, Math.cos(v) * 380, Math.sin(u) * Math.sin(v) * 380);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  // Procedural image-based lighting (no external HDRI): reflections for glass and steel.
  useEffect(() => {
    if (!q.env) {
      scene.environment = null;
      return;
    }
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [q.env, gl, scene]);

  const fog = useMemo(() => new THREE.Fog("#a9d4ea", 120, 460), []);
  useEffect(() => {
    scene.fog = fog;
    return () => {
      scene.fog = null;
    };
  }, [scene, fog]);

  const frameNo = useRef(0);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false; // refreshed every few frames below: sun and machines move slowly
    return () => {
      gl.shadowMap.autoUpdate = true;
    };
  }, [gl]);

  useFrame(() => {
    if (frameNo.current++ % 45 === 0) gl.shadowMap.needsUpdate = true;
    const ms = lightingMs();
    const elev = sunElevation(ms);
    const { zenith, horizon, day } = skyColors(elev);
    domeMat.uniforms.zenith.value.copy(zenith);
    domeMat.uniforms.horizon.value.copy(horizon);
    fog.color.copy(horizon);
    scene.background = horizon;
    const h = hourOfDay(ms);
    const az = ((h - 6) / 12) * Math.PI; // east → west
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(Math.abs(elev) + 0.12), Math.sin(Math.max(elev, 0.04) + 0.02), -0.45 + Math.sin(az) * 0.2).normalize();
    if (sun.current) {
      sun.current.position.copy(dir.clone().multiplyScalar(120));
      sun.current.intensity = THREE.MathUtils.lerp(0.08, 2.4, day);
      sun.current.color.set(day > 0.6 ? "#fff4e0" : "#ffb878").lerp(new THREE.Color("#9db8ff"), 1 - day);
      sun.current.castShadow = q.shadow > 0 && day > 0.05;
    }
    if (hemi.current) {
      hemi.current.intensity = THREE.MathUtils.lerp(0.3, 1.1, day);
      hemi.current.color.copy(zenith).lerp(new THREE.Color("#ffffff"), 0.45);
      hemi.current.groundColor.set("#6b737a");
    }
    // visible sun and moon on opposite sides of the dome, following the sim clock
    const far = dir.clone().multiplyScalar(330);
    if (sunDisc.current) {
      sunDisc.current.position.copy(far);
      sunDisc.current.visible = elev > -0.08;
      sunDisc.current.lookAt(0, 0, 0);
      sunDisc.current.scale.setScalar(1 + (1 - Math.min(1, Math.max(0, elev / 0.5))) * 0.35);
    }
    if (moonDisc.current) {
      const hm = ((h + 12 - 6) / 12) * Math.PI;
      const moonElev = Math.sin(((h + 12 - 6) / 24) * Math.PI * 2) * 1.05;
      moonDisc.current.position.set(Math.cos(hm) * Math.cos(Math.abs(moonElev) + 0.12), Math.sin(Math.max(moonElev, 0.04) + 0.02), -0.45 + Math.sin(hm) * 0.2).normalize().multiplyScalar(330);
      moonDisc.current.visible = moonElev > -0.08;
      moonDisc.current.lookAt(0, 0, 0);
    }
    if (stars.current) {
      const m = stars.current.material as THREE.PointsMaterial;
      m.opacity = THREE.MathUtils.clamp(1 - day * 1.6, 0, 1);
      stars.current.visible = m.opacity > 0.02;
    }
    if (dome.current) dome.current.position.set(0, 0, 0);
  });

  return (
    <>
      <mesh ref={dome} material={domeMat} renderOrder={-10}>
        <sphereGeometry args={[400, 32, 16]} />
      </mesh>
      <group ref={sunDisc}>
        <mesh>
          <circleGeometry args={[15, 40]} />
          <meshBasicMaterial color="#fff6d8" fog={false} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, -0.1]}>
          <circleGeometry args={[34, 40]} />
          <meshBasicMaterial color="#ffe9a8" transparent opacity={0.22} fog={false} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <group ref={moonDisc}>
        <mesh>
          <circleGeometry args={[9, 36]} />
          <meshBasicMaterial color="#e8eef6" fog={false} toneMapped={false} />
        </mesh>
        <mesh position={[3.2, 1.6, 0.05]}>
          <circleGeometry args={[2.1, 16]} />
          <meshBasicMaterial color="#c4ccd8" fog={false} toneMapped={false} />
        </mesh>
        <mesh position={[-2.8, -2.4, 0.05]}>
          <circleGeometry args={[1.6, 16]} />
          <meshBasicMaterial color="#cdd5e0" fog={false} toneMapped={false} />
        </mesh>
      </group>
      <points ref={stars} geometry={starGeo}>
        <pointsMaterial color="#ffffff" size={1.6} sizeAttenuation={false} transparent opacity={0} depthWrite={false} fog={false} />
      </points>
      <hemisphereLight ref={hemi} />
      <directionalLight
        ref={sun}
        castShadow={q.shadow > 0}
        shadow-mapSize={[q.shadowMap, q.shadowMap]}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={50}
        shadow-camera-bottom={-35}
        shadow-camera-near={10}
        shadow-camera-far={260}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />
    </>
  );
}

function makeGroundTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#9db88a";
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(8);
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = `rgba(${70 + rnd() * 50},${110 + rnd() * 50},${60 + rnd() * 30},0.13)`;
    g.fillRect(rnd() * 256, rnd() * 256, 3, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(160, 160);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Ground with an open light-well in front of the basement so the plant room can be seen. */
export function Ground() {
  const q = QUALITY[useUi((s) => s.quality)];
  const tex = useMemo(() => makeGroundTexture(), []);
  const hx = BUILD_W / 2;
  const hz = BUILD_D / 2;
  const trench = { z0: hz, z1: hz + 9 };
  const big = 500;
  const mat = <meshStandardMaterial map={tex} color="#ffffff" roughness={0.98} />;
  return (
    <group>
      {/* back, left, right, and front-outside of the light-well */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, -(hz + big / 2)]} receiveShadow>
        <planeGeometry args={[big * 2, big]} />
        {mat}
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, trench.z1 + big / 2]} receiveShadow>
        <planeGeometry args={[big * 2, big]} />
        {mat}
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[-(hx + big / 2), -0.02, (trench.z1 - hz) / 2 + 0]} receiveShadow>
        <planeGeometry args={[big, trench.z1 + hz]} />
        {mat}
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[hx + big / 2, -0.02, (trench.z1 - hz) / 2 + 0]} receiveShadow>
        <planeGeometry args={[big, trench.z1 + hz]} />
        {mat}
      </mesh>
      {/* the light-well: concrete floor at basement level and side walls */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -4.02, (trench.z0 + trench.z1) / 2]} receiveShadow>
        <planeGeometry args={[BUILD_W, trench.z1 - trench.z0]} />
        <meshStandardMaterial color="#9aa1a7" roughness={0.9} />
      </mesh>
      {[-hx, hx].map((x) => (
        <mesh key={x} position={[x, -2, (trench.z0 + trench.z1) / 2]}>
          <boxGeometry args={[0.4, 4, trench.z1 - trench.z0]} />
          <meshStandardMaterial color="#8b9298" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, -2, trench.z1]}>
        <boxGeometry args={[BUILD_W + 0.8, 4, 0.4]} />
        <meshStandardMaterial color="#8b9298" roughness={0.9} />
      </mesh>
      {/* entrance bridge across the light-well */}
      <mesh position={[0, -0.15, (trench.z0 + trench.z1) / 2]} receiveShadow castShadow={q.shadow > 0}>
        <boxGeometry args={[6, 0.3, trench.z1 - trench.z0]} />
        <meshStandardMaterial color="#7d8a94" roughness={0.85} />
      </mesh>
      {/* paved front path from the bridge to the avenue */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.022, 26.5]} receiveShadow>
        <planeGeometry args={[5, 12]} />
        <meshStandardMaterial color="#cfcdc6" roughness={0.9} />
      </mesh>
      {[-2.9, 2.9].map((x) => (
        <mesh key={x} position={[x, 0.55, (trench.z0 + trench.z1) / 2]}>
          <boxGeometry args={[0.08, 1.1, trench.z1 - trench.z0]} />
          <meshStandardMaterial color="#c3ced6" metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

/** Interior-lights factor used by floors: follows occupancy of the sim clock. */
export function useOccupancy() {
  return () => occupancyAt(simNowMs());
}
