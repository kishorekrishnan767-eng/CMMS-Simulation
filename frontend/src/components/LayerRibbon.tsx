import { useEffect, useRef, useState } from "react";
import { LAYERS } from "../config";
import { useLive } from "../store/live";
import { useUi } from "../store/ui";
import { fmtTime } from "./ui";

const COUNT_LABEL: Record<number, string> = { 1: "assets", 2: "readings", 3: "validations", 4: "detections", 5: "decisions", 6: "workflow", 7: "verifications" };

function Node({ n, name, short }: { n: number; name: string; short: string }) {
  const count = useLive((s) => s.layerCounts[n] ?? 0);
  const pulse = useLive((s) => s.layerPulse[n]);
  const [pulsing, setPulsing] = useState(false);
  const first = useRef(true);
  const active = useUi((s) => s.layerPanel === n);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPulsing(false);
    const a = window.requestAnimationFrame(() => setPulsing(true));
    const t = window.setTimeout(() => setPulsing(false), 950);
    return () => {
      window.cancelAnimationFrame(a);
      window.clearTimeout(t);
    };
  }, [pulse]);
  return (
    <button
      onClick={() => useUi.getState().set({ layerPanel: active ? null : n })}
      className={`layer-node min-w-[92px] flex-1 rounded-md border px-2.5 py-1.5 text-left transition-colors ${active ? "border-accent bg-panel2" : "border-line bg-panel/80 hover:border-accent/50"} ${pulsing ? "pulsing" : ""}`}
      data-testid={`layer-${n}`}
      data-count={count}
      data-pulse={pulse ?? 0}
      aria-label={`Layer ${n}: ${name}. ${count} ${COUNT_LABEL[n]}`}
      aria-pressed={active}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>L{n}</span>
        <span className="tabular-nums text-ink" data-testid={`layer-count-${n}`}>{count.toLocaleString()}</span>
      </div>
      <div className="truncate text-xs font-semibold">{short}</div>
    </button>
  );
}

function LayerPanel() {
  const n = useUi((s) => s.layerPanel);
  const events = useLive((s) => s.recentEvents);
  if (n == null) return null;
  const layer = LAYERS[n - 1];
  const mine = events.filter((e) => e.layer === n).slice(0, 8);
  return (
    <div className="glass absolute bottom-full left-0 right-0 mb-2 rounded-md border border-line p-3 shadow-lg" data-testid="layer-panel">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Layer {n} · {layer.name}</div>
        <button className="btn btn-sm" onClick={() => useUi.getState().set({ layerPanel: null })} aria-label="Close layer panel">✕</button>
      </div>
      <div className="text-xs text-muted">{layer.blurb}</div>
      <ul className="mt-2 space-y-1 text-xs">
        {mine.length === 0 && <li className="text-muted">Nothing yet.</li>}
        {mine.map((e) => (
          <li key={e.event_id} className="flex justify-between gap-3 rounded border border-line px-2 py-1">
            <span className="font-medium">{e.event_type}</span>
            <span className="truncate text-muted">{e.asset_id ?? ""} {e.correlation_id ?? ""}</span>
            <span className="tabular-nums text-muted">{fmtTime(e.occurred_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Bottom ribbon: Layers 1→7. Each node pulses and counts whenever an event passes through it. */
export default function LayerRibbon() {
  return (
    <div className="relative" data-testid="layer-ribbon">
      <LayerPanel />
      <div className="glass flex items-stretch gap-1 rounded-md border border-line p-1.5">
        {LAYERS.map((l, i) => (
          <div key={l.n} className="flex min-w-0 flex-1 items-center gap-1">
            <Node n={l.n} name={l.name} short={l.short} />
            {i < LAYERS.length - 1 && <span className="text-muted" aria-hidden>›</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
