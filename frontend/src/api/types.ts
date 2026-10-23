export type Health = "NORMAL" | "WATCH" | "ANOMALY" | "CLEARED";
export type Role = "ADMIN" | "OPERATOR" | "SUPERVISOR" | "TECHNICIAN" | "VERIFIER";

export interface Sensor {
  id: string; asset_id: string; kind: string; metric: string; unit: string; label: string;
  is_primary: boolean; quality: string; last_value: number | null; last_timestamp: string | null; range: [number, number];
}
export interface Asset {
  id: string; name: string; asset_type: string; criticality: "LOW" | "MEDIUM" | "HIGH"; status: string; health_state: Health;
  floor_level: number; floor_name: string; required_skills: string[]; install_date: string; last_maintenance: string | null;
  runtime_hours: number; manufacturer: string; model: string;
  limits: { warn: number; alarm: number; critical: number; unit: string; note: string };
  position: { x: number; y: number; z: number }; sensors: Sensor[]; simulated: boolean;
}
export interface TreeAsset { id: string; name: string; asset_type: string; criticality: string; health_state: Health; status: string }
export interface TreeFloor { level: number; name: string; kind: string; elevation_m: number; assets: TreeAsset[] }
export interface BuildingTree { id: string; name: string; description: string; address: string; floors: TreeFloor[] }

export interface SimState {
  sim_now: string; epoch: string; running: boolean; speed: number; seed: number; profile: string;
  repair_effectiveness: number; samples_generated: number; run_id: number; allowed_speeds: number[];
  active_faults: { id: number; asset_id: string; fault_type: string; sensor_id: string | null; status: string; started_at: string }[];
}

export interface EventEnvelope {
  event_id: string; event_type: string; layer: number; occurred_at: string; asset_id: string | null;
  correlation_id: string | null; schema_version: number; payload: Record<string, any>; id?: number; status?: string;
}

export interface Me { id: number; username: string; display_name: string; role: Role; technician_id: string | null; permissions: string[] }
export interface DemoUser { username: string; display_name: string; role: Role; technician_id: string | null; password: string }

export interface TelemetryPoint { id: number; t: string; v: number; q: string; status: string; exp?: number; lo?: number; hi?: number }
export interface TelemetrySeries {
  asset_id: string; sensor_id: string; metric: string; unit: string; points: TelemetryPoint[]; count: number;
  baseline?: { a: number; b: number; sigma: number; state: string };
}

export interface Anomaly {
  id: number; incident_id: string; asset_id: string; metric: string; state: "ACTIVE" | "CLEARED"; severity: string; confidence: number;
  observed_value: number; baseline_mean: number; baseline_sigma: number; z: number; slope: number; persistence: number;
  corroborating: Record<string, { corroborates: boolean }>; window_start: string; window_end: string; projection_hours: number | null;
  projection_note: string; explanation: string; detected_at: string; updated_at: string; cleared_at: string | null;
  evidence?: { id: number; kind: string; severity: string; observed_value: number; z: number; slope: number; reading_ids: number[]; created_at: string }[];
  decisions?: Decision[]; work_order?: { id: number; number: string; status: string } | null;
}

export interface RiskTerm { value: number; weight?: number; contribution?: number; label: string; multiplier?: number }
export interface Decision {
  id: number; incident_id: string; asset_id: string; severity: string; risk_score: number; action: string; priority: string | null;
  required_approval: string; reason: string; safety_note: string | null; policy_version: string; created_at: string;
  breakdown: { score: number; terms: Record<"S" | "C" | "P" | "R" | "Q", RiskTerm>; formula: string };
}

export type WoStatus = "DRAFT" | "OPEN" | "ASSIGNED" | "ON_HOLD" | "IN_PROGRESS" | "COMPLETED" | "VERIFIED" | "REWORK_REQUIRED" | "CLOSED" | "REJECTED" | "CANCELLED";
export interface WorkOrderSummary {
  id: number; number: string; asset_id: string; asset_name: string; floor_level: number; failure_mode: string; incident_id: string | null;
  title: string; status: WoStatus; priority: string; proposed_priority: string | null; action: string; hold_reason: string | null;
  assigned_technician: { id: string; name: string; color: string } | null; repair_count: number; required_skills: string[];
  created_at: string; updated_at: string; approved_at: string | null; assigned_at: string | null; arrives_at: string | null;
  started_at: string | null; completed_at: string | null; returns_at: string | null; verified_at: string | null; closed_at: string | null;
  safety_note: string | null; allowed_actions?: string[];
}
export interface WorkOrderDetail extends WorkOrderSummary {
  description: string; risk_assessment: Decision | null;
  events: { id: number; action: string; from_status: string | null; to_status: string | null; actor: string; actor_role: string; note: string | null; data: Record<string, any>; occurred_at: string }[];
  evidence: Record<string, any>[]; approvals: { id: number; role: string; decision: string; comment: string | null; occurred_at: string }[];
  parts: { sku: string; name: string; planned: number; reserved: number; consumed: number }[];
  inspections: { id: number; repair_number: number; technician_id: string; findings: string; checklist: Record<string, boolean>; parts_used: { sku: string; quantity: number }[]; labour_minutes: number; recorded_at: string }[];
  verifications: { id: number; repair_number: number; outcome: string; criteria: { criteria: Criterion[] }; sample_count: number; notes: string | null; occurred_at: string }[];
  closure_checklist_required: string[];
}
export interface Criterion { name: string; label: string; passed: boolean; value: number | null; threshold: number; unit: string }
export interface VerificationPreview {
  ready: boolean; samples: number; samples_required: number; settle_minutes: number; window_start?: string; window_end?: string; ready_at?: string;
  criteria: Criterion[]; all_passed: boolean; failed_criteria?: string[]; reason?: string;
}

export interface Candidate {
  technician_id: string; name: string; skills: string[]; certification_level: number; current_floor: number; eligible: boolean;
  ineligible_reasons: string[]; score: number; rank: number | null; active_jobs: number; on_shift: boolean; travel_minutes: number;
  breakdown: Record<string, { value: number; weight: number; contribution: number; detail: string }>; formula: string;
}
export interface Technician {
  id: string; name: string; skills: string[]; certification_level: number; home_floor: number; current_floor: number; status: string;
  max_jobs: number; active_jobs: { number: string; status: string; asset_id: string }[]; performance: number; jobs_completed: number;
  first_time_fixes: number; hourly_rate: number; color: string; on_shift: boolean; shifts: { weekday: number; start: number; end: number }[];
}
export interface InventoryItem { sku: string; name: string; unit: string; unit_cost: number; location: string; reorder_level: number; reorder_quantity: number; on_hand: number; reserved: number; available: number; low_stock: boolean }

export interface AuditRow { id: number; username: string; role: string; action: string; target_type: string; target_id: string | null; outcome: "ALLOWED" | "DENIED"; reason: string | null; correlation_id: string | null; occurred_at: string; before: any; after: any }
export interface TimelineItem { t: string; layer: number; type: string; title: string; detail: string; source: string; work_order?: string | null }
