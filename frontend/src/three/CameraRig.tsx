import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useAssets, useWorkOrders } from "../api/queries";
import type { Asset } from "../api/types";
import { useUi, type CameraGoal } from "../store/ui";
import { explodeOffset, floorY } from "./constants";
import { techWorld } from "./Technicians";

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
      const off = a.floor_level === 3 ? v(6, 3.6, 8) : v(10 * dist, 8 * dist + 1, 15 * dist);
      // inner floors: ghost what is above so the asset is not hidden by the ceiling
      return {
        pos: v(a.position.x + off.x, y + off.y, a.position.z + off.z),
        target: v(a.position.x, y + (a.floor_level === 3 ? 3.2 : 1.6), a.position.z),
        cutaway: a.floor_level < 6 ? a.floor_level : null,
      };
    }
    default:
      return { pos: v(58, 40, 66), target: v(0, 9, 0), cutaway: null };
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
  const { data: assets } = useAssets();
  const { data: wos } = useWorkOrders();
  const goal = useUi((s) => s.cameraGoal);
  const flight = useRef<Flight | null>(null);
  const followId = useRef<string | null>(null);
  const assetList = useMemo(() => assets ?? [], [assets]);

  useEffect(() => {
    if (goal.nonce === 0) return;
    const ui = useUi.getState();
    const pose = presetPose(goal, assetList, ui.explode);
    ui.set({ cutaway: pose.cutaway });
    followId.current = null;
    if (goal.preset === "follow") {
      const wo = (wos?.items ?? []).filter((w) => w.assigned_technician && w.asset_id === goal.assetId).sort((a, b) => b.id - a.id)[0];
      followId.current = wo?.assigned_technician?.id ?? null;
    }
    const c = controls.current;
    if (ui.reducedMotion || !c) {
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
      duration: THREE.MathUtils.clamp(0.9 + dist / 60, 0.9, 2.2),
      arc: Math.min(10, dist * 0.12),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.nonce]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const cancel = () => {
      flight.current = null;
      followId.current = null;
    };
    c.addEventListener("start", cancel);
    return () => c.removeEventListener("start", cancel);
  }, []);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const dt = Math.min(delta, 0.05);
    const f = flight.current;
    const follow = followId.current ? techWorld.get(followId.current) : undefined;
    if (f) {
      if (follow) {
        // keep re-aiming at the moving technician while flying in
        f.to.target.copy(follow).add(v(0, 0.2, 0));
        f.to.pos.copy(follow).add(v(7, 5.5, 9));
      }
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = ease(f.t);
      camera.position.lerpVectors(f.fromPos, f.to.pos, e);
      camera.position.y += f.arc * Math.sin(Math.PI * f.t);
      c.target.lerpVectors(f.fromTarget, f.to.target, e);
      if (f.t >= 1) flight.current = null;
    } else if (follow) {
      const k = 3;
      const tgt = follow.clone().add(v(0, 0.2, 0));
      const pos = follow.clone().add(v(7, 5.5, 9));
      c.target.set(THREE.MathUtils.damp(c.target.x, tgt.x, k, dt), THREE.MathUtils.damp(c.target.y, tgt.y, k, dt), THREE.MathUtils.damp(c.target.z, tgt.z, k, dt));
      camera.position.set(THREE.MathUtils.damp(camera.position.x, pos.x, k, dt), THREE.MathUtils.damp(camera.position.y, pos.y, k, dt), THREE.MathUtils.damp(camera.position.z, pos.z, k, dt));
    }
    c.update();
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
