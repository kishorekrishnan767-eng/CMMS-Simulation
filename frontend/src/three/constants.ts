import * as THREE from "three";
import type { Health } from "../api/types";
export { WO_COLOR } from "../config";

export const FLOOR_H = 4;
export const SLAB_T = 0.4;
export const BUILD_W = 40; // x extent
export const BUILD_D = 24; // z extent
export const LEVELS = [-1, 0, 1, 2, 3, 4, 5, 6];
export const ROOF_LEVEL = 6;
export const CORE = { x: 16, z: -6, w: 5, d: 7 };
export const RISER = { x: 0, z: -9.2 };

export const floorY = (level: number) => level * FLOOR_H;
/** Vertical offset of a floor in the exploded view (metres). */
export const explodeOffset = (level: number, explode: number) => explode * (level + 1) * 3.2;

export const PALETTE = {
  graphite: "#2a2f35",
  graphite2: "#363c43",
  concrete: "#8a9097",
  steel: "#c8ced4",
  steelDark: "#59616a",
  accent: "#2f6fd6",
  accentDeep: "#163a6e",
  glass: "#a9c3d6",
  ok: "#3fb26f",
  watch: "#e2a038",
  bad: "#e0483f",
  repair: "#3b82c4",
  offline: "#7b8794",
  pipeCold: "#3f7fc4",
  pipeHot: "#d0563e",
};

export const HEALTH_COLOR: Record<Health, string> = {
  NORMAL: PALETTE.ok,
  WATCH: PALETTE.watch,
  ANOMALY: PALETTE.bad,
  CLEARED: PALETTE.ok,
};

export const color = (hex: string) => new THREE.Color(hex);

/** Deterministic PRNG so the city is identical on every load. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AssetLayout {
  /** Where a technician stands to work on the asset (floor-local, relative to the asset origin). */
  approach: [number, number];
  /** Sideways offset of the last leg so the walk goes around the machine, not through it. */
  side: number;
  /** Height of the pin above the floor surface. */
  pinY: number;
}
export const ASSET_LAYOUT: Record<string, AssetLayout> = {
  SUPPLY_FAN: { approach: [0, 2.6], side: 0, pinY: 5.4 },
  EXHAUST_FAN: { approach: [0, -1.9], side: 0, pinY: 3.8 },
  CHILLER: { approach: [0, 3.0], side: 0, pinY: 5.2 },
  PUMP: { approach: [0, 1.9], side: 2.6, pinY: 3.2 },
  FCU: { approach: [0, 1.4], side: 0, pinY: 3.9 },
};

/** Maintenance crew room on the ground floor (level 0): technicians wait here between jobs. */
export const CREW_ROOM = { level: 0, x0: -19.6, x1: -10.4, z0: -11.6, z1: -3.2, doorZ: -4.6 };
/** Seats around the crew-room table (x, z, facing yaw). */
export const CREW_SEATS: [number, number, number][] = [[-16.7, -6.25, Math.PI], [-14.3, -6.25, Math.PI], [-15.5, -8.55, 0]];
/** Tool cabinet where technicians collect their kit on the way out. */
export const TOOL_CABINET = { x: -11.4, z: -9.6 };
/** Glass lift in the light-well at the front-east corner, visible from outside on every level. */
export const LIFT = { x: 17.6, z: 13.7, landingZ: 10.9, w: 1.7 };
/** Walking line on each floor, offset from the column grid (columns at z = −8, 0, 8). */
export const corridorZ = (level: number) => (level < 0 ? 6.6 : level >= 6 ? 1.6 : 1.0);
export const floorLabel = (level: number) => (level >= 6 ? "Roof" : level < 0 ? "B1" : level === 0 ? "Ground" : `Floor ${level}`);

/** Time-of-day helpers (sim clock is UTC; the building is treated as local time = UTC). */
export function hourOfDay(simMs: number) {
  const d = new Date(simMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}
export function isWeekend(simMs: number) {
  const day = new Date(simMs).getUTCDay();
  return day === 0 || day === 6;
}
/** 0..1 occupancy. There is no working day in this product: the office is fully staffed at every moment. */
export function occupancyAt(_simMs: number) {
  return 0.95;
}
/** Sun elevation in radians (−π/2 … π/2): sunrise ≈ 6h, noon ≈ 12h, sunset ≈ 18h. */
export function sunElevation(simMs: number) {
  const h = hourOfDay(simMs);
  return Math.sin(((h - 6) / 24) * Math.PI * 2) * 1.05;
}
