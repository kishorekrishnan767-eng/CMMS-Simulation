import { useEffect } from "react";
import { useWorkOrders } from "../api/queries";
import { useUi } from "../store/ui";
import AssetPanel from "./AssetPanel";
import JobPanel from "./JobPanel";
import OpsPanel from "./OpsPanel";

const TABS = [["ops", "Operations"], ["job", "Job"], ["asset", "Telemetry"]] as const;

/** Right side of the live twin: operations overview, the selected asset's job story, or its telemetry. */
export default function RightPanel() {
  const selected = useUi((s) => s.selectedAssetId);
  const tab = useUi((s) => s.rightTab);
  const { data: wos, isFetched } = useWorkOrders(selected ? `&asset_id=${selected}&active=true` : "&active=true");

  useEffect(() => {
    if (tab !== "auto" || !selected || !isFetched) return;
    useUi.getState().set({ rightTab: (wos?.items.length ?? 0) > 0 ? "job" : "asset" });
  }, [tab, selected, wos, isFetched]);

  const shown = !selected ? "ops" : tab === "auto" ? null : tab;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-line px-2 pt-2" role="tablist" aria-label="Side panel">
        {TABS.map(([k, label]) => {
          const disabled = k !== "ops" && !selected;
          return (
            <button
              key={k}
              role="tab"
              aria-selected={shown === k}
              disabled={disabled}
              onClick={() => useUi.getState().set({ rightTab: k })}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40 ${shown === k ? "border-line border-b-panel bg-panel text-ink" : "border-transparent text-muted hover:text-ink"}`}
              data-testid={`tab-${k}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {shown === "ops" && <OpsPanel />}
        {shown === "job" && selected && <JobPanel assetId={selected} />}
        {shown === "asset" && <AssetPanel />}
      </div>
    </div>
  );
}
