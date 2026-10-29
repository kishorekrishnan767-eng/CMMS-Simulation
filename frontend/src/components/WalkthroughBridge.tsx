import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalkthrough } from "../api/queries";
import type { WalkPhase } from "../api/types";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { SHOTS } from "./walkStory";

/** Wall seconds the finished machine stays on screen before the camera returns to the building overview. */
const DONE_HOLD_MS = 3500;

/** Glue between the 150-second run and the 3D view (renders nothing). Nothing here waits for a click. */
export default function WalkthroughBridge() {
  const { data: wt } = useWalkthrough();
  const qc = useQueryClient();
  const lastAsset = useRef<string | null>(null);
  const lastPhase = useRef<WalkPhase | null>(null);
  const doneTimer = useRef<number | undefined>(undefined);
  const leftWasOpen = useRef<boolean | null>(null);
  useEffect(() => () => window.clearTimeout(doneTimer.current), []);

  useEffect(() => {
    const ui = useUi.getState();
    const asset = wt?.asset_id ?? null;
    const phase = wt?.phase ?? "idle";
    if (!wt?.busy && phase !== "done" && leftWasOpen.current !== null) {
      // the run stopped (error, or Start over): give the building tree back
      ui.set({ leftPanelOpen: leftWasOpen.current, cinematic: false });
      leftWasOpen.current = null;
    }
    if (!asset) {
      lastAsset.current = null;
      lastPhase.current = null;
      return;
    }
    if (lastAsset.current !== asset && wt?.busy) {
      lastAsset.current = asset;
      usePlayer.getState().set({ active: false }); // the run takes the camera
      ui.selectAsset(asset, false);
      // the film gets the whole view: the building tree folds away until the run is over
      if (leftWasOpen.current === null) leftWasOpen.current = ui.leftPanelOpen;
      ui.set({ rightPanelOpen: true, rightTab: "process", leftPanelOpen: false });
    }
    if (phase === lastPhase.current) return;
    lastPhase.current = phase;
    window.clearTimeout(doneTimer.current);
    if (usePlayer.getState().active) return; // you took Kishore's eyes yourself: no camera moves
    if (phase === "done") {
      // the machine is fixed: hold on it a moment, then show the whole building, ready for the next run
      // (kept in a ref, not an effect cleanup: `busy` flips right after `done` and must not cancel it)
      doneTimer.current = window.setTimeout(() => {
        if (lastPhase.current !== "done") return;
        const u = useUi.getState();
        u.set({ cinematic: false, leftPanelOpen: leftWasOpen.current ?? true });
        leftWasOpen.current = null;
        u.fly({ preset: "overview", duration: 3.5 });
      }, DONE_HOLD_MS);
      return;
    }
    // the follow camera finds the technician through the work orders: fetch the assignment now, not in 5 s
    if (phase === "dispatch" || phase === "walking" || phase === "rework") qc.invalidateQueries({ queryKey: ["work-orders"] });
    const shot = SHOTS[phase];
    if (!shot || !wt?.busy) return;
    ui.set({ cinematic: true });
    ui.fly({ ...shot, assetId: asset });
  }, [wt?.asset_id, wt?.phase, wt?.busy, qc]);

  return null;
}
