import { useUi } from "../store/ui";
import AssetPanel from "./AssetPanel";
import JobPanel from "./JobPanel";
import OpsPanel from "./OpsPanel";
import PersonPanel from "./PersonPanel";
import ProcessPanel from "./ProcessPanel";

type Tab = "process" | "asset" | "ops" | "job" | "person";

/** Right side of the live building: the step-by-step Process, one machine's sensors, or the building overview. */
export default function RightPanel() {
  const selected = useUi((s) => s.selectedAssetId);
  const person = useUi((s) => s.selectedPersonId);
  const tab = useUi((s) => s.rightTab);

  const wanted: Tab = tab === "auto" ? "process" : tab;
  const shown: Tab = wanted === "person" && !person ? "process" : wanted;
  const tabs: [Tab, string][] = [["process", "Process"], ["asset", "Machine"], ["ops", "Overview"]];
  if (person) tabs.push(["person", "Person"]);
  if (shown === "job") tabs.push(["job", "Job"]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-line px-2 pt-2" role="tablist" aria-label="Side panel">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={shown === k}
            onClick={() => useUi.getState().set({ rightTab: k })}
            className={`-mb-px rounded-t-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${shown === k ? "border-line border-b-panel bg-panel text-ink" : "border-transparent text-muted hover:text-ink"}`}
            data-testid={`tab-${k}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {shown === "process" && <ProcessPanel />}
        {shown === "ops" && <OpsPanel />}
        {shown === "job" && selected && <JobPanel assetId={selected} />}
        {shown === "asset" && <AssetPanel />}
        {shown === "person" && <PersonPanel />}
      </div>
    </div>
  );
}
