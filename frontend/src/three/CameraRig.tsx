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
}

export function presetPose(goal: CameraGoal, assets: Asset[], explode: number): Pose {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (goal.preset) {
    case "roof":
      return { pos: v(24, floorY(6) + 13 + explodeOffset(6, explode), 24), target: v(0, floorY(6) + 1.5 + explodeOffset(6, explode), -3) };
    case "plant":
      return { pos: v(0, 7, 36), target: v(-1, -2, 0) };
    case "floor": {
      const l = goal.floor ?? 3;
      const y = floorY(l) + explodeOffset(l, explode);
      return { pos: v(26, y + 12, 34), target: v(0, y + 1.8, 0) };
    }
    case "asset":
    case "follow": {
      const a = assets.find((x) => x.id === goal.assetId);
      if (!a) return { pos: v(58, 38, 64), target: v(0, 10, 0) };
      const y = floorY(a.floor_level) + explodeOffset(a.floor_level, explode);
      const dist = goal.close ? 0.62 : 1;
      const isBasement = a.floor_level < 0;
      const off = a.floor_level === 3 ? v(6, 3.6, 8) : isBasement ? v(8, 9, 17) : v(10 * dist, 8 * dist + 1, 15 * dist);
      return { pos: v(a.position.x + off.x, y + off.y, a.position.z + off.z), target: v(a.position.x, y + (a.floor_level === 3 ? 3.2 : 1.6), a.position.z) };
    }
    default:
      return { pos: v(58, 40, 66), target: v(0, 9, 0) };
  }
}

/** Orbit camera with eased fly-to presets. User input cancels an ongoing fly-to. */
export function CameraRig({ orbit = false, orbitSpeed = 0.35 }: { orbit?: boolean; orbitSpeed?: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const { data: assets } = useAssets();
  const { data: wos } = useWorkOrders();
  const goal = useUi((s) => s.cameraGoal);
  const active = useRef<Pose | null>(null);
  const followId = useRef<string | null>(null);
  const settle = useRef(0);
  const assetList = useMemo(() => assets ?? [], [assets]);

  useEffect(() => {
    if (goal.nonce === 0) return;
    const pose = presetPose(goal, assetList, useUi.getState().explode);
    if (useUi.getState().reducedMotion) {
      camera.position.copy(pose.pos);
      controls.current?.target.copy(pose.target);
      return;
    }
    active.current = pose;
    settle.current = 0;
    followId.current = null;
    if (goal.preset === "follow") {
      const wo = (wos?.items ?? []).filter((w) => w.assigned_technician && w.asset_id === goal.assetId).sort((a, b) => b.id - a.id)[0];
      followId.current = wo?.assigned_technician?.id ?? null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.nonce]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const cancel = () => {
      active.current = null;
      followId.current = null;
    };
    c.addEventListener("start", cancel);
    return () => c.removeEventListener("start", cancel);
  }, []);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const a = active.current;
    if (a) {
      if (followId.current) {
        const p = techWorld.get(followId.current);
        if (p) {
          a.target.copy(p).add(new THREE.Vector3(0, 0.8, 0));
          a.pos.copy(p).add(new THREE.Vector3(7, 5.5, 9));
        }
      }
      const k = 3.2;
      camera.position.x = THREE.MathUtils.damp(camera.position.x, a.pos.x, k, delta);
      camera.position.y = THREE.MathUtils.damp(camera.position.y, a.pos.y, k, delta);
      camera.position.z = THREE.MathUtils.damp(camera.position.z, a.pos.z, k, delta);
      c.target.x = THREE.MathUtils.damp(c.target.x, a.target.x, k, delta);
      c.target.y = THREE.MathUtils.damp(c.target.y, a.target.y, k, delta);
      c.target.z = THREE.MathUtils.damp(c.target.z, a.target.z, k, delta);
      const close = camera.position.distanceTo(a.pos) < 0.15 && c.target.distanceTo(a.target) < 0.1;
      settle.current = close ? settle.current + delta : 0;
      if (settle.current > 0.4 && !followId.current) active.current = null;
    }
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={5}
      maxDistance={170}
      maxPolarAngle={Math.PI / 2.02}
      autoRotate={orbit}
      autoRotateSpeed={orbitSpeed * 4}
      target={[0, 9, 0]}
    />
  );
}
