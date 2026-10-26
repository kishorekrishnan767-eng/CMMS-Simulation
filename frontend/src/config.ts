/** Product name lives here (and in backend/app/config.py) — rename in one place. */
export const APP_NAME = "TwinCMMS";
export const BUILDING_ID = "TOWER-A";
export const GOLDEN_ASSET = "AHU-02-FAN-01";

export const LAYERS: { n: number; name: string; short: string; blurb: string }[] = [
  { n: 1, name: "Asset model", short: "Assets", blurb: "Building, floors, assets, sensors" },
  { n: 2, name: "Telemetry & simulation", short: "Telemetry", blurb: "Seeded physics publishes readings" },
  { n: 3, name: "Validation", short: "Validate", blurb: "Schema, units, duplicates, quality" },
  { n: 4, name: "Condition monitoring", short: "Detect", blurb: "Load-adjusted baseline, anomaly state machine" },
  { n: 5, name: "Risk & decision", short: "Decide", blurb: "Versioned policy, risk score, dedup" },
  { n: 6, name: "Maintenance workflow", short: "Workflow", blurb: "Work orders, dispatch, inventory" },
  { n: 7, name: "Verification & learning", short: "Verify", blurb: "Post-repair window, metrics" },
];

export const SIM_SPEEDS = [1, 10, 60, 300, 1800];

/** Work-order status colours (3D pins, charts, badges): calm hues, red reserved for rework. */
export const WO_COLOR: Record<string, string> = {
  DRAFT: "#8a94a0",
  OPEN: "#d08a1a",
  ASSIGNED: "#3b82c4",
  ON_HOLD: "#c9661a",
  IN_PROGRESS: "#1f5fbf",
  COMPLETED: "#14868a",
  VERIFIED: "#2f9e5a",
  REWORK_REQUIRED: "#c4302b",
  CLOSED: "#6b7785",
  REJECTED: "#9aa3ad",
  CANCELLED: "#9aa3ad",
};
