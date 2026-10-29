import { CREW_ROOM, CORE, LIFT } from "./constants";
import { EXTENT, carParkSpots, cells } from "./cityMap";
import { BMS_ROOM, BOARDROOM, EXEC_OFFICES, KISHORE, MEETING_NE, SERVER_ROOM, WORKSTATIONS } from "./office";
import type { StaffPose } from "./staff";
import { vehicle } from "./vehicle";

/*
 * Keyboard-controlled Kishore. Everything here is floor-local metres (the same frame as office.ts),
 * so the walking avatar, the desks and the walls all agree. The player can use floors 0–5 through the
 * glass lift; the roof and basement are reached by the technicians, not by Kishore. On the ground level
 * he can also walk out into the city, and get into his car (see vehicle.ts).
 */

export const PLAYER_LEVELS = [0, 1, 2, 3, 4, 5];
export const PLAYER_RADIUS = 0.32;
export const WALK_SPEED = 3.4; // m/s
export const RUN_SPEED = 6; // m/s (Shift)
export const CAR_PARKING = { x: 30.5, z: 7, level: 0 };

/** Inside the outer walls. */
export const BOUNDS = { x0: -19.5, x1: 19.5, z0: -11.5, z1: 11.5 };

export interface Rect { x0: number; x1: number; z0: number; z1: number }

/** Mutable game state, read every frame by the controller and by Kishore's avatar. */
export const player = {
  active: false,
  x: 0,
  z: 0,
  /** Fractional while the lift is moving. */
  level: 3,
  yaw: 0,
  /** Look up/down angle in first person, radians. */
  pitch: 0,
  /** Metres walked, drives the walking animation. */
  distance: 0,
  /** Signed vehicle speed in metres per second. */
  speed: 0,
  mode: "walk" as "walk" | "sit" | "lift" | "drive" | "heli" | "swing",
};

/** Where Kishore stands when control starts: the ground-floor lobby, facing the glass lift. */
export const SPAWN = { x: CAR_PARKING.x, z: CAR_PARKING.z + 3.2, level: 0, yaw: Math.PI };
export const HELICOPTER_SPAWN = { x: 30.5, z: 17, y: 2.2, yaw: 0 };
/** Where the "sit down" interaction triggers, and where he sits. */
export const DESK = { x: KISHORE.seat.sx, z: KISHORE.seat.sz, level: KISHORE.seat.level, yaw: KISHORE.seat.yaw, reach: 2.1 };
/** The lift landing on every floor. */
export const LANDING = { x: LIFT.x, z: LIFT.landingZ, reach: 1.7 };

type Door = { side: "n" | "s" | "e" | "w"; at: number; w: number };

/** Thin wall rectangles around a room (mirrors the glass walls drawn by Interior.tsx). */
function roomWalls(r: Rect, door?: Door, skip: ("n" | "s" | "e" | "w")[] = []): Rect[] {
  const t = 0.1;
  const out: Rect[] = [];
  const add = (side: "n" | "s" | "e" | "w", a: number, b: number, fixed: number, alongX: boolean) => {
    if (skip.includes(side)) return;
    const cuts: [number, number][] = door && door.side === side ? [[a, door.at - door.w / 2], [door.at + door.w / 2, b]] : [[a, b]];
    for (const [s, e] of cuts) {
      if (e - s <= 0.05) continue;
      out.push(alongX ? { x0: s, x1: e, z0: fixed - t, z1: fixed + t } : { x0: fixed - t, x1: fixed + t, z0: s, z1: e });
    }
  };
  add("n", r.x0, r.x1, r.z0, true);
  add("s", r.x0, r.x1, r.z1, true);
  add("w", r.z0, r.z1, r.x0, false);
  add("e", r.z0, r.z1, r.x1, false);
  return out;
}

const cache = new Map<number, Rect[]>();

/** Everything solid on a floor: desks, the lift/stair core, glass rooms and the BMS video wall. */
export function obstacles(level: number): Rect[] {
  const l = Math.round(level);
  const hit = cache.get(l);
  if (hit) return hit;
  const out: Rect[] = [];
  for (const w of WORKSTATIONS[l] ?? []) out.push({ x0: w.dx - 0.85, x1: w.dx + 0.85, z0: w.dz - 0.45, z1: w.dz + 0.45 });
  out.push({ x0: CORE.x - CORE.w / 2, x1: CORE.x + CORE.w / 2, z0: CORE.z - CORE.d / 2, z1: CORE.z + CORE.d / 2 });
  if (l === 1 || l === 4) out.push(...roomWalls(MEETING_NE, { side: "s", at: 8.7, w: 1.4 }));
  if (l === 2) out.push(...roomWalls(SERVER_ROOM, { side: "e", at: 10, w: 1.4 }));
  if (l === 3) {
    out.push(...roomWalls(BMS_ROOM, { side: "e", at: 10.6, w: 2.0 }, ["s", "w", "n"]));
    out.push({ x0: BMS_ROOM.x0, x1: BMS_ROOM.x1, z0: BMS_ROOM.wallZ - 0.15, z1: BMS_ROOM.wallZ + 0.15 }); // video wall
  }
  if (l === 5) {
    out.push(...roomWalls(BOARDROOM, { side: "n", at: -2.5, w: 1.4 }));
    out.push(...roomWalls(EXEC_OFFICES, { side: "e", at: 7.5, w: 1.4 }));
  }
  cache.set(l, out);
  return out;
}

/** Push a circle of radius `r` at (px, pz) out of every rectangle in `rects`. */
function pushOut(px: number, pz: number, rects: Rect[], r: number): [number, number] {
  for (let pass = 0; pass < 3; pass++) {
    for (const o of rects) {
      const cx = Math.min(o.x1, Math.max(o.x0, px));
      const cz = Math.min(o.z1, Math.max(o.z0, pz));
      const dx = px - cx;
      const dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        px = cx + (dx / d) * r;
        pz = cz + (dz / d) * r;
      } else {
        // centre is inside the rectangle: leave through the nearest face
        const left = px - o.x0;
        const right = o.x1 - px;
        const up = pz - o.z0;
        const down = o.z1 - pz;
        const m = Math.min(left, right, up, down);
        if (m === left) px = o.x0 - r;
        else if (m === right) px = o.x1 + r;
        else if (m === up) pz = o.z0 - r;
        else pz = o.z1 + r;
      }
    }
  }
  return [px, pz];
}

/** Outside walls of the tower (a front door at x = 0), the open light-well in front of it, and the city blocks. */
let groundRects: Rect[] | null = null;
function groundObstacles(): Rect[] {
  if (groundRects) return groundRects;
  const t = 0.2;
  const out: Rect[] = [
    ...obstacles(0),
    { x0: CREW_ROOM.x0, x1: CREW_ROOM.x1, z0: CREW_ROOM.z0, z1: CREW_ROOM.z1 },
    { x0: -20 - t, x1: -20 + t, z0: -12 - t, z1: 12 + t },
    { x0: 20 - t, x1: 20 + t, z0: -12 - t, z1: 12 + t },
    { x0: -20 - t, x1: 20 + t, z0: -12 - t, z1: -12 + t },
    { x0: -20 - t, x1: -1.6, z0: 12 - t, z1: 12 + t }, // front wall, door between x = ±1.6
    { x0: 1.6, x1: 20 + t, z0: 12 - t, z1: 12 + t },
    { x0: -20 - t, x1: -3, z0: 12 + t, z1: 21 }, // light-well in front of the basement; the entrance bridge is x ∈ [−3, 3]
    { x0: 3, x1: 20 + t, z0: 12 + t, z1: 21 },
    ...cells().filter((c) => c.kind !== "campus" && c.kind !== "park").map((c) => ({ x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1 })),
    ...carParkSpots().map(([x, z]): Rect => ({ x0: x - 0.9, x1: x + 0.9, z0: z - 2.1, z1: z + 2.1 })),
  ];
  groundRects = out;
  return out;
}

/** Push a circle of radius `r` out of everything solid on `level`, and keep it inside the walkable area. */
export function resolve(x: number, z: number, level: number, r = PLAYER_RADIUS): [number, number] {
  if (Math.round(level) === 0) {
    // ground level: the lobby, the grounds and the streets are one continuous walkable space
    const rects = groundObstacles();
    const parkedCar: Rect[] = player.mode === "drive" ? [] : [carRect()];
    const lim = EXTENT - 3;
    const [px, pz] = pushOut(Math.min(lim, Math.max(-lim, x)), Math.min(lim, Math.max(-lim, z)), [...rects, ...parkedCar], r);
    return [Math.min(lim, Math.max(-lim, px)), Math.min(lim, Math.max(-lim, pz))];
  }
  const [px, pz] = pushOut(Math.min(BOUNDS.x1 - r, Math.max(BOUNDS.x0 + r, x)), Math.min(BOUNDS.z1 - r, Math.max(BOUNDS.z0 + r, z)), obstacles(level), r);
  return [Math.min(BOUNDS.x1 - r, Math.max(BOUNDS.x0 + r, px)), Math.min(BOUNDS.z1 - r, Math.max(BOUNDS.z0 + r, pz))];
}

/** Bounding box of the parked car (it can be left at any angle). */
function carRect(): Rect {
  const s = Math.abs(Math.sin(vehicle.yaw));
  const c = Math.abs(Math.cos(vehicle.yaw));
  const ex = s * 2.1 + c * 0.9;
  const ez = c * 2.1 + s * 0.9;
  return { x0: vehicle.x - ex, x1: vehicle.x + ex, z0: vehicle.z - ez, z1: vehicle.z + ez };
}

/** Shortcut for a hurried demo: stand next to the BMS desk on Floor 3. */
export function jumpToDesk() {
  Object.assign(player, { x: DESK.x + 1.6, z: DESK.z + 0.6, level: DESK.level, yaw: -Math.PI / 2, mode: "walk" as const });
}

export const nearDesk = () => player.mode === "walk" && Math.round(player.level) === DESK.level && Math.hypot(player.x - DESK.x, player.z - DESK.z) < DESK.reach;
export const nearLift = () => player.mode === "walk" && Math.hypot(player.x - LANDING.x, player.z - LANDING.z) < LANDING.reach;
export const nearCar = () => player.mode === "walk" && Math.round(player.level) === 0 && Math.hypot(player.x - vehicle.x, player.z - vehicle.z) < 3.6;

/** Step out of the car onto the driver's side (or the other side if something is in the way). */
export function leaveCar() {
  const lx = Math.cos(vehicle.yaw);
  const lz = -Math.sin(vehicle.yaw);
  player.mode = "walk";
  player.level = 0;
  player.speed = 0;
  vehicle.v = 0;
  const left = resolve(vehicle.x + lx * 2.2, vehicle.z + lz * 2.2, 0);
  const rightSide = resolve(vehicle.x - lx * 2.2, vehicle.z - lz * 2.2, 0);
  const free = (p: [number, number]) => Math.hypot(p[0] - (vehicle.x + lx * 2.2), p[1] - (vehicle.z + lz * 2.2)) < 0.05;
  [player.x, player.z] = free(left) ? left : rightSide;
  player.yaw = vehicle.yaw + Math.PI / 2;
}

/** The pose Kishore's avatar takes while the player is steering him (same shape as the clock-driven pose). */
export function playerPose(): StaffPose {
  const seated = player.mode === "sit";
  return {
    x: player.x,
    z: player.z,
    level: player.level,
    yaw: player.yaw,
    distance: player.distance,
    inLift: player.mode === "lift",
    seg: 0,
    phase: seated ? "seated" : "arriving",
    text: seated ? "at the BMS desk" : player.mode === "lift" ? "in the lift" : player.mode === "drive" ? "driving around the city" : "under your control",
    seatedYaw: DESK.yaw,
  };
}
