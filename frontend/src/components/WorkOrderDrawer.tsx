import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from "recharts";
import { api } from "../api/client";
import { useCandidates, useTelemetry, useVerification, useWorkOrder } from "../api/queries";
import type { WorkOrderDetail } from "../api/types";
import { useSession } from "../store/session";
import RiskBreakdown from "./RiskBreakdown";
import { Drawer, ErrorState, Loading, PriorityBadge, StatusBadge, fmtMin, fmtTime, useAct } from "./ui";

const CLOSURE = ["work_verified", "area_safe_and_clean", "documentation_complete", "parts_reconciled"];
const ACTION_LABEL: Record<string, string> = {
  approve: "Approve", reject: "Reject", cancel: "Cancel", assign: "Assign", hold: "Put on hold", resume: "Resume", start: "Start work",
  complete: "Complete work", verify: "Verify", close: "Close", restart: "Restart (rework)", acknowledge_escalation: "Acknowledge escalation",
};
const ALL_ACTIONS = ["approve", "reject", "cancel", "assign", "hold", "resume", "start", "complete", "verify", "close", "restart"];
const NEEDS_REASON = new Set(["reject", "cancel", "hold"]);

function BeforeAfter({ wo }: { wo: WorkOrderDetail }) {
  const { data } = useTelemetry(wo.asset_id, "vibration_velocity", 6);
  const rows = useMemo(() => (data?.points ?? []).map((p) => ({ t: Date.parse(p.t.endsWith("Z") ? p.t : p.t + "Z"), v: p.v })), [data]);
  if (!rows.length) return null;
  const mark = (iso: string | null) => (iso ? Date.parse(iso.endsWith("Z") ? iso : iso + "Z") : null);
  const detected = mark(wo.created_at);
  const completed = mark(wo.completed_at);
  return (
    <div style={{ height: 170 }} data-testid="before-after">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={(v) => new Date(v).toISOString().slice(11, 16)} tick={{ fontSize: 10 }} minTickGap={30} />
          <YAxis tick={{ fontSize: 10 }} width={40} />
          <Tooltip labelFormatter={(v) => new Date(v as number).toISOString().slice(11, 16) + " UTC"} />
          <Area dataKey="v" stroke="#1f5fbf" fill="#1f5fbf" fillOpacity={0.18} isAnimationActive={false} name="vibration mm/s" />
          {detected && <ReferenceLine x={detected} stroke="#c4302b" label={{ value: "work order", fontSize: 10, fill: "#c4302b" }} />}
          {completed && <ReferenceLine x={completed} stroke="#2f9e5a" label={{ value: "repair", fontSize: 10, fill: "#2f9e5a" }} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function WorkOrderDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const me = useSession((s) => s.me);
  const { data: wo, error, refetch } = useWorkOrder(id);
  const { run, busy } = useAct();
  const [reason, setReason] = useState("");
  const [findings, setFindings] = useState("Inner-race spalling found on the drive-end bearing; bearing set replaced and re-greased.");
  const [parts, setParts] = useState<Record<string, number>>({});
  const [closure, setClosure] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState("auto");
  const [showAll, setShowAll] = useState(false);
  const canAssign = !!wo && ["OPEN"].includes(wo.status);
  const { data: cands } = useCandidates(id, canAssign);
  const verifying = !!wo && ["COMPLETED", "VERIFIED", "REWORK_REQUIRED"].includes(wo.status);
  const { data: ver } = useVerification(id, !!wo && wo.status === "COMPLETED");

  useEffect(() => {
    if (wo) setParts(Object.fromEntries(wo.parts.map((p) => [p.sku, p.planned])));
  }, [wo?.id, wo?.parts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setReason(""); }, [id]);

  const call = (action: string, body: Record<string, unknown> = {}, ok?: string) =>
    run(() => api.post(`/api/work-orders/${id}/${action}`, { note: reason || undefined, ...body }), ok ?? `${ACTION_LABEL[action]} — done`);

  const doAction = (a: string) => {
    if (a === "complete")
      return call("complete", { findings, parts_used: Object.entries(parts).map(([sku, quantity]) => ({ sku, quantity })), checklist: { lockout_tagout: true, bearing_replaced: true, alignment_checked: true } });
    if (a === "close") return call("close", { checklist: Object.fromEntries(CLOSURE.map((k) => [k, !!closure[k]])) });
    if (a === "verify") return call("verify", { outcome });
    if (a === "acknowledge_escalation") return run(() => api.post(`/api/work-orders/${id}/acknowledge-escalation`, { accept: true, note: reason || undefined }), "Escalation acknowledged");
    if (NEEDS_REASON.has(a) && !reason.trim()) {
      return run(() => api.post(`/api/work-orders/${id}/${a}`, {}), undefined); // lets the backend answer (422 reason required)
    }
    return call(a, a === "hold" ? { reason_code: "MANUAL" } : {});
  };

  const allowed = new Set(wo?.allowed_actions ?? []);
  return (
    <Drawer open={id != null} onClose={onClose} width={720} title={wo ? <span data-testid="wo-title">{wo.number} · {wo.title}</span> : "Work order"}>
      {!wo && !error && <Loading />}
      {error && <ErrorState error={error} retry={() => refetch()} />}
      {wo && (
        <div className="space-y-5" data-testid="wo-drawer">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={wo.status} /> <PriorityBadge priority={wo.priority} />
            {wo.proposed_priority && <span className="badge badge-bad">escalation proposed → {wo.proposed_priority}</span>}
            {wo.hold_reason && <span className="badge badge-watch">{wo.hold_reason.replace("_", " ")}</span>}
            <span className="badge badge-muted">{wo.asset_id}</span>
            {wo.incident_id && <span className="badge badge-muted">{wo.incident_id}</span>}
            <span className="text-xs text-muted">created {fmtTime(wo.created_at)} (sim)</span>
          </div>
          {wo.safety_note && <p className="rounded border border-watch/40 bg-watch/10 p-2 text-xs text-watch">{wo.safety_note}</p>}
          <p className="whitespace-pre-line text-sm text-muted">{wo.description}</p>

          <section className="rounded-md border border-line p-3">
            <div className="h-section mb-2">Actions {me ? <span className="normal-case text-muted">— you are {me.role}</span> : null}</div>
            <div className="mb-2 flex items-center gap-2">
              <input className="input" placeholder="Reason / note (required to reject, cancel, hold, or fail)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason or note" />
            </div>
            <div className="flex flex-wrap gap-2" data-testid="wo-actions">
              {[...allowed].filter((a) => a !== "assign").map((a) => (
                <button key={a} className="btn btn-primary btn-sm" disabled={busy} onClick={() => doAction(a)} data-testid={`act-${a}`}>
                  {ACTION_LABEL[a] ?? a}
                </button>
              ))}
              {allowed.size === 0 && <span className="text-xs text-muted">No actions are available to your role in this state.</span>}
            </div>
            <button className="mt-2 text-xs text-accent hover:underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Hide" : "Try any action — the backend decides (demonstrates 403 / 409 + audit)"}
            </button>
            {showAll && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="wo-try-all">
                {ALL_ACTIONS.filter((a) => a !== "assign").map((a) => (
                  <button key={a} className="btn btn-sm" disabled={busy} onClick={() => doAction(a)} data-testid={`try-${a}`}>{ACTION_LABEL[a]}</button>
                ))}
              </div>
            )}
            {allowed.has("complete") && (
              <div className="mt-3 space-y-2 rounded border border-line p-2 text-xs">
                <label className="block">Findings (required)
                  <textarea className="input mt-1" rows={2} value={findings} onChange={(e) => setFindings(e.target.value)} />
                </label>
                <div className="flex flex-wrap gap-3">
                  {wo.parts.map((p) => (
                    <label key={p.sku}>{p.name} used
                      <input type="number" min={0} className="input ml-2 inline-block w-16" value={parts[p.sku] ?? 0} onChange={(e) => setParts({ ...parts, [p.sku]: Number(e.target.value) })} />
                    </label>
                  ))}
                </div>
              </div>
            )}
            {allowed.has("verify") && (
              <label className="mt-3 block text-xs">Verification outcome
                <select className="input mt-1 w-auto" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="auto">auto (from criteria)</option><option value="pass">pass</option><option value="fail">fail (needs reason)</option>
                </select>
              </label>
            )}
            {allowed.has("close") && (
              <div className="mt-3 grid grid-cols-2 gap-1 text-xs">
                {CLOSURE.map((k) => (
                  <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={!!closure[k]} onChange={(e) => setClosure({ ...closure, [k]: e.target.checked })} /> {k.replaceAll("_", " ")}</label>
                ))}
              </div>
            )}
          </section>

          {canAssign && (
            <section className="rounded-md border border-line p-3" data-testid="dispatch-candidates">
              <div className="h-section mb-2">Dispatch ranking <span className="normal-case text-muted">— required skills: {wo.required_skills.join(", ")}</span></div>
              <p className="mb-2 text-[11px] text-muted">score = 0.35·skill fit + 0.25·proximity + 0.20·(1 − workload) + 0.20·first-time-fix rate. The supervisor confirms; the system never assigns silently.</p>
              <div className="space-y-2">
                {(cands?.candidates ?? []).map((c) => (
                  <div key={c.technician_id} className={`rounded-md border p-2 ${c.eligible ? "border-line" : "border-line opacity-80"}`} data-testid={`cand-${c.technician_id}`}>
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">{c.rank ? `#${c.rank} ` : ""}{c.name} <span className="text-xs text-muted">· floor {c.current_floor} · ETA {c.travel_minutes} min</span></div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums">{c.score.toFixed(2)}</span>
                        <button className="btn btn-sm" disabled={busy} onClick={() => call("assign", { technician_id: c.technician_id }, `Assigned ${c.name}`)} data-testid={`assign-${c.technician_id}`}>Assign</button>
                      </div>
                    </div>
                    {!c.eligible && <div className="mt-1 text-xs text-bad">Ineligible: {c.ineligible_reasons.join("; ")}</div>}
                    <div className="mt-1 grid grid-cols-4 gap-2 text-[11px] text-muted">
                      {Object.entries(c.breakdown).map(([k, v]) => (
                        <div key={k} title={v.detail}>{k.replace("_", " ")}: <b className="text-ink">{v.contribution.toFixed(3)}</b></div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {wo.risk_assessment && (
            <section className="rounded-md border border-line p-3">
              <div className="h-section mb-2">Risk decision & evidence</div>
              <RiskBreakdown decision={wo.risk_assessment} />
              <ul className="mt-3 space-y-1 text-xs" data-testid="wo-evidence">
                {wo.evidence.map((e) => (
                  <li key={e.id} className="rounded border border-line p-2">
                    <b>{e.kind === "system_draft" ? "Initial alert" : e.kind === "manual_draft" ? "Manual request" : "Attached alert"}</b> · {fmtTime(e.occurred_at)}
                    {e.severity && <> · {e.severity} · z {Number(e.z).toFixed(1)}σ · risk {e.risk_score}</>}
                    {e.reading_ids?.length ? <> · {e.reading_ids.length} supporting readings</> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <div className="h-section mb-1">Parts</div>
            <table className="w-full text-xs">
              <thead><tr><th className="th">Part</th><th className="th">Planned</th><th className="th">Reserved</th><th className="th">Consumed</th></tr></thead>
              <tbody>{wo.parts.map((p) => (<tr key={p.sku} className="tr"><td className="td">{p.sku} · {p.name}</td><td className="td">{p.planned}</td><td className="td">{p.reserved}</td><td className="td">{p.consumed}</td></tr>))}</tbody>
            </table>
          </section>

          {wo.inspections.length > 0 && (
            <section>
              <div className="h-section mb-1">Inspection records</div>
              {wo.inspections.map((i) => (
                <div key={i.id} className="mb-1 rounded border border-line p-2 text-xs">
                  <b>Repair #{i.repair_number}</b> by {i.technician_id} · {fmtMin(i.labour_minutes)} labour · parts {i.parts_used.map((p) => `${p.sku}×${p.quantity}`).join(", ") || "none"}
                  <div className="text-muted">{i.findings}</div>
                </div>
              ))}
            </section>
          )}

          {verifying && (
            <section className="rounded-md border border-line p-3" data-testid="verification-card">
              <div className="h-section mb-2">Verification (Layer 7)</div>
              {ver && (
                <>
                  <div className="mb-1 text-xs text-muted">Window: {ver.samples}/{ver.samples_required} post-repair samples after a {ver.settle_minutes} min settle {ver.ready_at ? `(ready ${fmtTime(ver.ready_at)})` : ""}</div>
                  <div className="mb-2 h-1.5 overflow-hidden rounded bg-panel2"><div className="h-full bg-accent" style={{ width: `${Math.min(100, (ver.samples / ver.samples_required) * 100)}%` }} /></div>
                  <ul className="space-y-1 text-xs">
                    {ver.criteria.map((c) => (
                      <li key={c.name} className="flex justify-between rounded border border-line px-2 py-1">
                        <span>{c.label}</span><span className={c.passed ? "text-ok" : "text-bad"}>{c.value ?? "—"} {c.unit} {c.passed ? "✓" : "✗"}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {wo.verifications.map((v) => (
                <div key={v.id} className="mt-2 text-xs"><span className={`badge ${v.outcome === "PASS" ? "badge-ok" : "badge-bad"}`}>{v.outcome}</span> repair #{v.repair_number} · {v.sample_count} samples · {fmtTime(v.occurred_at)} {v.notes ? `· ${v.notes}` : ""}</div>
              ))}
              <div className="mt-3"><BeforeAfter wo={wo} /></div>
            </section>
          )}

          <section>
            <div className="h-section mb-1">Approvals</div>
            {wo.approvals.length === 0 ? <div className="text-xs text-muted">None yet.</div> : wo.approvals.map((a) => (
              <div key={a.id} className="text-xs">{a.decision} by {a.role} · {fmtTime(a.occurred_at)} {a.comment ? `— ${a.comment}` : ""}</div>
            ))}
          </section>

          <section>
            <div className="h-section mb-1">Timeline</div>
            <ol className="space-y-1 border-l border-line pl-3 text-xs" data-testid="wo-timeline">
              {wo.events.map((e) => (
                <li key={e.id}>
                  <span className="tabular-nums text-muted">{fmtTime(e.occurred_at)}</span> · <b>{e.action}</b>{e.to_status ? ` → ${e.to_status}` : ""} · {e.actor} ({e.actor_role}){e.note ? ` — ${e.note}` : ""}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Drawer>
  );
}
