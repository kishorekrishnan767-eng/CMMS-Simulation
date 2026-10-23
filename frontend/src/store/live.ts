import { create } from "zustand";
import type { EventEnvelope, Health, SimState } from "../api/types";

export interface Toast {
  id: number;
  kind: "info" | "warn" | "bad" | "ok";
  title: string;
  body?: string;
  at: number;
}

export interface SimClock {
  simMs: number; // sim time (ms since epoch) at wall time wallAt
  wallAt: number; // performance.now()
  speed: number;
  running: boolean;
  seed: number;
  profile: string;
  repairEffectiveness: number;
}

interface LiveState {
  connected: boolean;
  clock: SimClock;
  health: Record<string, Health>;
  values: Record<string, Record<string, number>>;
  layerCounts: Record<number, number>;
  layerPulse: Record<number, number>;
  layerSequence: { layer: number; type: string; id: string }[];
  recentEvents: EventEnvelope[];
  toasts: Toast[];
  eventTick: number;
  setConnected: (c: boolean) => void;
  applySimState: (s: SimState) => void;
  setCounts: (c: Record<string, number>, override?: Record<number, number>) => void;
  seedAssets: (assets: { id: string; health_state: Health; sensors: { metric: string; last_value: number | null }[] }[]) => void;
  ingest: (e: EventEnvelope) => void;
  pushToast: (t: Omit<Toast, "id" | "at">) => void;
  dismissToast: (id: number) => void;
}

const parseMs = (iso: string) => Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
let toastId = 1;

function toastFor(e: EventEnvelope): Omit<Toast, "id" | "at"> | null {
  const p = e.payload;
  switch (e.event_type) {
    case "AnomalyDetected":
      return { kind: "bad", title: `Anomaly detected on ${e.asset_id}`, body: `${e.correlation_id} · ${p.severity} · z=${p.z}σ — ${String(p.explanation ?? "").slice(0, 110)}…` };
    case "AnomalyEscalated":
      return { kind: "bad", title: `Anomaly escalated to ${p.severity}`, body: `${e.asset_id} · ${e.correlation_id}` };
    case "AnomalyWatch":
      return { kind: "warn", title: `Watch: ${e.asset_id}`, body: "Detector sees a persistent deviation (not yet an anomaly)" };
    case "RiskAssessed":
      return p.action === "MONITOR" ? null : { kind: "warn", title: `Risk ${Math.round(p.risk_score)}/100 → ${p.action}`, body: `${e.asset_id} · priority ${p.priority}` };
    case "WorkOrderDrafted":
      return { kind: "info", title: `Draft work order ${p.work_order}`, body: `${p.priority} · awaiting supervisor approval` };
    case "EvidenceAttached":
      return { kind: "info", title: `Alert attached to ${p.work_order}`, body: "No duplicate work order created" };
    case "WorkOrderApproved":
      return { kind: "ok", title: `${p.work_order} approved`, body: "Ready for dispatch" };
    case "TechnicianAssigned":
      return { kind: "info", title: `${p.technician_name} assigned to ${p.work_order}`, body: `Score ${p.score} · ETA ${p.travel_minutes} sim-min` };
    case "PartsShortage":
      return { kind: "bad", title: "Parts shortage", body: `${p.work_order} on hold (awaiting parts)` };
    case "WorkStarted":
      return { kind: "info", title: `Work started on ${p.work_order}` };
    case "WorkCompleted":
      return { kind: "ok", title: `${p.work_order} completed`, body: "Verification window collecting…" };
    case "VerificationPassed":
      return { kind: "ok", title: `Verification passed for ${p.work_order}` };
    case "VerificationFailed":
      return { kind: "bad", title: `Verification failed for ${p.work_order}`, body: `Failing: ${(p.failed_criteria ?? []).join(", ")}` };
    case "WorkOrderClosed":
      return { kind: "ok", title: `${p.work_order} closed` };
    case "AnomalyCleared":
      return { kind: "ok", title: `Anomaly cleared on ${e.asset_id}`, body: String(p.reason ?? "") };
    case "TelemetryRejected":
      return { kind: "warn", title: "Validation rejected telemetry", body: Object.entries(p.reasons ?? {}).map(([k, v]) => `${k}×${v}`).join(", ") };
    case "DataQualityWarning":
      return { kind: "warn", title: "Data-quality warning", body: String(p.message ?? "") };
    case "FaultInjected":
      return { kind: "info", title: `Simulation: ${p.fault_type} injected`, body: `${e.asset_id} (ground truth)` };
    default:
      return null;
  }
}

export const useLive = create<LiveState>((set, get) => ({
  connected: false,
  clock: { simMs: Date.parse("2026-03-02T08:00:00Z"), wallAt: 0, speed: 60, running: false, seed: 42, profile: "demo", repairEffectiveness: 1 },
  health: {},
  values: {},
  layerCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
  layerPulse: {},
  layerSequence: [],
  recentEvents: [],
  toasts: [],
  eventTick: 0,
  setConnected: (connected) => set({ connected }),
  applySimState: (s) =>
    set({ clock: { simMs: parseMs(s.sim_now), wallAt: performance.now(), speed: s.speed, running: s.running, seed: s.seed, profile: s.profile, repairEffectiveness: s.repair_effectiveness } }),
  setCounts: (c, override) =>
    set({ layerCounts: { ...(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, c[String(n)] ?? 0])) as Record<number, number>), ...(override ?? {}) } }),
  seedAssets: (assets) => {
    const health: Record<string, Health> = { ...get().health };
    const values: Record<string, Record<string, number>> = { ...get().values };
    for (const a of assets) {
      health[a.id] = a.health_state;
      values[a.id] = { ...(values[a.id] ?? {}) };
      for (const s of a.sensors) if (s.last_value != null && values[a.id][s.metric] === undefined) values[a.id][s.metric] = s.last_value;
    }
    set({ health, values });
  },
  ingest: (e) => {
    const s = get();
    const p = e.payload;
    const patch: Partial<LiveState> = {};
    const now = performance.now();

    if (e.event_type === "TelemetryAccepted") {
      const values = { ...s.values };
      for (const r of p.readings as { asset_id: string; metric: string; value: number }[]) {
        values[r.asset_id] = { ...(values[r.asset_id] ?? {}), [r.metric]: r.value };
      }
      patch.values = values;
      patch.clock = { ...s.clock, simMs: parseMs(p.to), wallAt: now };
    } else if (e.event_type === "HealthStateChanged") {
      patch.health = { ...s.health, [p.asset_id]: p.to as Health };
    } else if (e.event_type === "SimulationControl") {
      patch.clock = { ...s.clock, simMs: s.clock.simMs + (s.clock.running ? (now - s.clock.wallAt) * s.clock.speed : 0), wallAt: now, running: !!p.running, speed: p.speed ?? s.clock.speed };
    }

    patch.layerCounts = { ...s.layerCounts, [e.layer]: (s.layerCounts[e.layer] ?? 0) + 1 };
    patch.layerPulse = { ...s.layerPulse, [e.layer]: now };
    if (e.event_type === "TelemetryAccepted" || e.event_type === "TelemetryRejected") {
      // readings are produced by Layer 2 and validated by Layer 3: both nodes light up
      patch.layerCounts[2] = (patch.layerCounts[2] ?? 0) + (p.count ?? 0);
      patch.layerPulse[2] = now;
    }
    if (e.event_type !== "TelemetryAccepted") {
      patch.layerSequence = [...s.layerSequence.slice(-299), { layer: e.layer, type: e.event_type, id: e.event_id }];
      patch.recentEvents = [e, ...s.recentEvents].slice(0, 300);
      const t = toastFor(e);
      if (t) patch.toasts = [...s.toasts, { ...t, id: toastId++, at: Date.now() }].slice(-5);
    }
    patch.eventTick = s.eventTick + 1;
    set(patch as LiveState);
  },
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: toastId++, at: Date.now() }].slice(-5) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Current sim time in ms, interpolated between server updates while the simulation is running. */
export function simNowMs(): number {
  const { clock } = useLive.getState();
  if (!clock.running) return clock.simMs;
  return clock.simMs + (performance.now() - clock.wallAt) * clock.speed;
}

export const parseSimMs = parseMs;
