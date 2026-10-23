import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAnalytics } from "../api/queries";
import { Empty, ErrorState, Loading, PageShell, fmtMin, fmtMoney, fmtTime } from "../components/ui";

function Kpi({ label, value, hint, id }: { label: string; value: string; hint?: string; id: string }) {
  return (
    <div className="kpi" data-testid={`kpi-${id}`}>
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      <span className="kpi-v">{value}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "#8aa4b8", OPEN: "#ffb020", ASSIGNED: "#8b7bff", ON_HOLD: "#ff8a3d", IN_PROGRESS: "#4da3ff", COMPLETED: "#1fd1b6",
  VERIFIED: "#2fe0a0", REWORK_REQUIRED: "#ff4d8d", CLOSED: "#5b7a88", REJECTED: "#6b7280", CANCELLED: "#6b7280",
};

export default function AnalyticsPage() {
  const { data, isLoading, error, refetch } = useAnalytics();
  if (isLoading) return <PageShell title="Analytics"><Loading /></PageShell>;
  if (error || !data) return <PageShell title="Analytics"><ErrorState error={error} retry={() => refetch()} /></PageShell>;
  const { maintenance: m, detector: d, assets } = data;
  const evals: any[] = d.evaluations ?? [];
  const noData = evals.length === 0;
  return (
    <PageShell
      title="Analytics"
      subtitle="Every figure is computed from stored data: raw readings, anomaly records, work orders, the stock ledger and the fault ground truth. Nothing here is hardcoded. Metrics describe a demo detector on simulated data — not real-world accuracy."
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4" data-testid="kpis">
        <Kpi id="latency" label="Detection latency" value={fmtMin(d.avg_detection_latency_min)} hint="fault start → anomaly detected" />
        <Kpi id="lead" label="Lead time before alarm limit" value={d.avg_lead_time_min == null ? "—" : fmtMin(d.avg_lead_time_min)} hint="detected → alarm limit crossed (or would have been, if repaired earlier)" />
        <Kpi id="mtta" label="MTTA" value={fmtMin(m.mtta_min)} hint={`alert → approval · ${m.mtta_samples} sample(s)`} />
        <Kpi id="mttr" label="MTTR" value={fmtMin(m.mttr_min)} hint={`alert → verified · ${m.mttr_samples} sample(s)`} />
        <Kpi id="precision" label="Alert precision" value={d.precision == null ? "—" : `${(d.precision * 100).toFixed(0)}%`} hint={`TP ${d.true_positives} · FP ${d.false_positives} · FN ${d.false_negatives}${d.pending_faults ? ` · ${d.pending_faults} pending` : ""}`} />
        <Kpi id="cost" label="Maintenance cost" value={fmtMoney(m.total_cost)} hint={`labour ${fmtMoney(m.labour_cost)} + parts ${fmtMoney(m.parts_cost)}`} />
        <Kpi id="ftf" label="First-time-fix rate" value={m.first_time_fix_rate == null ? "—" : `${(m.first_time_fix_rate * 100).toFixed(0)}%`} hint="closed incidents" />
        <Kpi id="closed" label="Work orders" value={`${m.closed} closed / ${m.open} open`} hint={`${m.work_orders_total} total`} />
      </div>

      {noData && (
        <div className="card mt-4"><Empty title="No closed incidents yet" hint="Detector and maintenance KPIs appear after an incident has been detected, repaired, verified and closed. Run the guided demo to produce one." /></div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <div className="h-section mb-2">Work-order throughput by status</div>
          {m.throughput.length === 0 ? <Empty title="No work orders" /> : (
            <div style={{ height: 240 }} data-testid="chart-throughput">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={m.throughput} margin={{ left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="status" tick={{ fontSize: 10 }} interval={0} angle={-20} height={50} textAnchor="end" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>{m.throughput.map((t: any) => <Cell key={t.status} fill={STATUS_COLOR[t.status] ?? "#1fd1b6"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
        <section className="card p-4">
          <div className="h-section mb-2">Alerts and work orders by asset</div>
          <div style={{ height: 240 }} data-testid="chart-assets">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={assets.assets} margin={{ left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="asset_id" tick={{ fontSize: 9 }} interval={0} angle={-25} height={60} textAnchor="end" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="alerts" name="alerts (anomalies)" fill="#ff4d4f" radius={[4, 4, 0, 0]} />
                <Bar dataKey="work_orders" name="work orders" fill="#4da3ff" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="card scroll-thin mt-4 overflow-x-auto">
        <div className="h-section p-4 pb-0">Detector evaluation per injected fault (ground truth: fault_injections)</div>
        <table className="w-full text-sm" data-testid="eval-table">
          <thead>
            <tr><th className="th">Incident</th><th className="th">Asset</th><th className="th">Fault start</th><th className="th">Detected</th><th className="th">Latency</th><th className="th">Lead time</th><th className="th">MTTA</th><th className="th">MTTR</th><th className="th">Cost</th><th className="th">Before → after (mm/s)</th></tr>
          </thead>
          <tbody>
            {evals.length === 0 && <tr><td className="td text-muted" colSpan={10}>No evaluations stored yet.</td></tr>}
            {evals.map((e) => (
              <tr key={e.id} className="tr">
                <td className="td font-medium">{e.incident_id}</td><td className="td">{e.asset_id}</td>
                <td className="td tabular-nums">{fmtTime(e.fault_start)}</td><td className="td tabular-nums">{fmtTime(e.detected_at)}</td>
                <td className="td tabular-nums">{fmtMin(e.detection_latency_min)}</td>
                <td className="td tabular-nums" title={e.details?.lead_time_note}>
                  {e.lead_time_min == null ? "limit never reached" : fmtMin(e.lead_time_min)}
                  {e.details?.lead_time_basis === "counterfactual" && <span className="ml-1 text-[10px] text-muted">(vs. unrepaired fault)</span>}
                </td>
                <td className="td tabular-nums">{fmtMin(e.mtta_min)}</td><td className="td tabular-nums">{fmtMin(e.mttr_min)}</td>
                <td className="td tabular-nums">{fmtMoney(e.total_cost)}</td>
                <td className="td tabular-nums">{e.before_mean ?? "—"} → {e.after_mean ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="p-4 pt-2 text-[11px] text-muted">{d.note} Thresholds change only through a new versioned policy file plus an audit entry — never automatically.</p>
      </section>

      <section className="card mt-4 p-4">
        <div className="h-section mb-2">Technician first-time-fix rate (updated from closed work orders)</div>
        <div className="grid gap-2 sm:grid-cols-3">
          {m.technicians.map((t: any) => (
            <div key={t.id} className="rounded-lg border border-line p-3"><div className="font-medium">{t.name}</div><div className="text-xs text-muted">{(t.performance * 100).toFixed(1)}% · {t.jobs_completed} job(s) closed</div></div>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
