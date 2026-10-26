import { create } from "zustand";

export type Quality = "low" | "medium" | "high";
export type CameraPreset = "overview" | "roof" | "plant" | "crew" | "floor" | "asset" | "follow";
export type ThemeMode = "dark" | "light";

export interface CameraGoal {
  preset: CameraPreset;
  floor?: number;
  assetId?: string;
  close?: boolean;
  nonce: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

interface UiState {
  quality: Quality;
  autoQuality: boolean;
  theme: ThemeMode;
  reducedMotion: boolean;
  selectedAssetId: string | null;
  isolatedFloor: number | null; // show only this floor (others ghosted)
  cutaway: number | null; // floors above this level are ghosted (set by the camera for basement views)
  explode: number; // 0..1
  xray: boolean;
  heat: boolean;
  showSensors: boolean;
  showLabels: boolean;
  showPins: boolean;
  showTechnicians: boolean;
  cameraGoal: CameraGoal;
  fps: number;
  rightPanelOpen: boolean;
  /** "auto" resolves to the job tab when the selected asset has open work, else its telemetry. */
  rightTab: "ops" | "job" | "asset" | "auto";
  layerPanel: number | null;
  setQuality: (q: Quality) => void;
  set: (patch: Partial<UiState>) => void;
  selectAsset: (id: string | null, fly?: boolean) => void;
  fly: (goal: Omit<CameraGoal, "nonce">) => void;
}

let nonce = 1;

export const useUi = create<UiState>((set, get) => ({
  quality: read<Quality>("twincmms.quality", "medium"),
  autoQuality: read<boolean>("twincmms.autoQuality", true),
  theme: read<ThemeMode>("twincmms.theme", "light"),
  reducedMotion: read<boolean>("twincmms.reducedMotion", false),
  selectedAssetId: null,
  isolatedFloor: null,
  cutaway: null,
  explode: 0,
  xray: false,
  heat: false,
  showSensors: true,
  showLabels: true,
  showPins: true,
  showTechnicians: true,
  cameraGoal: { preset: "overview", nonce: 0 },
  fps: 0,
  rightPanelOpen: true,
  rightTab: "ops",
  layerPanel: null,
  setQuality: (q) => {
    write("twincmms.quality", q);
    set({ quality: q });
  },
  set: (patch) => {
    if ("autoQuality" in patch) write("twincmms.autoQuality", patch.autoQuality);
    if ("theme" in patch) write("twincmms.theme", patch.theme);
    if ("reducedMotion" in patch) write("twincmms.reducedMotion", patch.reducedMotion);
    set(patch);
  },
  selectAsset: (id, fly = true) => {
    set({ selectedAssetId: id, rightPanelOpen: true, rightTab: id ? "auto" : "ops" });
    if (id && fly) get().fly({ preset: "asset", assetId: id });
  },
  fly: (goal) => set({ cameraGoal: { ...goal, nonce: nonce++ } }),
}));
