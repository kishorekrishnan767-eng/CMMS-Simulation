import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { useAssets } from "../api/queries";
import { simNowMs, useLive } from "../store/live";
import { FLOOR_H, SLAB_T, mulberry32, occupancyAt } from "./constants";
import { BMS_ROOM, BOARDROOM, EMPLOYEES, EXEC_OFFICES, MEETING_NE, SERVER_ROOM, WORKSTATIONS, type Workstation } from "./office";
import { cap, merge, part } from "./Person";

const WALL_H = FLOOR_H - SLAB_T;
const NAMED = new Set(EMPLOYEES.map((e) => e.seat.id));
type V3 = [number, number, number];

const tmpO = new THREE.Object3D();
const tmpC = new THREE.Color();
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);

// ------------------------------------------------------------------------------------------ geometry kits
/** Desk + chair + monitor frame + keyboard, in the workstation's local frame (person at −z, faces +z). */
function deskGeometry() {
  const wood = "#cdb894";
  const metal = "#3b4148";
  const dark = "#22262b";
  const chair = "#30363d";
  const p = [
    part(box(1.6, 0.04, 0.8), wood, [0, 0.74, 0]),
    part(box(0.04, 0.72, 0.7), metal, [-0.74, 0.36, 0]),
    part(box(0.04, 0.72, 0.7), metal, [0.74, 0.36, 0]),
    part(box(1.4, 0.3, 0.02), "#b9a47f", [0, 0.58, 0.3]),
    part(box(0.14, 0.2, 0.04), dark, [0, 0.86, 0.2]),
    part(box(0.6, 0.35, 0.026), dark, [0, 1.0, 0.2]),
    part(box(0.42, 0.012, 0.14), "#2b3036", [0, 0.765, -0.14]),
    part(box(0.07, 0.016, 0.1), "#2b3036", [0.34, 0.765, -0.12]),
    part(cyl(0.04, 0.035, 0.1), "#f1f1ee", [-0.55, 0.81, 0.05]),
    // chair
    part(box(0.46, 0.06, 0.44), chair, [0, 0.46, -0.95]),
    part(box(0.44, 0.52, 0.05), "#3e6fa8", [0, 0.78, -1.18], [-0.08, 0, 0]),
    part(cyl(0.025, 0.025, 0.4, 8), "#888f96", [0, 0.24, -0.95]),
    part(box(0.5, 0.03, 0.06), dark, [0, 0.05, -0.95]),
    part(box(0.06, 0.03, 0.5), dark, [0, 0.05, -0.95]),
    part(box(0.05, 0.04, 0.3), dark, [-0.25, 0.62, -0.97]),
    part(box(0.05, 0.04, 0.3), dark, [0.25, 0.62, -0.97]),
  ];
  return merge(p);
}

/** Seated staff: `tint` takes the per-instance shirt colour, `fixed` carries skin / hair / trousers. */
function staffGeometry() {
  const skin = "#c9a083";
  const hair = "#2a211a";
  const pants = "#303744";
  const white = "#ffffff";
  const rig = new THREE.Object3D();
  const body = new THREE.Object3D();
  body.position.set(0, -0.44, -0.08);
  rig.add(body);
  const j = (parent: THREE.Object3D, pos: V3, rot: V3 = [0, 0, 0]) => {
    const o = new THREE.Object3D();
    o.position.set(...pos);
    o.rotation.set(...rot);
    parent.add(o);
    return o;
  };
  const hipL = j(body, [-0.11, 0.92, 0], [-1.5, 0, 0]);
  const hipR = j(body, [0.11, 0.92, 0], [-1.5, 0, 0]);
  const kneeL = j(hipL, [0, -0.44, 0], [1.55, 0, 0]);
  const kneeR = j(hipR, [0, -0.44, 0], [1.55, 0, 0]);
  const torso = j(body, [0, 0.92, 0], [0.24, 0, 0]);
  const head = j(torso, [0, 0.66, 0], [0.15, 0, 0]);
  const armL = j(torso, [-0.25, 0.5, 0], [-0.9, 0, 0]);
  const armR = j(torso, [0.25, 0.5, 0], [-0.9, 0, 0]);
  const elbowL = j(armL, [0, -0.28, 0], [-1.1, 0, 0]);
  const elbowR = j(armR, [0, -0.28, 0], [-1.1, 0, 0]);
  rig.updateMatrixWorld(true);
  const at = (o: THREE.Object3D, g: THREE.BufferGeometry) => g.applyMatrix4(o.matrixWorld);
  const tint = [
    at(torso, part(cap(0.19, 0.6), white, [0, 0.34, 0])),
    at(torso, part(new THREE.SphereGeometry(0.075, 8, 6), white, [-0.2, 0.55, 0])),
    at(torso, part(new THREE.SphereGeometry(0.075, 8, 6), white, [0.2, 0.55, 0])),
    at(armL, part(cap(0.062, 0.3), white, [0, -0.15, 0])),
    at(armR, part(cap(0.062, 0.3), white, [0, -0.15, 0])),
  ];
  const fixed = [
    at(torso, part(box(0.34, 0.16, 0.2), pants, [0, 0.06, 0])),
    at(head, part(new THREE.SphereGeometry(0.12, 12, 9), skin, [0, 0.15, 0], [0, 0, 0], [0.95, 1.06, 1])),
    at(head, part(new THREE.SphereGeometry(0.128, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), hair, [0, 0.17, -0.012], [-0.15, 0, 0])),
    at(elbowL, part(cap(0.05, 0.28), skin, [0, -0.14, 0])),
    at(elbowR, part(cap(0.05, 0.28), skin, [0, -0.14, 0])),
    at(hipL, part(cap(0.085, 0.46), pants, [0, -0.23, 0])),
    at(hipR, part(cap(0.085, 0.46), pants, [0, -0.23, 0])),
    at(kneeL, part(cap(0.075, 0.44), pants, [0, -0.22, 0])),
    at(kneeR, part(cap(0.075, 0.44), pants, [0, -0.22, 0])),
    at(kneeL, part(box(0.13, 0.09, 0.27), "#24201c", [0, -0.44, 0.05])),
    at(kneeR, part(box(0.13, 0.09, 0.27), "#24201c", [0, -0.44, 0.05])),
  ];
  return { tint: merge(tint), fixed: merge(fixed) };
}

function plantGeometry() {
  return merge([
    part(cyl(0.22, 0.17, 0.45, 12), "#d9d5cc", [0, 0.225, 0]),
    part(new THREE.IcosahedronGeometry(0.4, 1), "#4d8a4f", [0, 0.85, 0], [0, 0, 0], [1, 1.25, 1]),
    part(new THREE.IcosahedronGeometry(0.27, 1), "#5f9d58", [0.18, 1.2, 0.08]),
    part(new THREE.IcosahedronGeometry(0.24, 1), "#437a47", [-0.2, 1.0, -0.12]),
  ]);
}

function rackGeometry() {
  const p = [part(box(0.62, 2.0, 1.0), "#20252b", [0, 1.0, 0]), part(box(0.56, 1.86, 0.02), "#14181c", [0, 1.0, 0.51])];
  for (let i = 0; i < 9; i++) {
    p.push(part(box(0.5, 0.1, 0.012), i % 3 === 0 ? "#3a424b" : "#2b3138", [0, 0.22 + i * 0.19, 0.52]));
  }
  return merge(p);
}

/** Wall segments around a rectangle; `door` cuts a gap of `w` metres centred at `at` on `side`. */
function wallSegments(r: { x0: number; x1: number; z0: number; z1: number }, door?: { side: "n" | "s" | "e" | "w"; at: number; w: number }, skip: ("n" | "s" | "e" | "w")[] = []) {
  const segs: { x: number; z: number; len: number; alongX: boolean }[] = [];
  const add = (side: "n" | "s" | "e" | "w", a: number, b: number, fixed: number, alongX: boolean) => {
    if (skip.includes(side)) return;
    const cuts: [number, number][] = door && door.side === side ? [[a, door.at - door.w / 2], [door.at + door.w / 2, b]] : [[a, b]];
    for (const [s, e] of cuts) if (e - s > 0.05) segs.push(alongX ? { x: (s + e) / 2, z: fixed, len: e - s, alongX } : { x: fixed, z: (s + e) / 2, len: e - s, alongX });
  };
  add("n", r.x0, r.x1, r.z0, true);
  add("s", r.x0, r.x1, r.z1, true);
  add("w", r.z0, r.z1, r.x0, false);
  add("e", r.z0, r.z1, r.x1, false);
  return segs;
}

/** Glazed room: slim dark frames (opaque) and glass panes (transparent), as two merged geometries. */
function glassRoomGeometry(segs: ReturnType<typeof wallSegments>, h = WALL_H - 0.05) {
  const frame: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  for (const s of segs) {
    const size = (len: number, hh: number, t: number): V3 => (s.alongX ? [len, hh, t] : [t, hh, len]);
    glass.push(part(box(...size(s.len, h - 0.12, 0.025)), "#ffffff", [s.x, h / 2, s.z]));
    frame.push(part(box(...size(s.len, 0.07, 0.07)), "#2f353b", [s.x, h - 0.04, s.z]));
    frame.push(part(box(...size(s.len, 0.1, 0.07)), "#2f353b", [s.x, 0.05, s.z]));
    const n = Math.max(1, Math.round(s.len / 2.2));
    for (let i = 0; i <= n; i++) {
      const o = -s.len / 2 + (s.len * i) / n;
      frame.push(part(box(...(s.alongX ? ([0.06, h, 0.07] as V3) : ([0.07, h, 0.06] as V3))), "#2f353b", s.alongX ? [s.x + o, h / 2, s.z] : [s.x, h / 2, s.z + o]));
    }
  }
  return { frame: merge(frame), glass: merge(glass) };
}

// ------------------------------------------------------------------------------------------ textures
function codeScreenTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 80;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16202b";
  g.fillRect(0, 0, 128, 80);
  g.fillStyle = "#1f2c3a";
  g.fillRect(0, 0, 128, 7);
  const rnd = mulberry32(3);
  const cols = ["#7fb2e8", "#9bd18b", "#e8b86f", "#c9a0e6", "#d4d8dc"];
  for (let y = 12; y < 76; y += 6) {
    let x = 6 + Math.floor(rnd() * 3) * 6;
    while (x < 112) {
      const w = 6 + Math.floor(rnd() * 22);
      g.fillStyle = cols[Math.floor(rnd() * cols.length)];
      g.fillRect(x, y, w, 3);
      x += w + 4;
      if (rnd() < 0.12) break;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function floorTexture(kind: "carpet" | "wood" | "tile") {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const rnd = mulberry32(kind.length * 17);
  if (kind === "wood") {
    g.fillStyle = "#b99c78";
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = `rgba(${90 + rnd() * 40},${60 + rnd() * 30},${30 + rnd() * 20},0.22)`;
      g.fillRect(0, i * 16, 128, 16);
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.fillRect(0, i * 16, 128, 1);
      g.fillRect(Math.floor(rnd() * 120), i * 16, 1, 16);
    }
  } else if (kind === "carpet") {
    g.fillStyle = "#9ea5ad";
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2200; i++) {
      g.fillStyle = `rgba(${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},0.05)`;
      g.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    g.strokeStyle = "rgba(0,0,0,0.16)";
    g.strokeRect(0.5, 0.5, 127, 127);
    g.strokeRect(0.5, 0.5, 63, 63);
    g.strokeRect(64.5, 64.5, 63, 63);
  } else {
    g.fillStyle = "#c9ccd0";
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(0,0,0,0.14)";
    g.strokeRect(0.5, 0.5, 127, 127);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(kind === "wood" ? 8 : 10, kind === "wood" ? 5 : 6);
  t.anisotropy = 4;
  return t;
}

const FLOOR_KIND: Record<number, "carpet" | "wood" | "tile"> = { 0: "tile", 1: "carpet", 2: "carpet", 3: "carpet", 4: "carpet", 5: "wood" };

// ------------------------------------------------------------------------------------------ Prasath's screen
/** Shows prasad.jpg as a wallpaper on Prasath's monitor. Rendered as a separate mesh so it can have its own texture. */
function PrasathScreen() {
  const tex = useTexture("/prasad.jpg");
  const prasad = EMPLOYEES.find((e) => e.id === "EMP-PRASATH");
  if (!prasad) return null;
  // The screen plane in deskGeometry is 0.56×0.31 at y=1.0, z=0.185 in the desk's local frame.
  // We overlay this separate mesh at Prasath's desk position so it can carry its own texture.
  const { dx, dz, yaw } = prasad.seat;
  // Screen local offset: [0, 1.0, 0.185] rotated by yaw around Y
  const wx = dx + Math.sin(yaw) * 0.185;
  const wz = dz + Math.cos(yaw) * 0.185;
  return (
    <mesh position={[wx, 1.0, wz]} rotation={[0, yaw + Math.PI, 0]}>
      <planeGeometry args={[0.56, 0.31]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
  );
}

// ------------------------------------------------------------------------------------------ BMS video wall
const ASSET_SHORT: Record<string, string> = { SUPPLY_FAN: "Supply fan", EXHAUST_FAN: "Exhaust fan", CHILLER: "Chiller", PUMP: "Pump", FCU: "AC unit" };

/** Live BMS wall: every asset with its health and vibration, redrawn once a second from the real store. */
function BmsWall({ position }: { position: V3 }) {
  const { data: assets } = useAssets();
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 360;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
  const last = useRef(0);
  const ref = useRef(assets);
  ref.current = assets;
  useFrame((state) => {
    if (state.clock.elapsedTime - last.current < 1) return;
    last.current = state.clock.elapsedTime;
    const live = useLive.getState();
    const c = tex.image as HTMLCanvasElement;
    const g = c.getContext("2d")!;
    g.fillStyle = "#0e1319";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#1c2630";
    g.fillRect(0, 0, c.width, 54);
    g.fillStyle = "#e9eef2";
    g.font = "600 28px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText("Livewire BMS · Building overview", 24, 28);
    g.textAlign = "right";
    g.fillStyle = "#8fa0ad";
    g.font = "500 22px ui-monospace, Consolas, monospace";
    const d = new Date(simNowMs());
    g.fillText(`${d.toISOString().slice(0, 10)}  ${d.toISOString().slice(11, 19)} UTC · SIMULATED`, c.width - 24, 28);
    g.textAlign = "left";
    const list = [...(ref.current ?? [])].sort((a, b) => a.floor_level - b.floor_level || a.id.localeCompare(b.id));
    const colW = 420;
    const rowH = 46;
    list.forEach((a, i) => {
      const col = Math.floor(i / 6);
      const row = i % 6;
      const x = 24 + col * (colW + 12);
      const y = 78 + row * rowH;
      const h = live.health[a.id] ?? a.health_state;
      const colr = h === "ANOMALY" ? "#ec5e58" : h === "WATCH" ? "#e2a038" : "#4aba74";
      g.fillStyle = h === "ANOMALY" ? "rgba(236,94,88,0.14)" : "rgba(255,255,255,0.03)";
      g.fillRect(x - 8, y - 4, colW, rowH - 4);
      g.fillStyle = colr;
      g.beginPath();
      g.arc(x + 8, y + 17, 8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#e9eef2";
      g.font = "600 20px ui-monospace, Consolas, monospace";
      g.fillText(a.id, x + 28, y + 12);
      g.fillStyle = "#8fa0ad";
      g.font = "500 16px Inter, system-ui, sans-serif";
      g.fillText(`${ASSET_SHORT[a.asset_type] ?? a.asset_type} · ${a.floor_level < 0 ? "B1" : a.floor_level === 0 ? "G" : a.floor_level === 6 ? "Roof" : `F${a.floor_level}`}`, x + 28, y + 32);
      const v = live.values[a.id]?.vibration_velocity;
      g.textAlign = "right";
      g.fillStyle = colr;
      g.font = "600 20px ui-monospace, Consolas, monospace";
      g.fillText(v === undefined ? "—" : `${v.toFixed(2)} mm/s`, x + colW - 22, y + 12);
      g.fillStyle = "#8fa0ad";
      g.font = "500 16px Inter, system-ui, sans-serif";
      g.fillText(h === "ANOMALY" ? "early warning" : h === "WATCH" ? "watching" : "normal", x + colW - 22, y + 32);
      g.textAlign = "left";
    });
    tex.needsUpdate = true;
  });
  return (
    <group position={position}>
      <mesh>
        <planeGeometry args={[9.9, 2.8]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, -0.03]}>
        <boxGeometry args={[10.1, 3.0, 0.05]} />
        <meshStandardMaterial color="#1b2026" roughness={0.5} />
      </mesh>
      <mesh position={[0, -1.56, 0.0]}>
        <boxGeometry args={[10.1, 0.06, 0.06]} />
        <meshBasicMaterial color="#4f8fe0" toneMapped={false} />
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------------------------------------ the interior
function place(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, ry: number, s = 1) {
  tmpO.position.set(x, y, z);
  tmpO.rotation.set(0, ry, 0);
  tmpO.scale.setScalar(s);
  tmpO.updateMatrix();
  m.setMatrixAt(i, tmpO.matrix);
}

const PLANTS: Record<number, [number, number][]> = {
  1: [[-18.5, 11], [4.5, 3], [18.5, -10.5], [-18.5, -1]],
  2: [[-10.5, 11], [4.5, 3], [18.5, -10.5], [-18.5, -1]],
  3: [[-2.2, 11], [4.5, 3], [18.5, -10.5], [-18.5, -1]],
  4: [[-18.5, 11], [4.5, 3], [13, -11], [-18.5, -1]],
  5: [[-8.5, 11], [3.5, 11], [18.5, -10.5], [-18.5, -1], [5, -2]],
};

/** Furniture, staff and rooms of one floor. `ghost` is the parent floor's x-ray / isolation factor. */
export function Interior({ level, ghost }: { level: number; ghost: MutableRefObject<number> }) {
  const stations = WORKSTATIONS[level] ?? [];
  const desks = useRef<THREE.InstancedMesh>(null);
  const screens = useRef<THREE.InstancedMesh>(null);
  const tint = useRef<THREE.InstancedMesh>(null);
  const fixed = useRef<THREE.InstancedMesh>(null);
  const plants = useRef<THREE.InstancedMesh>(null);
  const racks = useRef<THREE.InstancedMesh>(null);
  const leds = useRef<THREE.InstancedMesh>(null);
  const kit = useMemo(() => ({
    desk: deskGeometry(), staff: staffGeometry(), plant: plantGeometry(), rack: rackGeometry(),
    screen: new THREE.PlaneGeometry(0.56, 0.31).rotateY(Math.PI).translate(0, 1.0, 0.185), // faces the seated person (−z)
  }), []);
  const mats = useMemo(() => {
    const std = (extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, ...extra });
    const tex = floorTexture(FLOOR_KIND[level] ?? "carpet");
    return {
      furn: std(),
      staffTint: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
      staffFixed: std({ roughness: 0.85 }),
      screen: new THREE.MeshBasicMaterial({ map: codeScreenTexture(), toneMapped: false }),
      floor: new THREE.MeshStandardMaterial({ map: tex, roughness: level === 5 ? 0.45 : 0.92 }),
      glass: new THREE.MeshStandardMaterial({ color: "#bcd3e2", roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.16, depthWrite: false }),
      frame: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }),
      led: new THREE.MeshBasicMaterial({ color: "#6dd3a4", toneMapped: false }),
    };
  }, [level]);
  const rand = useMemo(() => {
    const r = mulberry32(900 + level);
    return stations.map(() => ({ threshold: 0.12 + r() * 0.8, shirt: ["#d9dee3", "#6f95b8", "#b98a5e", "#8a9a7b", "#c46a5a", "#4d5b6a", "#e3d9c6", "#7a6f9a"][Math.floor(r() * 8)], phase: r() * 6.28, scale: 0 }));
  }, [stations, level]);

  const rooms = useMemo(() => {
    const out: { key: string; segs: ReturnType<typeof wallSegments> }[] = [];
    if (level === 1 || level === 4) out.push({ key: "meet", segs: wallSegments(MEETING_NE, { side: "s", at: 8.7, w: 1.4 }) });
    if (level === 2) out.push({ key: "server", segs: wallSegments(SERVER_ROOM, { side: "e", at: 10, w: 1.4 }) });
    if (level === 3) out.push({ key: "bms", segs: wallSegments(BMS_ROOM, { side: "e", at: 10.6, w: 2.0 }, ["s", "w", "n"]) });
    if (level === 5) {
      out.push({ key: "board", segs: wallSegments(BOARDROOM, { side: "n", at: -2.5, w: 1.4 }) });
      out.push({ key: "exec", segs: wallSegments(EXEC_OFFICES, { side: "e", at: 7.5, w: 1.4 }) });
    }
    return out.map((r) => ({ ...r, geo: glassRoomGeometry(r.segs) }));
  }, [level]);

  useEffect(() => {
    stations.forEach((w, i) => {
      place(desks.current!, i, w.dx, 0, w.dz, w.yaw);
      place(screens.current!, i, w.dx, 0, w.dz, w.yaw);
      tmpC.set(0.85 + ((i * 37) % 10) / 70, 0.85 + ((i * 17) % 10) / 70, 0.9);
      screens.current!.setColorAt(i, tmpC);
      place(fixed.current!, i, w.sx, 0, w.sz, w.yaw, 0.0001);
      tint.current!.setColorAt(i, tmpC.set(rand[i].shirt));
    });
    for (const m of [desks, screens, tint, fixed]) if (m.current) m.current.instanceMatrix.needsUpdate = true;
    for (const m of [screens, tint]) if (m.current?.instanceColor) m.current.instanceColor.needsUpdate = true;
    (PLANTS[level] ?? []).forEach(([x, z], i) => place(plants.current!, i, x, 0, z, i));
    plants.current!.instanceMatrix.needsUpdate = true;
    if (racks.current && leds.current) {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const x = -17.6 + (i % 4) * 1.5;
        const z = i < 4 ? 6.2 : 9.8;
        place(racks.current, i, x, 0, z, i < 4 ? Math.PI : 0);
        tmpO.position.set(x, 1.4, z + (i < 4 ? -0.53 : 0.53));
        tmpO.rotation.set(0, 0, 0);
        tmpO.scale.set(0.4, 0.05, 0.01);
        tmpO.updateMatrix();
        leds.current.setMatrixAt(i, tmpO.matrix);
      }
      racks.current.instanceMatrix.needsUpdate = true;
      leds.current.instanceMatrix.needsUpdate = true;
    }
  }, [stations, rand, level]);

  useFrame((state, delta) => {
    const k = ghost.current;
    const o = 1 - k * 0.9;
    for (const m of [mats.furn, mats.staffTint, mats.staffFixed, mats.floor, mats.frame]) {
      m.opacity = o;
      m.transparent = k > 0.02;
      m.depthWrite = k < 0.5;
    }
    mats.glass.opacity = 0.16 * o;
    const sim = simNowMs();
    const occ = occupancyAt(sim);
    const t = state.clock.elapsedTime;
    // staff: present while the office is busy; ease in/out, keep working (typing sway)
    const dt = Math.min(delta, 0.05);
    stations.forEach((w: Workstation, i) => {
      const r = rand[i];
      const want = NAMED.has(w.id) ? 0 : occ > r.threshold ? 1 : 0;
      r.scale += (want - r.scale) * Math.min(1, dt * 3.5 + 0.02);
      const s = Math.max(0.0001, r.scale);
      const sway = Math.sin(t * 1.3 + r.phase) * 0.03;
      tmpO.position.set(w.sx, 0, w.sz);
      tmpO.rotation.set(Math.sin(t * 5 + r.phase) * 0.006, w.yaw + sway, 0);
      tmpO.scale.setScalar(s);
      tmpO.updateMatrix();
      fixed.current!.setMatrixAt(i, tmpO.matrix);
      tint.current!.setMatrixAt(i, tmpO.matrix);
    });
    fixed.current!.instanceMatrix.needsUpdate = true;
    tint.current!.instanceMatrix.needsUpdate = true;
    if (leds.current) mats.led.color.set(Math.sin(t * 6) > 0.2 ? "#6dd3a4" : "#2f7a5a");
  });

  const wallZ = BMS_ROOM.wallZ;
  return (
    <group>
      {/* floor finish */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, 0]} material={mats.floor} receiveShadow>
        <planeGeometry args={[39.4, 23.4]} />
      </mesh>

      <instancedMesh ref={desks} args={[kit.desk, mats.furn, stations.length]} frustumCulled={false} />
      <instancedMesh ref={screens} args={[kit.screen, mats.screen, stations.length]} frustumCulled={false} />
      <instancedMesh ref={tint} args={[kit.staff.tint, mats.staffTint, stations.length]} frustumCulled={false} />
      <instancedMesh ref={fixed} args={[kit.staff.fixed, mats.staffFixed, stations.length]} frustumCulled={false} />
      <instancedMesh ref={plants} args={[kit.plant, mats.furn, (PLANTS[level] ?? []).length || 1]} frustumCulled={false} />

      {/* Prasath's monitor: show his photo as a wallpaper on his specific screen */}
      {level === 1 && <PrasathScreen />}

      {rooms.map((r) => (
        <group key={r.key}>
          <mesh geometry={r.geo.frame} material={mats.frame} />
          <mesh geometry={r.geo.glass} material={mats.glass} renderOrder={5} />
        </group>
      ))}

      {(level === 1 || level === 4) && <MeetingRoom label={level === 1 ? "Stand-up room" : "Project room"} />}
      {level === 2 && (
        <group>
          <instancedMesh ref={racks} args={[kit.rack, mats.furn, 8]} frustumCulled={false} />
          <instancedMesh ref={leds} args={[undefined, mats.led, 8]} frustumCulled={false}>
            <boxGeometry args={[1, 1, 1]} />
          </instancedMesh>
          <mesh rotation-x={-Math.PI / 2} position={[(SERVER_ROOM.x0 + SERVER_ROOM.x1) / 2, 0.02, (SERVER_ROOM.z0 + SERVER_ROOM.z1) / 2]}>
            <planeGeometry args={[SERVER_ROOM.x1 - SERVER_ROOM.x0, SERVER_ROOM.z1 - SERVER_ROOM.z0]} />
            <meshStandardMaterial color="#5a6269" roughness={0.6} />
          </mesh>
        </group>
      )}
      {level === 3 && (
        <group>
          <BmsWall position={[(BMS_ROOM.x0 + BMS_ROOM.x1) / 2, 2.3, wallZ + 0.05]} />
          <mesh rotation-x={-Math.PI / 2} position={[(BMS_ROOM.x0 + BMS_ROOM.x1) / 2, 0.02, (BMS_ROOM.z0 + BMS_ROOM.z1) / 2]}>
            <planeGeometry args={[BMS_ROOM.x1 - BMS_ROOM.x0, BMS_ROOM.z1 - BMS_ROOM.z0]} />
            <meshStandardMaterial color="#454d55" roughness={0.9} />
          </mesh>
        </group>
      )}
      {level === 5 && <Boardroom />}
    </group>
  );
}

function MeetingRoom({ label }: { label: string }) {
  const cx = (MEETING_NE.x0 + MEETING_NE.x1) / 2;
  const cz = (MEETING_NE.z0 + MEETING_NE.z1) / 2;
  const sign = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = "#24292f";
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = "#f4f5f6";
    g.font = "600 24px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText(label, 18, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [label]);
  return (
    <group>
      <mesh position={[cx, 0.74, cz]} castShadow>
        <boxGeometry args={[3.6, 0.05, 1.4]} />
        <meshStandardMaterial color="#b89b7a" roughness={0.5} />
      </mesh>
      {[-1.4, 0, 1.4].flatMap((x) => [-1, 1].map((s) => (
        <mesh key={`${x}${s}`} position={[cx + x, 0.45, cz + s * 1.0]}>
          <boxGeometry args={[0.45, 0.9, 0.45]} />
          <meshStandardMaterial color="#30363d" roughness={0.7} />
        </mesh>
      )))}
      <mesh position={[cx, 1.8, MEETING_NE.z0 + 0.1]}>
        <boxGeometry args={[2.4, 1.35, 0.05]} />
        <meshStandardMaterial color="#14181c" roughness={0.4} />
      </mesh>
      <mesh position={[cx, 1.8, MEETING_NE.z0 + 0.14]}>
        <planeGeometry args={[2.3, 1.25]} />
        <meshBasicMaterial color="#223244" toneMapped={false} />
      </mesh>
      <mesh position={[MEETING_NE.x0 + 1.3, 2.9, MEETING_NE.z1 - 0.08]} rotation-y={Math.PI}>
        <planeGeometry args={[1.8, 0.45]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Boardroom() {
  const cx = (BOARDROOM.x0 + BOARDROOM.x1) / 2;
  const cz = (BOARDROOM.z0 + BOARDROOM.z1) / 2;
  return (
    <group>
      <mesh position={[cx, 0.76, cz]} castShadow>
        <boxGeometry args={[6.2, 0.08, 1.9]} />
        <meshStandardMaterial color="#3a2d25" roughness={0.35} />
      </mesh>
      {Array.from({ length: 6 }, (_, i) => -2.5 + i).flatMap((x) => [-1, 1].map((s) => (
        <mesh key={`${x}${s}`} position={[cx + x + 0.25, 0.5, cz + s * 1.3]}>
          <boxGeometry args={[0.5, 1.0, 0.5]} />
          <meshStandardMaterial color="#20252a" roughness={0.6} />
        </mesh>
      )))}
      <mesh position={[cx, 1.9, BOARDROOM.z0 + 0.1]}>
        <boxGeometry args={[3.4, 1.7, 0.05]} />
        <meshStandardMaterial color="#14181c" />
      </mesh>
      <mesh position={[cx, 1.9, BOARDROOM.z0 + 0.14]}>
        <planeGeometry args={[3.3, 1.6]} />
        <meshBasicMaterial color="#1d3552" toneMapped={false} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <group key={i} position={[EXEC_OFFICES.x0 + 1.9 + i * 3.1, 0, 9.3]}>
          <mesh position={[0, 0.74, 0]}>
            <boxGeometry args={[1.7, 0.05, 0.85]} />
            <meshStandardMaterial color="#4b3a2e" roughness={0.4} />
          </mesh>
          <mesh position={[0, 0.5, 0.9]}>
            <boxGeometry args={[0.6, 0.9, 0.6]} />
            <meshStandardMaterial color="#2a2f35" />
          </mesh>
        </group>
      ))}
    </group>
  );
}
