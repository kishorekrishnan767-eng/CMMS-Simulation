import { simNowMs } from "../store/live";

const DAY_MS = 86_400_000;

/**
 * Timestamp that drives the scene's sky, sun and street lights. There is no night in this product:
 * it is always noon (sun at its peak), so every machine, floor and person is always clearly visible.
 */
export function lightingMs(): number {
  return Math.floor(simNowMs() / DAY_MS) * DAY_MS + DAY_MS / 2;
}
