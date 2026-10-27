import { api } from "../api/client";
import type { Me, WalkthroughState } from "../api/types";
import { useSession } from "../store/session";

/** The demo only needs *a* signed-in user; if nobody is, sign in as the demo operator so one click just works. */
export async function ensureSignedIn() {
  const s = useSession.getState();
  if (s.token) return;
  const r = await api.post<{ access_token: string; user: Me }>("/api/auth/login", { username: "operator", password: "demo1234" });
  s.login(r.access_token, r.user);
}

export async function startWalkthrough(assetId: string) {
  await ensureSignedIn();
  return api.post<WalkthroughState>("/api/walkthrough/start", { asset_id: assetId });
}

export async function nextWalkthroughStep() {
  await ensureSignedIn();
  return api.post<WalkthroughState>("/api/walkthrough/next");
}

export async function resetWalkthrough() {
  await ensureSignedIn();
  return api.post<WalkthroughState>("/api/walkthrough/reset");
}
