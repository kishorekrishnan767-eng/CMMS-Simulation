import { CORE, LIFT, corridorZ } from "./constants";
import type { Waypoint } from "./techPath";

/*
 * Office layout of the Livewire Digital Solutions building, in floor-local coordinates (metres,
 * y = 0 on the floor surface). One definition feeds the furniture, the seated staff and the walking
 * routes, so people always sit exactly where a chair is.
 *
 *   Desk rows (people face their monitor):
 *     A  desk z = 5.6   person z = 4.65  faces +z      B  desk z = 6.9   person z = 7.85  faces −z
 *     C  desk z = −5.6  person z = −4.65 faces −z      D  desk z = −6.9  person z = −7.85 faces +z
 *   Columns every 3.5 m; aisles run between columns. The corridor line z = 1 and the east service
 *   line x = 18.8 stay clear (the same lines technicians use).
 */

export const HX = 20;
export const HZ = 12;
export const COLS = [-16.5, -13, -9.5, -6, -2.5, 1];

export type Row = "A" | "B" | "C" | "D" | "BMS" | "COUPLE";
export interface Workstation {
  id: string;
  level: number;
  row: Row;
  /** Desk centre. */
  dx: number;
  dz: number;
  /** Seat (person) position and facing yaw (radians, 0 = +z). */
  sx: number;
  sz: number;
  yaw: number;
}

function ws(level: number, row: Row, x: number, deskZ: number, yaw: number): Workstation {
  const sx = x - Math.sin(yaw) * 0.95;
  const sz = deskZ - Math.cos(yaw) * 0.95;
  return { id: `${level}${row}${x}`, level, row, dx: x, dz: deskZ, sx, sz, yaw };
}

const rowA = (l: number, xs: number[]) => xs.map((x) => ws(l, "A", x, 5.6, 0));
const rowB = (l: number, xs: number[]) => xs.map((x) => ws(l, "B", x, 6.9, Math.PI));
const rowC = (l: number, xs: number[]) => xs.map((x) => ws(l, "C", x, -5.6, Math.PI));
const rowD = (l: number, xs: number[]) => xs.map((x) => ws(l, "D", x, -6.9, 0));

/** BMS control room consoles (Floor 3): three consoles facing the video wall on the north side. */
export const BMS_ROOM = { x0: -19, x1: -3, z0: 3, z1: 11.5, wallZ: 3.35 };
const consoles = [-16, -11, -6].map((x) => ws(3, "BMS", x, 5.6, Math.PI));

/** Couples room (Floor 1, south-east): Vaseem and Yasar's own glazed office, door on the corridor side (north). It
 *  stays clear of the AC unit FCU-01-01 at (8, 5) and of the technicians' route along x = 18.8 / z = 1. */
export const COUPLES_ROOM = { x0: 10, x1: 15.4, z0: 3.4, z1: 11.6, doorX: 12.7 };
const coupleDesks = [11.9, 13.6].map((x) => ws(1, "COUPLE", x, 9.9, 0)); // side by side, facing the south windows

/** Server room (Floor 2, south-west). */
export const SERVER_ROOM = { x0: -19, x1: -11, z0: 4.5, z1: 11.5 };
/** Meeting rooms / boardroom / offices (decor, per level). */
export const MEETING_NE = { x0: 5, x1: 12.5, z0: -11, z1: -3 };
export const BOARDROOM = { x0: -8, x1: 3, z0: 3.5, z1: 11.5 };
export const EXEC_OFFICES = { x0: -19, x1: -9, z0: 3.5, z1: 11.5 };

export const WORKSTATIONS: Record<number, Workstation[]> = {
  1: [...rowA(1, COLS), ...rowB(1, COLS), ...rowC(1, COLS), ...rowD(1, COLS), ...coupleDesks],
  2: [...rowA(2, COLS.slice(2)), ...rowB(2, COLS.slice(2)), ...rowC(2, COLS), ...rowD(2, COLS)],
  3: [...consoles, ...rowC(3, COLS), ...rowD(3, COLS)],
  4: [...rowA(4, COLS), ...rowB(4, COLS), ...rowC(4, COLS), ...rowD(4, COLS)],
  5: [...rowC(5, COLS.slice(0, 4)), ...rowD(5, COLS.slice(0, 4))],
};

export const findWs = (level: number, row: Row, x: number) => WORKSTATIONS[level].find((w) => w.row === row && w.dx === x)!;

export interface Employee {
  id: string;
  name: string;
  role: string;
  team: string;
  /** Workstation. */
  seat: Workstation;
  /** Arrival / departure, hours of the (sim) day. */
  arrive: number;
  leave: number;
  /** Where on the street they arrive from: −1 west, +1 east. */
  from: -1 | 1;
  collaboration?: { partnerId: string; activity: string; start: number; end: number };
  look: { chest: string; sleeve: string; pants: string; skin: string; hair: string; boots: string; lanyard: string };
}

const emp = (id: string, name: string, role: string, team: string, seat: Workstation, arrive: number, leave: number, from: -1 | 1, skin: string, hair: string, shirt: string, pants: string, collaboration?: Employee["collaboration"]): Employee => ({
  id, name, role, team, seat, arrive, leave, from,
  collaboration,
  look: { chest: shirt, sleeve: shirt, pants, skin, hair, boots: "#2a2622", lanyard: "#1f5fbf" },
});

export const EMPLOYEES: Employee[] = [
  emp("EMP-PRASATH", "Prasath", "Software developer", "Development", findWs(1, "A", -9.5), 7.75, 17.9, -1, "#a87556", "#1c1815", "#d9dee3", "#33384a"),
  // Vaseem and Yasar work side by side in their own Couples room (Floor 1)
  emp("EMP-VASEEM", "Vaseem", "Software developer", "Development", findWs(1, "COUPLE", 11.9), 8.28, 18.1, 1, "#c99a78", "#2b2118", "#6f95b8", "#2d3640", { partnerId: "EMP-YASAR", activity: "Pair programming and feature review", start: 10, end: 12.5 }),
  emp("EMP-YASAR", "Yasar", "Software developer", "Development", findWs(1, "COUPLE", 13.6), 8.42, 17.8, -1, "#8d6248", "#101010", "#b98a5e", "#3a3f46", { partnerId: "EMP-VASEEM", activity: "Pair programming and feature review", start: 10, end: 12.5 }),
  emp("EMP-KISHORE", "Kishore", "BMS supervisor", "Building management", findWs(3, "BMS", -11), 8.07, 18.3, 1, "#c99a78", "#1c1815", "#1f4f8a", "#2a2f38"),
  emp("EMP-GURU", "Guru", "Project engineer", "Projects", findWs(4, "A", -13), 8.55, 17.7, 1, "#a87556", "#101010", "#8a9a7b", "#3a3a3a"),
  emp("EMP-MANO", "Mano", "Project engineer", "Projects", findWs(4, "B", -13), 8.7, 18.0, -1, "#e0b896", "#4a3322", "#c46a5a", "#2d3640"),
];
export const KISHORE = EMPLOYEES.find((e) => e.id === "EMP-KISHORE")!;

// ------------------------------------------------------------------------------------ routes
/** Street sidewalk the staff arrive on, front path to the bridge, and the entrance. */
const SIDEWALK_Z = 33.6;
const PATH_X = 0;
const BRIDGE_END_Z = 21;
const DOOR_Z = HZ;
const LOBBY_LINE = 9.2;

const wp = (x: number, level: number, z: number): Waypoint => ({ x, level, z });

/** Whole walk from the street to a desk: street → bridge → lobby → lift (or stairs for floor 0) → desk. */
export function routeToDesk(e: Employee): Waypoint[] {
  const s = e.seat;
  const g = 0;
  const pts: Waypoint[] = [
    wp(PATH_X + e.from * 38, g, SIDEWALK_Z),
    wp(PATH_X + e.from * 4, g, SIDEWALK_Z),
    wp(PATH_X, g, SIDEWALK_Z - 1.5),
    wp(PATH_X, g, BRIDGE_END_Z),
    wp(PATH_X, g, DOOR_Z + 0.5),
    wp(PATH_X, g, DOOR_Z - 1.5),
    wp(PATH_X + 3, g, LOBBY_LINE),
    wp(LIFT.x - 4, g, LOBBY_LINE + 1.4),
    wp(LIFT.x, g, LIFT.landingZ),
    wp(LIFT.x, g, LIFT.z), // into the glass lift
    wp(LIFT.x, s.level, LIFT.z),
    wp(LIFT.x, s.level, LIFT.landingZ),
  ];
  const aisle = s.dx + 1.75;
  if (s.row === "COUPLE") {
    // from the lift landing along the east side to the Couples room door (north wall), then to the desk
    const cr = COUPLES_ROOM;
    pts.push(wp(16.9, s.level, 10.4), wp(16.9, s.level, cr.z0 - 0.8), wp(cr.doorX, s.level, cr.z0 - 0.8), wp(cr.doorX, s.level, cr.z0 + 1.2), wp(s.sx, s.level, cr.z0 + 1.2), wp(s.sx, s.level, s.sz));
  } else if (s.row === "BMS") {
    pts.push(wp(-3.8, s.level, 10.6), wp(aisle, s.level, 10.6), wp(aisle, s.level, s.sz), wp(s.sx, s.level, s.sz));
  } else if (s.dz > 0) {
    pts.push(wp(aisle, s.level, 10.4), wp(aisle, s.level, s.sz), wp(s.sx, s.level, s.sz));
  } else {
    const cz = corridorZ(s.level);
    pts.push(wp(18.8, s.level, LIFT.landingZ), wp(18.8, s.level, cz), wp(aisle, s.level, cz), wp(aisle, s.level, s.sz), wp(s.sx, s.level, s.sz));
  }
  void CORE;
  return pts;
}

/** Sim minutes for the walk from the street to the desk (and back). Demo-paced so it is watchable. */
export const WALK_MINUTES = 9;
