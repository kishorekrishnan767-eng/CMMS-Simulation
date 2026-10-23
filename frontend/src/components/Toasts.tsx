import { useEffect } from "react";
import { useLive } from "../store/live";

const COLORS = { info: "border-repair/60", warn: "border-watch/60", bad: "border-bad/70", ok: "border-ok/60" } as const;

export default function Toasts() {
  const toasts = useLive((s) => s.toasts);
  const dismiss = useLive((s) => s.dismissToast);
  useEffect(() => {
    const timers = toasts.map((t) => window.setTimeout(() => dismiss(t.id), t.kind === "bad" ? 9000 : 5500));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, dismiss]);
  return (
    <div className="pointer-events-none fixed bottom-24 right-3 z-50 flex w-[min(92vw,360px)] flex-col gap-2" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass pointer-events-auto rounded-lg border-l-4 border px-3 py-2 shadow-xl ${COLORS[t.kind]}`} role="status">
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
