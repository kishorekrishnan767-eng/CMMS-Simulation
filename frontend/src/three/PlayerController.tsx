import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { LIFT, explodeOffset, floorY } from "./constants";
import { camState } from "./CameraRig";
import { KISHORE } from "./office";
import {
  DESK, LANDING, PLAYER_LEVELS, RUN_SPEED, SPAWN, WALK_SPEED, leaveCar, nearCar, nearDesk, nearLift, player, resolve,
} from "./player";
import { liftRiders, techWorld } from "./Technicians";
import { stepVehicle, vehicle } from "./vehicle";

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
const smooth = (t: number) => t * t * (3 - 2 * t);
const EYE_STAND = 1.62;
const EYE_SEATED = 1.25;
const FOV_FPV = 72;
const FOV_ORBIT = 42;

interface Ride { phase: "in" | "ride" | "out"; t: number; from: number; to: number }

/**
 * Keyboard control of Kishore, seen through his own eyes.
 *   W A S D   walk and strafe relative to where he looks · Shift run
 *   drag the mouse (or ← → ↑ ↓) to look around
 *   E         sit at the BMS desk / get in or out of the car   · R / F  lift up / down (at the glass lift)
 *   In the car (chase camera): W gas · S brake, then reverse · A D steer · Space handbrake · Shift boost · E park
 *   Esc       give control back
 *
 * First person: the camera sits at his eye (1.62 m standing, 1.25 m seated) and looks along
 *   forward = (sin ψ·cos θ, sin θ, cos ψ·cos θ)       ψ = heading, θ = pitch
 * so a three.js camera (which looks down −z) needs rotation.y = ψ + π, rotation.x = θ (order YXZ).
 * While it is active the orbit controls are switched off and the camera rig leaves the camera alone.
 */
export function PlayerController() {
  const active = usePlayer((s) => s.active);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const keys = useRef(new Set<string>());
  const ride = useRef<Ride | null>(null);
  const sitT = useRef(1);
  const lastPrompt = useRef<string | null>(null);
  const dragging = useRef(false);
  const fpvApplied = useRef<boolean | null>(null);

  const worldY = (level: number) => floorY(level) + explodeOffset(level, useUi.getState().explode);

  /** Switch the camera between his eyes and the ordinary orbit camera. */
  const setFpv = (on: boolean) => {
    if (fpvApplied.current === on) return;
    fpvApplied.current = on;
    camState.fpv = on;
    camera.fov = on ? FOV_FPV : FOV_ORBIT;
    camera.near = on ? 0.15 : 0.5;
    camera.rotation.order = on ? "YXZ" : "XYZ";
    camera.updateProjectionMatrix();
    if (controls) controls.enabled = !on;
    if (!on) useUi.getState().fly({ preset: "player" });
  };

  // take / give back control
  useEffect(() => {
    if (!active) return;
    if (!player.active) {
      Object.assign(player, { active: true, x: SPAWN.x, z: SPAWN.z, level: SPAWN.level, yaw: SPAWN.yaw, pitch: 0, distance: 0, mode: "walk" });
    } else if (player.mode === "lift") {
      // the 3D canvas was rebuilt (e.g. quality lowered) mid-ride: step out at the landing instead of getting stuck
      Object.assign(player, { x: LANDING.x, z: LANDING.z, level: Math.round(player.level), mode: "walk" });
    }
    ride.current = null;
    sitT.current = 1;
    keys.current.clear();
    fpvApplied.current = null;
    return () => {
      if (usePlayer.getState().active) return; // only remounted (dev double-run, canvas rebuilt): keep him where he is
      const eye = new THREE.Vector3(player.x, worldY(player.level) + 1.2, player.z);
      player.active = false;
      ride.current = null;
      liftRiders.delete(KISHORE.id);
      techWorld.delete(KISHORE.id);
      usePlayer.getState().set({ prompt: null, seated: false });
      lastPrompt.current = null;
      useUi.getState().set({ cutaway: null });
      // hand the camera back to the orbit controls, just behind where he stood
      fpvApplied.current = null;
      camState.fpv = false;
      camera.fov = FOV_ORBIT;
      camera.near = 0.5;
      camera.rotation.order = "XYZ";
      camera.updateProjectionMatrix();
      camera.position.set(eye.x - Math.sin(player.yaw) * 7, eye.y + 4, eye.z - Math.cos(player.yaw) * 7);
      if (controls) {
        controls.enabled = true;
        controls.target.copy(eye);
        controls.update();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controls]);

  // look around by dragging on the 3D view, and keep the chase camera off the mouse while it orbits
  useEffect(() => {
    if (!controls) return;
    const on = () => { dragging.current = true; };
    const off = () => { dragging.current = false; };
    controls.addEventListener("start", on);
    controls.addEventListener("end", off);
    return () => {
      controls.removeEventListener("start", on);
      controls.removeEventListener("end", off);
    };
  }, [controls]);

  useEffect(() => {
    if (!active) return;
    const el = gl.domElement;
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || player.mode === "drive") return;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!last || player.mode === "drive") return;
      player.yaw -= (e.clientX - last.x) * 0.0035;
      player.pitch = THREE.MathUtils.clamp(player.pitch - (e.clientY - last.y) * 0.003, -1.3, 1.3);
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => { last = null; };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [active, gl]);

  // keyboard
  useEffect(() => {
    if (!active) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (TYPING.test(e.target.tagName) || e.target.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "escape") return usePlayer.getState().set({ active: false });
      if (["w", "a", "s", "d", "e", "r", "f", " ", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k)) e.preventDefault();
      if (k === "shift") keys.current.add("shift");
      if (!e.repeat && k === "e" && player.mode === "drive") {
        if (Math.abs(vehicle.v) < 3) leaveCar(); // the camera returns to his eyes on the next frame
      } else if (!e.repeat && k === "e" && nearDesk()) {
        Object.assign(player, { mode: "sit", yaw: DESK.yaw, pitch: 0 });
        sitT.current = 0;
        usePlayer.getState().set({ seated: true, sat: usePlayer.getState().sat + 1 });
      } else if (!e.repeat && k === "e" && nearCar()) {
        Object.assign(player, { mode: "drive", level: 0, x: vehicle.x, z: vehicle.z, yaw: vehicle.yaw, speed: 0 });
        usePlayer.getState().set({ seated: false });
        useUi.getState().set({ cutaway: null });
      }
      if (!e.repeat && (k === "r" || k === "f") && nearLift() && !ride.current) {
        const to = Math.round(player.level) + (k === "r" ? 1 : -1);
        if (PLAYER_LEVELS.includes(to)) {
          ride.current = { phase: "in", t: 0, from: Math.round(player.level), to };
          player.mode = "lift";
          player.yaw = 0; // into the cab
        }
      }
      keys.current.add(k);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [active]);

  useFrame((_, delta) => {
    if (!active || !player.active) return;
    const dt = Math.min(delta, 0.1); // a slow frame moves him further, but never far enough to skip through a wall
    const k = keys.current;
    const fpv = player.mode !== "drive";
    setFpv(fpv);

    // axes relative to where he looks
    const fx = Math.sin(player.yaw);
    const fz = Math.cos(player.yaw);
    const ix = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
    const iz = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
    if (fpv) {
      player.yaw += ((k.has("arrowleft") ? 1 : 0) - (k.has("arrowright") ? 1 : 0)) * 1.9 * dt;
      player.pitch = THREE.MathUtils.clamp(player.pitch + ((k.has("arrowup") ? 1 : 0) - (k.has("arrowdown") ? 1 : 0)) * 1.3 * dt, -1.3, 1.3);
    }

    if (player.mode === "drive") {
      stepVehicle({
        throttle: iz,
        steer: ix,
        handbrake: k.has(" "),
        boost: k.has("shift"),
      }, dt);
      player.distance += Math.abs(vehicle.v) * dt;
      Object.assign(player, { x: vehicle.x, z: vehicle.z, yaw: vehicle.yaw, speed: vehicle.v });
      const kmh = Math.round(Math.abs(vehicle.v) * 3.6);
      if (usePlayer.getState().speed !== kmh) usePlayer.getState().set({ speed: kmh });
    } else if (player.mode === "sit") {
      if (sitT.current < 1) {
        sitT.current = Math.min(1, sitT.current + dt / 0.5);
        const e = smooth(sitT.current);
        player.x += (DESK.x - player.x) * e;
        player.z += (DESK.z - player.z) * e;
      }
      if (ix || iz) {
        // stand up behind the chair
        player.mode = "walk";
        [player.x, player.z] = resolve(DESK.x, DESK.z + 0.9, DESK.level);
        usePlayer.getState().set({ seated: false });
      }
    } else if (player.mode === "walk") {
      if (ix || iz) {
        // forward = (sin ψ, cos ψ), the walker's right = (−cos ψ, sin ψ)
        const dx = fx * iz - Math.cos(player.yaw) * ix;
        const dz = fz * iz + Math.sin(player.yaw) * ix;
        const len = Math.hypot(dx, dz) || 1;
        const speed = k.has("shift") ? RUN_SPEED : WALK_SPEED;
        const [nx, nz] = resolve(player.x + (dx / len) * speed * dt, player.z + (dz / len) * speed * dt, player.level);
        player.distance += Math.hypot(nx - player.x, nz - player.z);
        player.x = nx;
        player.z = nz;
      }
    } else if (ride.current) {
      const r = ride.current;
      const cab = { x: LIFT.x, z: LIFT.z };
      if (r.phase === "in") {
        r.t = Math.min(1, r.t + dt / 0.7);
        const e = smooth(r.t);
        player.x = LANDING.x + (cab.x - LANDING.x) * e;
        player.z = LANDING.z + (cab.z - LANDING.z) * e;
        if (r.t >= 1) Object.assign(r, { phase: "ride", t: 0 });
      } else if (r.phase === "ride") {
        r.t = Math.min(1, r.t + dt / (1.6 * Math.abs(r.to - r.from)));
        player.level = r.from + (r.to - r.from) * smooth(r.t);
        if (r.t >= 1) {
          Object.assign(r, { phase: "out", t: 0, from: r.to });
          player.yaw = Math.PI; // turn round and step out towards the building
        }
      } else {
        r.t = Math.min(1, r.t + dt / 0.7);
        const e = smooth(r.t);
        player.x = cab.x + (LANDING.x - cab.x) * e;
        player.z = cab.z + (LANDING.z - cab.z) * e;
        if (r.t >= 1) {
          player.level = r.to;
          player.mode = "walk";
          ride.current = null;
        }
      }
    }
    // the glass lift carries him, so its cab follows
    if (player.mode === "lift") liftRiders.set(KISHORE.id, worldY(player.level));
    else liftRiders.delete(KISHORE.id);

    // the floors above him turn to a faint ghost while he is inside; the whole tower shows when he is outside
    const lvl = Math.round(player.level);
    if (usePlayer.getState().level !== lvl) usePlayer.getState().set({ level: lvl });
    const outside = player.mode === "drive" || (player.level < 0.2 && (player.z > 12.2 || Math.abs(player.x) > 20));
    const wantCut = outside ? null : lvl;
    if (useUi.getState().cutaway !== wantCut) useUi.getState().set({ cutaway: wantCut });

    // context hint
    const prompt =
      player.mode === "drive" ? "W gas · S brake / reverse · A D steer · Space handbrake · E park" :
      player.mode === "sit" ? "Move to stand up" :
      nearDesk() ? "E  sit at the BMS desk" :
      nearCar() ? "E  get in the car" :
      nearLift() ? `R  lift up   F  lift down   (Floor ${lvl})` : null;
    if (prompt !== lastPrompt.current) {
      lastPrompt.current = prompt;
      usePlayer.getState().set({ prompt });
    }

    if (!controls) return;
    if (fpv) {
      // through his eyes
      const eyeY = worldY(player.level) + (player.mode === "sit" ? EYE_SEATED : EYE_STAND);
      camera.position.set(player.x, eyeY, player.z);
      camera.rotation.set(player.pitch, player.yaw + Math.PI, 0, "YXZ");
      const cp = Math.cos(player.pitch);
      controls.target.set(player.x + fx * cp * 3, eyeY + Math.sin(player.pitch) * 3, player.z + fz * cp * 3);
      return;
    }

    // driving: chase camera. It moves with the car (so the mouse can still orbit) and swings round behind it
    const eye = new THREE.Vector3(player.x, worldY(player.level) + 1.2, player.z);
    if (!camState.flying) {
      const err = eye.clone().sub(controls.target);
      const follow = err.multiplyScalar(1 - Math.exp(-14 * dt));
      controls.target.add(follow);
      camera.position.add(follow);
      if (!dragging.current && vehicle.v > 1) {
        const off = camera.position.clone().sub(controls.target);
        const radius = Math.hypot(off.x, off.z);
        let ang = Math.atan2(off.x, off.z);
        const want = vehicle.yaw + Math.PI;
        const diff = Math.atan2(Math.sin(want - ang), Math.cos(want - ang));
        ang += diff * (1 - Math.exp(-THREE.MathUtils.clamp(vehicle.v / 8, 0, 1.5) * 2.2 * dt));
        camera.position.set(controls.target.x + Math.sin(ang) * radius, camera.position.y, controls.target.z + Math.cos(ang) * radius);
      }
    }
  });

  return null;
}
