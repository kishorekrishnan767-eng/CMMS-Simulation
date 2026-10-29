import { useProcedures, useTechnicians, useWorkOrders } from "../api/queries";
import type { Asset, WalkthroughState } from "../api/types";
import { buildPath, pathLength, routeMarks, stepAt, techPose, workBegan } from "../three/techPath";
import { Progress, parseIso, useSimNow } from "./ui";
import { PHASE_CARD, playShot, type Beat } from "./walkStory";

/** Segments of the story strip: the fault itself, then the seven steps. */
const SEGMENTS = 8;

/**
 * The one-line "you are here" bar that stays at the top of the Process tab while the run plays:
 * which step, in plain words, the strip of all steps, the latest thing that happened, and a button that
 * flies the camera back to this moment of the story.
 */
export function NowBar({ wt, asset, beat }: { wt: WalkthroughState; asset: Asset; beat: Beat }) {
  const card = PHASE_CARD[wt.phase] ?? -1;
  const latest = wt.log[wt.log.length - 1]?.text;
  return (
    <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2" data-testid="wt-now">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold tracking-wider text-accent">{beat.kicker}</span>
        <button className="btn btn-sm" onClick={() => playShot(wt.phase, asset.id)} title="Fly the camera back to what is happening now" data-testid="wt-show-me">
          🎥 Show me
        </button>
      </div>
      <div className="mt-0.5 text-[15px] font-semibold leading-snug">
        <span aria-hidden>{beat.icon}</span> {beat.title}
      </div>
      <div className="mt-1.5 flex gap-1" role="presentation" aria-label={`Story progress: ${Math.max(0, card)} of 7 steps`}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i key={i} className={`h-1 flex-1 rounded-full transition-colors duration-500 ${i < card ? "bg-ok" : i === card ? "now-seg bg-accent" : "bg-line"}`} />
        ))}
      </div>
      {latest && (
        <div className="clamp-2 mt-1.5 text-[12px] leading-snug text-muted" role="status" data-testid="wt-latest" title={latest}>
          <span className="text-accent">▶</span> {latest}
        </div>
      )}
    </div>
  );
}

/** What is happening, why it matters and where to look: the plain-language heart of the live step's card. */
export function Explain({ beat }: { beat: Beat }) {
  return (
    <div className="mt-1.5 space-y-1.5 rounded-md bg-panel2 p-2 text-[12px] leading-snug" data-testid="wt-explain">
      <p className="text-[12.5px] text-ink">{beat.what}</p>
      <p><b className="text-accent">Why it matters · </b>{beat.why}</p>
      <p><b className="text-accent">In the 3D view · </b>{beat.look}</p>
    </div>
  );
}

/** The latest work order of the asset, its technician and the repair plan, with the sim clock ticking. */
function useCrew(asset: Asset) {
  const now = useSimNow(300);
  const { data: list } = useWorkOrders(`&asset_id=${asset.id}`);
  const wo = [...(list?.items ?? [])].sort((a, b) => b.id - a.id)[0] ?? null;
  const { data: techs } = useTechnicians();
  const { data: cat } = useProcedures();
  const tech = techs?.find((t) => t.id === wo?.assigned_technician?.id) ?? null;
  const steps = cat && wo ? (wo.repair_count >= 1 ? cat.rework : cat.procedures[asset.asset_type] ?? []) : [];
  return { now, wo, tech, steps };
}

/** What the worker is doing on each leg of the walk, keyed by where the leg ends. */
function legText(first: string, to: string, inLift: boolean, floor: string): string {
  if (inLift) return `${first} rides the glass lift to ${floor}`;
  if (to === "Tool kit") return `${first} gets up and fetches the tool kit`;
  if (to === "Glass lift") return `${first} walks to the glass lift`;
  if (to.endsWith("landing")) return `${first} rides the glass lift to ${floor}`;
  return `${first} walks to ${to}`;
}

/** The route as stops on a line: crew room → tool kit → lift → floor → machine, with the worker moving along it. */
function Journey({ asset, first, techId, progress, inLift, minutesLeft }: { asset: Asset; first: string; techId: string; progress: number; inLift: boolean; minutesLeft: number | null }) {
  const marks = routeMarks(techId, asset);
  const floor = asset.floor_level === 0 ? "Ground" : marks.find((m) => m.label.endsWith("landing"))?.label.replace(" landing", "") ?? "";
  let leg = 0;
  marks.forEach((m, i) => {
    if (progress >= m.at - 1e-3 && i < marks.length - 1) leg = i;
  });
  const span = Math.max(1e-6, marks[leg + 1].at - marks[leg].at);
  const f = Math.min(1, Math.max(0, (progress - marks[leg].at) / span));
  return (
    <div data-testid="wt-journey">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span><b>{legText(first, marks[leg + 1].label, inLift, floor)}</b></span>
        {minutesLeft != null && <span className="shrink-0 text-[11px] text-muted">≈ {minutesLeft} min to go (building time)</span>}
      </div>
      <ol className="journey mt-2">
        {marks.map((m, i) => {
          const last = i === marks.length - 1;
          const done = progress >= m.at - 1e-3 && (!last || progress >= 0.999);
          const next = i === leg + 1;
          return (
            <li key={m.label} data-state={done ? "done" : next ? "next" : "todo"}>
              <span className={`j-dot ${done ? "done" : next ? "next" : ""}`} aria-hidden>{done ? "✓" : ""}</span>
              <span className={`text-[12px] ${done ? "text-muted" : next ? "font-semibold" : "text-muted"}`}>{m.label}</span>
              {!last && (
                <span className="j-line" aria-hidden>
                  <i style={{ height: `${i < leg ? 100 : i === leg ? f * 100 : 0}%` }} />
                  {i === leg && <em style={{ top: `${f * 100}%` }}>{inLift ? "🛗" : "👷"}</em>}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Why each repair step is done, in one plain sentence (keys are the backend's procedure step keys). */
const STEP_WHY: Record<string, string> = {
  permit: "Safety first: the machine is locked out, so nobody can start it while hands are inside.",
  inspect: "Look for the cause with eyes and hands before anything is changed.",
  measure: "Measure vibration and temperature to confirm what the sensors suggested.",
  replace: "The worn part is swapped for the spare that was reserved earlier.",
  align: "Everything is set straight, so the new part does not wear out again.",
  test: "Switch back on and watch: the trend must settle before the job counts as done.",
};

/** The repair checklist: finished steps ticked, the live step explained with its own progress bar. */
function RepairSteps({ steps, current, within }: { steps: { key: string; label: string; minutes: number }[]; current: number; within: number }) {
  return (
    <ol className="space-y-1" data-testid="wt-repair">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "now" : "todo";
        return (
          <li key={s.key} className={`rounded-md px-2 py-1 text-[12px] ${state === "now" ? "bg-accent/10" : ""}`} data-state={state}>
            <div className={`flex items-start gap-1.5 ${state === "todo" ? "text-muted" : state === "done" ? "text-muted" : "font-semibold"}`}>
              <span className="w-3 shrink-0 text-center" aria-hidden>{state === "done" ? "✓" : state === "now" ? "▶" : "·"}</span>
              <span className="flex-1">{s.label}</span>
              <span className="shrink-0 text-[10.5px] font-normal text-muted">{s.minutes} min</span>
            </div>
            {state === "now" && (
              <div className="mt-1 pl-[18px]">
                <p className="text-[11.5px] font-normal text-muted">{STEP_WHY[s.key] ?? ""}</p>
                <div className="mt-1"><Progress value={within} /></div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The technician's story for step 6, live from the work order and the same pose the 3D worker is drawn from:
 * the route while walking, a short line at the permit, then the repair checklist.
 */
export function CrewStory({ asset }: { asset: Asset }) {
  const { now, wo, tech, steps } = useCrew(asset);
  if (!wo?.assigned_technician || !tech) return null;
  const first = tech.name.split(" ")[0];
  const pose = techPose(tech, wo, asset, now, steps);
  if (pose.phase === "walking") {
    const total = pathLength(buildPath(tech.id, asset)) || 1;
    const arrives = parseIso(wo.arrives_at);
    const left = Number.isNaN(arrives) ? null : Math.max(0, Math.ceil((arrives - now) / 60000));
    return (
      <div className="mt-1.5 rounded-md bg-panel2 p-2" data-testid="wt-live">
        <Journey asset={asset} first={first} techId={tech.id} progress={pose.distance / total} inLift={pose.inLift} minutesLeft={left} />
      </div>
    );
  }
  if (wo.status === "IN_PROGRESS" && steps.length) {
    const current = stepAt(steps, (now - workBegan(wo)) / 60000);
    const before = steps.slice(0, current).reduce((a, s) => a + s.minutes, 0);
    const within = Math.min(1, Math.max(0, ((now - workBegan(wo)) / 60000 - before) / Math.max(1, steps[current].minutes)));
    return (
      <div className="mt-1.5 rounded-md bg-panel2 p-1.5" data-testid="wt-live">
        <RepairSteps steps={steps} current={current} within={within} />
      </div>
    );
  }
  return (
    <div className="mt-1.5 rounded-md bg-panel2 p-2 text-[12px] text-muted" data-testid="wt-live">
      {first} has arrived: toolbox talk, then the permit to work is signed
    </div>
  );
}
