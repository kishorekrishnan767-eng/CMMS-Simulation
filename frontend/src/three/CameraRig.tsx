import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useAssets, useWorkOrders } from "../api/queries";
import type { Asset } from "../api/types";
import { useUi, type CameraGoal } from "../store/ui";
import { FLOOR_H, LIFT, ROOF_LEVEL, explodeOffset, floorY } from "./constants";
import { KISHORE } from "./office";
import { player } from "./player";
import { techMotion, techWorld, type Motion } from "./Technicians";

/** True while a fly-to is in progress (the keyboard-controlled Kishore waits for it before the camera trails him). */
export const camState = { flying: false, /** the camera is Kishore's eyes: the rig must not touch it */ fpv: false };

interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  /** Floors above this level are cut away (ghosted) while the camera looks here. */
  cutaway: number | null;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Basement views: the floors above are lifted off and the camera looks down into the plant room. */
function basementPose(x: number, z: number, explode: number, close = false): Pose {
  const y = floorY(-1) + explodeOffset(-1, explode);
  const d = close ? 0.75 : 1;
  return { pos: v(x + 9 * d, y + 13 * d, z + 15 * d), target: v(x, y + 0.8, z), cutaway: -1 };
}

export function presetPose(goal: CameraGoal, assets: Asset[], explode: number): Pose {
  switch (goal.preset) {
    case "roof":
      return { pos: v(24, floorY(6) + 13 + explodeOffset(6, explode), 24), target: v(0, floorY(6) + 1.5 + explodeOffset(6, explode), -3), cutaway: null };
    case "plant":
      return { ...basementPose(-1, 0, explode), pos: v(12, floorY(-1) + 19, 24) };
    case "kishore": {
      // over Kishore's shoulder at his BMS console (Floor 3): him, his screens and the video wall
      const y = floorY(3) + explodeOffset(3, explode);
      const s = KISHORE.seat;
      return { pos: v(s.sx + 2.8, y + 2.9, s.sz + 3.6), target: v(s.sx - 0.3, y + 1.15, s.sz - 1.2), cutaway: 3 };
    }
    case "bms": {
      // Floor 3 control room seen from the front, floors above lifted off
      const y = floorY(3) + explodeOffset(3, explode);
      return { pos: v(-3, y + 7.5, 21), target: v(-11, y + 1.5, 4.5), cutaway: 3 };
    }
    case "player": {
      // third person: behind and above the keyboard-controlled Kishore, floors above cut away
      const l = Math.round(player.level);
      const y = floorY(l) + explodeOffset(l, explode);
      // walking: high enough to look down over the desks (floors above are ghosted, so no ceiling blocks the view);
      // driving: low and well back, like a chase camera
      const drive = player.mode === "drive";
      const back = drive ? 10 : 6.5;
      return {
        pos: v(player.x - Math.sin(player.yaw) * back, y + (drive ? 4.2 : 7), player.z - Math.cos(player.yaw) * back),
        target: v(player.x, y + (drive ? 1.2 : 1), player.z),
        cutaway: drive ? null : l,
      };
    }
    case "person":
    case "entrance":
      // street view of the front door: where staff arrive from
      return { pos: v(16, 7.5, 46), target: v(0, 2.2, 22), cutaway: null };
    case "crew":
      // from the lobby, under the ground-floor ceiling, looking through the crew room's glass wall
      return { pos: v(-8.5, floorY(0) + 3.1, 6.2), target: v(-15.2, floorY(0) + 0.9, -7.4), cutaway: 0 };
    case "floor": {
      const l = goal.floor ?? 3;
      if (l < 0) return basementPose(-1, 0, explode);
      const y = floorY(l) + explodeOffset(l, explode);
      return { pos: v(26, y + 12, 34), target: v(0, y + 1.8, 0), cutaway: l };
    }
    case "asset":
    case "follow": {
      const a = assets.find((x) => x.id === goal.assetId);
      if (!a) return { pos: v(58, 38, 64), target: v(0, 10, 0), cutaway: null };
      if (a.floor_level < 0) return basementPose(a.position.x, a.position.z, explode, goal.close);
      const y = floorY(a.floor_level) + explodeOffset(a.floor_level, explode);
      const dist = goal.close ? 0.62 : 1;
      const off = v(10 * dist, 9 * dist + 1, 15 * dist);
      // inner floors: ghost what is above so the asset is not hidden by the ceiling
      return {
        pos: v(a.position.x + off.x, y + off.y, a.position.z + off.z),
        target: v(a.position.x, y + 1.6, a.position.z),
        cutaway: a.floor_level < 6 ? a.floor_level : null,
      };
    }
    default:
      return { pos: v(78, 52, 92), target: v(0, 8, 4), cutaway: null };
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Exponential approach of angle `a` to `b` along the short way round: a + Δ·(1 − e^(−k·dt)). */
const dampAngle = (a: number, b: number, k: number, dt: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * (1 - Math.exp(-k * dt));

/** What the tracking shot remembers between frames: the smoothed heading and how far into the lift ride it is. */
interface Track {
  yaw: number;
  lift: number;
  init: boolean;
}
const newTrack = (): Track => ({ yaw: 0, lift: 0, init: false });

const cPos = new THREE.Vector3();
const cTgt = new THREE.Vector3();
const lPos = new THREE.Vector3();
const lTgt = new THREE.Vector3();
const aPos = new THREE.Vector3();
const aTgt = new THREE.Vector3();

/**
 * Cinematic tracking shot of a walking technician at world position `w` (y = chest height), written into `pos`/`target`.
 * Three framings, blended so the camera glides between them instead of cutting:
 *   chase   6.4 m behind and 2.9 m above chest height, aimed 1.6 m ahead of the worker: he sits low in the frame and
 *           the way ahead is visible. The heading is damped (rate 2.8/s) so the camera swings round the corners of the route.
 *   lift    on the landing in front of the glass lift and in the cab: from the open east side of the shaft at his eye
 *           height, rising with the cab (for a basement job: from inside the light-well, west of the cab). The street side
 *           of the cab is a solid panel and the camera cannot sit inside the frame, so it stays outside; the ride moves
 *           ≈ 6 m/s, so the caller must track vertically with a stiff rate.
 *   arrive  within 11 m of the machine: swings to the repair framing, centred between worker and machine, so the walk
 *           flows into the repair shot with no cut. Weight = 1 − smoothstep(4.5, 11, distance).
 * Indoors (floors 0–5) the camera is held inside the building footprint, so it never films the worker from behind a facade.
 */
export function trackPose(w: THREE.Vector3, motion: Motion | undefined, asset: Asset | undefined, tr: Track, dt: number, pos: THREE.Vector3, target: THREE.Vector3) {
  const inLift = !!motion?.inLift;
  // the cab and the landing in front of it are filmed from outside too, so the camera is already in place when he steps in
  const liftShot = inLift || (!!asset && asset.floor_level !== 0 && Math.hypot(w.x - LIFT.x, w.z - (LIFT.landingZ + 0.8)) < 5.5);
  const heading = motion?.yaw ?? tr.yaw;
  if (!tr.init) {
    tr.yaw = heading;
    tr.lift = liftShot ? 1 : 0;
    tr.init = true;
  } else if (!inLift) tr.yaw = dampAngle(tr.yaw, heading, 2.8, dt);
  tr.lift = THREE.MathUtils.damp(tr.lift, liftShot ? 1 : 0, 3.5, dt);
  const fx = Math.sin(tr.yaw);
  const fz = Math.cos(tr.yaw);
  cPos.set(w.x - fx * 6.4, w.y + 2.9, w.z - fz * 6.4);
  cTgt.set(w.x + fx * 1.6, w.y + 0.15, w.z + fz * 1.6);
  // the lift stands in the open light-well; its east wall rises to ground level and the cab roof is opaque, so a ride
  // down to B1 is filmed from inside the well, west of the cab, at the worker's height
  if (asset && asset.floor_level < 0) lPos.set(LIFT.x - 6.5, w.y + 0.4, LIFT.z + 1.5);
  else lPos.set(LIFT.x + 7.5, w.y + 0.7, LIFT.z + 2.0);
  lTgt.set(w.x, w.y + 0.4, w.z); // aimed at the worker (who is the cab while riding), so stepping out never leaves the frame
  pos.copy(cPos).lerp(lPos, tr.lift);
  target.copy(cTgt).lerp(lTgt, tr.lift);
  if (asset && tr.lift < 0.5) {
    const d = Math.hypot(w.x - asset.position.x, w.z - asset.position.z);
    const b = 1 - smoothstep(4.5, 11, d);
    if (b > 0) {
      aTgt.set(asset.position.x, w.y - 1 + 1.4, asset.position.z).lerp(cTgt.set(w.x, w.y + 0.2, w.z), 0.5);
      aPos.copy(aTgt).add(cPos.set(6.0, 4.6, 8.8));
      pos.lerp(aPos, b);
      target.lerp(aTgt, b);
    }
  }
  if (tr.lift < 0.5 && w.y - 1 < floorY(ROOF_LEVEL) - 1) {
    pos.x = THREE.MathUtils.clamp(pos.x, -19, 19);
    pos.z = THREE.MathUtils.clamp(pos.z, -11, 11);
  }
}

/** easeInOutCubic: slow start, fast middle, gentle landing. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Flight {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  to: Pose;
  t: number;
  duration: number;
  arc: number;
}

/**
 * Orbit camera with timed fly-to presets. A flight interpolates the target linearly and the camera
 * along a shallow arc (lifted by `arc`·sin(πt)) with easeInOutCubic timing; duration grows with
 * distance (0.9–2.2 s). In follow mode the camera then trails the technician with exponential damping.
 * Any user input cancels the flight / follow.
 */
export function CameraRig({ orbit = false, orbitSpeed = 0.35 }: { orbit?: boolean; orbitSpeed?: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const size = useThree((s) => s.size);
  const { data: assets } = useAssets();
  const { data: wos } = useWorkOrders();
  const goal = useUi((s) => s.cameraGoal);
  const flight = useRef<Flight | null>(null);
  const followId = useRef<string | null>(null);
  const followOffset = useRef(v(7, 5.5, 9));
  const assetList = useMemo(() => assets ?? [], [assets]);
  const track = useRef<Track>(newTrack());
  const wosRef = useRef(wos);
  wosRef.current = wos;
  const lookup = useRef(0);
  /** Sideways shift (px) that centres the subject in the part of the view the side panels leave free. */
  const shift = useRef(0);
  const applied = useRef(0);
  const appliedW = useRef(0);

  /** The technician assigned to the latest work order of `assetId`, read from the freshest work-order list. */
  const technicianFor = (assetId?: string) =>
    (wosRef.current?.items ?? []).filter((w) => w.assigned_technician && w.asset_id === assetId).sort((a, b) => b.id - a.id)[0]?.assigned_technician?.id ?? null;

  /** Start an eased flight from wherever the camera is now to `pose` (or jump there with reduced motion). */
  const beginFlight = (pose: Pose, duration?: number) => {
    const c = controls.current;
    if (useUi.getState().reducedMotion || !c) {
      camera.position.copy(pose.pos);
      c?.target.copy(pose.target);
      flight.current = null;
      return;
    }
    const dist = camera.position.distanceTo(pose.pos) + c.target.distanceTo(pose.target) * 0.5;
    flight.current = {
      fromPos: camera.position.clone(),
      fromTarget: c.target.clone(),
      to: pose,
      t: 0,
      duration: duration ?? THREE.MathUtils.clamp(0.9 + dist / 60, 0.9, 2.2),
      arc: Math.min(10, dist * 0.12),
    };
  };

  useEffect(() => {
    if (goal.nonce === 0) return;
    const ui = useUi.getState();
    const pose = presetPose(goal, assetList, ui.explode);
    ui.set({ cutaway: pose.cutaway, following: null });
    followId.current = null;
    followOffset.current = v(7, 5.5, 9);
    track.current = newTrack();
    lookup.current = 0;
    if (goal.preset === "follow") {
      followId.current = technicianFor(goal.assetId);
      if (followId.current) ui.set({ following: followId.current });
    }
    if (goal.preset === "person" && goal.personId && techWorld.has(goal.personId)) {
      // already at work: trail them straight away
      ui.set({ following: goal.personId });
      followId.current = goal.personId;
      followOffset.current = v(5, 4.6, 7.5);
      ui.set({ following: goal.personId });
    }
    beginFlight(pose, goal.duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.nonce]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const cancel = () => {
      flight.current = null;
      followId.current = null;
      useUi.getState().set({ following: null, cinematic: false });
    };
    c.addEventListener("start", cancel);
    return () => c.removeEventListener("start", cancel);
  }, []);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const dt = Math.min(delta, 0.05);
    if (camState.fpv) flight.current = null;
    // the assignment can reach the browser a moment after the "walking" shot starts: keep looking until the worker is found
    if (goal.preset === "follow" && !followId.current && goal.nonce > 0 && (lookup.current += dt) > 0.25) {
      lookup.current = 0;
      const found = technicianFor(goal.assetId);
      if (found && techWorld.has(found)) {
        followId.current = found;
        track.current = newTrack();
        useUi.getState().set({ following: found });
        const w = techWorld.get(found)!;
        const pose: Pose = { pos: v(0, 0, 0), target: v(0, 0, 0), cutaway: null };
        trackPose(w, techMotion.get(found), assetList.find((a) => a.id === goal.assetId), track.current, dt, pose.pos, pose.target);
        beginFlight(pose, 1.6);
      }
    }
    const f = flight.current;
    const follow = followId.current ? techWorld.get(followId.current) : undefined;
    const tracking = !!follow && goal.preset === "follow";
    const trackAsset = tracking ? assetList.find((a) => a.id === goal.assetId) : undefined;
    if (f) {
      if (follow && followId.current) {
        // keep re-aiming at the moving technician while flying in
        if (tracking) trackPose(follow, techMotion.get(followId.current), trackAsset, track.current, dt, f.to.pos, f.to.target);
        else {
          f.to.target.copy(follow).add(v(0, 0.2, 0));
          f.to.pos.copy(follow).add(followOffset.current);
        }
      }
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = ease(f.t);
      camera.position.lerpVectors(f.fromPos, f.to.pos, e);
      camera.position.y += f.arc * Math.sin(Math.PI * f.t);
      c.target.lerpVectors(f.fromTarget, f.to.target, e);
      if (f.t >= 1) flight.current = null;
    } else if (follow && followId.current) {
      const pos = v(0, 0, 0);
      const tgt = v(0, 0, 0);
      let kp = 2.2;
      let kt = 2.2;
      let kv = 2.2; // vertical rate
      if (tracking) {
        trackPose(follow, techMotion.get(followId.current), trackAsset, track.current, dt, pos, tgt);
        // a short lag behind the walker; the cab climbs ~6 m/s, so the vertical follow is stiff enough to keep him in frame
        const lift = track.current.lift;
        kp = 3.2 + 1.5 * lift;
        kt = 6 + 2 * lift;
        kv = 3.2 + 20 * lift;
      } else {
        tgt.copy(follow).add(v(0, 0.2, 0));
        pos.copy(follow).add(followOffset.current);
      }
      const kvt = tracking ? kv : kt;
      c.target.set(THREE.MathUtils.damp(c.target.x, tgt.x, kt, dt), THREE.MathUtils.damp(c.target.y, tgt.y, kvt, dt), THREE.MathUtils.damp(c.target.z, tgt.z, kt, dt));
      camera.position.set(THREE.MathUtils.damp(camera.position.x, pos.x, kp, dt), THREE.MathUtils.damp(camera.position.y, pos.y, kv, dt), THREE.MathUtils.damp(camera.position.z, pos.z, kp, dt));
    }
    // the floor the followed person is on is the floor shown: floors above it are cut away, so a technician
    // walking from the ground-floor crew room down to the basement plant room is never hidden by a slab
    if (follow && useUi.getState().explode < 0.02) {
      // ceil: while riding the lift between two floors, the upper one stays (so he is never hidden in the cab)
      const want = Math.ceil((follow.y - 1) / FLOOR_H - 0.02);
      const ui = useUi.getState();
      if (ui.cutaway !== want) ui.set({ cutaway: want });
    }
    // cinematic hold: a slow drift around the target once the flight has landed (≈ 2.7 min per turn)
    const ui = useUi.getState();
    const drift = ui.cinematic && !flight.current && !follow && !camState.fpv && !ui.reducedMotion;
    c.autoRotate = orbit || drift;
    c.autoRotateSpeed = orbit ? orbitSpeed * 4 : 0.45;
    if (drift && !ui.explode) {
      // a slow push-in (0.3 m/s, never closer than 9 m) on top of the drift, so a held shot is never a still photograph
      const away = camera.position.clone().sub(c.target);
      const dist = away.length();
      if (dist > 9) camera.position.addScaledVector(away.divideScalar(dist), -0.3 * dt);
    }
    camState.flying = flight.current !== null;

    // Composition: while the film plays, the subject is centred in the part of the view the side panels leave free
    // (the left panel covers 264 px, the right one min(94 vw, 410 px) + 8 px). The projection centre moves by half the
    // difference: shift = (left − right) / 2 px, applied as a view offset and eased so panels opening never jerk the shot.
    const W = size.width;
    const wantShift = ui.cinematic && !camState.fpv && W >= 900 ? ((ui.leftPanelOpen ? 264 : 0) - (ui.rightPanelOpen ? Math.min(0.94 * W, 410) + 8 : 0)) / 2 : 0;
    shift.current = THREE.MathUtils.damp(shift.current, wantShift, 3, dt);
    if (Math.abs(shift.current) < 0.2 && wantShift === 0) shift.current = 0;
    if (Math.abs(shift.current - applied.current) > 0.2 || (shift.current !== 0 && appliedW.current !== W) || (shift.current === 0 && applied.current !== 0)) {
      const cam = camera as THREE.PerspectiveCamera;
      if (shift.current === 0) cam.clearViewOffset();
      else cam.setViewOffset(W, size.height, -shift.current, 0, W, size.height);
      applied.current = shift.current;
      appliedW.current = W;
    }
    if (!camState.fpv) c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.07}
      rotateSpeed={0.7}
      zoomSpeed={0.9}
      panSpeed={0.8}
      screenSpacePanning
      minDistance={4}
      maxDistance={170}
      maxPolarAngle={Math.PI / 2.02}
      autoRotate={orbit}
      autoRotateSpeed={orbitSpeed * 4}
      target={[0, 9, 0]}
    />
  );
}
