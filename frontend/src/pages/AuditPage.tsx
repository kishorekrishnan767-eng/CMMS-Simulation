import { useState } from "react";
import { useAudit, useDeadLetters } from "../api/queries";
import { Empty, ErrorState, Loading, PageShell, fmtTime } from "../components/ui";
import { useSession } from "../store/session";

export default function AuditPage() {
  const me = useSession((s) => s.me);
  const [outcome, setOutcome] = useState("");
  const [user, setUser] = useState("");
  const [action, setAction] = useState("");
  const query = new URLSearchParams({ limit: "150", ...(outcome ? { outcome } : {}), ...(user ? { username: user } : {}), ...(action ? { action } : {}) }).toString();
  const { data, isLoading, error, refetch } = useAudit(query, !!me);
  const { data: dl } = useDeadLetters(!!me);
  return (
    <PageShell title="Audit log" subtitle="Who did what, with which outcome. Actions the backend refuses are recorded too (DENIED) — including permission failures, separation-of-duties violations and invalid transitions.">
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <label className="text-xs">Outcome
          <select className="input mt-1" value={outcome} onChange={(e) => setOutcome(e.target.value)} data-testid="filter-outcome"><option value="">All</option><option value="DENIED">DENIED</option><option value="ALLOWED">ALLOWED</option></select>
        </label>
        <label className="text-xs">User
          <select className="input mt-1" value={user} onChange={(e) => setUser(e.target.value)}><option value="">All</option>{["admin", "operator", "supervisor", "tech1", "tech2", "tech3", "verifier"].map((u) => <option key={u}>{u}</option>)}</select>
        </label>
        <label className="text-xs">Action contains
          <input className="input mt-1" value={action} onChange={(e) => setAction(e.target.value)} placeholder="wo.approve" />
        </label>
        <button className="btn btn-sm" onClick={() => { setOutcome(""); setUser(""); setAction(""); }}>Clear</button>
        {data && <span className="ml-auto text-xs text-muted">{data.total} record(s)</span>}
      </div>
      {!me && <Empty title="Sign in to view the audit log" hint="Use the role switcher in the header." />}
      {isLoading && me && <Loading />}
      {error && <ErrorState error={error} retry={() => refetch()} />}
      {data && (
        <div className="card scroll-thin overflow-x-auto">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead><tr><th className="th">When (sim)</th><th className="th">User</th><th className="th">Action</th><th className="th">Target</th><th className="th">Outcome</th><th className="th">Reason</th><th className="th">Incident</th></tr></thead>
            <tbody>
              {data.items.length === 0 && <tr><td className="td text-muted" colSpan={7}>No matching records.</td></tr>}
              {data.items.map((r) => (
                <tr key={r.id} className={`tr ${r.outcome === "DENIED" ? "bg-bad/10" : ""}`} data-outcome={r.outcome}>
                  <td className="td tabular-nums">{fmtTime(r.occurred_at)}</td>
                  <td className="td">{r.username} <span className="text-xs text-muted">({r.role})</span></td>
                  <td className="td font-medium">{r.action}</td>
                  <td className="td">{r.target_type} {r.target_id ?? ""}</td>
                  <td className="td"><span className={`badge ${r.outcome === "DENIED" ? "badge-bad" : "badge-ok"}`}>{r.outcome}</span></td>
                  <td className="td max-w-[380px] text-xs text-muted">{r.reason ?? ""}</td>
                  <td className="td">{r.correlation_id ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="card mt-6 p-4" data-testid="dead-letters">
        <div className="h-section mb-2">Dead-letter queue</div>
        <p className="mb-2 text-xs text-muted">Events whose consumer failed five times (exponential backoff) land here for inspection. An empty queue is the healthy state.</p>
        {!dl || dl.items.length === 0 ? <div className="text-sm text-muted">Empty — no dead-lettered events.</div> : (
          <table className="w-full text-xs"><thead><tr><th className="th">Event</th><th className="th">Consumer</th><th className="th">Attempts</th><th className="th">Error</th><th className="th">When</th></tr></thead>
            <tbody>{dl.items.map((x) => (<tr key={x.id} className="tr"><td className="td">{x.event_type}</td><td className="td">{x.consumer}</td><td className="td">{x.attempts}</td><td className="td text-bad">{x.error}</td><td className="td">{fmtTime(x.created_at)}</td></tr>))}</tbody></table>
        )}
      </section>
    </PageShell>
  );
}
