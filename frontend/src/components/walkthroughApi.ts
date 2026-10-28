import { api } from "../api/client";
import type { Me, WalkthroughState } from "../api/types";
import { KISHORE, useSession } from "../store/session";

/** No sign-in in this simulation: if the app has not signed in as Kishore yet, do it now so one click just works. */
export async function ensureSignedIn() {
  const s = useSession.getState();
  if (s.token) return;
  const r = await api.post<{ access_token: string; user: Me }>("/api/auth/login", { username: KISHORE, password: "demo1234" });
  s.login(r.access_token, r.user);
}

/** Inject the anomaly and play the whole story by itself in one minute (`auto = false`: one step per call). */
export async function startWalkthrough(assetId: string, auto = true) {
  await ensureSignedIn();
  return api.post<WalkthroughState>("/api/walkthrough/start", { asset_id: assetId, auto });
}

export async function nextWalkthroughStep() {
  await ensureSignedIn();
  return api.post<WalkthroughState>("/api/walkthrough/next");
}

export async function resetWalkthrough() {
  await ensureSignedIn();
  return api.post<WalkthroughState>("/api/walkthrough/reset");
}
