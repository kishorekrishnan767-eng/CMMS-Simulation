import * as THREE from "three";
import type { Health } from "../api/types";

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
  graphite: "#26323a",
  graphite2: "#33414b",
  concrete: "#7d8a94",
  steel: "#c3ced6",
  steelDark: "#55636d",
  teal: "#1fd1b6",
  tealDeep: "#0b3b40",
  glass: "#79c9d4",
  ok: "#2fe0a0",
  watch: "#ffb020",
  bad: "#ff4d4f",
  repair: "#4da3ff",
  offline: "#7b8794",
  pipeCold: "#3b9cff",
  pipeHot: "#ff6b57",
};

export const HEALTH_COLOR: Record<Health, string> = {
  NORMAL: PALETTE.ok,
  WATCH: PALETTE.watch,
  ANOMALY: PALETTE.bad,
  CLEARED: PALETTE.ok,
};

export const WO_COLOR: Record<string, string> = {
  DRAFT: "#8aa4b8",
  OPEN: "#ffb020",
  ASSIGNED: "#8b7bff",
  ON_HOLD: "#ff8a3d",
  IN_PROGRESS: "#4da3ff",
  COMPLETED: "#1fd1b6",
  VERIFIED: "#2fe0a0",
  REWORK_REQUIRED: "#ff4d8d",
  CLOSED: "#2fe0a0",
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
  /** Height of the pin above the floor surface. */
  pinY: number;
}
export const ASSET_LAYOUT: Record<string, AssetLayout> = {
  SUPPLY_FAN: { approach: [0, 2.6], pinY: 5.4 },
  EXHAUST_FAN: { approach: [0, 1.9], pinY: 3.8 },
  CHILLER: { approach: [0, 3.0], pinY: 5.2 },
  PUMP: { approach: [0, 1.9], pinY: 3.2 },
  FCU: { approach: [0, 1.4], pinY: 3.9 },
};

/** Time-of-day helpers (sim clock is UTC; the building is treated as local time = UTC). */
export function hourOfDay(simMs: number) {
  const d = new Date(simMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}
export function isWeekend(simMs: number) {
  const day = new Date(simMs).getUTCDay();
  return day === 0 || day === 6;
}
/** 0..1 occupancy: ramps up 7–9h, plateau, ramps down 17–20h, lower at weekends. */
export function occupancyAt(simMs: number) {
  const h = hourOfDay(simMs);
  let o: number;
  if (h < 6) o = 0.03;
  else if (h < 9) o = 0.03 + ((h - 6) / 3) * 0.92;
  else if (h < 17) o = 0.95;
  else if (h < 20) o = 0.95 - ((h - 17) / 3) * 0.9;
  else o = 0.05;
  return isWeekend(simMs) ? o * 0.25 : o;
}
/** Sun elevation in radians (−π/2 … π/2): sunrise ≈ 6h, noon ≈ 12h, sunset ≈ 18h. */
export function sunElevation(simMs: number) {
  const h = hourOfDay(simMs);
  return Math.sin(((h - 6) / 24) * Math.PI * 2) * 1.05;
}
