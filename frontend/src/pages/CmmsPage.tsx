import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWorkOrders } from "../api/queries";
import type { WorkOrderSummary } from "../api/types";
import { Empty, ErrorState, Loading, PageShell, PriorityBadge, StatusBadge, fmtTime } from "../components/ui";
import WorkOrderDrawer from "../components/WorkOrderDrawer";

const COLUMNS: { key: string; title: string; statuses: string[] }[] = [
  { key: "draft", title: "Draft", statuses: ["DRAFT"] },
  { key: "open", title: "Open", statuses: ["OPEN"] },
  { key: "assigned", title: "Assigned / hold", statuses: ["ASSIGNED", "ON_HOLD"] },
  { key: "progress", title: "In progress", statuses: ["IN_PROGRESS", "REWORK_REQUIRED"] },
  { key: "completed", title: "Completed", statuses: ["COMPLETED"] },
  { key: "verified", title: "Verified", statuses: ["VERIFIED"] },
  { key: "closed", title: "Closed", statuses: ["CLOSED", "REJECTED", "CANCELLED"] },
];

function Card({ wo, onOpen }: { wo: WorkOrderSummary; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="card w-full p-3 text-left transition-colors hover:border-accent/60" data-testid={`wo-card-${wo.number}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{wo.number}</span>
        <PriorityBadge priority={wo.priority} />
      </div>
      <div className="mt-1 line-clamp-2 text-xs text-muted">{wo.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={wo.status} />
        <span className="badge badge-muted">{wo.asset_id}</span>
        {wo.proposed_priority && <span className="badge badge-bad">↑ {wo.proposed_priority}?</span>}
        {wo.assigned_technician && <span className="text-[11px]" style={{ color: wo.assigned_technician.color }}>● {wo.assigned_technician.name.split(" ")[0]}</span>}
      </div>
    </button>
  );
}

export default function CmmsPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<"board" | "table">("board");
  const { data, isLoading, error, refetch } = useWorkOrders();
  const open = params.get("wo") ? Number(params.get("wo")) : null;
  const setOpen = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("wo", String(id));
    else p.delete("wo");
    setParams(p, { replace: true });
  };
  const items = data?.items ?? [];
  return (
    <PageShell
      title="Work orders"
      subtitle="One active work order per asset and failure mode. Every transition is performed by a single backend state machine; the actions you see depend on your role, and the backend rejects anything else."
      actions={
        <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="View">
          {(["board", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`px-3 py-1.5 text-xs capitalize ${view === v ? "bg-accent text-[#04201c]" : "bg-panel2 text-muted"}`} data-testid={`view-${v}`}>{v}</button>
          ))}
        </div>
      }
    >
      {isLoading && <Loading />}
      {error && <ErrorState error={error} retry={() => refetch()} />}
      {!isLoading && !error && items.length === 0 && (
        <div className="card"><Empty title="No work orders yet" hint="Inject bearing wear on a fan (Control page) or run the guided demo — the detector and decision engine will draft one." /></div>
      )}
      {items.length > 0 && view === "board" && (
        <div className="scroll-thin grid auto-cols-[minmax(230px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2" data-testid="kanban">
          {COLUMNS.map((c) => {
            const col = items.filter((w) => c.statuses.includes(w.status));
            return (
              <section key={c.key} aria-label={c.title} className="min-w-[230px]">
                <div className="mb-2 flex items-center justify-between"><span className="h-section">{c.title}</span><span className="badge badge-muted">{col.length}</span></div>
                <div className="space-y-2">{col.map((w) => <Card key={w.id} wo={w} onOpen={() => setOpen(w.id)} />)}</div>
              </section>
            );
          })}
        </div>
      )}
      {items.length > 0 && view === "table" && (
        <div className="card scroll-thin overflow-x-auto">
          <table className="w-full text-sm" data-testid="wo-table">
            <thead><tr><th className="th">No.</th><th className="th">Asset</th><th className="th">Title</th><th className="th">Status</th><th className="th">Priority</th><th className="th">Technician</th><th className="th">Created (sim)</th></tr></thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id} className="tr cursor-pointer hover:bg-panel2" onClick={() => setOpen(w.id)}>
                  <td className="td font-medium">{w.number}</td><td className="td">{w.asset_id}</td><td className="td">{w.title}</td>
                  <td className="td"><StatusBadge status={w.status} /></td><td className="td"><PriorityBadge priority={w.priority} /></td>
                  <td className="td">{w.assigned_technician?.name ?? "—"}</td><td className="td tabular-nums">{fmtTime(w.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <WorkOrderDrawer id={open} onClose={() => setOpen(null)} />
    </PageShell>
  );
}
