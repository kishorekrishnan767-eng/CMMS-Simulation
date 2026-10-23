import { create } from "zustand";
import type { Me } from "../api/types";

const KEY = "twincmms.session";

function load(): { token: string | null; me: Me | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return { token: null, me: null };
}

function save(v: { token: string | null; me: Me | null }) {
  try {
    if (v.token) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

interface SessionState {
  token: string | null;
  me: Me | null;
  login: (token: string, me: Me) => void;
  logout: () => void;
}

export const useSession = create<SessionState>((set) => ({
  ...load(),
  login: (token, me) => {
    save({ token, me });
    set({ token, me });
  },
  logout: () => {
    save({ token: null, me: null });
    set({ token: null, me: null });
  },
}));
