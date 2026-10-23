import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { BUILD_D, BUILD_W, hourOfDay, mulberry32, occupancyAt, sunElevation } from "./constants";

export const QUALITY = {
  low: { dpr: 1, shadow: 0, env: false, blocks: 24, trees: 0, mullions: false, bloom: false, haze: false, shadowMap: 512 },
  medium: { dpr: 1.25, shadow: 1, env: false, blocks: 56, trees: 46, mullions: true, bloom: false, haze: true, shadowMap: 1024 },
  high: { dpr: 2, shadow: 2, env: true, blocks: 96, trees: 130, mullions: true, bloom: true, haze: true, shadowMap: 2048 },
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

  const fog = useMemo(() => new THREE.Fog("#a9d4ea", 90, 330), []);
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
    if (frameNo.current++ % 20 === 0) gl.shadowMap.needsUpdate = true;
    const ms = simNowMs();
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
      hemi.current.intensity = THREE.MathUtils.lerp(0.22, 0.85, day);
      hemi.current.color.copy(zenith).lerp(new THREE.Color("#ffffff"), 0.25);
      hemi.current.groundColor.set("#1b2a32");
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

function makeWindowTexture(seed: number) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0e1820";
  g.fillRect(0, 0, 64, 128);
  const rnd = mulberry32(seed);
  for (let y = 4; y < 124; y += 8) {
    for (let x = 4; x < 60; x += 8) {
      const lit = rnd() > 0.55;
      g.fillStyle = lit ? "#ffd88a" : "#1c2a36";
      g.fillRect(x, y, 4, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Low-poly surrounding city blocks (instanced) with lit windows at night, plus trees. */
export function City() {
  const q = QUALITY[useUi((s) => s.quality)];
  const blocks = useMemo(() => {
    const rnd = mulberry32(2026);
    const out: { x: number; z: number; w: number; d: number; h: number; tone: number }[] = [];
    let guard = 0;
    while (out.length < q.blocks && guard++ < 5000) {
      const r = 78 + rnd() * 180;
      const a = rnd() * Math.PI * 2;
      const x = Math.cos(a) * r * 1.25;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < BUILD_W / 2 + 28 && Math.abs(z) < BUILD_D / 2 + 34) continue;
      const w = 10 + rnd() * 16;
      const d = 10 + rnd() * 16;
      if (out.some((b) => Math.abs(b.x - x) < (b.w + w) / 2 + 3 && Math.abs(b.z - z) < (b.d + d) / 2 + 3)) continue;
      out.push({ x, z, w, d, h: 8 + Math.pow(rnd(), 1.9) * 46, tone: rnd() });
    }
    return out;
  }, [q.blocks]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const tex = useMemo(() => makeWindowTexture(7), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#6a7b88", roughness: 0.85, metalness: 0.1, emissive: new THREE.Color("#ffd88a"), emissiveMap: tex, emissiveIntensity: 0 }), [tex]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    blocks.forEach((b, i) => {
      o.position.set(b.x, b.h / 2, b.z);
      o.scale.set(b.w, b.h, b.d);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      c.set("#4f606d").lerp(new THREE.Color("#8fa2b0"), b.tone);
      m.setColorAt(i, c);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [blocks]);

  useFrame(() => {
    const night = 1 - THREE.MathUtils.smoothstep(sunElevation(simNowMs()), -0.1, 0.18);
    mat.emissiveIntensity = night * 0.9;
  });

  const trees = useMemo(() => {
    const rnd = mulberry32(99);
    const out: { x: number; z: number; s: number }[] = [];
    let guard = 0;
    while (out.length < q.trees && guard++ < 4000) {
      const x = (rnd() - 0.5) * 150;
      const z = (rnd() - 0.5) * 120;
      if (Math.abs(x) < BUILD_W / 2 + 5 && Math.abs(z) < BUILD_D / 2 + 12) continue;
      if (blocks.some((b) => Math.abs(b.x - x) < b.w / 2 + 2 && Math.abs(b.z - z) < b.d / 2 + 2)) continue;
      out.push({ x, z, s: 0.8 + rnd() * 0.9 });
    }
    return out;
  }, [q.trees, blocks]);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const o = new THREE.Object3D();
    trees.forEach((t, i) => {
      o.position.set(t.x, 1.6 * t.s, t.z);
      o.scale.setScalar(t.s);
      o.updateMatrix();
      crowns.current?.setMatrixAt(i, o.matrix);
      o.position.set(t.x, 0.7 * t.s, t.z);
      o.scale.set(t.s, t.s, t.s);
      o.updateMatrix();
      trunks.current?.setMatrixAt(i, o.matrix);
    });
    if (crowns.current) crowns.current.instanceMatrix.needsUpdate = true;
    if (trunks.current) trunks.current.instanceMatrix.needsUpdate = true;
  }, [trees]);

  return (
    <group>
      <instancedMesh ref={mesh} args={[undefined, undefined, blocks.length]} material={mat} frustumCulled={false} castShadow={q.shadow > 1} receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      {trees.length > 0 && (
        <>
          <instancedMesh ref={crowns} args={[undefined, undefined, trees.length]} frustumCulled={false}>
            <coneGeometry args={[1.5, 3.4, 7]} />
            <meshStandardMaterial color="#2f6b4f" roughness={0.9} />
          </instancedMesh>
          <instancedMesh ref={trunks} args={[undefined, undefined, trees.length]} frustumCulled={false}>
            <cylinderGeometry args={[0.18, 0.24, 1.4, 6]} />
            <meshStandardMaterial color="#4b3a2c" roughness={1} />
          </instancedMesh>
        </>
      )}
    </group>
  );
}

function makeGroundTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3b4d57";
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(255,255,255,0.05)";
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(40, 40);
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
  const mat = <meshStandardMaterial map={tex} color="#9fb2bb" roughness={0.95} />;
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
        <meshStandardMaterial color="#5b6770" roughness={0.9} />
      </mesh>
      {[-hx, hx].map((x) => (
        <mesh key={x} position={[x, -2, (trench.z0 + trench.z1) / 2]}>
          <boxGeometry args={[0.4, 4, trench.z1 - trench.z0]} />
          <meshStandardMaterial color="#4c5861" roughness={0.9} />
        </mesh>
      ))}
      <mesh position={[0, -2, trench.z1]}>
        <boxGeometry args={[BUILD_W + 0.8, 4, 0.4]} />
        <meshStandardMaterial color="#4c5861" roughness={0.9} />
      </mesh>
      {/* entrance bridge across the light-well */}
      <mesh position={[0, -0.15, (trench.z0 + trench.z1) / 2]} receiveShadow castShadow={q.shadow > 0}>
        <boxGeometry args={[6, 0.3, trench.z1 - trench.z0]} />
        <meshStandardMaterial color="#7d8a94" roughness={0.85} />
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
