import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { QUALITY } from "./SceneEnvironment";
import { BUILD_D, BUILD_W, CORE, FLOOR_H, LEVELS, ROOF_LEVEL, SLAB_T, explodeOffset, floorY, mulberry32, occupancyAt } from "./constants";

const HX = BUILD_W / 2;
const HZ = BUILD_D / 2;

function canvasTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 256, repeat?: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

let _signTex: THREE.CanvasTexture | null = null;
function signTexture() {
  if (!_signTex) {
    _signTex = canvasTexture((g, w, h) => {
      g.fillStyle = "#0b2a2e";
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "#1fd1b6";
      g.lineWidth = 6;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = "#e8fffb";
      g.font = "700 64px Inter, system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("TOWER A", w / 2, h / 2 - 8);
      g.fillStyle = "#1fd1b6";
      g.font = "500 26px Inter, system-ui, sans-serif";
      g.fillText("SIMULATED DIGITAL TWIN", w / 2, h / 2 + 44);
    }, 512, 160);
  }
  return _signTex;
}

let _ceilTex: THREE.CanvasTexture | null = null;
function ceilingTexture() {
  if (!_ceilTex) {
    _ceilTex = canvasTexture((g, w, h) => {
      g.fillStyle = "#cfd8dc";
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "#8795a0";
      g.lineWidth = 3;
      g.strokeRect(0, 0, w, h);
    }, 64, 64, [20, 12]);
  }
  return _ceilTex;
}

interface Mats {
  slab: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  desk: THREE.MeshStandardMaterial;
  core: THREE.MeshStandardMaterial;
  light: THREE.MeshBasicMaterial;
  ceiling: THREE.MeshStandardMaterial;
  all: THREE.Material[];
}

function useFloorMaterials(): Mats {
  return useMemo(() => {
    const std = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...extra });
    const slab = std("#4a5963", { roughness: 0.9 });
    const glass = std("#79c9d4", { roughness: 0.06, metalness: 0.35, transparent: true, opacity: 0.22, depthWrite: false, envMapIntensity: 1.4 });
    const wall = std("#b9c4cb");
    const metal = std("#2f3b44", { metalness: 0.6, roughness: 0.4 });
    const desk = std("#9aa8b1");
    const core = std("#55646f", { roughness: 0.7 });
    const light = new THREE.MeshBasicMaterial({ color: "#fff6dd", transparent: true, opacity: 0.95 });
    const ceiling = std("#cfd8dc", { map: ceilingTexture(), roughness: 0.95, side: THREE.DoubleSide });
    return { slab, glass, wall, metal, desk, core, light, ceiling, all: [slab, glass, wall, metal, desk, core, ceiling] };
  }, []);
}

const PARTITIONS: [number, number, number, number][] = [
  // [x, z, width, depth] — corridor walls and meeting rooms
  [-6, 2.0, 22, 0.15], [-6, -2.0, 22, 0.15], [10.6, 5.5, 0.15, 7], [10.6, -5.5, 0.15, 7], [14, 3.0, 7, 0.15],
];

interface FloorProps {
  level: number;
  children?: ReactNode;
}

/** One storey of Tower A: slab, structure, curtain wall, interior, lights. Procedural, instanced. */
export function Floor({ level, children }: FloorProps) {
  const q = QUALITY[useUi((s) => s.quality)];
  const group = useRef<THREE.Group>(null);
  const mats = useFloorMaterials();
  const lightMat = mats.light;
  const hasInterior = level >= 0 && level < ROOF_LEVEL;
  const isBasement = level < 0;
  const isRoof = level === ROOF_LEVEL;
  const ghost = useRef(0);
  const rand = useMemo(() => mulberry32(500 + level)(), [level]);

  // Instanced meshes -----------------------------------------------------------------------
  const columns = useRef<THREE.InstancedMesh>(null);
  const mullions = useRef<THREE.InstancedMesh>(null);
  const desks = useRef<THREE.InstancedMesh>(null);
  const lights = useRef<THREE.InstancedMesh>(null);

  const colPos = useMemo(() => {
    const out: [number, number][] = [];
    for (const x of [-16, -8, 0, 8, 16]) for (const z of [-8, 0, 8]) out.push([x, z]);
    return out;
  }, []);
  const mullionPos = useMemo(() => {
    const out: [number, number, number, number][] = []; // x,z,sx,sz
    for (let x = -HX + 2.5; x < HX; x += 2.5) {
      out.push([x, HZ, 0.1, 0.12], [x, -HZ, 0.1, 0.12]);
    }
    for (let z = -HZ + 2.5; z < HZ; z += 2.5) {
      out.push([HX, z, 0.12, 0.1], [-HX, z, 0.12, 0.1]);
    }
    return out;
  }, []);
  const deskPos = useMemo(() => {
    const out: [number, number][] = [];
    for (let x = -17; x <= 9.5; x += 3.4) for (const z of [4.6, 8, -4.6, -8]) out.push([x, z]);
    return out;
  }, []);
  const lightPos = useMemo(() => {
    const out: [number, number][] = [];
    for (let x = -17.5; x <= 17.5; x += 5) for (const z of [-8, -4, 0, 4, 8]) out.push([x, z]);
    return out;
  }, []);

  useEffect(() => {
    const o = new THREE.Object3D();
    const place = (m: THREE.InstancedMesh | null, i: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      if (!m) return;
      o.position.set(x, y, z);
      o.scale.set(sx, sy, sz);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    };
    colPos.forEach(([x, z], i) => place(columns.current, i, x, isBasement ? FLOOR_H / 2 : FLOOR_H / 2 - SLAB_T / 2, z, 0.5, FLOOR_H - SLAB_T, 0.5));
    mullionPos.forEach(([x, z, sx, sz], i) => place(mullions.current, i, x, (FLOOR_H - SLAB_T) / 2, z, sx, FLOOR_H - SLAB_T, sz));
    deskPos.forEach(([x, z], i) => place(desks.current, i, x, 0.38, z, 1.5, 0.76, 0.75));
    lightPos.forEach(([x, z], i) => place(lights.current, i, x, FLOOR_H - SLAB_T - 0.06, z, 1.6, 0.04, 0.5));
    [columns, mullions, desks, lights].forEach((r) => {
      if (r.current) r.current.instanceMatrix.needsUpdate = true;
    });
  }, [colPos, mullionPos, deskPos, lightPos, isBasement, q.mullions]);

  // Per-frame: explode offset, ghosting, occupancy-driven lights --------------------------------
  useFrame((_, delta) => {
    const ui = useUi.getState();
    const g = group.current;
    if (!g) return;
    const targetY = floorY(level) + explodeOffset(level, ui.explode);
    g.position.y = THREE.MathUtils.damp(g.position.y, targetY, ui.reducedMotion ? 60 : 5, delta);
    const isolatedOut = ui.isolatedFloor !== null && ui.isolatedFloor !== level;
    const target = isolatedOut ? 1 : ui.xray ? 0.7 : 0;
    ghost.current = THREE.MathUtils.damp(ghost.current, target, 8, delta);
    const k = ghost.current;
    mats.slab.opacity = 1 - k * 0.8;
    mats.wall.opacity = 1 - k * 0.9;
    mats.core.opacity = 1 - k * 0.8;
    mats.desk.opacity = 1 - k * 0.9;
    mats.ceiling.opacity = 1 - k * 0.95;
    mats.glass.opacity = 0.22 * (1 - k * 0.8);
    for (const m of [mats.slab, mats.wall, mats.core, mats.desk, mats.ceiling]) {
      m.transparent = k > 0.02;
      m.depthWrite = k < 0.5;
    }
    const occ = occupancyAt(simNowMs());
    const on = occ > rand * 0.85 ? 1 : 0;
    const bright = hasInterior ? (0.12 + 0.88 * occ) * on : isBasement ? 0.9 : 0.1;
    lightMat.color.setRGB(1 * bright, 0.96 * bright, 0.86 * bright);
    lightMat.opacity = (1 - k * 0.9) * (on || isBasement ? 1 : 0.15);
  });

  const wallH = FLOOR_H - SLAB_T;

  return (
    <group ref={group} position={[0, floorY(level), 0]}>
      {/* slab (top surface at y = 0) */}
      <mesh position={[0, -SLAB_T / 2, 0]} material={mats.slab} receiveShadow castShadow={q.shadow > 0}>
        <boxGeometry args={[BUILD_W, SLAB_T, BUILD_D]} />
      </mesh>

      {/* structure */}
      <instancedMesh ref={columns} args={[undefined, undefined, colPos.length]} material={mats.core} castShadow={false} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>

      {isBasement && (
        <>
          <pointLight position={[0, 3, 0]} intensity={90} distance={45} color="#ffe9c4" />
          <pointLight position={[-12, 3, 0]} intensity={60} distance={30} color="#dff3ff" />
          <instancedMesh ref={lights} args={[undefined, undefined, lightPos.length]} material={lightMat} frustumCulled={false}>
            <boxGeometry args={[1, 1, 1]} />
          </instancedMesh>
          {/* concrete walls on three sides — the front is open to the light-well */}
          <mesh position={[0, wallH / 2 + SLAB_T / 2 - 0.2, -HZ]} material={mats.wall}>
            <boxGeometry args={[BUILD_W, FLOOR_H, 0.4]} />
          </mesh>
          {[-HX, HX].map((x) => (
            <mesh key={x} position={[x, wallH / 2 + SLAB_T / 2 - 0.2, 0]} material={mats.wall}>
              <boxGeometry args={[0.4, FLOOR_H, BUILD_D]} />
            </mesh>
          ))}
        </>
      )}

      {hasInterior && (
        <>
          {/* curtain wall: four glass faces + mullions */}
          <mesh position={[0, wallH / 2, HZ]} material={mats.glass} renderOrder={5}>
            <boxGeometry args={[BUILD_W, wallH, 0.08]} />
          </mesh>
          <mesh position={[0, wallH / 2, -HZ]} material={mats.glass} renderOrder={5}>
            <boxGeometry args={[BUILD_W, wallH, 0.08]} />
          </mesh>
          <mesh position={[HX, wallH / 2, 0]} material={mats.glass} renderOrder={5}>
            <boxGeometry args={[0.08, wallH, BUILD_D]} />
          </mesh>
          <mesh position={[-HX, wallH / 2, 0]} material={mats.glass} renderOrder={5}>
            <boxGeometry args={[0.08, wallH, BUILD_D]} />
          </mesh>
          {q.mullions && (
            <instancedMesh ref={mullions} args={[undefined, undefined, mullionPos.length]} material={mats.metal} frustumCulled={false}>
              <boxGeometry args={[1, 1, 1]} />
            </instancedMesh>
          )}
          {/* spandrel band hides the slab edge from outside */}
          {[HZ, -HZ].map((z) => (
            <mesh key={z} position={[0, 0.25, z]} material={mats.metal}>
              <boxGeometry args={[BUILD_W + 0.2, 0.6, 0.2]} />
            </mesh>
          ))}
          {[HX, -HX].map((x) => (
            <mesh key={x} position={[x, 0.25, 0]} material={mats.metal}>
              <boxGeometry args={[0.2, 0.6, BUILD_D + 0.2]} />
            </mesh>
          ))}

          {/* stair / lift core */}
          <mesh position={[CORE.x, wallH / 2, CORE.z]} material={mats.core} castShadow={q.shadow > 1}>
            <boxGeometry args={[CORE.w, wallH, CORE.d]} />
          </mesh>
          <mesh position={[CORE.x - CORE.w / 2 - 0.02, 1.1, CORE.z + 1.4]}>
            <boxGeometry args={[0.06, 2.2, 1.3]} />
            <meshStandardMaterial color="#1b252c" metalness={0.7} roughness={0.3} />
          </mesh>
          <mesh position={[CORE.x - CORE.w / 2 - 0.02, 1.1, CORE.z - 1.4]}>
            <boxGeometry args={[0.06, 2.2, 1.3]} />
            <meshStandardMaterial color="#1b252c" metalness={0.7} roughness={0.3} />
          </mesh>

          {/* interior partitions */}
          {PARTITIONS.map(([x, z, w, d], i) => (
            <mesh key={i} position={[x, wallH / 2, z]} material={mats.wall}>
              <boxGeometry args={[w, wallH, d]} />
            </mesh>
          ))}
          {/* ceiling grid and light panels */}
          <mesh position={[0, wallH - 0.02, 0]} rotation-x={Math.PI / 2} material={mats.ceiling}>
            <planeGeometry args={[BUILD_W - 0.4, BUILD_D - 0.4]} />
          </mesh>
          <instancedMesh ref={lights} args={[undefined, undefined, lightPos.length]} material={lightMat} frustumCulled={false}>
            <boxGeometry args={[1, 1, 1]} />
          </instancedMesh>
          {level >= 1 && (
            <instancedMesh ref={desks} args={[undefined, undefined, deskPos.length]} material={mats.desk} frustumCulled={false}>
              <boxGeometry args={[1, 1, 1]} />
            </instancedMesh>
          )}
          {level === 0 && <Lobby mats={mats} />}
        </>
      )}

      {isRoof && <RoofDeck mats={mats} />}
      {children}
    </group>
  );
}

function Lobby({ mats }: { mats: Mats }) {
  return (
    <group>
      <mesh position={[-6, 0.55, 5]} material={mats.core}>
        <boxGeometry args={[7, 1.1, 1.2]} />
      </mesh>
      <mesh position={[-6, 1.12, 5]}>
        <boxGeometry args={[7.2, 0.06, 1.4]} />
        <meshStandardMaterial color="#1fd1b6" emissive="#1fd1b6" emissiveIntensity={0.25} />
      </mesh>
      {[-2, 0, 2].map((x) => (
        <mesh key={x} position={[x, 1.1, HZ - 0.12]}>
          <boxGeometry args={[1.6, 2.2, 0.06]} />
          <meshStandardMaterial color="#14212a" metalness={0.8} roughness={0.2} />
        </mesh>
      ))}
      <mesh position={[0, 3.05, HZ + 0.14]}>
        <planeGeometry args={[8, 0.9]} />
        <meshBasicMaterial map={signTexture()} toneMapped={false} />
      </mesh>
      {[-14, 12].map((x) => (
        <group key={x} position={[x, 0, 8]}>
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.45, 0.35, 0.6, 12]} />
            <meshStandardMaterial color="#3a464f" />
          </mesh>
          <mesh position={[0, 1.1, 0]}>
            <icosahedronGeometry args={[0.7, 0]} />
            <meshStandardMaterial color="#2f6b4f" roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function RoofDeck({ mats }: { mats: Mats }) {
  const wall = (pos: [number, number, number], size: [number, number, number]) => (
    <mesh position={pos} material={mats.core} castShadow>
      <boxGeometry args={size} />
    </mesh>
  );
  return (
    <group>
      {wall([0, 0.5, HZ - 0.15], [BUILD_W, 1, 0.3])}
      {wall([0, 0.5, -HZ + 0.15], [BUILD_W, 1, 0.3])}
      {wall([HX - 0.15, 0.5, 0], [0.3, 1, BUILD_D])}
      {wall([-HX + 0.15, 0.5, 0], [0.3, 1, BUILD_D])}
      {/* lift machine room on top of the core */}
      <mesh position={[CORE.x, 1.6, CORE.z]} material={mats.core} castShadow>
        <boxGeometry args={[CORE.w, 3.2, CORE.d]} />
      </mesh>
      <mesh position={[CORE.x, 3.25, CORE.z]}>
        <boxGeometry args={[CORE.w + 0.3, 0.12, CORE.d + 0.3]} />
        <meshStandardMaterial color="#c3ced6" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* walkway markings */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, 0.2]}>
        <planeGeometry args={[34, 0.5]} />
        <meshStandardMaterial color="#e6c84a" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** All storeys; `renderLevel` injects the equipment that stands on each floor. */
export function Building({ renderLevel }: { renderLevel: (level: number) => ReactNode }) {
  return (
    <group>
      {LEVELS.map((level) => (
        <Floor key={level} level={level}>
          {renderLevel(level)}
        </Floor>
      ))}
    </group>
  );
}
