import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalkthrough } from "../api/queries";
import { useLive } from "../store/live";
import { useDemoMode } from "../store/demoMode";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { nextWalkthroughStep } from "./walkthroughApi";

/**
 * Glue between the walkthrough steps and the 3D view (renders nothing):
 *  - moves the camera to what each step is about,
 *  - plays the steps one after another when the demo is on automatic,
 *  - turns "Kishore sat at his BMS desk" into the approval step,
 *  - hands the keyboard back when the technician takes over.
 */
export default function WalkthroughBridge() {
  const qc = useQueryClient();
  const { data: wt } = useWalkthrough();
  const sat = usePlayer((s) => s.sat);
  const lastSat = useRef(sat);
  const lastAsset = useRef<string | null>(null);
  const lastKey = useRef("");
  const auto = useDemoMode((s) => s.auto);
  const controlling = usePlayer((s) => s.active);

  // camera cues
  useEffect(() => {
    if (!wt?.asset_id) {
      lastAsset.current = null;
      lastKey.current = "";
      return;
    }
    const ui = useUi.getState();
    const asset = wt.asset_id;
    if (lastAsset.current !== asset) {
      lastAsset.current = asset;
      ui.selectAsset(asset, false);
      ui.set({ rightPanelOpen: true, rightTab: "process" });
      ui.fly({ preset: "asset", assetId: asset, close: true });
    }
    const key = `${wt.stage}:${wt.busy}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    let controlling = usePlayer.getState().active;
    if (wt.stage >= 5 && controlling) {
      usePlayer.getState().set({ active: false }); // the technician takes over the camera
      controlling = false;
    }
    if (controlling) return; // you are looking through Kishore's eyes: no camera moves
    switch (wt.stage) {
      case 1:
      case 2:
        ui.fly({ preset: "asset", assetId: asset, close: true });
        break;
      case 3:
        if (wt.busy) ui.fly({ preset: "asset", assetId: asset });
        else ui.fly({ preset: "bms" });
        break;
      case 5:
        if (wt.busy) ui.fly({ preset: "crew" });
        break;
      case 6:
        if (wt.busy) ui.fly({ preset: "follow", assetId: asset });
        break;
      case 7:
        ui.fly({ preset: "asset", assetId: asset });
        break;
    }
  }, [wt?.asset_id, wt?.stage, wt?.busy, wt]);

  // automatic demonstration: after each step has been on screen for a moment, the next one starts by itself
  useEffect(() => {
    if (!auto || !wt?.started || wt.busy || wt.error || wt.stage >= wt.total) return;
    if (wt.stage === 3 && controlling) return; // you are walking Kishore to his desk: he approves when he sits down
    const id = window.setTimeout(() => {
      nextWalkthroughStep()
        .then(() => qc.invalidateQueries({ queryKey: ["walkthrough"] }))
        .catch((e: Error) => useLive.getState().pushToast({ kind: "bad", title: "Demo stopped", body: e.message }));
    }, wt.stage === 0 ? 1200 : 2600);
    return () => window.clearTimeout(id);
  }, [auto, wt?.started, wt?.busy, wt?.stage, wt?.total, wt?.error, controlling, qc]);

  // Kishore sits at the console → approve
  useEffect(() => {
    if (sat === lastSat.current) return;
    lastSat.current = sat;
    if (wt?.started && wt.stage === 3 && !wt.busy) {
      nextWalkthroughStep()
        .then(() => qc.invalidateQueries({ queryKey: ["walkthrough"] }))
        .catch((e: Error) => useLive.getState().pushToast({ kind: "bad", title: "Could not approve", body: e.message }));
    }
  }, [sat, wt, qc]);

  return null;
}
