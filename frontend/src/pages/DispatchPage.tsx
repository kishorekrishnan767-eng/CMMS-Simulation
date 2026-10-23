import { useTechnicians } from "../api/queries";
import { Empty, ErrorState, Loading, PageShell } from "../components/ui";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FLOOR = (l: number) => (l === 6 ? "Roof" : l === -1 ? "Basement" : l === 0 ? "Lobby" : `Floor ${l}`);
const STATUS_CLS: Record<string, string> = { AVAILABLE: "badge-ok", TRAVELING: "badge-info", ON_SITE: "badge-info", RETURNING: "badge-watch" };

export default function DispatchPage() {
  const { data, isLoading, error, refetch } = useTechnicians();
  return (
    <PageShell
      title="Technicians"
      subtitle="Roster with skills, shift, current floor and workload. The dispatch score uses skill fit, proximity, workload and the first-time-fix rate — which is updated from real closed work orders, never tuned automatically."
    >
      {isLoading && <Loading />}
      {error && <ErrorState error={error} retry={() => refetch()} />}
      {data && data.length === 0 && <Empty title="No technicians" />}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="roster">
        {(data ?? []).map((t) => {
          const first = t.shifts[0];
          const last = t.shifts[t.shifts.length - 1];
          return (
            <article key={t.id} className="card p-4" data-testid={`tech-card-${t.id}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 text-lg font-semibold">
                    <i className="inline-block h-3 w-3 rounded-full" style={{ background: t.color }} /> {t.name}
                  </div>
                  <div className="text-xs text-muted">{t.id} · certification level {t.certification_level}</div>
                </div>
                <span className={`badge ${STATUS_CLS[t.status] ?? "badge-muted"}`}>{t.status.replace("_", " ")}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {t.skills.map((s) => (
                  <span key={s} className="badge badge-muted">{s.replaceAll("_", " ")}</span>
                ))}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div><dt className="text-xs text-muted">Current location</dt><dd>{FLOOR(t.current_floor)}</dd></div>
                <div><dt className="text-xs text-muted">Home floor</dt><dd>{FLOOR(t.home_floor)}</dd></div>
                <div>
                  <dt className="text-xs text-muted">Shift</dt>
                  <dd>
                    {t.on_shift ? <span className="text-ok">on shift</span> : <span className="text-muted">off shift</span>}
                    {first ? ` · ${first.start}:00–${first.end}:00 (${DAYS[first.weekday]}–${DAYS[last.weekday]})` : ""}
                  </dd>
                </div>
                <div><dt className="text-xs text-muted">Workload</dt><dd>{t.active_jobs.length}/{t.max_jobs} active jobs</dd></div>
                <div><dt className="text-xs text-muted">First-time-fix rate</dt><dd className="tabular-nums">{(t.performance * 100).toFixed(1)}%</dd></div>
                <div><dt className="text-xs text-muted">Jobs closed</dt><dd className="tabular-nums">{t.jobs_completed} ({t.first_time_fixes} first-time)</dd></div>
              </dl>
              <div className="mt-3 h-1.5 overflow-hidden rounded bg-panel2"><div className="h-full bg-accent" style={{ width: `${t.performance * 100}%` }} /></div>
              {t.active_jobs.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs">
                  {t.active_jobs.map((j) => (
                    <li key={j.number} className="rounded border border-line px-2 py-1">{j.number} · {j.asset_id} · {j.status.replace("_", " ")}</li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </PageShell>
  );
}
