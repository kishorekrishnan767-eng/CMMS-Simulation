import type { Asset, WalkPhase, WalkthroughState } from "../api/types";
import { useUi, type CameraGoal } from "../store/ui";
import { floorLabel } from "../three/constants";

/** The card a phase belongs to: 0 = the wear begins, 1–7 = the seven steps, 8 = back to normal. */
export const PHASE_CARD: Record<WalkPhase, number> = {
  idle: -1, starting: 0, preparing: 0, wear: 0, readings: 1, prediction: 2, workorder: 3, approval: 4, approved: 4,
  dispatch: 5, walking: 6, working: 6, rework: 7, verifying: 7, closing: 7, done: 8,
};

type Shot = Omit<CameraGoal, "nonce" | "assetId">;

/**
 * The camera director of the run: one shot per phase of the story. Each is an eased flight that then holds with a
 * gentle drift around its subject. The walk is a chase camera (see CameraRig) and the repair continues the same
 * framing, so the arrival is one move, not a cut. `null` keeps the current shot.
 */
export const SHOTS: Record<WalkPhase, Shot | null> = {
  idle: null,
  starting: null,
  preparing: null,
  wear: { preset: "asset", close: true, duration: 4 },
  readings: { preset: "asset", duration: 3.6 },
  prediction: { preset: "asset", close: true, duration: 3.6 },
  workorder: { preset: "asset", duration: 3.6 },
  approval: { preset: "kishore", duration: 4.5 },
  approved: null,
  dispatch: { preset: "crew", duration: 4 },
  walking: { preset: "follow", duration: 3 },
  working: { preset: "asset", close: true, duration: 2.2 },
  rework: { preset: "follow", duration: 3 },
  verifying: { preset: "asset", duration: 3.8 },
  closing: null,
  done: null,
};

/** Fly to the shot of `phase` (or the machine itself where the phase keeps the current shot). */
export function playShot(phase: WalkPhase, assetId: string) {
  const ui = useUi.getState();
  ui.set({ cinematic: true });
  ui.fly({ ...(SHOTS[phase] ?? { preset: "asset" as const }), assetId });
}

/** One beat of the story in plain words: what is happening, why it matters, and where to look in the 3D view. */
export interface Beat {
  kicker: string;
  icon: string;
  title: string;
  what: string;
  why: string;
  look: string;
}

const first = (name: unknown, fallback = "The technician") => (typeof name === "string" && name ? name.split(" ")[0] : fallback);

/** The beat for the run's current phase, or null when nothing is playing. */
export function beatFor(wt: WalkthroughState, asset: Asset): Beat | null {
  const n = PHASE_CARD[wt.phase] ?? -1;
  const step = `STEP ${n} OF 7`;
  const tech = first((wt.results["5"] ?? {}).technician);
  const where = floorLabel(asset.floor_level);
  switch (wt.phase) {
    case "starting":
    case "preparing":
      return {
        kicker: "GETTING READY", icon: "⏳", title: "Setting the stage",
        what: "Clearing anything an earlier run left behind, so this story starts clean.",
        why: "The same starting point every time means you only ever see this one machine's story.",
        look: "The building is quiet. Nothing has gone wrong yet.",
      };
    case "wear":
      return {
        kicker: "THE FAULT BEGINS", icon: "⚙", title: "A bearing starts to wear",
        what: `Deep inside ${asset.name}, one bearing begins to wear. The monitoring system is not told.`,
        why: "Real faults start small and silent. Catching this moment early is what the system is for.",
        look: "The camera is on the machine. Its vibration is creeping up but is still inside the normal band.",
      };
    case "readings":
      return {
        kicker: step, icon: "📡", title: "Sensors send their data",
        what: `${asset.sensors.length} sensors on ${asset.name} each send one reading a minute.`,
        why: "A repeated or garbled reading would cause false alarms, so every reading is checked on arrival. Copies are set aside, bad data is rejected with a reason, and nothing is lost silently.",
        look: "Live values float above the machine: vibration, temperature, current and speed.",
      };
    case "prediction":
      return {
        kicker: step, icon: "📈", title: "The detector spots the drift",
        what: "Each reading is compared with what is normal for this machine at this load, then the trend is projected forward.",
        why: "A warning before the alarm limit (a demo value, not a standard) leaves time to plan a repair instead of reacting to a breakdown.",
        look: "A red halo appears on the machine: an early warning, consistent with possible bearing wear. Inspection recommended.",
      };
    case "workorder":
      return {
        kicker: step, icon: "📋", title: "One work order is created",
        what: "The risk is scored from how severe it is, how critical the machine is, how long it has lasted and how fast it rises. ONE work order is opened.",
        why: "The risk sets the priority. Repeat alerts for the same problem join the same work order, so the crew never gets duplicates.",
        look: "A work-order pin appears over the machine.",
      };
    case "approval":
    case "approved":
      return {
        kicker: step, icon: "✍", title: "Kishore reviews and approves",
        what: "The request lands on Kishore's screen with the evidence: the trend, the prediction and the risk score.",
        why: "A person stays in charge: nothing is dispatched until the supervisor approves. In this demo he approves by himself.",
        look: "The camera is on Kishore at his control-room desk on Floor 3.",
      };
    case "dispatch":
      return {
        kicker: step, icon: "👷", title: "The best technician gets the job",
        what: "Technicians are ranked by skill, distance to the machine and current workload. The spare parts are reserved.",
        why: "The right person with the right parts means the job is fixed first time.",
        look: "In the crew room the job appears on the wall screen and the technician gets up.",
      };
    case "walking":
      return {
        kicker: `${step} · THE WALK`, icon: "🚶", title: `${tech} walks to the machine`,
        what: asset.floor_level === 0
          ? `${tech} picks up the tool kit and walks along the ground-floor corridor to ${asset.name}.`
          : `${tech} picks up the tool kit, takes the glass lift to ${where} and walks to ${asset.name}.`,
        why: "Travel time is part of the repair time. The ETA the system promised is what you watch being played out.",
        look: `Follow ${tech}: the glowing ring marks them and the dotted line is the route.`,
      };
    case "working":
      return {
        kicker: `${step} · THE REPAIR`, icon: "🔧", title: `${tech} repairs ${asset.name}`,
        what: "Following the written procedure for this type of machine, one step at a time.",
        why: "Every step is recorded on the work order, so the repair can be audited and repeated.",
        look: "The worker crouches at the machine. The checklist below ticks off as each step finishes.",
      };
    case "rework":
      return {
        kicker: `${step} · REWORK`, icon: "↩", title: `${tech} goes back to the machine`,
        what: `The independent check was not satisfied, so ${tech} returns to ${asset.name} to repeat the repair.`,
        why: "A technician cannot mark their own work as good: fresh data has to prove it.",
        look: `Follow ${tech} back to the machine.`,
      };
    case "verifying":
    case "closing":
      return {
        kicker: step, icon: "✅", title: "An independent check proves the fix",
        what: "Fresh readings after the repair are compared with normal, independently of the technician.",
        why: "Only data can show the machine is healthy again. Then Kishore closes the work order.",
        look: "The halo turns green as the vibration settles back to normal.",
      };
    case "done":
      return {
        kicker: "BACK TO NORMAL", icon: "🟢", title: "Healthy again, job closed",
        what: `${asset.name} is healthy again and the work order is closed.`,
        why: "From the first worn bearing to the closed job, every step was recorded.",
        look: "The whole building comes back into view.",
      };
    default:
      return null;
  }
}
