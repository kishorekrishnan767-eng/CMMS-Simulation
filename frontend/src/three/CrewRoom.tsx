import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useTechnicians, useWorkOrders } from "../api/queries";
import { useUi } from "../store/ui";
import { CREW_ROOM, CREW_SEATS, FLOOR_H, SLAB_T, TOOL_CABINET } from "./constants";

const W = CREW_ROOM.x1 - CREW_ROOM.x0;
const D = CREW_ROOM.z1 - CREW_ROOM.z0;
const CX = (CREW_ROOM.x0 + CREW_ROOM.x1) / 2;
const CZ = (CREW_ROOM.z0 + CREW_ROOM.z1) / 2;
const WALL_H = FLOOR_H - SLAB_T;
const DADO = 1.0;
const DOOR = { z0: CREW_ROOM.doorZ - 0.8, z1: CREW_ROOM.doorZ + 0.8 };
const TABLE = { x: -15.5, z: -7.4, w: 3.0, d: 1.2 };

const STATUS_TEXT: Record<string, string> = {
  AVAILABLE: "In crew room", TRAVELING: "Travelling", ON_SITE: "On site", RETURNING: "Returning",
};

/** Live crew board on the crew-room wall: one row per technician, drawn from the API (no fake data). */
function useCrewBoard() {
  const { data: techs } = useTechnicians();
  const { data: wos } = useWorkOrders("&active=true");
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 300;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
  useEffect(() => {
    const c = tex.image as HTMLCanvasElement;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1d2126";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#f1f3f5";
    g.font = "600 26px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText("Maintenance crew", 24, 34);
    g.fillStyle = "#8f98a3";
    g.font = "500 15px Inter, system-ui, sans-serif";
    const open = (wos?.items ?? []).length;
    g.fillText(`${open} active work order${open === 1 ? "" : "s"}`, 300, 36);
    g.fillStyle = "#3a4048";
    g.fillRect(24, 60, c.width - 48, 2);
    (techs ?? []).forEach((t, i) => {
      const y = 96 + i * 62;
      g.fillStyle = t.color;
      g.fillRect(24, y - 20, 8, 40);
      g.fillStyle = "#f1f3f5";
      g.font = "600 20px Inter, system-ui, sans-serif";
      g.fillText(t.name, 46, y - 8);
      g.fillStyle = "#8f98a3";
      g.font = "500 14px Inter, system-ui, sans-serif";
      g.fillText(t.skills.map((s) => s.toLowerCase().replace("_", " ")).join(" · "), 46, y + 14);
      const job = t.active_jobs[0];
      const status = t.on_shift ? STATUS_TEXT[t.status] ?? t.status : "Off shift";
      g.textAlign = "right";
      g.fillStyle = t.status === "AVAILABLE" ? "#7fd39c" : t.on_shift ? "#f2b04f" : "#8f98a3";
      g.font = "600 17px Inter, system-ui, sans-serif";
      g.fillText(status, c.width - 24, y - 8);
      g.fillStyle = "#b8c0c8";
      g.font = "500 14px ui-monospace, Consolas, monospace";
      g.fillText(job ? `${job.number} · ${job.asset_id}` : "—", c.width - 24, y + 14);
      g.textAlign = "left";
    });
    tex.needsUpdate = true;
  }, [techs, wos, tex]);
  return tex;
}

function signTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#24292f";
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = "#f08c00";
  g.fillRect(0, 0, 8, 64);
  g.fillStyle = "#f4f5f6";
  g.font = "600 22px Inter, system-ui, sans-serif";
  g.textBaseline = "middle";
  g.fillText("Maintenance crew", 22, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Ground-floor crew room (floor-local coordinates): glazed partitions above a solid dado so the room
 * can be seen from outside, a table with one chair per technician, lockers, the tool cabinet they
 * stop at on the way out, and a live crew board.
 */
export function CrewRoom() {
  const group = useRef<THREE.Group>(null);
  const board = useCrewBoard();
  const sign = useMemo(() => signTexture(), []);
  const m = useMemo(() => ({
    floor: new THREE.MeshStandardMaterial({ color: "#6d7a84", roughness: 0.55, metalness: 0.05 }),
    dado: new THREE.MeshStandardMaterial({ color: "#d7dbdf", roughness: 0.85 }),
    glass: new THREE.MeshStandardMaterial({ color: "#b9cad6", roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.18, depthWrite: false }),
    frame: new THREE.MeshStandardMaterial({ color: "#3a4148", roughness: 0.5, metalness: 0.4 }),
    table: new THREE.MeshStandardMaterial({ color: "#b89b7a", roughness: 0.6 }),
    chair: new THREE.MeshStandardMaterial({ color: "#2f353c", roughness: 0.7 }),
    locker: new THREE.MeshStandardMaterial({ color: "#7d8b97", roughness: 0.45, metalness: 0.45 }),
    cabinet: new THREE.MeshStandardMaterial({ color: "#b8322a", roughness: 0.45, metalness: 0.3 }),
  }), []);

  useFrame(() => {
    const ui = useUi.getState();
    if (group.current) group.current.visible = (ui.isolatedFloor === null || ui.isolatedFloor === 0) && !(ui.cutaway !== null && ui.cutaway < 0);
  });

  // glazed partition = solid dado + glass + head frame, along x (north side) or z (east side, with door)
  const partition = (key: string, pos: [number, number], len: number, alongX: boolean) => {
    const size = (h: number, t: number): [number, number, number] => (alongX ? [len, h, t] : [t, h, len]);
    return (
      <group key={key} position={[pos[0], 0, pos[1]]}>
        <mesh position={[0, DADO / 2, 0]} material={m.dado} castShadow>
          <boxGeometry args={size(DADO, 0.12)} />
        </mesh>
        <mesh position={[0, DADO + (WALL_H - DADO) / 2, 0]} material={m.glass} renderOrder={5}>
          <boxGeometry args={size(WALL_H - DADO, 0.04)} />
        </mesh>
        <mesh position={[0, WALL_H - 0.04, 0]} material={m.frame}>
          <boxGeometry args={size(0.08, 0.1)} />
        </mesh>
      </group>
    );
  };

  return (
    <group ref={group}>
      <mesh rotation-x={-Math.PI / 2} position={[CX, 0.012, CZ]} material={m.floor} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>
      {/* north partition (to the lobby) and east partition with the door opening */}
      {partition("n", [CX, CREW_ROOM.z1], W, true)}
      {partition("e1", [CREW_ROOM.x1, (CREW_ROOM.z0 + DOOR.z0) / 2], DOOR.z0 - CREW_ROOM.z0, false)}
      {partition("e2", [CREW_ROOM.x1, (DOOR.z1 + CREW_ROOM.z1) / 2], CREW_ROOM.z1 - DOOR.z1, false)}
      <mesh position={[CREW_ROOM.x1, 2.2, CREW_ROOM.doorZ]} material={m.frame}>
        <boxGeometry args={[0.12, 0.08, DOOR.z1 - DOOR.z0]} />
      </mesh>
      <mesh position={[CREW_ROOM.x1 + 0.08, 2.65, CREW_ROOM.doorZ]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[1.6, 0.4]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>

      {/* table + chairs (one per technician seat) */}
      <mesh position={[TABLE.x, 0.74, TABLE.z]} material={m.table} castShadow receiveShadow>
        <boxGeometry args={[TABLE.w, 0.05, TABLE.d]} />
      </mesh>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[TABLE.x + sx * (TABLE.w / 2 - 0.1), 0.36, TABLE.z + sz * (TABLE.d / 2 - 0.1)]} material={m.frame}>
          <boxGeometry args={[0.05, 0.72, 0.05]} />
        </mesh>
      ))}
      {CREW_SEATS.map(([x, z, yaw], i) => (
        <group key={i} position={[x, 0, z]} rotation-y={yaw}>
          <mesh position={[0, 0.45, 0.05]} material={m.chair} castShadow>
            <boxGeometry args={[0.46, 0.05, 0.44]} />
          </mesh>
          <mesh position={[0, 0.72, 0.27]} material={m.chair}>
            <boxGeometry args={[0.46, 0.5, 0.04]} />
          </mesh>
          <mesh position={[0, 0.22, 0.05]} material={m.frame}>
            <cylinderGeometry args={[0.025, 0.025, 0.44, 8]} />
          </mesh>
        </group>
      ))}
      {/* a mug and a radio on the table */}
      <mesh position={[TABLE.x + 0.6, 0.81, TABLE.z + 0.1]}>
        <cylinderGeometry args={[0.045, 0.04, 0.1, 12]} />
        <meshStandardMaterial color="#e9ecef" roughness={0.4} />
      </mesh>
      <mesh position={[TABLE.x - 0.5, 0.82, TABLE.z - 0.15]}>
        <boxGeometry args={[0.08, 0.13, 0.04]} />
        <meshStandardMaterial color="#20252a" roughness={0.6} />
      </mesh>

      {/* lockers on the back wall */}
      {Array.from({ length: 6 }, (_, i) => (
        <group key={i} position={[CREW_ROOM.x0 + 0.6 + i * 0.62, 0, CREW_ROOM.z0 + 0.3]}>
          <mesh position={[0, 0.95, 0]} material={m.locker} castShadow>
            <boxGeometry args={[0.58, 1.9, 0.5]} />
          </mesh>
          <mesh position={[0.2, 1.05, 0.26]} material={m.frame}>
            <boxGeometry args={[0.03, 0.14, 0.02]} />
          </mesh>
        </group>
      ))}

      {/* tool cabinet against the east wall */}
      <group position={[TOOL_CABINET.x + 0.45, 0, TOOL_CABINET.z]}>
        <mesh position={[0, 0.55, 0]} material={m.cabinet} castShadow>
          <boxGeometry args={[0.6, 1.1, 1.3]} />
        </mesh>
        {[0.25, 0.5, 0.75, 0.95].map((h) => (
          <mesh key={h} position={[-0.31, h, 0]} material={m.frame}>
            <boxGeometry args={[0.02, 0.025, 1.0]} />
          </mesh>
        ))}
      </group>

      {/* live crew board on the west wall */}
      <mesh position={[CREW_ROOM.x0 + 0.06, 1.75, TABLE.z]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[3.0, 1.76]} />
        <meshBasicMaterial map={board} toneMapped={false} />
      </mesh>
      <mesh position={[CREW_ROOM.x0 + 0.03, 1.75, TABLE.z]} rotation-y={Math.PI / 2} material={m.frame}>
        <boxGeometry args={[3.12, 1.88, 0.03]} />
      </mesh>
    </group>
  );
}
