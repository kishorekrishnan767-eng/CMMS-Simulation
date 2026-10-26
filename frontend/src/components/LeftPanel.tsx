import { useTree } from "../api/queries";
import type { Health } from "../api/types";
import { useLive } from "../store/live";
import { useUi, type Quality } from "../store/ui";
import { Loading } from "./ui";

function Toggle({ label, on, onChange, testid }: { label: string; on: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded px-2 py-1 text-[12.5px] hover:bg-panel2">
      <span>{label}</span>
      <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
    </label>
  );
}

function Dot({ id, fallback }: { id: string; fallback: Health }) {
  const h = useLive((s) => s.health[id] ?? fallback);
  return <i className={`dot dot-${h.toLowerCase()}`} title={h} />;
}

const FLOOR_LABEL = (level: number) => (level === 6 ? "Roof" : level === -1 ? "B1" : level === 0 ? "G" : `F${level}`);
const CAMERAS = [
  ["Overview", { preset: "overview" }], ["Roof plant", { preset: "roof" }], ["Basement B1", { preset: "plant" }],
  ["Crew room", { preset: "crew" }], ["Floor 3", { preset: "floor", floor: 3 }],
] as const;

export default function LeftPanel() {
  const { data: tree, isLoading } = useTree();
  const ui = useUi();
  const selected = ui.selectedAssetId;
  return (
    <div className="space-y-4 p-3 text-sm" data-testid="left-panel">
      <section>
        <div className="h-section mb-1">Camera</div>
        <div className="grid grid-cols-2 gap-1">
          {CAMERAS.map(([label, g]) => (
            <button key={label} className="btn btn-sm justify-start" onClick={() => ui.fly(g as never)} data-testid={`cam-${label.toLowerCase().replace(" ", "-")}`}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="h-section mb-1">Building</div>
        {isLoading && <Loading />}
        <ul className="space-y-1">
          {[...(tree?.floors ?? [])].reverse().map((f) => (
            <li key={f.level}>
              <div className="flex items-center justify-between">
                <button
                  className={`flex-1 rounded px-2 py-1 text-left text-xs font-semibold ${ui.isolatedFloor === f.level ? "bg-accent/10 text-accent" : "text-ink/80 hover:text-ink"}`}
                  onClick={() => {
                    const on = ui.isolatedFloor !== f.level;
                    ui.set({ isolatedFloor: on ? f.level : null });
                    if (on) ui.fly({ preset: "floor", floor: f.level });
                  }}
                  title="Isolate this floor"
                  aria-pressed={ui.isolatedFloor === f.level}
                >
                  {FLOOR_LABEL(f.level)} · {f.name}
                </button>
                <button className="px-1 text-xs text-muted hover:text-accent" onClick={() => ui.fly({ preset: "floor", floor: f.level })} aria-label={`Fly to ${f.name}`}>
                  ◎
                </button>
              </div>
              {f.assets.map((a) => (
                <button key={a.id} onClick={() => ui.selectAsset(a.id)} data-testid={`tree-${a.id}`}
                  className={`ml-3 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded px-2 py-1 text-left text-xs ${selected === a.id ? "bg-accent/10 text-accent" : "hover:bg-panel2"}`}>
                  <Dot id={a.id} fallback={a.health_state} />
                  <span className="mono truncate">{a.id}</span>
                </button>
              ))}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="h-section mb-1">View</div>
        <label className="block px-2 text-xs">
          Exploded view
          <input type="range" min={0} max={1} step={0.05} value={ui.explode} onChange={(e) => ui.set({ explode: Number(e.target.value) })} className="mt-1 w-full accent-[rgb(var(--accent))]" aria-label="Exploded view" data-testid="explode" />
        </label>
        <Toggle label="X-ray shell" on={ui.xray} onChange={(v) => ui.set({ xray: v })} testid="toggle-xray" />
        <Toggle label="Condition heat overlay" on={ui.heat} onChange={(v) => ui.set({ heat: v })} testid="toggle-heat" />
        <Toggle label="Sensor markers" on={ui.showSensors} onChange={(v) => ui.set({ showSensors: v })} />
        <Toggle label="Asset labels" on={ui.showLabels} onChange={(v) => ui.set({ showLabels: v })} />
        <Toggle label="Work-order pins" on={ui.showPins} onChange={(v) => ui.set({ showPins: v })} />
        <Toggle label="Technicians" on={ui.showTechnicians} onChange={(v) => ui.set({ showTechnicians: v })} />
        {(ui.isolatedFloor !== null || ui.cutaway !== null) && (
          <button className="btn btn-sm mt-1 w-full" onClick={() => ui.set({ isolatedFloor: null, cutaway: null })}>Show all floors</button>
        )}
      </section>

      <section>
        <div className="h-section mb-1">Graphics quality</div>
        <div className="seg" role="group" aria-label="Graphics quality">
          {(["low", "medium", "high"] as Quality[]).map((q) => (
            <button key={q} onClick={() => ui.setQuality(q)} aria-pressed={ui.quality === q} data-testid={`quality-${q}`} className="capitalize">
              {q}
            </button>
          ))}
        </div>
        <Toggle label="Auto-downgrade if FPS drops" on={ui.autoQuality} onChange={(v) => ui.set({ autoQuality: v })} />
        <div className="px-2 text-[11px] text-muted" data-testid="fps">{ui.fps ? `${ui.fps} fps` : "measuring…"}</div>
      </section>
    </div>
  );
}
