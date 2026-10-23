import { CORE, ASSET_LAYOUT } from "./constants";
import type { Asset, Technician, WorkOrderSummary } from "../api/types";

/** A waypoint in (x, level, z): `level` is a (possibly fractional) floor level, so lifts are vertical segments. */
export interface Waypoint {
  x: number;
  level: number;
  z: number;
}

const LANDING_X = CORE.x - CORE.w / 2 - 1.2;
const LANDING_Z = CORE.z + 1.4;
const CORE_X = CORE.x - 0.4;

/** Where a technician waits on their home floor (distinct spots so avatars do not overlap). */
export function homeSpot(techId: string, floor: number): Waypoint {
  const idx = Number(techId.replace(/\D/g, "")) || 1;
  return { x: 9.5 - (idx - 1) * 1.6, level: floor, z: floor === -1 ? 5.5 : floor === 0 ? 6.0 : 2.4 };
}

/** Waypoint graph: home → floor landing → lift core → target landing → corridor → asset approach. */
export function buildPath(homeFloor: number, techId: string, asset: Asset): Waypoint[] {
  const approachOff = (ASSET_LAYOUT[asset.asset_type] ?? ASSET_LAYOUT.PUMP).approach;
  const home = homeSpot(techId, homeFloor);
  const target: Waypoint = { x: asset.position.x + approachOff[0], level: asset.floor_level, z: asset.position.z + approachOff[1] };
  const pts: Waypoint[] = [home];
  if (homeFloor !== asset.floor_level) {
    pts.push({ x: LANDING_X, level: homeFloor, z: LANDING_Z });
    pts.push({ x: CORE_X, level: homeFloor, z: CORE.z });
    pts.push({ x: CORE_X, level: asset.floor_level, z: CORE.z });
    pts.push({ x: LANDING_X, level: asset.floor_level, z: LANDING_Z });
  } else {
    pts.push({ x: LANDING_X, level: homeFloor, z: LANDING_Z });
  }
  // corridor (z ≈ 0) towards the asset, then the final approach
  pts.push({ x: Math.min(LANDING_X, 11.5), level: asset.floor_level, z: 0 });
  pts.push({ x: target.x, level: asset.floor_level, z: 0 });
  pts.push(target);
  return dedupe(pts);
}

function dedupe(pts: Waypoint[]): Waypoint[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z, (p.level - pts[i - 1].level) * 4) > 0.05);
}

/** Length weight of a segment; vertical (lift) travel counts slower so the ride is visible. */
function segLen(a: Waypoint, b: Waypoint) {
  return Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.level - a.level) * 4 * 0.6;
}

export interface Sample {
  x: number;
  level: number;
  z: number;
  yaw: number;
  distance: number;
  inLift: boolean;
}

export function sampleAt(path: Waypoint[], fraction: number): Sample {
  const f = Math.min(1, Math.max(0, fraction));
  const lens = path.slice(1).map((p, i) => segLen(path[i], p));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let d = f * total;
  let yaw = 0;
  for (let i = 0; i < lens.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (Math.hypot(b.x - a.x, b.z - a.z) > 0.01) yaw = Math.atan2(b.x - a.x, b.z - a.z);
    if (d <= lens[i] || i === lens.length - 1) {
      const t = lens[i] > 0 ? Math.min(1, d / lens[i]) : 1;
      return {
        x: a.x + (b.x - a.x) * t, level: a.level + (b.level - a.level) * t, z: a.z + (b.z - a.z) * t,
        yaw, distance: f * total, inLift: Math.abs(b.level - a.level) > 0.01,
      };
    }
    d -= lens[i];
  }
  const last = path[path.length - 1];
  return { x: last.x, level: last.level, z: last.z, yaw, distance: total, inLift: false };
}

export type Phase = "idle" | "walking" | "working" | "returning";
export interface Pose extends Sample {
  phase: Phase;
  woNumber: string | null;
  assetId: string | null;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso.endsWith("Z") ? iso : iso + "Z") : NaN);
const REWORK_WALK_MIN = 3;

/** Pose of a technician at sim time `now`, derived purely from the work-order timestamps. */
export function techPose(tech: Technician, wo: WorkOrderSummary | null, asset: Asset | null, now: number): Pose {
  const home = homeSpot(tech.id, tech.home_floor);
  const idle: Pose = { x: home.x, level: home.level, z: home.z, yaw: 0, distance: 0, inLift: false, phase: "idle", woNumber: wo?.number ?? null, assetId: asset?.id ?? null };
  if (!wo || !asset) return idle;
  const path = buildPath(tech.home_floor, tech.id, asset);
  const arrives = ms(wo.arrives_at);
  const assigned = ms(wo.assigned_at);
  const completed = ms(wo.completed_at);
  const returns = ms(wo.returns_at);
  const withPhase = (s: Sample, phase: Phase): Pose => ({ ...s, phase, woNumber: wo.number, assetId: asset.id });

  const walking = (wo.status === "ASSIGNED" || wo.status === "ON_HOLD" || wo.status === "IN_PROGRESS") && !isNaN(arrives) && now < arrives;
  if (walking) {
    const rework = wo.repair_count >= 1;
    const start = rework ? arrives - REWORK_WALK_MIN * 60000 : assigned;
    const p = (now - start) / Math.max(1, arrives - start);
    return withPhase(sampleAt(path, rework ? 0.78 + 0.22 * Math.min(1, Math.max(0, p)) : p), "walking");
  }
  if (wo.status === "IN_PROGRESS" || wo.status === "ASSIGNED") return withPhase(sampleAt(path, 1), wo.status === "IN_PROGRESS" ? "working" : "idle");
  if (["COMPLETED", "VERIFIED", "REWORK_REQUIRED", "CLOSED"].includes(wo.status) && !isNaN(completed) && !isNaN(returns) && now < returns) {
    const p = (now - completed) / Math.max(1, returns - completed);
    const s = sampleAt([...path].reverse(), p);
    return withPhase({ ...s, yaw: s.yaw }, "returning");
  }
  return idle;
}
