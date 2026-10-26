import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { mulberry32, occupancyAt, sunElevation } from "./constants";
import { cap, merge, part } from "./Person";
import { QUALITY } from "./SceneEnvironment";

/*
 * The city around the Livewire Digital Solutions campus — fully procedural and instanced.
 *
 * Street grid: avenues (along x) at Z_LINES and streets (along z) at X_LINES, ROAD_W wide with
 * SIDEWALK_W pavements. The cell between the four innermost roads is the campus; the ring of cells
 * around it is downtown (mid-rise offices), one cell is a park, the rest are suburban houses.
 * Traffic, pedestrians, clouds and aircraft move in wall-clock time (ambience, not simulation state);
 * window and street lighting follow the simulation clock's day/night.
 */

export const X_LINES = [-250, -196, -122, -48, 48, 122, 196, 250];
export const Z_LINES = [-250, -186, -110, -36, 38, 112, 188, 250];
const ROAD_X = X_LINES.slice(1, -1); // streets (run along z)
const ROAD_Z = Z_LINES.slice(1, -1); // avenues (run along x)
const EXTENT = 250;
const ROAD_W = 9;
const SIDEWALK_W = 2.4;
const INSET = ROAD_W / 2 + SIDEWALK_W + 0.6;
const PARK = { ix: 4, iz: 2 }; // cell (column, row) used as the park

type Kind = "campus" | "downtown" | "park" | "suburb";
interface Cell { x0: number; x1: number; z0: number; z1: number; kind: Kind; ix: number; iz: number }

function cells(): Cell[] {
  const out: Cell[] = [];
  for (let i = 0; i < X_LINES.length - 1; i++) {
    for (let j = 0; j < Z_LINES.length - 1; j++) {
      const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
      const kind: Kind = ring === 0 ? "campus" : i === PARK.ix && j === PARK.iz ? "park" : ring === 1 ? "downtown" : "suburb";
      out.push({ x0: X_LINES[i] + INSET, x1: X_LINES[i + 1] - INSET, z0: Z_LINES[j] + INSET, z1: Z_LINES[j + 1] - INSET, kind, ix: i, iz: j });
    }
  }
  return out;
}

/** Night factor 0 (day) … 1 (night) from the sim clock. */
export const nightFactor = (ms: number) => 1 - THREE.MathUtils.smoothstep(sunElevation(ms), -0.1, 0.18);

const tmpO = new THREE.Object3D();
const tmpC = new THREE.Color();

function place(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0) {
  tmpO.position.set(x, y, z);
  tmpO.rotation.set(0, ry, 0);
  tmpO.scale.set(sx, sy, sz);
  tmpO.updateMatrix();
  m.setMatrixAt(i, tmpO.matrix);
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Gable roof: a triangular prism over a unit footprint, ridge along x, height 1. */
function gableGeometry() {
  const p = [
    [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0], // west gable
    [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0], // east gable
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0], // south slope
    [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0], // north slope
  ].flat();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------ streets
function Streets() {
  const roads = useRef<THREE.InstancedMesh>(null);
  const walks = useRef<THREE.InstancedMesh>(null);
  const dashes = useRef<THREE.InstancedMesh>(null);
  const zebra = useRef<THREE.InstancedMesh>(null);
  const layout = useMemo(() => {
    const dashList: [number, number, boolean][] = [];
    const nearCross = (v: number, lines: number[]) => lines.some((l) => Math.abs(v - l) < ROAD_W);
    for (const z of ROAD_Z) for (let x = -EXTENT; x < EXTENT; x += 6) if (!nearCross(x, ROAD_X)) dashList.push([x, z, true]);
    for (const x of ROAD_X) for (let z = -EXTENT; z < EXTENT; z += 6) if (!nearCross(z, ROAD_Z)) dashList.push([x, z, false]);
    const zebraList: [number, number, boolean][] = [];
    for (const x of ROAD_X) for (const z of ROAD_Z) {
      for (let k = -3; k <= 3; k++) {
        zebraList.push([x + k * 1.1, z - ROAD_W / 2 - 1.4, false], [x + k * 1.1, z + ROAD_W / 2 + 1.4, false]);
        zebraList.push([x - ROAD_W / 2 - 1.4, z + k * 1.1, true], [x + ROAD_W / 2 + 1.4, z + k * 1.1, true]);
      }
    }
    return { dashList, zebraList };
  }, []);
  const n = ROAD_X.length + ROAD_Z.length;

  useEffect(() => {
    let i = 0;
    for (const z of ROAD_Z) place(roads.current!, i++, 0, 0.03, z, EXTENT * 2, 1, ROAD_W);
    for (const x of ROAD_X) place(roads.current!, i++, x, 0.031, 0, ROAD_W, 1, EXTENT * 2);
    roads.current!.instanceMatrix.needsUpdate = true;
    i = 0;
    for (const z of ROAD_Z) for (const s of [-1, 1]) place(walks.current!, i++, 0, 0.08, z + s * (ROAD_W / 2 + SIDEWALK_W / 2), EXTENT * 2, 0.16, SIDEWALK_W);
    for (const x of ROAD_X) for (const s of [-1, 1]) place(walks.current!, i++, x + s * (ROAD_W / 2 + SIDEWALK_W / 2), 0.081, 0, SIDEWALK_W, 0.16, EXTENT * 2);
    walks.current!.instanceMatrix.needsUpdate = true;
    layout.dashList.forEach(([x, z, alongX], k) => place(dashes.current!, k, x, 0.045, z, alongX ? 2.6 : 0.16, 1, alongX ? 0.16 : 2.6));
    dashes.current!.instanceMatrix.needsUpdate = true;
    layout.zebraList.forEach(([x, z, alongX], k) => place(zebra.current!, k, x, 0.046, z, alongX ? 2.2 : 0.55, 1, alongX ? 0.55 : 2.2));
    zebra.current!.instanceMatrix.needsUpdate = true;
  }, [layout]);

  const plane = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  return (
    <group>
      <instancedMesh ref={roads} args={[plane, undefined, n]} receiveShadow frustumCulled={false}>
        <meshLambertMaterial color="#4a4f55" />
      </instancedMesh>
      <instancedMesh ref={walks} args={[undefined, undefined, n * 2]} receiveShadow frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#c9cac6" />
      </instancedMesh>
      <instancedMesh ref={dashes} args={[plane, undefined, layout.dashList.length]} frustumCulled={false}>
        <meshLambertMaterial color="#e9e6dc" />
      </instancedMesh>
      <instancedMesh ref={zebra} args={[plane, undefined, layout.zebraList.length]} frustumCulled={false}>
        <meshLambertMaterial color="#efeee9" />
      </instancedMesh>
    </group>
  );
}

// ------------------------------------------------------------------------------------------ buildings
interface Lots {
  houses: { x: number; z: number; w: number; d: number; h: number; ry: number; wall: number; roof: number }[];
  towers: { x: number; z: number; w: number; d: number; h: number; tone: number }[];
  trees: { x: number; z: number; s: number; conifer: boolean }[];
  ponds: { x: number; z: number; r: number }[];
  lawns: Cell[];
  plazas: Cell[];
}

const WALLS = ["#f1ece2", "#e8dccb", "#d9c7b0", "#f4f1ea", "#cfd6d2", "#e7d5c4", "#d6dbe2"];
const ROOFS = ["#7a3b2e", "#5b4a42", "#3f474f", "#8c5a3c", "#6b3a33"];

function useLots(density: number): Lots {
  return useMemo(() => {
    const rnd = mulberry32(2026);
    const out: Lots = { houses: [], towers: [], trees: [], ponds: [], lawns: [], plazas: [] };
    for (const c of cells()) {
      if (c.kind === "campus") continue;
      if (c.kind === "park") {
        out.lawns.push(c);
        const cx = (c.x0 + c.x1) / 2;
        const cz = (c.z0 + c.z1) / 2;
        out.ponds.push({ x: cx + 6, z: cz - 4, r: 14 });
        for (let k = 0; k < 70 * density; k++) {
          const x = c.x0 + 3 + rnd() * (c.x1 - c.x0 - 6);
          const z = c.z0 + 3 + rnd() * (c.z1 - c.z0 - 6);
          if (Math.hypot(x - cx - 6, z - cz + 4) < 17) continue;
          out.trees.push({ x, z, s: 0.9 + rnd() * 1.1, conifer: rnd() < 0.3 });
        }
        continue;
      }
      if (c.kind === "downtown") {
        out.plazas.push(c);
        const cols = 2;
        const rows = 2;
        const cw = (c.x1 - c.x0) / cols;
        const cd = (c.z1 - c.z0) / rows;
        for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
          if (rnd() < 0.18) {
            out.trees.push({ x: c.x0 + (a + 0.5) * cw, z: c.z0 + (b + 0.5) * cd, s: 1.3, conifer: false });
            continue;
          }
          const w = cw * (0.55 + rnd() * 0.3);
          const d = cd * (0.55 + rnd() * 0.3);
          // the row in front of the campus stays low-rise so the building is seen over it
          const h = c.iz === 4 ? 9 + rnd() * 13 : 14 + Math.pow(rnd(), 1.6) * 52;
          out.towers.push({ x: c.x0 + (a + 0.5) * cw, z: c.z0 + (b + 0.5) * cd, w, d, h, tone: rnd() });
        }
        continue;
      }
      // suburb: lots along the edges of the block, back gardens in the middle
      const lot = 15;
      const spanX = c.x1 - c.x0;
      const spanZ = c.z1 - c.z0;
      const nx = Math.floor(spanX / lot);
      const nz = Math.floor(spanZ / lot);
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        const edge = a === 0 || b === 0 || a === nx - 1 || b === nz - 1;
        const x = c.x0 + (a + 0.5) * (spanX / nx);
        const z = c.z0 + (b + 0.5) * (spanZ / nz);
        if (!edge || rnd() > density) {
          if (rnd() < 0.55) out.trees.push({ x: x + (rnd() - 0.5) * 6, z: z + (rnd() - 0.5) * 6, s: 0.8 + rnd() * 0.7, conifer: rnd() < 0.35 });
          continue;
        }
        // face the nearest street
        const ry = b === 0 || b === nz - 1 ? 0 : Math.PI / 2;
        out.houses.push({
          x, z, ry, w: 7 + rnd() * 2.5, d: 6.5 + rnd() * 2, h: rnd() < 0.3 ? 5.6 : 3.2,
          wall: Math.floor(rnd() * WALLS.length), roof: Math.floor(rnd() * ROOFS.length),
        });
        if (rnd() < 0.7) out.trees.push({ x: x + (rnd() - 0.5) * 9, z: z + (rnd() - 0.5) * 9, s: 0.7 + rnd() * 0.6, conifer: rnd() < 0.4 });
      }
    }
    // street trees on the campus avenues
    for (let x = -40; x <= 40; x += 10) out.trees.push({ x, z: 38 - ROAD_W / 2 - SIDEWALK_W - 1.5, s: 0.9, conifer: false });
    return out;
  }, [density]);
}

function houseTexture(emissive: boolean) {
  return canvasTex(128, 128, (g) => {
    g.fillStyle = emissive ? "#000" : "#ffffff";
    g.fillRect(0, 0, 128, 128);
    for (const x of [18, 76]) {
      g.fillStyle = emissive ? "#ffcf7a" : "#4c5965";
      g.fillRect(x, 40, 32, 34);
      if (!emissive) {
        g.fillStyle = "#ffffff";
        g.fillRect(x + 15, 40, 2, 34);
        g.fillRect(x, 56, 32, 2);
      }
    }
    if (!emissive) {
      g.fillStyle = "#8a6a52";
      g.fillRect(56, 84, 18, 44);
    }
  });
}

function towerTexture(emissive: boolean) {
  const rnd = mulberry32(emissive ? 9 : 7);
  const t = canvasTex(64, 128, (g) => {
    g.fillStyle = emissive ? "#000" : "#e9ecef";
    g.fillRect(0, 0, 64, 128);
    for (let y = 4; y < 124; y += 8) for (let x = 3; x < 61; x += 6) {
      if (emissive) {
        g.fillStyle = rnd() > 0.45 ? "#ffd894" : "#000";
      } else {
        g.fillStyle = "#6f8496";
      }
      g.fillRect(x, y, 4, 5);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function Buildings({ lots }: { lots: Lots }) {
  const houseBody = useRef<THREE.InstancedMesh>(null);
  const houseRoof = useRef<THREE.InstancedMesh>(null);
  const towers = useRef<THREE.InstancedMesh>(null);
  const roofTops = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const firs = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const gable = useMemo(() => gableGeometry(), []);
  const mats = useMemo(() => ({
    house: new THREE.MeshLambertMaterial({ map: houseTexture(false), emissiveMap: houseTexture(true), emissive: new THREE.Color("#ffd28a"), emissiveIntensity: 0 }),
    roof: new THREE.MeshLambertMaterial({ flatShading: true }),
    tower: new THREE.MeshLambertMaterial({ map: towerTexture(false), emissiveMap: towerTexture(true), emissive: new THREE.Color("#ffd894"), emissiveIntensity: 0 }),
  }), []);

  useEffect(() => {
    lots.houses.forEach((h, i) => {
      place(houseBody.current!, i, h.x, h.h / 2, h.z, h.w, h.h, h.d, h.ry);
      houseBody.current!.setColorAt(i, tmpC.set(WALLS[h.wall]));
      place(houseRoof.current!, i, h.x, h.h, h.z, h.w + 0.8, 2.4, h.d + 0.8, h.ry);
      houseRoof.current!.setColorAt(i, tmpC.set(ROOFS[h.roof]));
    });
    lots.towers.forEach((t, i) => {
      place(towers.current!, i, t.x, t.h / 2, t.z, t.w, t.h, t.d);
      towers.current!.setColorAt(i, tmpC.set("#c4ccd4").lerp(new THREE.Color("#f2efe8"), t.tone));
      place(roofTops.current!, i, t.x, t.h + 0.9, t.z, t.w * 0.4, 1.8, t.d * 0.35);
    });
    let ci = 0;
    let fi = 0;
    lots.trees.forEach((t, i) => {
      place(trunks.current!, i, t.x, 0.8 * t.s, t.z, t.s, t.s, t.s);
      if (t.conifer) place(firs.current!, fi++, t.x, 2.6 * t.s, t.z, t.s, t.s, t.s);
      else {
        place(crowns.current!, ci, t.x, 2.5 * t.s, t.z, t.s * (1 + ((i * 7) % 5) * 0.06), t.s * 0.9, t.s);
        crowns.current!.setColorAt(ci++, tmpC.set(i % 3 === 0 ? "#5f8a4b" : i % 3 === 1 ? "#4d7a43" : "#6f9a52"));
      }
    });
    crowns.current!.count = ci;
    firs.current!.count = fi;
    for (const m of [houseBody, houseRoof, towers, roofTops, crowns, firs, trunks]) {
      if (!m.current) continue;
      m.current.instanceMatrix.needsUpdate = true;
      if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true;
    }
  }, [lots]);

  useFrame(() => {
    const night = nightFactor(simNowMs());
    mats.house.emissiveIntensity = night * 0.9;
    mats.tower.emissiveIntensity = night * 1.1;
  });

  return (
    <group>
      <instancedMesh ref={houseBody} args={[undefined, mats.house, lots.houses.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={houseRoof} args={[gable, mats.roof, lots.houses.length]} frustumCulled={false} />
      <instancedMesh ref={towers} args={[undefined, mats.tower, lots.towers.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={roofTops} args={[undefined, undefined, lots.towers.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#8c949b" />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[undefined, undefined, lots.trees.length]} frustumCulled={false}>
        <icosahedronGeometry args={[1.6, 1]} />
        <meshLambertMaterial flatShading />
      </instancedMesh>
      <instancedMesh ref={firs} args={[undefined, undefined, lots.trees.length]} frustumCulled={false}>
        <coneGeometry args={[1.3, 3.6, 7]} />
        <meshLambertMaterial color="#3f6b45" flatShading />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, lots.trees.length]} frustumCulled={false}>
        <cylinderGeometry args={[0.16, 0.22, 1.6, 6]} />
        <meshLambertMaterial color="#6a5240" />
      </instancedMesh>
      {lots.plazas.map((c, i) => (
        <mesh key={`p${i}`} rotation-x={-Math.PI / 2} position={[(c.x0 + c.x1) / 2, 0.02, (c.z0 + c.z1) / 2]} receiveShadow>
          <planeGeometry args={[c.x1 - c.x0, c.z1 - c.z0]} />
          <meshLambertMaterial color="#d5d3cd" />
        </mesh>
      ))}
      {lots.ponds.map((p, i) => (
        <group key={`w${i}`} position={[p.x, 0.04, p.z]}>
          <mesh rotation-x={-Math.PI / 2}>
            <circleGeometry args={[p.r + 1.2, 40]} />
            <meshLambertMaterial color="#cfc6b4" />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
            <circleGeometry args={[p.r, 40]} />
            <meshLambertMaterial color="#5f93b5" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------------------------------ street lights
function StreetLights() {
  const poles = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (const z of ROAD_Z) for (let x = -EXTENT + 10; x < EXTENT; x += 30) out.push([x, z - ROAD_W / 2 - 0.6]);
    for (const x of ROAD_X) for (let z = -EXTENT + 25; z < EXTENT; z += 30) out.push([x + ROAD_W / 2 + 0.6, z]);
    return out;
  }, []);
  const headMat = useMemo(() => new THREE.MeshLambertMaterial({ color: "#d9dde0", emissive: new THREE.Color("#ffe2a8"), emissiveIntensity: 0 }), []);
  useEffect(() => {
    spots.forEach(([x, z], i) => {
      place(poles.current!, i, x, 3.2, z, 1, 1, 1);
      place(heads.current!, i, x, 6.35, z, 1, 1, 1);
    });
    poles.current!.instanceMatrix.needsUpdate = true;
    heads.current!.instanceMatrix.needsUpdate = true;
  }, [spots]);
  useFrame(() => {
    headMat.emissiveIntensity = nightFactor(simNowMs()) * 2.2;
  });
  return (
    <group>
      <instancedMesh ref={poles} args={[undefined, undefined, spots.length]} frustumCulled={false}>
        <cylinderGeometry args={[0.07, 0.1, 6.4, 6]} />
        <meshLambertMaterial color="#59616a" />
      </instancedMesh>
      <instancedMesh ref={heads} args={[undefined, headMat, spots.length]} frustumCulled={false}>
        <boxGeometry args={[0.7, 0.16, 0.36]} />
      </instancedMesh>
    </group>
  );
}

// ------------------------------------------------------------------------------------------ traffic
interface Car { road: number; alongX: boolean; at: number; lane: number; dir: 1 | -1; speed: number; offset: number; bus: boolean; color: string }
const CAR_COLORS = ["#d8dcdf", "#2c3238", "#b2312a", "#1f4f8a", "#e6e2d6", "#7c858e", "#3c6e57", "#9a9fa4", "#f2f2ef", "#5b3f63"];

function Traffic({ count }: { count: number }) {
  const body = useRef<THREE.InstancedMesh>(null);
  const cabin = useRef<THREE.InstancedMesh>(null);
  const base = useRef<THREE.InstancedMesh>(null);
  const front = useRef<THREE.InstancedMesh>(null);
  const rear = useRef<THREE.InstancedMesh>(null);
  const cars = useMemo<Car[]>(() => {
    const rnd = mulberry32(77);
    const roads = [...ROAD_Z.map((z) => ({ alongX: true, at: z })), ...ROAD_X.map((x) => ({ alongX: false, at: x }))];
    return Array.from({ length: count }, (_, i) => {
      const r = roads[i % roads.length];
      const dir: 1 | -1 = (Math.floor(i / roads.length) % 2 === 0 ? 1 : -1);
      const bus = i % 11 === 5;
      return {
        road: i % roads.length, alongX: r.alongX, at: r.at, lane: dir * 2.2, dir, bus,
        speed: bus ? 7 : 8 + rnd() * 6, offset: rnd() * EXTENT * 2,
        color: bus ? (i % 2 ? "#e0a326" : "#f1f1ee") : CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)],
      };
    });
  }, [count]);
  const lightsFront = useMemo(() => new THREE.MeshLambertMaterial({ color: "#f4f1e6", emissive: new THREE.Color("#fff1c9"), emissiveIntensity: 0.2 }), []);
  const lightsRear = useMemo(() => new THREE.MeshLambertMaterial({ color: "#7a1c18", emissive: new THREE.Color("#ff3b2f"), emissiveIntensity: 0.3 }), []);

  useEffect(() => {
    cars.forEach((c, i) => {
      body.current!.setColorAt(i, tmpC.set(c.color));
      cabin.current!.setColorAt(i, tmpC.set(c.bus ? c.color : "#28303a"));
    });
    for (const m of [body, cabin]) if (m.current?.instanceColor) m.current.instanceColor.needsUpdate = true;
  }, [cars]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const night = nightFactor(simNowMs());
    lightsFront.emissiveIntensity = 0.2 + night * 2.5;
    lightsRear.emissiveIntensity = 0.3 + night * 1.6;
    // traffic thins out at night: hide a share of the cars (deterministic per car)
    const busy = 0.35 + 0.65 * Math.max(occupancyAt(simNowMs()), 0.25);
    const L = EXTENT * 2;
    cars.forEach((c, i) => {
      const s = (((c.offset + t * c.speed) % L) + L) % L - EXTENT;
      const pos = c.dir * s;
      const x = c.alongX ? pos : c.at + c.lane;
      const z = c.alongX ? c.at + c.lane : pos;
      const ry = c.alongX ? (c.dir > 0 ? 0 : Math.PI) : c.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      const on = (i * 0.618) % 1 < busy ? 1 : 0.0001;
      const len = c.bus ? 2.6 : 1;
      const tall = c.bus ? 1.9 : 1;
      place(base.current!, i, x, 0.36, z, 3.9 * len * on, 0.42 * on, 1.84 * on, ry);
      place(body.current!, i, x, 0.82 * (c.bus ? 1.4 : 1), z, 4.2 * len * on, 0.62 * tall * on, 1.8 * on, ry);
      tmpO.position.set(c.bus ? 0 : -0.25, 0, 0);
      const ox = Math.cos(ry) * (c.bus ? 0 : -0.25);
      const oz = -Math.sin(ry) * (c.bus ? 0 : -0.25);
      place(cabin.current!, i, x + ox, c.bus ? 2.0 : 1.38, z + oz, (c.bus ? 10.6 : 2.3) * on, (c.bus ? 0.9 : 0.62) * on, 1.66 * on, ry);
      const fx = Math.cos(ry) * 2.1 * len;
      const fz = -Math.sin(ry) * 2.1 * len;
      place(front.current!, i, x + fx, 0.78, z + fz, 0.08 * on, 0.18 * on, 1.5 * on, ry);
      place(rear.current!, i, x - fx, 0.82, z - fz, 0.08 * on, 0.16 * on, 1.5 * on, ry);
    });
    for (const m of [base, body, cabin, front, rear]) if (m.current) m.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={base} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#1b1e22" />
      </instancedMesh>
      <instancedMesh ref={body} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={cabin} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={front} args={[undefined, lightsFront, count]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh ref={rear} args={[undefined, lightsRear, count]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </group>
  );
}

/** Parked cars on the campus car park (static). */
function CarPark() {
  const body = useRef<THREE.InstancedMesh>(null);
  const cabin = useRef<THREE.InstancedMesh>(null);
  const stripes = useRef<THREE.InstancedMesh>(null);
  const spots = useMemo(() => {
    const rnd = mulberry32(31);
    const out: [number, number, string][] = [];
    for (const x of [26.5, 34.5]) for (let z = -24; z <= 4; z += 3) if (rnd() < 0.78) out.push([x, z, CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]]);
    return out;
  }, []);
  useEffect(() => {
    spots.forEach(([x, z, c], i) => {
      place(body.current!, i, x, 0.62, z, 4.2, 0.9, 1.8, Math.PI / 2 + (x > 30 ? Math.PI : 0));
      place(cabin.current!, i, x, 1.35, z, 2.3, 0.62, 1.66, Math.PI / 2);
      body.current!.setColorAt(i, tmpC.set(c));
    });
    body.current!.instanceMatrix.needsUpdate = true;
    cabin.current!.instanceMatrix.needsUpdate = true;
    if (body.current!.instanceColor) body.current!.instanceColor.needsUpdate = true;
  }, [spots]);
  const lines = useMemo(() => {
    const out: [number, number][] = [];
    for (const x of [26.5, 34.5]) for (let z = -25.5; z <= 5.5; z += 3) out.push([x, z]);
    return out;
  }, []);
  useEffect(() => {
    lines.forEach(([x, z], i) => {
      tmpO.position.set(x, 0.03, z);
      tmpO.rotation.set(-Math.PI / 2, 0, 0);
      tmpO.scale.set(1, 1, 1);
      tmpO.updateMatrix();
      stripes.current!.setMatrixAt(i, tmpO.matrix);
    });
    stripes.current!.instanceMatrix.needsUpdate = true;
  }, [lines]);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[30.5, 0.025, -10]} receiveShadow>
        <planeGeometry args={[13, 33]} />
        <meshLambertMaterial color="#5a5f65" />
      </mesh>
      <instancedMesh ref={stripes} args={[undefined, undefined, lines.length]} frustumCulled={false}>
        <planeGeometry args={[4.6, 0.12]} />
        <meshBasicMaterial color="#e9e6dc" />
      </instancedMesh>
      {/* driveway from the avenue to the car park */}
      <mesh rotation-x={-Math.PI / 2} position={[30.5, 0.026, 12]} receiveShadow>
        <planeGeometry args={[6, 44]} />
        <meshLambertMaterial color="#5a5f65" />
      </mesh>
      <instancedMesh ref={body} args={[undefined, undefined, spots.length]} castShadow frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={cabin} args={[undefined, undefined, spots.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#28303a" />
      </instancedMesh>
    </group>
  );
}

// ------------------------------------------------------------------------------------------ pedestrians
/** Walking figures: tinted torso, fixed head, and two legs that swing (three instanced meshes). */
function Pedestrians({ count }: { count: number }) {
  const torso = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const legs = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => ({
    torso: merge([
      part(cap(0.19, 0.62), "#ffffff", [0, 1.18, 0]),
      part(cap(0.055, 0.6), "#ffffff", [-0.26, 1.12, 0]),
      part(cap(0.055, 0.6), "#ffffff", [0.26, 1.12, 0]),
    ]),
    head: merge([part(new THREE.SphereGeometry(0.115, 10, 8), "#c99a78", [0, 1.62, 0]), part(new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.6), "#241d17", [0, 1.65, -0.01])]),
    leg: part(cap(0.08, 0.86), "#2f3744", [0, -0.43, 0]),
  }), []);
  const peds = useMemo(() => {
    const rnd = mulberry32(5);
    const lanes = [
      { alongX: true, at: 38 - ROAD_W / 2 - SIDEWALK_W / 2 }, { alongX: true, at: 38 + ROAD_W / 2 + SIDEWALK_W / 2 },
      { alongX: true, at: -36 + ROAD_W / 2 + SIDEWALK_W / 2 }, { alongX: false, at: 48 - ROAD_W / 2 - SIDEWALK_W / 2 },
      { alongX: false, at: -48 + ROAD_W / 2 + SIDEWALK_W / 2 }, { alongX: true, at: 112 - ROAD_W / 2 - SIDEWALK_W / 2 },
    ];
    return Array.from({ length: count }, (_, i) => ({
      ...lanes[i % lanes.length], dir: rnd() < 0.5 ? 1 : -1, speed: 1.1 + rnd() * 0.6, offset: rnd() * 240, side: (rnd() - 0.5) * 1.2,
      shirt: ["#3b6ea8", "#c0503e", "#e3d9c6", "#2f3a46", "#6a8f5c", "#d29a3a", "#8a5a8f"][i % 7],
    }));
  }, [count]);
  useEffect(() => {
    peds.forEach((p, i) => torso.current!.setColorAt(i, tmpC.set(p.shirt)));
    if (torso.current?.instanceColor) torso.current.instanceColor.needsUpdate = true;
  }, [peds]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const L = 240;
    peds.forEach((p, i) => {
      const s = (((p.offset + t * p.speed) % L) + L) % L - L / 2;
      const pos = p.dir * s;
      const x = p.alongX ? pos : p.at + p.side;
      const z = p.alongX ? p.at + p.side : pos;
      const ry = p.alongX ? (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : p.dir > 0 ? 0 : Math.PI;
      const ph = t * 6.5 * p.speed + i * 1.7;
      const bob = Math.abs(Math.cos(ph)) * 0.04;
      place(torso.current!, i, x, 0.0 + bob, z, 1, 1, 1, ry);
      place(head.current!, i, x, 0.0 + bob, z, 1, 1, 1, ry);
      for (const k of [0, 1]) {
        tmpO.position.set(x, 0.86, z);
        tmpO.rotation.set(Math.sin(ph + k * Math.PI) * 0.6, ry, 0, "YXZ");
        tmpO.scale.set(1, 1, 1);
        // hip offset to the side of the walking direction
        const side = k === 0 ? -0.1 : 0.1;
        tmpO.position.x += Math.cos(ry) * side;
        tmpO.position.z -= Math.sin(ry) * side;
        tmpO.updateMatrix();
        legs.current!.setMatrixAt(i * 2 + k, tmpO.matrix);
      }
    });
    torso.current!.instanceMatrix.needsUpdate = true;
    head.current!.instanceMatrix.needsUpdate = true;
    legs.current!.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      <instancedMesh ref={torso} args={[geo.torso, undefined, count]} frustumCulled={false}>
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={head} args={[geo.head, undefined, count]} frustumCulled={false}>
        <meshLambertMaterial vertexColors />
      </instancedMesh>
      <instancedMesh ref={legs} args={[geo.leg, undefined, count * 2]} frustumCulled={false}>
        <meshLambertMaterial vertexColors />
      </instancedMesh>
    </group>
  );
}

// ------------------------------------------------------------------------------------------ sky life
function Clouds() {
  const puffs = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true, transparent: true, opacity: 0.94 }), []);
  const data = useMemo(() => {
    const rnd = mulberry32(404);
    const out: { x: number; y: number; z: number; s: number; speed: number }[] = [];
    for (let c = 0; c < 16; c++) {
      const cx = (rnd() - 0.5) * 640;
      const cz = (rnd() - 0.5) * 560;
      const cy = 95 + rnd() * 35;
      const speed = 1.2 + rnd() * 1.4;
      for (let k = 0; k < 6; k++) out.push({ x: cx + (k - 2.5) * 7 + rnd() * 3, y: cy + rnd() * 4, z: cz + (rnd() - 0.5) * 9, s: 6 + rnd() * 6, speed });
    }
    return out;
  }, []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const night = nightFactor(simNowMs());
    mat.color.setRGB(1 - night * 0.72, 1 - night * 0.7, 1 - night * 0.62);
    data.forEach((p, i) => {
      const x = (((p.x + t * p.speed + 320) % 640) + 640) % 640 - 320;
      place(puffs.current!, i, x, p.y, p.z, p.s, p.s * 0.55, p.s * 0.8);
    });
    puffs.current!.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={puffs} args={[undefined, mat, data.length]} frustumCulled={false}>
      <icosahedronGeometry args={[1, 1]} />
    </instancedMesh>
  );
}

function Airplane({ altitude, z0, z1, period, phase, dir }: { altitude: number; z0: number; z1: number; period: number; phase: number; dir: 1 | -1 }) {
  const g = useRef<THREE.Group>(null);
  const strobe = useRef<THREE.Mesh>(null);
  const beacon = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const t = (state.clock.elapsedTime + phase) % period;
    const f = t / period;
    const x = dir * (-460 + f * 920);
    const z = z0 + (z1 - z0) * f;
    if (g.current) {
      g.current.position.set(x, altitude, z);
      g.current.rotation.y = Math.atan2(dir * 920, z1 - z0) - Math.PI / 2;
    }
    const e = state.clock.elapsedTime;
    if (strobe.current) strobe.current.visible = e % 1.2 < 0.08;
    if (beacon.current) beacon.current.visible = e % 1.0 < 0.5;
  });
  return (
    <group ref={g} scale={1.6}>
      <mesh rotation-z={Math.PI / 2}>
        <capsuleGeometry args={[0.55, 6, 4, 10]} />
        <meshLambertMaterial color="#f4f5f6" />
      </mesh>
      <mesh position={[0.2, -0.15, 0]}>
        <boxGeometry args={[1.5, 0.12, 8.4]} />
        <meshLambertMaterial color="#e3e6e9" />
      </mesh>
      <mesh position={[-3.2, 0.9, 0]}>
        <boxGeometry args={[1.1, 1.6, 0.12]} />
        <meshLambertMaterial color="#1f5fbf" />
      </mesh>
      <mesh position={[-3.3, 0.15, 0]}>
        <boxGeometry args={[0.8, 0.1, 3]} />
        <meshLambertMaterial color="#e3e6e9" />
      </mesh>
      <mesh position={[0.2, -0.15, 4.25]}>
        <sphereGeometry args={[0.14, 6, 6]} />
        <meshBasicMaterial color="#35ff5a" fog={false} />
      </mesh>
      <mesh position={[0.2, -0.15, -4.25]}>
        <sphereGeometry args={[0.14, 6, 6]} />
        <meshBasicMaterial color="#ff3030" fog={false} />
      </mesh>
      <mesh ref={strobe} position={[-3.6, 1.7, 0]}>
        <sphereGeometry args={[0.22, 6, 6]} />
        <meshBasicMaterial color="#ffffff" fog={false} />
      </mesh>
      <mesh ref={beacon} position={[0, -0.6, 0]}>
        <sphereGeometry args={[0.16, 6, 6]} />
        <meshBasicMaterial color="#ff4a3a" fog={false} />
      </mesh>
    </group>
  );
}

/** The whole city: streets, buildings, park, car park, traffic, pedestrians, clouds and aircraft. */
export function City() {
  const quality = useUi((s) => s.quality);
  const q = QUALITY[quality];
  const lots = useLots(q.cityDensity);
  return (
    <group>
      <Streets />
      <Buildings lots={lots} />
      <StreetLights />
      <CarPark />
      <Traffic count={q.cars} />
      {q.pedestrians > 0 && <Pedestrians count={q.pedestrians} />}
      {q.clouds && <Clouds />}
      <Airplane altitude={150} z0={-140} z1={60} period={46} phase={0} dir={1} />
      <Airplane altitude={185} z0={120} z1={-30} period={62} phase={23} dir={-1} />
    </group>
  );
}
