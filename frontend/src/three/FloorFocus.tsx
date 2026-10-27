import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useUi } from "../store/ui";
import { FLOOR_H, ROOF_LEVEL } from "./constants";
import { camState } from "./CameraRig";
import { player } from "./player";

/**
 * Free roaming through the tower. The floor being looked at is the floor that contains the orbit
 * target; while the camera is zoomed in on the building every floor above it is lifted off, so any
 * floor (basement plant room included) can be entered, orbited and panned across with the mouse.
 * Zoom out, or look at the roof or the street, and the whole tower comes back.
 *
 *   level = ⌊target.y / FLOOR_H⌋           (ground floor y ∈ [0, 4), basement y ∈ [−4, 0), …)
 *   focus when |target.x| < 26, |target.z| < 18 and the camera is closer than 36 m (leave at 46 m)
 *
 * Fly-to presets, the followed person and the keyboard-controlled Kishore set the cut-away
 * themselves; this component only takes over once none of them is in charge.
 */
export function FloorFocus() {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const last = useRef<number | null | undefined>(undefined);

  // test/debug hook: lets automated checks move the camera like a user dragging the mouse would
  useEffect(() => {
    const w = window as unknown as { __twin?: Record<string, unknown> };
    if (w.__twin) Object.assign(w.__twin, { controls, camera, camState });
  }, [controls, camera]);

  useFrame(() => {
    if (!controls) return;
    const ui = useUi.getState();
    if (ui.following || player.active || ui.explode > 0.02 || ui.isolatedFloor !== null) return;
    const t = controls.target;
    const dist = camera.position.distanceTo(t);
    const level = Math.floor(t.y / FLOOR_H);
    const inside = Math.abs(t.x) < 26 && Math.abs(t.z) < 18 && level >= -1 && level < ROOF_LEVEL;
    const near = dist < (last.current != null ? 46 : 36);
    const want = inside && near ? level : null;
    // flights set the cut-away themselves; follow the camera on changes, and re-assert it once settled
    if (want !== last.current || (!camState.flying && ui.cutaway !== want)) {
      last.current = want;
      if (ui.cutaway !== want) ui.set({ cutaway: want });
    }
  });
  return null;
}
