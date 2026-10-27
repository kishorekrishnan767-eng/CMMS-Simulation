import { carParkSpots, drivable } from "./cityMap";
import { trafficCars } from "./traffic";

/*
 * Kishore's car: a kinematic bicycle model with a tyre-grip limit.
 *
 *   forward = (sin ψ, cos ψ)            ψ = heading, +ψ turns left, steering δ > 0 turns right
 *   v̇   = engine(1 − v/vmax) − brake − drag·|v|v − rolling      (a ≈ 7.5 m/s² off the line, 12 m/s² braking)
 *   ψ̇   = −(v / L) · tan δ                                       (L = 2.6 m wheelbase)
 *   |ψ̇·v| ≤ μg ≈ 8.5 m/s²                                        (understeer: past the grip limit the nose runs wide)
 *   δ   → δmax / (1 + (v / 9)²)  at 1.8 rad/s, centring at 3 rad/s (less lock at speed, like a real rack)
 *
 * The car cannot leave the asphalt: the street grid, the car park and its driveway are drivable, curbs and
 * buildings are not (it scrapes along them, losing speed). It cannot pass through traffic or parked cars.
 */
export const CAR = { L: 2.6, halfLen: 2.1, halfW: 0.9, /** radius of the circles that stand in for a body in collisions */ r: 0.9 };
const ENGINE = 7.5;
const BRAKE = 12;
const REVERSE_MAX = 6;
const GRIP = 8.5;
const MAX_STEER = 0.62;

export const vehicle = {
  x: 30.5,
  z: 7,
  yaw: 0,
  /** Signed speed along the heading, m/s. */
  v: 0,
  /** Front-wheel angle, rad (+ = right). */
  steer: 0,
  /** Longitudinal / lateral acceleration, m/s² (drive the body pitch and roll). */
  ax: 0,
  ay: 0,
  /** Wheel rotation, rad. */
  wheel: 0,
  braking: false,
  /** 0..1 shake after an impact. */
  hit: 0,
};

export interface DriveInput { throttle: number; steer: number; handbrake: boolean; boost: boolean }

const fwd = (yaw: number) => [Math.sin(yaw), Math.cos(yaw)] as const;
const right = (yaw: number) => [-Math.cos(yaw), Math.sin(yaw)] as const; // driver's right: forward × up

/** The parts of a car body that must stay on the asphalt: four corners and the middle of each end. */
function onAsphalt(x: number, z: number, yaw: number): boolean {
  const [fx, fz] = fwd(yaw);
  const [rx, rz] = right(yaw);
  for (const a of [-CAR.halfLen, 0, CAR.halfLen]) {
    for (const b of [-CAR.halfW, CAR.halfW]) {
      if (!drivable(x + fx * a + rx * b, z + fz * a + rz * b)) return false;
    }
  }
  return true;
}

let parked: [number, number][] | null = null;
function parkedCars(): [number, number][] {
  if (!parked) parked = carParkSpots().map(([x, z]) => [x, z] as [number, number]);
  return parked;
}

/** Circles covering a car body of length `len` (centre, heading) — three for a car, more for a bus. */
function circles(x: number, z: number, yaw: number, len: number): [number, number][] {
  const [fx, fz] = fwd(yaw);
  const n = Math.max(3, Math.ceil(len / 1.8));
  const half = len / 2 - CAR.r;
  return Array.from({ length: n }, (_, i) => {
    const o = n === 1 ? 0 : -half + (2 * half * i) / (n - 1);
    return [x + fx * o, z + fz * o] as [number, number];
  });
}

/** Push the car out of anything solid it overlaps (traffic, parked cars). Returns the strongest impact speed. */
function collide(): number {
  let impact = 0;
  const mine = circles(vehicle.x, vehicle.z, vehicle.yaw, 4.2);
  const [fx, fz] = fwd(vehicle.yaw);
  const rad = CAR.r * 2;
  const hitCircle = (cx: number, cz: number, ovx: number, ovz: number) => {
    for (const [px, pz] of mine) {
      const dx = px - cx;
      const dz = pz - cz;
      const d = Math.hypot(dx, dz);
      if (d >= rad || d < 1e-6) continue;
      const nx = dx / d;
      const nz = dz / d;
      vehicle.x += nx * (rad - d);
      vehicle.z += nz * (rad - d);
      const closing = (vehicle.v * fx - ovx) * -nx + (vehicle.v * fz - ovz) * -nz; // positive when driving into it
      if (closing > 0) {
        impact = Math.max(impact, closing);
        vehicle.v *= 0.45;
      }
    }
  };
  for (const t of trafficCars) {
    if (!t.on || Math.abs(t.x - vehicle.x) > 12 || Math.abs(t.z - vehicle.z) > 12) continue;
    const [tx, tz] = fwd(t.yaw);
    for (const [cx, cz] of circles(t.x, t.z, t.yaw, t.len)) hitCircle(cx, cz, tx * t.v, tz * t.v);
  }
  for (const [px, pz] of parkedCars()) {
    if (Math.abs(px - vehicle.x) > 8 || Math.abs(pz - vehicle.z) > 8) continue;
    for (const [cx, cz] of circles(px, pz, 0, 4.2)) hitCircle(cx, cz, 0, 0);
  }
  return impact;
}

/** Advance the car by `dt` seconds (sub-stepped so a slow frame cannot tunnel through a curb). */
export function stepVehicle(inp: DriveInput, dt: number): void {
  const n = Math.max(1, Math.ceil(dt / (1 / 60)));
  for (let i = 0; i < n; i++) step(inp, dt / n);
}

function step(inp: DriveInput, dt: number): void {
  const c = vehicle;
  const vmax = inp.boost ? 24 : 16;
  const v0 = c.v;

  // longitudinal: engine, brakes, drag, rolling resistance
  let a = 0;
  c.braking = false;
  if (inp.throttle > 0) {
    if (c.v < -0.4) { a = BRAKE; c.braking = true; }
    else a = ENGINE * (1 - Math.max(0, c.v) / vmax) * (inp.boost ? 1.25 : 1);
  } else if (inp.throttle < 0) {
    if (c.v > 0.4) { a = -BRAKE; c.braking = true; }
    else a = -4.5 * (1 - Math.max(0, -c.v) / REVERSE_MAX);
  }
  if (inp.handbrake) { a -= Math.sign(c.v) * 9; c.braking = true; }
  const resist = (Math.abs(c.v) > 0.05 ? Math.sign(c.v) * (0.45 + (inp.throttle ? 0 : 1.2)) : 0) + 0.011 * c.v * Math.abs(c.v);
  c.v += (a - resist) * dt;
  if (!inp.throttle && !inp.handbrake && Math.abs(c.v) < 0.2) c.v = 0;
  if (c.v * v0 < 0 && !inp.throttle) c.v = 0; // friction cannot reverse the car

  // steering: less lock at speed, rate-limited, self-centring
  const lock = MAX_STEER / (1 + (c.v / 9) ** 2);
  const want = inp.steer * lock;
  const rate = (inp.steer ? 1.8 : 3.0) * dt;
  c.steer += Math.max(-rate, Math.min(rate, want - c.steer));
  let yawRate = -(c.v / CAR.L) * Math.tan(c.steer);
  const lat = Math.abs(yawRate * c.v);
  const grip = inp.handbrake ? GRIP * 0.7 : GRIP;
  if (lat > grip) yawRate *= grip / lat;
  const yaw = c.yaw + yawRate * dt;

  // move; if the new pose leaves the asphalt, slide along whichever axis is still free
  const [fx, fz] = fwd(yaw);
  const dx = fx * c.v * dt;
  const dz = fz * c.v * dt;
  let ok = true;
  if (onAsphalt(c.x + dx, c.z + dz, yaw)) {
    c.x += dx;
    c.z += dz;
  } else if (onAsphalt(c.x + dx, c.z, yaw)) {
    c.x += dx;
    c.v *= 0.97;
  } else if (onAsphalt(c.x, c.z + dz, yaw)) {
    c.z += dz;
    c.v *= 0.97;
  } else {
    ok = false;
    c.hit = Math.max(c.hit, Math.min(1, Math.abs(c.v) / 10));
    c.v *= -0.2; // bounce off the curb
  }
  if (ok || onAsphalt(c.x, c.z, yaw)) c.yaw = yaw;

  const impact = collide();
  if (impact > 0.5) c.hit = Math.max(c.hit, Math.min(1, impact / 10));
  c.hit = Math.max(0, c.hit - dt * 2.5);

  c.ax = (c.v - v0) / dt;
  c.ay = yawRate * c.v;
  c.wheel += (c.v * dt) / 0.32;
}

