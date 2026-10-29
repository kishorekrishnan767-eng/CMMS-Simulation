import { useEffect, useRef } from "react";
import { useWalkthrough } from "../api/queries";
import { useLive } from "../store/live";

const COLORS = { info: "border-repair/60", warn: "border-watch/60", bad: "border-bad/70", ok: "border-ok/60" } as const;

export default function Toasts() {
  const toasts = useLive((s) => s.toasts);
  const dismiss = useLive((s) => s.dismissToast);
  // while the one-minute run plays, the Process tab tells the story: only errors pop up over the cinematic view
  const playing = !!useWalkthrough().data?.busy;
  const shown = playing ? toasts.filter((t) => t.kind === "bad") : toasts;
  // each toast gets exactly one timer: rebuilding them whenever a new toast arrives would keep an old one on screen for as
  // long as events keep coming (during the run, hidden info toasts arrive all the time)
  const scheduled = useRef(new Set<number>());
  useEffect(() => {
    for (const t of toasts) {
      if (scheduled.current.has(t.id)) continue;
      scheduled.current.add(t.id);
      window.setTimeout(() => {
        scheduled.current.delete(t.id);
        dismiss(t.id);
      }, t.kind === "bad" ? 9000 : 5500);
    }
  }, [toasts, dismiss]);
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-50 flex w-[min(92vw,380px)] -translate-x-1/2 flex-col gap-2" aria-live="polite" data-testid="toasts">
      {shown.slice(-3).map((t) => (
        <div key={t.id} className={`toast glass pointer-events-auto rounded-md border-l-4 border px-3 py-2 shadow-xl ${COLORS[t.kind]}`} role="status">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[13px] font-semibold">{t.title}</div>
            <button className="text-muted hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
          {t.body && <div className="mt-0.5 text-xs text-muted">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
