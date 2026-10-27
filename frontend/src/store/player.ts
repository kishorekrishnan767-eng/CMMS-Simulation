import { create } from "zustand";

/** What the on-screen controls need to know about the keyboard-controlled Kishore (the 3D state lives in three/player.ts). */
interface PlayerUi {
  /** Kishore is being steered with the keyboard. */
  active: boolean;
  /** Whole floor number he is on. */
  level: number;
  /** Context hint near the bottom of the screen, e.g. "Press E to sit down". */
  prompt: string | null;
  /** Seated at the BMS desk. */
  seated: boolean;
  /** Driving speed, km/h. */
  speed: number;
  /** Bumped each time he sits at the desk; the walkthrough listens for it to approve the job. */
  sat: number;
  set: (patch: Partial<Omit<PlayerUi, "set">>) => void;
}

export const usePlayer = create<PlayerUi>((set) => ({
  active: false,
  level: 3,
  prompt: null,
  seated: false,
  speed: 0,
  sat: 0,
  set: (patch) => set(patch),
}));
