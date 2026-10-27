import { mulberry32 } from "./constants";

/*
 * Pure geometry of the city around the campus (no React, no three): shared by the scenery, the traffic
 * simulation, the driveable car and Kishore's walking collisions, so they all agree where a road is.
 *
 * Avenues run along x at Z_LINES, streets along z at X_LINES, ROAD_W wide with SIDEWALK_W pavements.
 */
export const X_LINES = [-250, -196, -122, -48, 48, 122, 196, 250];
export const Z_LINES = [-250, -186, -110, -36, 38, 112, 188, 250];
export const ROAD_X = X_LINES.slice(1, -1); // streets (run along z)
export const ROAD_Z = Z_LINES.slice(1, -1); // avenues (run along x)
export const EXTENT = 250;
export const ROAD_W = 9;
export const SIDEWALK_W = 2.4;
export const INSET = ROAD_W / 2 + SIDEWALK_W + 0.6;
export const PARK = { ix: 4, iz: 2 }; // cell (column, row) used as the park

export type Kind = "campus" | "downtown" | "park" | "suburb";
export interface Cell { x0: number; x1: number; z0: number; z1: number; kind: Kind; ix: number; iz: number }

export function cells(): Cell[] {
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

export const CAR_COLORS = ["#d8dcdf", "#2c3238", "#b2312a", "#1f4f8a", "#e6e2d6", "#7c858e", "#3c6e57", "#9a9fa4", "#f2f2ef", "#5b3f63"];

/** The campus car park (x, z extents) and the driveway that joins it to the avenue in front of the building. */
export const CAR_PARK = { x0: 24, x1: 37, z0: -26.5, z1: 6.5 };
export const DRIVEWAY = { x0: 27.5, x1: 33.5, z0: -10, z1: 34 };

/** Parked cars on the campus car park: x, z, colour. */
export function carParkSpots(): [number, number, string][] {
  const rnd = mulberry32(31);
  const out: [number, number, string][] = [];
  for (const x of [26.5, 34.5]) for (let z = -24; z <= 4; z += 3) if (rnd() < 0.78) out.push([x, z, CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]]);
  return out;
}

/** Distance from `v` to the nearest road centre line in `lines`. */
const nearest = (v: number, lines: number[]) => lines.reduce((m, l) => Math.min(m, Math.abs(v - l)), Infinity);

/** True on asphalt a car may drive on: the street grid, the car park and its driveway. */
export function drivable(x: number, z: number): boolean {
  if (Math.abs(x) > EXTENT - 2 || Math.abs(z) > EXTENT - 2) return false;
  if (nearest(x, ROAD_X) < ROAD_W / 2 || nearest(z, ROAD_Z) < ROAD_W / 2) return true;
  const inside = (r: { x0: number; x1: number; z0: number; z1: number }) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
  return inside(CAR_PARK) || inside(DRIVEWAY);
}

/** Every road crossing: centre, and the index used to stagger its signal. */
export const CROSSINGS = ROAD_X.flatMap((x, i) => ROAD_Z.map((z, j) => ({ x, z, k: i * 7 + j * 3 })));

/** Traffic signal cycle (seconds): along-x green, yellow, all-red, along-z green, yellow, all-red. */
export const SIGNAL = { gx: 15, y: 2.5, r: 1.5, gz: 15 };
export const SIGNAL_CYCLE = 2 * (SIGNAL.y + SIGNAL.r) + SIGNAL.gx + SIGNAL.gz;
export type Lamp = "green" | "yellow" | "red";

/** Lamp shown to traffic travelling along x (`alongX`) or along z at a crossing with stagger `k`, at wall-clock time `t`. */
export function signalState(t: number, k: number, alongX: boolean): Lamp {
  const p = (((t + k * 3.7) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const a0 = SIGNAL.gx;
  const a1 = a0 + SIGNAL.y;
  const a2 = a1 + SIGNAL.r;
  const b0 = a2 + SIGNAL.gz;
  const b1 = b0 + SIGNAL.y;
  if (alongX) return p < a0 ? "green" : p < a1 ? "yellow" : "red";
  if (p < a2) return "red";
  return p < b0 ? "green" : p < b1 ? "yellow" : "red";
}
