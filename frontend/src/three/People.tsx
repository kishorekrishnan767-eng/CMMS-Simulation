import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useAsset, useWalkthrough } from "../api/queries";
import { simNowMs, useLive } from "../store/live";
import { useUi } from "../store/ui";
import { explodeOffset, floorY } from "./constants";
import { EMPLOYEES, KISHORE, type Employee } from "./office";
import { Person, type Joints } from "./Person";
import { player, playerPose } from "./player";
import { staffPose } from "./staff";
import { liftRiders, techWorld } from "./Technicians";

const damp = THREE.MathUtils.damp;
const BUBBLE_SECONDS = 6;

/** What Kishore is doing in the one-minute run (read by his avatar every frame): reading the request, or approving. */
export const kishoreReview: { mode: "reviewing" | "approved" | null; run: boolean } = { mode: null, run: false };

/** What Kishore (the BMS supervisor) says when the real system raises or advances something. */
const BUBBLE: Record<string, (e: { asset_id: string | null; payload: Record<string, any> }) => string> = {
  AnomalyDetected: (e) => `Early warning on ${e.asset_id}. Checking the trend.`,
  WorkOrderDrafted: (e) => `New work order ${e.payload.work_order}. Reviewing the evidence.`,
  WorkOrderApproved: (e) => `Approved ${e.payload.work_order}.`,
  TechnicianAssigned: (e) => `Sending ${e.payload.technician_name} to ${e.asset_id}.`,
  PartsShortage: (e) => `${e.payload.work_order} is waiting for parts. Ordering.`,
  WorkOrderClosed: (e) => `Closed ${e.payload.work_order}. All clear.`,
};

/** A named employee: walks in from the street, rides the lift, sits at the desk and works. */
const EmployeeAvatar = memo(function EmployeeAvatar({ emp }: { emp: Employee }) {
  const j = useRef<Joints | null>(null);
  const label = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const ring = useRef<THREE.Mesh>(null);
  const smooth = useRef<THREE.Vector3 | null>(null);
  const prevPhase = useRef<string>("away");
  const yaw = useRef(emp.seat.yaw);
  const sit = useRef(0);
  const gait = useRef(0);
  const last = useMemo(() => new THREE.Vector3(), []);
  const people = useUi((s) => s.showTechnicians);
  const [bubble, setBubble] = useState<string | null>(null);
  const look = useMemo(() => emp.look, [emp]);

  // Kishore reacts to what the BMS sees: subscribe to the live event stream.
  useEffect(() => {
    if (emp.id !== KISHORE.id) return;
    let lastId = useLive.getState().recentEvents[0]?.event_id;
    let timer: number | undefined;
    const unsub = useLive.subscribe((s) => {
      const e = s.recentEvents[0];
      if (!e || e.event_id === lastId) return;
      lastId = e.event_id;
      const f = BUBBLE[e.event_type];
      if (!f || kishoreReview.run) return;
      setBubble(f(e));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBubble(null), BUBBLE_SECONDS * 1000);
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [emp.id]);

  useFrame((state, delta) => {
    const r = j.current;
    if (!r) return;
    const ui = useUi.getState();
    const dt = Math.min(delta, 0.05);
    // Kishore under keyboard control ignores the clock: he is wherever the player has walked him
    const steered = emp.id === KISHORE.id && player.active;
    const p = steered ? playerPose() : staffPose(emp, simNowMs());
    const followed = ui.following === emp.id || steered;
    // selected while still at home: start trailing them the moment they arrive
    if (prevPhase.current === "away" && p.phase === "arriving" && ui.selectedPersonId === emp.id && !followed) ui.fly({ preset: "person", personId: emp.id });
    prevPhase.current = p.phase;
    // a followed person is always shown (the camera's cutaway follows them, not the other way round)
    // in first person (and in the car) his own body is not drawn: the camera is his eyes
    const present = steered
      ? false
      : p.phase !== "away" && people && (followed || ui.cutaway === null || p.level <= ui.cutaway + 0.01);
    r.root.visible = present;
    // name tags only when the camera is reasonably close (otherwise they clutter the overview)
    const near = state.camera.position.distanceTo(r.root.position) < 48 || ui.selectedPersonId === emp.id;
    if (tag.current) tag.current.style.display = present && ui.showLabels && near ? "" : "none";
    if (!present) {
      liftRiders.delete(emp.id);
      techWorld.delete(emp.id);
      smooth.current = null;
      return;
    }
    const y = floorY(p.level) + explodeOffset(p.level, ui.explode);
    const target = new THREE.Vector3(p.x, y, p.z);
    if (!smooth.current || smooth.current.distanceTo(target) > 8) smooth.current = target.clone();
    const k = ui.reducedMotion ? 60 : 14;
    smooth.current.set(damp(smooth.current.x, target.x, k, dt), damp(smooth.current.y, target.y, k, dt), damp(smooth.current.z, target.z, k, dt));
    const speed = last.distanceTo(smooth.current) / Math.max(dt, 1e-4);
    last.copy(smooth.current);
    r.root.position.copy(smooth.current);
    techWorld.set(emp.id, smooth.current.clone().setY(smooth.current.y + 1));
    if (p.inLift) liftRiders.set(emp.id, y);
    else liftRiders.delete(emp.id);

    // face the walking direction; seated people face their monitor
    const seated = p.phase === "seated";
    const face = seated ? p.seatedYaw : p.yaw;
    let d = face - yaw.current;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw.current += d * Math.min(1, dt * (seated ? 4 : 7));
    r.root.rotation.y = yaw.current;

    const t = state.clock.elapsedTime;
    const moving = !seated && !p.inLift && speed > 0.05;
    gait.current = moving ? (speed > 5 ? gait.current + dt * 9 : p.distance * 2.3) : gait.current;
    const swing = moving ? Math.sin(gait.current) : 0;
    sit.current = damp(sit.current, seated ? 1 : 0, 6, dt);
    const s = sit.current;
    r.hipL.rotation.x = -1.5 * s + swing * 0.55 * (1 - s);
    r.hipR.rotation.x = -1.5 * s - swing * 0.55 * (1 - s);
    r.kneeL.rotation.x = 1.55 * s + Math.max(0, -swing) * 0.7 * (1 - s);
    r.kneeR.rotation.x = 1.55 * s + Math.max(0, swing) * 0.7 * (1 - s);
    r.body.position.y = -0.44 * s + (moving ? Math.abs(Math.cos(gait.current)) * 0.045 : Math.sin(t * 1.3 + emp.id.length) * 0.006);
    r.body.position.z = -0.08 * s;
    r.torso.rotation.x = 0.24 * s + (moving ? 0.06 : 0);
    // typing, or checking the BMS wall (Kishore looks across the screens)
    const review = emp.id === KISHORE.id && seated ? kishoreReview.mode : null;
    const typing = seated ? Math.sin(t * (review === "reviewing" ? 13 : 9) + emp.id.length) * 0.07 : 0;
    if (review) {
      // reading the request: eyes on his screen, leaning in; approved: a thumbs-up
      r.head.rotation.x = damp(r.head.rotation.x, review === "reviewing" ? 0.28 : 0.05, 6, dt);
      r.head.rotation.y = damp(r.head.rotation.y, review === "reviewing" ? Math.sin(t * 0.9) * 0.08 : 0.25, 6, dt);
      r.torso.rotation.x = 0.24 * s + (review === "reviewing" ? 0.14 : 0);
    } else {
      r.head.rotation.x = seated ? 0.15 : 0;
      r.head.rotation.y = seated ? Math.sin(t * (emp.id === KISHORE.id ? 0.45 : 0.18) + emp.id.length) * (emp.id === KISHORE.id ? 0.5 : 0.25) : 0;
    }
    const aL = seated ? -0.9 : -swing * 0.6;
    const aR = review === "approved" ? -2.5 : seated ? -0.9 : swing * 0.6;
    r.armL.rotation.x = damp(r.armL.rotation.x, aL, 10, dt);
    r.armR.rotation.x = damp(r.armR.rotation.x, aR, 10, dt);
    r.elbowL.rotation.x = damp(r.elbowL.rotation.x, seated ? -1.1 + typing : -0.25, 10, dt);
    r.elbowR.rotation.x = damp(r.elbowR.rotation.x, review === "approved" ? -0.5 : seated ? -1.1 - typing : -0.25, 10, dt);

    if (ring.current) {
      const sel = ui.selectedPersonId === emp.id;
      ring.current.visible = sel;
      if (sel) ring.current.rotation.z += dt * 0.8;
    }
    // trail the person with the floors above cut away (full building while outside)
    if (followed) {
      const outside = p.level < 0.2 && (p.z > 12.2 || Math.abs(p.x) > 20);
      const want = outside ? null : Math.max(0, Math.round(p.level));
      if (ui.cutaway !== want) ui.set({ cutaway: want });
    }
    if (label.current) {
      const text = `${emp.name} · ${p.text}`;
      if (label.current.textContent !== text) label.current.textContent = text;
    }
  });

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        useUi.getState().selectPerson(emp.id);
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <Person
        look={look}
        onReady={(joints) => {
          j.current = joints;
          joints.root.visible = false;
        }}
      >
        <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.05, 0]} visible={false}>
          <ringGeometry args={[0.55, 0.66, 36]} />
          <meshBasicMaterial color="#2f6fd6" transparent opacity={0.95} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
        <Html position={[0, 2.15, 0]} center zIndexRange={[17, 0]} style={{ pointerEvents: "none" }}>
          <div ref={tag} className="tech-tag" data-testid={`emp-${emp.id}`} style={{ ["--vest" as string]: "#2f6fd6" }}>
            {bubble && (
              <div className="tech-msg">
                <b>{emp.name} · {emp.role}</b>
                {bubble}
              </div>
            )}
            <div ref={label} className="tech-tag-text" />
          </div>
        </Html>
      </Person>
    </group>
  );
});

/**
 * Kishore's approval in the one-minute run, shown over his BMS console: the request he received, what he checks
 * (each line ticks when the run reports he has looked at it), then the approval. Hidden when Floor 3 is cut away.
 */
function KishoreReviewCard() {
  const { data: wt } = useWalkthrough();
  const { data: asset } = useAsset(wt?.asset_id ?? null);
  const box = useRef<HTMLDivElement>(null);
  const phase = wt?.phase ?? "idle";
  const mode = phase === "approval" ? "reviewing" : phase === "approved" ? "approved" : null;
  kishoreReview.mode = mode;
  kishoreReview.run = !!wt?.busy;
  useFrame(() => {
    const ui = useUi.getState();
    const show = !!mode && !player.active && (ui.cutaway === null || ui.cutaway >= KISHORE.seat.level);
    const el = box.current?.parentElement;
    if (el && el.style.display !== (show ? "" : "none")) el.style.display = show ? "" : "none";
  });
  if (!wt || !mode) return null;
  const r3 = wt.results["3"] ?? {};
  const r2 = wt.results["2"] ?? {};
  const said = wt.log.filter((l) => l.stage === 4).map((l) => l.text);
  const checks: [string, boolean][] = [
    ["Trend and prediction", said.some((t) => t.includes("opens the request"))],
    ["Risk score and priority", said.some((t) => t.includes("opens the request"))],
    ["Machine history and crew", said.some((t) => t.includes("machine's history"))],
  ];
  const s = KISHORE.seat;
  return (
    <group position={[s.sx, floorY(s.level), s.sz]}>
      <Html position={[1.15, 1.85, 0.2]} center zIndexRange={[18, 0]} style={{ pointerEvents: "none" }}>
        <div ref={box} className={`kishore-card ${mode}`} data-testid="kishore-review">
          {mode === "reviewing" ? (
            <>
              <div className="kc-head">📨 Approval request · Kishore is reviewing</div>
              <div className="kc-title">{String(r3.work_order ?? "")} · {String(r3.priority ?? "")} · {asset?.name ?? wt.asset_id}</div>
              {r2.z != null && <div className="kc-sub">Vibration {Number(r2.z).toFixed(1)}σ above normal{r2.projection_hours != null ? ` · alarm limit in ~${Math.round(Number(r2.projection_hours) * 60)} min` : ""}</div>}
              <ul>
                {checks.map(([label, ok]) => (
                  <li key={label} className={ok ? "ok" : ""}>{ok ? "✓" : "…"} {label}</li>
                ))}
              </ul>
              <div className="kc-bar"><i /></div>
            </>
          ) : (
            <>
              <div className="kc-head">✅ Approved by Kishore</div>
              <div className="kc-title">{String(r3.work_order ?? "")} goes to dispatch</div>
              <div className="kc-sub">The best technician is sent with the right parts</div>
            </>
          )}
        </div>
      </Html>
    </group>
  );
}

/** The named employees (Prasath, Vaseem, Yasar, Kishore, Guru, Mano), and Kishore's approval card. */
export function Employees() {
  return (
    <group>
      {EMPLOYEES.map((e) => (
        <EmployeeAvatar key={e.id} emp={e} />
      ))}
      <KishoreReviewCard />
    </group>
  );
}
