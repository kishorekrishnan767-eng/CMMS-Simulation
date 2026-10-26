/** Product name lives here (and in backend/app/config.py) — rename in one place. */
export const APP_NAME = "Livewire BMS";
export const BUILDING_ID = "TOWER-A";
export const GOLDEN_ASSET = "AHU-02-FAN-01";

export const LAYERS: { n: number; name: string; short: string; blurb: string }[] = [
  { n: 1, name: "Equipment", short: "Equipment", blurb: "Every fan, pump, chiller and AC unit, with its sensors" },
  { n: 2, name: "Sensor readings", short: "Sensors", blurb: "Vibration, temperature, current and speed, every minute" },
  { n: 3, name: "Data quality", short: "Clean data", blurb: "Bad readings are rejected, with the reason recorded" },
  { n: 4, name: "Early warning", short: "Predict", blurb: "Compares each reading with what is normal for that machine" },
  { n: 5, name: "Risk & decision", short: "Decide", blurb: "Scores the risk and raises one work order" },
  { n: 6, name: "Maintenance", short: "Fix", blurb: "Approve, dispatch, repair" },
  { n: 7, name: "Verification", short: "Verify", blurb: "Proves the repair worked and measures the result" },
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
