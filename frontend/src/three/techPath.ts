import { ASSET_LAYOUT, CREW_ROOM, CREW_SEATS, LIFT, TOOL_CABINET, corridorZ, floorLabel } from "./constants";
import type { Asset, ProcedureStep, Technician, WorkOrderSummary } from "../api/types";

/** A waypoint in (x, level, z): `level` is a (possibly fractional) floor level, so lifts are vertical segments. */
export interface Waypoint {
  x: number;
  level: number;
  z: number;
}

/** Walk line on the ground floor in front of the crew-room door, and the east service line. */
const DOOR_IN = { x: CREW_ROOM.x1 - 0.8, z: CREW_ROOM.doorZ };
const DOOR_OUT = { x: CREW_ROOM.x1 + 1.2, z: CREW_ROOM.doorZ };
const EAST_X = 18.8;

/** Seat (and facing) of a technician in the crew room; distinct per technician so avatars never overlap. */
export function crewSeat(techId: string): [number, number, number] {
  const idx = (Number(techId.replace(/\D/g, "")) || 1) - 1;
  return CREW_SEATS[idx % CREW_SEATS.length];
}

/** Ordered waypoints of one floor's horizontal leg from the lift landing to the asset's work position. */
function floorLegToAsset(asset: Asset): Waypoint[] {
  const lay = ASSET_LAYOUT[asset.asset_type] ?? ASSET_LAYOUT.PUMP;
  const l = asset.floor_level;
  const cz = corridorZ(l);
  const tx = asset.position.x + lay.approach[0];
  const tz = asset.position.z + lay.approach[1];
  const sx = tx + lay.side;
  return [
    { x: EAST_X, level: l, z: LIFT.landingZ },
    { x: EAST_X, level: l, z: cz },
    { x: sx, level: l, z: cz },
    { x: sx, level: l, z: tz },
    { x: tx, level: l, z: tz },
  ];
}

/**
 * Route graph: crew-room seat → tool cabinet → door → ground-floor walk line → east service line →
 * lift landing → glass lift (vertical) → landing on the asset's floor → corridor → around the machine →
 * work position. Every technician lives in the crew room, so every route starts and ends there.
 */
export function buildPath(techId: string, asset: Asset): Waypoint[] {
  const [sx, sz] = crewSeat(techId);
  const g = CREW_ROOM.level;
  const pts: Waypoint[] = [
    { x: sx, level: g, z: sz },
    { x: sx, level: g, z: sz + (sz > -7.4 ? 0.9 : -0.9) }, // stand up, step away from the table
    { x: TOOL_CABINET.x - 0.2, level: g, z: TOOL_CABINET.z + 1.0 }, // collect the tool kit
    { x: DOOR_IN.x, level: g, z: DOOR_IN.z },
    { x: DOOR_OUT.x, level: g, z: DOOR_OUT.z },
    { x: DOOR_OUT.x, level: g, z: corridorZ(g) },
    { x: EAST_X, level: g, z: corridorZ(g) },
    { x: EAST_X, level: g, z: LIFT.landingZ },
    { x: LIFT.x, level: g, z: LIFT.landingZ },
  ];
  if (asset.floor_level === g) {
    pts.push(...floorLegToAsset(asset));
  } else {
    pts.push({ x: LIFT.x, level: g, z: LIFT.z });
    pts.push({ x: LIFT.x, level: asset.floor_level, z: LIFT.z });
    pts.push({ x: LIFT.x, level: asset.floor_level, z: LIFT.landingZ });
    pts.push(...floorLegToAsset(asset));
  }
  return dedupe(pts);
}

function dedupe(pts: Waypoint[]): Waypoint[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z, (p.level - pts[i - 1].level) * 4) > 0.05);
}

/** Length weight of a segment; vertical (lift) travel counts 0.6 m per metre so the ride stays visible. */
function segLen(a: Waypoint, b: Waypoint) {
  return Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.level - a.level) * 4 * 0.6;
}

export function pathLength(path: Waypoint[]) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += segLen(path[i - 1], path[i]);
  return total;
}

export interface Sample {
  x: number;
  level: number;
  z: number;
  yaw: number;
  distance: number;
  inLift: boolean;
  /** Index of the segment being walked (0-based). */
  seg: number;
}

/**
 * Point at `fraction` (0..1) of the path length, sampled by arc length. Speed ramps linearly up over
 * the first e = 3 % of the route and down over the last 3 % (trapezoidal speed profile, v = 1/(1−e)):
 *   f < e:       f' = v·f² / 2e
 *   e ≤ f ≤ 1−e: f' = v·(e/2 + f − e)
 *   f > 1−e:     f' = 1 − v·(1−f)² / 2e
 */
export function sampleAt(path: Waypoint[], fraction: number): Sample {
  const r = Math.min(1, Math.max(0, fraction));
  const e = 0.03;
  const v = 1 / (1 - e);
  const f = r < e ? (v * r * r) / (2 * e) : r > 1 - e ? 1 - (v * (1 - r) * (1 - r)) / (2 * e) : v * (e / 2 + r - e);
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
        yaw, distance: f * total, inLift: Math.abs(b.level - a.level) > 0.01, seg: i,
      };
    }
    d -= lens[i];
  }
  const last = path[path.length - 1];
  return { x: last.x, level: last.level, z: last.z, yaw, distance: total, inLift: false, seg: lens.length - 1 };
}

/**
 * idle      seated in the crew room
 * walking   dispatched: collecting tools, walking, riding the lift
 * arrived   on site, before the permit is signed (toolbox talk)
 * working   on site, following the procedure (see `step`)
 * returning walking back to the crew room after sign-off
 */
export type Phase = "idle" | "walking" | "arrived" | "working" | "returning";
export interface Pose extends Sample {
  phase: Phase;
  woNumber: string | null;
  assetId: string | null;
  /** Index into the procedure while working (−1 otherwise), and that step's key. */
  step: number;
  stepKey: string | null;
  /** Human-readable status line for labels and panels. */
  text: string;
  seated: boolean;
}

/** Short on-label names of procedure steps (the full text is in the job panel). */
const STEP_SHORT: Record<string, string> = {
  permit: "permit & lock-out", inspect: "inspecting", measure: "measuring", replace: "replacing bearing", align: "aligning", test: "test run",
};

const ms = (iso: string | null) => (iso ? Date.parse(iso.endsWith("Z") ? iso : iso + "Z") : NaN);
/** Mirrors backend dispatch.travel_minutes: 3 min to the lift + 2 min per floor (ASSUMPTIONS #13). */
export const travelMinutes = (from: number, to: number) => 3 + 2 * Math.abs(from - to);

/** Which procedure step is active `elapsedMin` minutes after work began (last step once over-running). */
export function stepAt(steps: ProcedureStep[], elapsedMin: number) {
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    acc += steps[i].minutes;
    if (elapsedMin < acc) return i;
  }
  return steps.length - 1;
}

/** When work actually began: the later of the permit (started_at) and the latest arrival (rework). */
export function workBegan(wo: WorkOrderSummary) {
  const s = ms(wo.started_at);
  const a = ms(wo.arrives_at);
  return Math.max(isNaN(s) ? -Infinity : s, isNaN(a) ? -Infinity : a);
}

/** Pose of a technician at sim time `now`, derived purely from the work-order timestamps. */
export function techPose(tech: Technician, wo: WorkOrderSummary | null, asset: Asset | null, now: number, steps: ProcedureStep[] | null): Pose {
  const [hx, hz, hyaw] = crewSeat(tech.id);
  const base = { step: -1, stepKey: null, seated: false, woNumber: wo?.number ?? null, assetId: asset?.id ?? null };
  const idle: Pose = {
    x: hx, level: CREW_ROOM.level, z: hz, yaw: hyaw, distance: 0, inLift: false, seg: 0, phase: "idle", ...base,
    seated: true, text: tech.on_shift ? "in crew room" : "off shift",
  };
  if (!wo || !asset) return idle;
  const path = buildPath(tech.id, asset);
  const arrives = ms(wo.arrives_at);
  const assigned = ms(wo.assigned_at);
  const completed = ms(wo.completed_at);
  const returns = ms(wo.returns_at);
  const at = (s: Sample, phase: Phase, text: string, extra: Partial<Pose> = {}): Pose => ({ ...s, ...base, phase, text, ...extra });
  const where = floorLabel(asset.floor_level);
  const active = wo.status === "ASSIGNED" || wo.status === "ON_HOLD" || wo.status === "IN_PROGRESS";

  if (active && !isNaN(arrives) && now < arrives) {
    // rework: the backend measures travel from the technician's current floor, so a short trip
    // means they were still on the way back and turn around near the asset
    const rework = wo.repair_count >= 1;
    const restart = rework ? ms(wo.updated_at) : assigned;
    const full = travelMinutes(CREW_ROOM.level, asset.floor_level) * 60000;
    const span = Math.max(1, arrives - restart);
    const from = rework ? Math.min(0.92, Math.max(0, 1 - span / full)) : 0;
    const p = from + (1 - from) * Math.min(1, Math.max(0, (now - restart) / span));
    const s = sampleAt(path, p);
    const lift = s.inLift ? ` · lift to ${where}` : s.seg <= 2 && !rework ? " · collecting tools" : "";
    return at(s, "walking", `walking to ${asset.id}${lift}`);
  }
  if (wo.status === "ASSIGNED" || (wo.status === "ON_HOLD" && !isNaN(arrives))) {
    return at(sampleAt(path, 1), "arrived", wo.status === "ON_HOLD" ? `on site · waiting (${(wo.hold_reason ?? "hold").toLowerCase().replace("_", " ")})` : "on site · toolbox talk");
  }
  if (wo.status === "IN_PROGRESS") {
    const began = workBegan(wo);
    const elapsed = (now - began) / 60000;
    const plan = steps ?? [];
    const i = plan.length ? stepAt(plan, elapsed) : -1;
    const label = i >= 0 ? STEP_SHORT[plan[i].key] ?? plan[i].key : "working";
    return at(sampleAt(path, 1), "working", `repairing ${asset.id} · ${label}`, { step: i, stepKey: i >= 0 ? plan[i].key : null });
  }
  if (["COMPLETED", "VERIFIED", "REWORK_REQUIRED", "CLOSED"].includes(wo.status) && !isNaN(completed) && !isNaN(returns) && now < returns) {
    const p = (now - completed) / Math.max(1, returns - completed);
    const s = sampleAt([...path].reverse(), p);
    return at(s, "returning", s.inLift ? "returning · lift to Ground" : "returning to crew room");
  }
  return idle;
}
