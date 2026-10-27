import { create } from "zustand";

/** How the anomaly demonstration advances: by itself (`auto`), or one click per step. */
interface DemoMode {
  auto: boolean;
  set: (auto: boolean) => void;
}

export const useDemoMode = create<DemoMode>((set) => ({
  auto: true,
  set: (auto) => set({ auto }),
}));
