import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalkthrough } from "../api/queries";
import type { WalkPhase } from "../api/types";
import { usePlayer } from "../store/player";
import { useUi, type CameraGoal } from "../store/ui";

type Shot = Omit<CameraGoal, "nonce" | "assetId">;

/**
 * The camera director of the one-minute run: one cinematic shot per phase of the story. Each shot is a slow,
 * eased flight (2.4–3.5 s) that then holds with a gentle drift around its subject; the walk is trailed with the
 * floors above the technician cut away (so a basement job shows the basement). `null` keeps the current shot.
 */
const SHOTS: Record<WalkPhase, Shot | null> = {
  idle: null,
  starting: null,
  preparing: null,
  wear: { preset: "asset", close: true, duration: 3 }, // the machine where the bearing starts to wear
  readings: { preset: "asset", duration: 2.6 }, // its sensors and their live tags
  prediction: { preset: "asset", close: true, duration: 2.6 }, // the halo turns red: the early warning
  workorder: { preset: "asset", duration: 2.6 }, // the work-order pin appears over the machine
  approval: { preset: "kishore", duration: 3.4 }, // Kishore at his BMS console, reading the request
  approved: null, // stay on Kishore while he approves
  dispatch: { preset: "crew", duration: 3 }, // the job reaches the crew room, the technician gets up
  walking: { preset: "follow", duration: 2.6 }, // tools, lift, corridor: trailed all the way
  working: { preset: "asset", close: true, duration: 2.6 }, // the repair, step by step
  rework: { preset: "follow", duration: 2.6 }, // back to the machine after a failed check
  verifying: { preset: "asset", duration: 2.8 }, // fresh readings settle back to normal
  closing: null,
  done: null, // handled below: a short hold, then back to the whole building
};

/** Wall seconds the finished machine stays on screen before the camera returns to the building overview. */
const DONE_HOLD_MS = 3500;

/** Glue between the one-minute run and the 3D view (renders nothing). Nothing here waits for a click. */
export default function WalkthroughBridge() {
  const { data: wt } = useWalkthrough();
  const qc = useQueryClient();
  const lastAsset = useRef<string | null>(null);
  const lastPhase = useRef<WalkPhase | null>(null);
  const doneTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(doneTimer.current), []);

  useEffect(() => {
    const ui = useUi.getState();
    const asset = wt?.asset_id ?? null;
    const phase = wt?.phase ?? "idle";
    if (!asset) {
      lastAsset.current = null;
      lastPhase.current = null;
      return;
    }
    if (lastAsset.current !== asset && wt?.busy) {
      lastAsset.current = asset;
      usePlayer.getState().set({ active: false }); // the run takes the camera
      ui.selectAsset(asset, false);
      ui.set({ rightPanelOpen: true, rightTab: "process" });
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
        useUi.getState().set({ cinematic: false });
        useUi.getState().fly({ preset: "overview", duration: 3.5 });
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
