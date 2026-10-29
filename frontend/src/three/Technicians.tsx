import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { useAssets, useProcedures, useTechnicians, useWorkOrders } from "../api/queries";
import type { Asset, ProcedureStep, Technician, WorkOrderSummary } from "../api/types";
import { simNowMs } from "../store/live";
import { useUi } from "../store/ui";
import { explodeOffset, floorLabel, floorY } from "./constants";
import { Person, type Joints } from "./Person";
import { buildPath, techPose, type Pose } from "./techPath";

/** World positions of technicians, refreshed every frame (used by the follow camera). */
export const techWorld = new Map<string, THREE.Vector3>();
/** World Y of every technician currently riding the lift (read by the lift cab). */
export const liftRiders = new Map<string, number>();
/** Heading (radians, 0 = +z) and activity of every technician, refreshed every frame for the cinematic camera. */
export interface Motion { yaw: number; inLift: boolean; phase: string }
export const techMotion = new Map<string, Motion>();
// test/debug hook (see main.tsx): lets automated checks ask where a technician is on screen
if (typeof window !== "undefined") {
  const hook = (window as unknown as { __twin?: Record<string, unknown> }).__twin;
  if (hook) Object.assign(hook, { techWorld, techMotion });
}

const SKIN = "#c99a78";
const TROUSERS = "#2d3640";
const SHIRT = "#4a5560";
const HAT = "#f4f4f2";
const BOOT = "#1d2126";

/** How long (wall seconds) the dispatch message stays above a technician after a new assignment. */
const MESSAGE_SECONDS = 7;

interface Rig extends Joints {
  wrench: THREE.Object3D;
  tablet: THREE.Object3D;
  boxHand: THREE.Object3D;
  boxFloor: THREE.Object3D;
}

const damp = THREE.MathUtils.damp;

/** Pose targets per procedure step: crouch (0..1), torso lean, and which prop is in hand. */
const STEP_STYLE: Record<string, { crouch: number; lean: number; prop: "wrench" | "tablet" | null; tempo: number }> = {
  permit: { crouch: 0, lean: 0.05, prop: "tablet", tempo: 1.2 },
  inspect: { crouch: 0.55, lean: 0.35, prop: null, tempo: 1.8 },
  measure: { crouch: 0.2, lean: 0.2, prop: "tablet", tempo: 1.4 },
  replace: { crouch: 0.85, lean: 0.4, prop: "wrench", tempo: 6.5 },
  align: { crouch: 0.6, lean: 0.3, prop: "wrench", tempo: 3.2 },
  test: { crouch: 0, lean: -0.05, prop: "tablet", tempo: 0.8 },
};

const Avatar = memo(function Avatar({ tech, wo, asset, steps }: { tech: Technician; wo: WorkOrderSummary | null; asset: Asset | null; steps: ProcedureStep[] | null }) {
  const rig = useRef<Partial<Rig>>({});
  const r = rig.current;
  const mount = <K extends "wrench" | "tablet" | "boxHand" | "boxFloor">(k: K) => (o: THREE.Object3D | null) => {
    if (o) r[k] = o;
  };
  const look = useMemo(() => ({ chest: tech.color, sleeve: SHIRT, pants: TROUSERS, skin: SKIN, boots: BOOT, hat: HAT, stripes: true }), [tech.color]);
  const label = useRef<HTMLDivElement>(null);
  const msg = useRef<HTMLDivElement>(null);
  const beacon = useRef<THREE.Group>(null);
  const beaconRing = useRef<THREE.Mesh>(null);
  const beaconArrow = useRef<THREE.Mesh>(null);
  const yaw = useRef(0);
  const smooth = useRef<THREE.Vector3 | null>(null);
  const crouch = useRef(0);
  const sit = useRef(1);
  const lean = useRef(0);
  const gait = useRef(0);
  const last = useMemo(() => new THREE.Vector3(), []);
  const visible = useUi((s) => s.showTechnicians);
  const [message, setMessage] = useState<string | null>(null);

  // A new assignment is "radioed" to the technician: show it above their head for a few seconds.
  const assignKey = wo?.assigned_at && wo.status !== "CLOSED" ? `${wo.number}@${wo.assigned_at}` : null;
  const seen = useRef<string | null>(assignKey);
  useEffect(() => {
    if (!assignKey || assignKey === seen.current || !wo || !asset) return;
    seen.current = assignKey;
    setMessage(`${wo.number} · ${wo.priority} — ${asset.name}, ${floorLabel(asset.floor_level)}. ${wo.title.split("—")[0].trim()}`);
    const t = window.setTimeout(() => setMessage(null), MESSAGE_SECONDS * 1000);
    return () => window.clearTimeout(t);
  }, [assignKey, wo, asset]);

  useFrame((state, delta) => {
    const g = r.root;
    if (!g || !r.body || !r.hipL || !r.hipR || !r.kneeL || !r.kneeR || !r.armL || !r.armR || !r.elbowL || !r.elbowR || !r.torso || !r.head) return;
    const ui = useUi.getState();
    const dt = Math.min(delta, 0.05);
    const p: Pose = techPose(tech, wo, asset, simNowMs(), steps);
    const y = floorY(p.level) + explodeOffset(p.level, ui.explode);
    const target = new THREE.Vector3(p.x, y, p.z);
    // follow the analytic pose with a short critically-damped lag: hides refetch jitter, never drifts
    if (!smooth.current || smooth.current.distanceTo(target) > 8) smooth.current = target.clone();
    const k = ui.reducedMotion ? 60 : 14;
    smooth.current.set(damp(smooth.current.x, target.x, k, dt), damp(smooth.current.y, target.y, k, dt), damp(smooth.current.z, target.z, k, dt));
    const speed = last.distanceTo(smooth.current) / Math.max(dt, 1e-4);
    last.copy(smooth.current);
    g.position.copy(smooth.current);
    techWorld.set(tech.id, smooth.current.clone().setY(smooth.current.y + 1));
    const motion = techMotion.get(tech.id);
    if (motion) Object.assign(motion, { yaw: p.yaw, inLift: p.inLift, phase: p.phase });
    else techMotion.set(tech.id, { yaw: p.yaw, inLift: p.inLift, phase: p.phase });
    if (p.inLift) liftRiders.set(tech.id, y);
    else liftRiders.delete(tech.id);

    // locator: the worker the camera trails (or any worker on the walk while the film plays) glows through walls
    const spot = ui.following === tech.id || (ui.cinematic && p.phase === "walking");
    if (beacon.current) {
      beacon.current.visible = spot && g.visible;
      if (spot) {
        const pulse = Math.sin(state.clock.elapsedTime * 4);
        beaconRing.current?.scale.setScalar(1 + 0.12 * pulse);
        if (beaconArrow.current) beaconArrow.current.position.y = 3.25 + 0.14 * pulse;
      }
    }

    const onSite = p.phase === "working" || p.phase === "arrived";
    const face = onSite && asset ? Math.atan2(asset.position.x - p.x, asset.position.z - p.z) : p.yaw;
    let d = face - yaw.current;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw.current += d * Math.min(1, dt * 7);
    g.rotation.y = yaw.current;
    // hide technicians on floors that are lifted off by the camera cutaway
    // off-shift technicians have gone home; the crew board still lists them
    const shown = visible && (ui.cutaway === null || p.level <= ui.cutaway + 0.01) && !(p.phase === "idle" && !tech.on_shift);
    g.visible = shown;
    const tag = label.current?.parentElement;
    const near = state.camera.position.distanceTo(g.position) < 60 || p.phase === "walking" || p.phase === "working";
    const showTag = shown && near;
    if (tag && tag.style.display !== (showTag ? "" : "none")) tag.style.display = showTag ? "" : "none";

    const t = state.clock.elapsedTime;
    const moving = (p.phase === "walking" || p.phase === "returning") && !p.inLift && speed > 0.05;
    // stride follows distance travelled; at very high sim speeds fall back to a brisk fixed cadence
    gait.current = moving ? (speed > 5 ? gait.current + dt * 9 : p.distance * 2.3) : gait.current;
    const swing = moving ? Math.sin(gait.current) : 0;
    const style = p.phase === "working" && p.stepKey ? STEP_STYLE[p.stepKey] ?? STEP_STYLE.inspect : null;

    sit.current = damp(sit.current, p.seated ? 1 : 0, 6, dt);
    crouch.current = damp(crouch.current, style ? style.crouch : 0, 4, dt);
    lean.current = damp(lean.current, style ? style.lean : moving ? 0.08 : 0, 5, dt);
    const s = sit.current;
    const c = crouch.current;

    // legs: hip pitch (forward is negative x-rotation), knee bends back
    const hipBase = -1.5 * s - 1.05 * c;
    const kneeBase = 1.55 * s + 1.9 * c;
    r.hipL.rotation.x = hipBase + swing * 0.55 * (1 - s);
    r.hipR.rotation.x = hipBase - swing * 0.55 * (1 - s);
    r.kneeL.rotation.x = kneeBase + Math.max(0, -swing) * 0.7 * (1 - s);
    r.kneeR.rotation.x = kneeBase + Math.max(0, swing) * 0.7 * (1 - s);
    // body drops when sitting / crouching; small bob while walking; slow breathing at rest
    const bob = moving ? Math.abs(Math.cos(gait.current)) * 0.045 : Math.sin(t * 1.3 + tech.id.length) * 0.006;
    r.body.position.y = -0.44 * s - 0.42 * c + bob;
    r.body.position.z = -0.08 * s;
    r.torso.rotation.x = lean.current + (s > 0.5 ? 0.12 : 0);
    r.head.rotation.x = style ? 0.25 : s > 0.5 ? 0.2 + Math.sin(t * 0.4 + tech.id.length) * 0.08 : 0;
    r.head.rotation.y = s > 0.5 ? Math.sin(t * 0.23 + tech.id.length * 2) * 0.35 : 0;

    // arms
    let aL = -swing * 0.6;
    let aR = swing * 0.6;
    let eL = 0.25;
    let eR = 0.25;
    if (p.phase === "walking" || p.phase === "returning") {
      aL = 0.05; // left hand carries the toolbox
      eL = 0.1;
    }
    if (s > 0.5) {
      aL = -0.9; aR = -0.9; eL = 1.1; eR = 1.1; // forearms on the table
    }
    if (p.phase === "arrived") {
      aL = -0.3; aR = -0.5; eR = 1.2; // checking the permit on the tablet
    }
    if (style) {
      const w = Math.sin(t * style.tempo);
      if (style.prop === "wrench") {
        aR = -1.25 + w * 0.35; eR = 0.6 + Math.max(0, w) * 0.5; aL = -1.0; eL = 0.5;
      } else if (style.prop === "tablet") {
        aL = -0.85; eL = 1.2; aR = -0.6 + w * 0.12; eR = 1.0;
      } else {
        aR = -1.1 + w * 0.25; eR = 0.4; aL = -0.7 + Math.sin(t * style.tempo + 1.4) * 0.2; eL = 0.5;
      }
    }
    r.armL.rotation.x = damp(r.armL.rotation.x, aL, 10, dt);
    r.armR.rotation.x = damp(r.armR.rotation.x, aR, 10, dt);
    r.elbowL.rotation.x = damp(r.elbowL.rotation.x, -eL, 10, dt);
    r.elbowR.rotation.x = damp(r.elbowR.rotation.x, -eR, 10, dt);

    if (r.wrench) r.wrench.visible = style?.prop === "wrench";
    if (r.tablet) r.tablet.visible = style?.prop === "tablet" || p.phase === "arrived";
    if (r.boxHand) r.boxHand.visible = p.phase === "walking" || p.phase === "returning";
    if (r.boxFloor) r.boxFloor.visible = onSite;

    if (label.current) {
      const text = `${tech.name.split(" ")[0]} · ${p.text}`;
      if (label.current.textContent !== text) label.current.textContent = text;
      if (label.current.dataset.phase !== p.phase) label.current.dataset.phase = p.phase;
    }
  });

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        const ui = useUi.getState();
        if (wo && asset && wo.status !== "CLOSED") ui.selectAsset(wo.asset_id);
        else ui.fly({ preset: "crew" });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <Person
        look={look}
        onReady={(j) => Object.assign(r, j)}
        handR={
          <group ref={mount("wrench")} position={[0, -0.02, 0.08]} rotation-x={Math.PI / 2} visible={false}>
            <mesh>
              <boxGeometry args={[0.035, 0.26, 0.02]} />
              <meshStandardMaterial color="#a8b0b8" metalness={0.85} roughness={0.3} />
            </mesh>
            <mesh position={[0, 0.14, 0]}>
              <torusGeometry args={[0.035, 0.012, 6, 12, Math.PI * 1.5]} />
              <meshStandardMaterial color="#a8b0b8" metalness={0.85} roughness={0.3} />
            </mesh>
          </group>
        }
        handL={
          <>
            <group ref={mount("tablet")} position={[0.06, 0, 0.1]} rotation-x={-0.9} visible={false}>
              <mesh>
                <boxGeometry args={[0.2, 0.014, 0.27]} />
                <meshStandardMaterial color="#22272d" roughness={0.5} />
              </mesh>
              <mesh position={[0, 0.008, 0]}>
                <planeGeometry args={[0.17, 0.23]} />
                <meshBasicMaterial color="#9cc2ef" side={THREE.DoubleSide} />
              </mesh>
            </group>
            <group ref={mount("boxHand")} position={[0, -0.12, 0]} visible={false}>
              <Toolbox />
            </group>
          </>
        }
      >
        <group ref={mount("boxFloor")} position={[0.55, 0.1, 0.15]} rotation-y={0.4} visible={false}>
          <Toolbox />
        </group>
        <group ref={beacon} visible={false}>
          {/* drawn without depth testing, so the worker is never lost behind a wall, a machine or the lift frame */}
          <mesh ref={beaconRing} position={[0, 0.06, 0]} rotation-x={-Math.PI / 2} renderOrder={8}>
            <ringGeometry args={[0.62, 0.8, 40]} />
            <meshBasicMaterial color={tech.color} transparent opacity={0.95} depthTest={false} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, 0.07, 0]} rotation-x={-Math.PI / 2} renderOrder={8}>
            <circleGeometry args={[0.62, 32]} />
            <meshBasicMaterial color={tech.color} transparent opacity={0.22} depthTest={false} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, 1.15, 0]} renderOrder={7}>
            <cylinderGeometry args={[0.7, 0.7, 2.3, 24, 1, true]} />
            <meshBasicMaterial color={tech.color} transparent opacity={0.1} depthTest={false} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh ref={beaconArrow} position={[0, 3.25, 0]} rotation-x={Math.PI} renderOrder={8}>
            <coneGeometry args={[0.2, 0.42, 4]} />
            <meshBasicMaterial color={tech.color} depthTest={false} toneMapped={false} />
          </mesh>
        </group>
        <Html position={[0, 2.25, 0]} center zIndexRange={[18, 0]} style={{ pointerEvents: "none" }}>
          <div className="tech-tag" data-testid={`tech-${tech.id}`} style={{ ["--vest" as string]: tech.color }}>
            {message && (
              <div ref={msg} className="tech-msg" data-testid={`tech-msg-${tech.id}`}>
                <b>Dispatch → {tech.name.split(" ")[0]}</b>
                {message}
              </div>
            )}
            <div ref={label} className="tech-tag-text" data-phase="idle" />
          </div>
        </Html>
      </Person>
    </group>
  );
});

function Toolbox() {
  return (
    <group>
      <mesh castShadow>
        <boxGeometry args={[0.36, 0.17, 0.17]} />
        <meshStandardMaterial color="#c23b2b" roughness={0.55} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.12, 0]}>
        <boxGeometry args={[0.2, 0.025, 0.03]} />
        <meshStandardMaterial color="#20252a" />
      </mesh>
    </group>
  );
}

/** Dashed route from the crew room to the asset while a technician is on the way there. */
function Route({ tech, asset }: { tech: Technician; asset: Asset }) {
  const explode = useUi((s) => s.explode);
  const color = tech.color;
  const pts = useMemo(
    () => buildPath(tech.id, asset).map((w) => new THREE.Vector3(w.x, floorY(w.level) + explodeOffset(w.level, explode) + 0.07, w.z)),
    [tech.id, asset, explode],
  );
  const end = pts[pts.length - 1];
  const ring = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (ring.current) ring.current.scale.setScalar(1 + 0.12 * Math.sin(state.clock.elapsedTime * 3));
  });
  return (
    <group>
      <Line points={pts} color={color} lineWidth={2} dashed dashSize={0.5} gapSize={0.35} transparent opacity={0.85} depthTest={false} renderOrder={6} />
      <mesh ref={ring} position={end} rotation-x={-Math.PI / 2} renderOrder={6}>
        <ringGeometry args={[0.45, 0.6, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} depthTest={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Technician avatars: pose is derived from work-order timestamps and the sim clock, so walking
 *  speeds up, slows down and pauses exactly with the simulation. */
export function Technicians() {
  const { data: techs } = useTechnicians();
  const { data: wos } = useWorkOrders();
  const { data: assets } = useAssets();
  const { data: catalogue } = useProcedures();
  const show = useUi((s) => s.showTechnicians);
  const byTech = useMemo(() => {
    const m = new Map<string, WorkOrderSummary>();
    for (const w of [...(wos?.items ?? [])].sort((a, b) => a.id - b.id)) if (w.assigned_technician) m.set(w.assigned_technician.id, w);
    return m;
  }, [wos]);
  const assetMap = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  // Re-render a few times a second so the route shows only while a walk is under way.
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  const now = simNowMs();
  return (
    <group>
      {(techs ?? []).map((t) => {
        const wo = byTech.get(t.id) ?? null;
        const asset = wo ? assetMap.get(wo.asset_id) ?? null : null;
        const steps = asset && catalogue ? (wo && wo.repair_count >= 1 ? catalogue.rework : catalogue.procedures[asset.asset_type] ?? null) : null;
        const pose = techPose(t, wo, asset, now, steps);
        return (
          <group key={t.id}>
            <Avatar tech={t} wo={wo} asset={asset} steps={steps} />
            {show && wo && asset && pose.phase === "walking" && <Route tech={t} asset={asset} />}
          </group>
        );
      })}
    </group>
  );
}
