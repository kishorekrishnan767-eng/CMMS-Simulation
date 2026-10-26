import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAnomalies, useAsset, useAutopilot, useProcedures, useTechnicians, useVerification, useWorkOrder, useWorkOrders } from "../api/queries";
import type { Anomaly, ProcedureStep, WorkOrderDetail } from "../api/types";
import { useUi } from "../store/ui";
import { floorLabel } from "../three/constants";
import { stepAt, travelMinutes, workBegan } from "../three/techPath";
import { Empty, HealthBadge, Loading, PriorityBadge, Progress, StatusBadge, fmtHM, parseIso, useSimNow } from "./ui";

const ACTIVE = new Set(["ASSIGNED", "ON_HOLD", "IN_PROGRESS"]);

function Entry({ time, title, who, tone = "done", children, testid }: { time: string | null; title: ReactNode; who?: string; tone?: "done" | "now" | "bad" | "next"; children?: ReactNode; testid?: string }) {
  const dot = { done: "bg-ink/70", now: "bg-accent ring-4 ring-accent/20", bad: "bg-bad", next: "bg-panel border border-line" }[tone];
  return (
    <li className={`relative pb-4 pl-5 ${tone === "next" ? "text-muted" : ""}`} data-testid={testid}>
      <span className={`absolute left-[-5px] top-[5px] h-2.5 w-2.5 rounded-full ${dot}`} />
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold leading-snug">{title}</div>
        <span className="mono shrink-0 text-muted">{time ? fmtHM(time) : ""}</span>
      </div>
      {who && <div className="text-[11.5px] text-muted">{who}</div>}
      {children && <div className="mt-1.5 text-[12.5px] leading-relaxed">{children}</div>}
    </li>
  );
}

function Checklist({ steps, current, done }: { steps: ProcedureStep[]; current: number; done: boolean }) {
  return (
    <ol className="mt-1 space-y-1">
      {steps.map((s, i) => {
        const state = done || i < current ? "done" : i === current ? "now" : "next";
        return (
          <li key={s.key} className={`flex items-start gap-2 text-[12px] ${state === "next" ? "text-muted" : ""}`} data-state={state}>
            <span className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border text-[9px] ${state === "done" ? "border-ok bg-ok text-white" : state === "now" ? "border-accent" : "border-line"}`}>
              {state === "done" ? "✓" : state === "now" ? <i className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
            </span>
            <span className={state === "now" ? "font-semibold" : ""}>{s.label}</span>
            {s.minutes > 0 && <span className="mono ml-auto shrink-0 text-muted">{s.minutes}′</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** What is happening right now on this job, with live progress driven by the sim clock. */
function NowCard({ wo, steps, now, waitText }: { wo: WorkOrderDetail; steps: ProcedureStep[]; now: number; waitText: string | null }) {
  const { data: ver } = useVerification(wo.id, wo.status === "COMPLETED");
  const tech = wo.assigned_technician;
  const first = tech?.name.split(" ")[0] ?? "Technician";
  const arrives = parseIso(wo.arrives_at);
  const where = floorLabel(wo.floor_level);
  let title = "";
  let body: ReactNode = null;
  let progress: number | null = null;
  let tone: "accent" | "ok" | "watch" | "bad" = "accent";

  if (ACTIVE.has(wo.status) && !Number.isNaN(arrives) && now < arrives) {
    const restart = wo.repair_count >= 1 ? parseIso(wo.updated_at) : parseIso(wo.assigned_at);
    progress = (now - restart) / Math.max(1, arrives - restart);
    title = wo.repair_count >= 1 ? `${first} is heading back for rework` : `${first} is on the way`;
    body = (
      <>Crew room → tools → {wo.floor_level === 0 ? "" : `lift to ${where} → `}{wo.asset_id} · ETA <b className="mono">{fmtHM(arrives)}</b> ({Math.max(0, Math.ceil((arrives - now) / 60000))} min, planned {travelMinutes(0, wo.floor_level)} min)</>
    );
  } else if (wo.status === "IN_PROGRESS") {
    const began = workBegan(wo);
    const elapsed = (now - began) / 60000;
    const total = steps.reduce((a, s) => a + s.minutes, 0) || 1;
    const i = stepAt(steps, elapsed);
    progress = elapsed / total;
    title = elapsed > total ? `${first} is finishing up and signing off` : `${first} is working: ${steps[i]?.label.split(/[;,—]/)[0] ?? "repair"}`;
    body = <Checklist steps={steps} current={i} done={false} />;
  } else if (wo.status === "ASSIGNED" || (wo.status === "ON_HOLD" && tech)) {
    title = wo.status === "ON_HOLD" ? `On hold — ${(wo.hold_reason ?? "").toLowerCase().replace("_", " ")}` : `${first} is on site: toolbox talk and permit`;
    tone = wo.status === "ON_HOLD" ? "watch" : "accent";
  } else if (wo.status === "COMPLETED") {
    title = "Repair done — collecting post-repair readings";
    if (ver) {
      progress = ver.samples / Math.max(1, ver.samples_required);
      body = <>Verification window: <b className="mono">{ver.samples}/{ver.samples_required}</b> samples after a {ver.settle_minutes} min settle. {first} is walking back to the crew room.</>;
    }
  } else if (wo.status === "REWORK_REQUIRED") {
    title = "Verification failed — technician recalled for rework";
    tone = "bad";
  } else if (wo.status === "VERIFIED") {
    title = "Repair verified — awaiting supervisor closure";
    tone = "ok";
  } else if (wo.status === "CLOSED") {
    title = "Closed — equipment back in normal service";
    tone = "ok";
    progress = 1;
  } else if (wo.status === "DRAFT") {
    title = "Waiting for supervisor approval";
    tone = "watch";
  } else if (wo.status === "OPEN") {
    title = "Approved — waiting for a technician to be dispatched";
    tone = "watch";
  } else {
    title = wo.status.replace("_", " ").toLowerCase();
  }
  return (
    <section className="rounded-md border border-line bg-panel2 p-3" data-testid="job-now">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        <i className="live-dot h-1.5 w-1.5 rounded-full bg-ok" /> Now
      </div>
      <div className="text-[14px] font-semibold leading-snug">{title}</div>
      {waitText && wo.status !== "CLOSED" && <div className="mt-0.5 text-[12px] text-muted">{waitText}</div>}
      {progress !== null && <div className="mt-2"><Progress value={progress} tone={tone} /></div>}
      {body && <div className="mt-2 text-[12.5px] text-muted">{body}</div>}
    </section>
  );
}

function issueText(a: Anomaly | undefined) {
  if (!a) return null;
  return (
    <>
      <p>{a.explanation}</p>
      {a.projection_hours != null && (
        <p className="mt-1.5 rounded-md border border-watch/30 bg-watch/10 px-2 py-1 text-[12px]" data-testid="prediction">
          <b>Prediction:</b> if left alone, vibration is on course to reach the alarm limit in about {Math.max(1, Math.round(a.projection_hours * 60))} min. The work order was raised before that happened.
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        <span className="badge badge-bad">{a.severity}</span>
        <span className="badge badge-muted">z = {a.z.toFixed(1)}σ</span>
        <span className="badge badge-muted">{a.observed_value.toFixed(2)} vs baseline {a.baseline_mean.toFixed(2)} mm/s</span>
        <span className="badge badge-muted">confidence {(a.confidence * 100).toFixed(0)}%</span>
      </div>
    </>
  );
}

/** The full story of one asset's latest work order: issue → decision → dispatch → travel → repair → verification → closure. */
export default function JobPanel({ assetId }: { assetId: string }) {
  const now = useSimNow(500);
  const { data: asset } = useAsset(assetId);
  const { data: list, isLoading } = useWorkOrders(`&asset_id=${assetId}`);
  const latest = (list?.items ?? []).find((w) => !["REJECTED", "CANCELLED"].includes(w.status)) ?? null;
  const { data: wo } = useWorkOrder(latest?.id ?? null);
  const { data: anomalies } = useAnomalies(undefined, assetId);
  const { data: catalogue } = useProcedures();
  const { data: ap } = useAutopilot();
  const { data: techs } = useTechnicians();
  const anomaly = useMemo(() => (anomalies?.items ?? []).find((a) => a.incident_id === wo?.incident_id) ?? (anomalies?.items ?? []).find((a) => a.state === "ACTIVE"), [anomalies, wo?.incident_id]);

  if (isLoading || !asset) return <Loading />;
  if (!latest || !wo) {
    return (
      <div className="space-y-3 p-4" data-testid="job-panel">
        <Header name={asset.name} id={asset.id} where={floorLabel(asset.floor_level)} />
        {anomaly && anomaly.state === "ACTIVE" ? (
          <section className="rounded-md border border-bad/30 bg-bad/5 p-3 text-[12.5px]">
            <div className="mb-1 font-semibold">Anomaly detected — the decision engine is scoring the risk</div>
            {issueText(anomaly)}
          </section>
        ) : (
          <Empty title="No work order for this asset" hint="When the detector raises an anomaly and the risk is high enough, a draft work order appears here and you can follow it end to end." />
        )}
      </div>
    );
  }

  const rework = wo.repair_count >= 1 && wo.status !== "COMPLETED" && wo.status !== "VERIFIED" && wo.status !== "CLOSED";
  const steps = (rework ? catalogue?.rework : catalogue?.procedures[asset.asset_type]) ?? [];
  const lastLog = [...(ap?.log ?? [])].reverse().find((l) => l.wo === wo.number);
  const waitText = lastLog?.kind === "wait" ? lastLog.text : null;
  const tech = techs?.find((t) => t.id === wo.assigned_technician?.id);
  const inspections = [...wo.inspections];
  const verifications = [...wo.verifications];
  const evidence = wo.events.filter((e) => e.action === "EVIDENCE_ATTACHED").length;
  const procedureFor = (n: number) => (n > 1 ? catalogue?.rework : catalogue?.procedures[asset.asset_type]) ?? [];
  // the checklist as the technician actually signed it: planned steps they ticked, else their own keys
  const recorded = (ins: WorkOrderDetail["inspections"][number]): ProcedureStep[] => {
    const ticked = procedureFor(ins.repair_number).filter((s) => ins.checklist[s.key]);
    return ticked.length ? ticked : Object.keys(ins.checklist).map((k) => ({ key: k, label: k.replaceAll("_", " "), minutes: 0 }));
  };

  return (
    <div className="space-y-3 p-4" data-testid="job-panel">
      <Header name={asset.name} id={asset.id} where={floorLabel(asset.floor_level)} />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mono font-semibold">{wo.number}</span>
        <StatusBadge status={wo.status} />
        <PriorityBadge priority={wo.priority} />
        {wo.repair_count > 1 && <span className="badge badge-watch">repair #{wo.repair_count}</span>}
        <HealthBadge health={asset.health_state} />
      </div>
      <NowCard wo={wo} steps={steps} now={now} waitText={waitText} />
      <div className="flex gap-2">
        {wo.assigned_technician && (
          <button className="btn btn-sm" onClick={() => useUi.getState().fly({ preset: "follow", assetId: asset.id })} data-testid="follow-tech">
            Follow {wo.assigned_technician.name.split(" ")[0]}
          </button>
        )}
        <Link className="btn btn-sm" to={`/cmms?wo=${wo.id}`}>Open work order</Link>
      </div>

      <div className="h-section pt-1">Job history</div>
      <ol className="ml-1 border-l border-line" data-testid="job-timeline">
        <Entry time={anomaly?.detected_at ?? wo.created_at} title={anomaly ? `Issue detected · ${anomaly.incident_id}` : "Maintenance requested"} tone="bad" who="Layer 4 condition monitoring (simulated sensors)">
          {issueText(anomaly) ?? <p className="text-muted">{wo.description}</p>}
        </Entry>
        {wo.events.map((e) => {
          const d = e.data ?? {};
          const who = `${e.actor} · ${e.actor_role.toLowerCase()}`;
          switch (e.action) {
            case "system_draft":
            case "manual_draft":
              return (
                <Entry key={e.id} time={e.occurred_at} title="Work order drafted" who={who}>
                  {wo.risk_assessment ? (
                    <p>Risk <b>{Math.round(wo.risk_assessment.risk_score)}/100</b> → {wo.risk_assessment.action.toLowerCase().replace("_", " ")}, priority {wo.risk_assessment.priority}. {wo.risk_assessment.reason}</p>
                  ) : <p>{wo.title}</p>}
                  {evidence > 0 && <p className="mt-1 text-muted">+{evidence} later alert{evidence > 1 ? "s" : ""} attached as evidence — no duplicate work order.</p>}
                </Entry>
              );
            case "EVIDENCE_ATTACHED":
              return null;
            case "approve":
              return <Entry key={e.id} time={e.occurred_at} title="Approved" who={who}>{e.note && <p className="text-muted">“{e.note}”</p>}</Entry>;
            case "assign":
              return (
                <Entry key={e.id} time={e.occurred_at} title={`Dispatched to ${d.technician_name ?? wo.assigned_technician?.name ?? "technician"}`} who={who}>
                  <div className="rounded-md border border-line bg-panel p-2" data-testid="dispatch-message">
                    <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-accent">Message to {String(d.technician_name ?? "technician").split(" ")[0]}</div>
                    <div>{wo.number} ({wo.priority}) — {asset.name}, {floorLabel(asset.floor_level)}. {wo.title}.</div>
                    <div className="mt-1 text-muted">
                      Parts reserved: {wo.parts.map((p) => `${p.sku}×${p.planned}`).join(", ") || "none"} · travel {d.travel_minutes ?? "?"} min · ETA {fmtHM(d.arrives_at)}
                      {typeof d.score === "number" && <> · dispatch score {d.score.toFixed(2)}</>}
                    </div>
                  </div>
                  {Array.isArray(d.shortages) && d.shortages.length > 0 && <p className="mt-1 text-watch">Short of {d.shortages.map((s: { sku: string }) => s.sku).join(", ")} — job goes on hold for parts.</p>}
                </Entry>
              );
            case "hold":
              return <Entry key={e.id} time={e.occurred_at} title="Put on hold" who={who} tone="bad">{e.note && <p className="text-muted">{e.note}</p>}</Entry>;
            case "resume":
              return <Entry key={e.id} time={e.occurred_at} title="Resumed" who={who}>{e.note && <p className="text-muted">{e.note}</p>}</Entry>;
            case "start":
              return <Entry key={e.id} time={e.occurred_at} title="Arrived on site, work started" who={who}>{e.note && <p className="text-muted">{e.note}</p>}</Entry>;
            case "restart":
              return <Entry key={e.id} time={e.occurred_at} title={`Rework: back to ${asset.id}`} who={who}><p className="text-muted">ETA {fmtHM(d.arrives_at)} · repair #{d.repair_number}</p></Entry>;
            case "complete": {
              const ins = inspections.find((i) => i.repair_number === d.repair_number) ?? inspections[0];
              return (
                <Entry key={e.id} time={e.occurred_at} title={`Repair #${d.repair_number ?? ""} completed`} who={who}>
                  <p>{ins?.findings ?? d.findings}</p>
                  {ins && <Checklist steps={recorded(ins)} current={99} done />}
                  <p className="mt-1 text-muted">
                    Parts used: {(ins?.parts_used ?? d.parts_used ?? []).map((p: { sku: string; quantity: number }) => `${p.sku}×${p.quantity}`).join(", ") || "none"} · labour {Math.round(ins?.labour_minutes ?? d.labour_minutes ?? 0)} min
                  </p>
                </Entry>
              );
            }
            case "verify_pass":
            case "verify_fail": {
              const pass = e.action === "verify_pass";
              const rec = verifications.shift();
              return (
                <Entry key={e.id} time={e.occurred_at} title={pass ? "Verification passed" : "Verification failed"} who={who} tone={pass ? "done" : "bad"}>
                  <ul className="space-y-0.5">
                    {(rec?.criteria.criteria ?? d.criteria?.criteria ?? []).map((c: { name: string; label: string; passed: boolean; value: number | null; threshold: number; unit: string }) => (
                      <li key={c.name} className="flex justify-between gap-2">
                        <span className={c.passed ? "" : "text-bad"}>{c.passed ? "✓" : "✕"} {c.label}</span>
                        <span className="mono text-muted">{c.value == null ? "—" : c.value.toFixed(2)} / {c.threshold} {c.unit}</span>
                      </li>
                    ))}
                  </ul>
                </Entry>
              );
            }
            case "close":
              return <Entry key={e.id} time={e.occurred_at} title="Closed" who={who}><p className="text-muted">{d.first_time_fix ? "First-time fix." : `Fixed after ${d.repairs ?? wo.repair_count} repairs.`}</p></Entry>;
            case "ESCALATION_ACKNOWLEDGED":
              return <Entry key={e.id} time={e.occurred_at} title="Priority escalation accepted" who={who} />;
            default:
              return <Entry key={e.id} time={e.occurred_at} title={e.action.replaceAll("_", " ").toLowerCase()} who={who}>{e.note && <p className="text-muted">{e.note}</p>}</Entry>;
          }
        })}
        {wo.status !== "CLOSED" && <Entry time={null} title={nextStep(wo.status)} tone="next" />}
      </ol>
      {tech && (
        <p className="text-[11px] text-muted">
          {tech.name}: {tech.skills.map((s) => s.toLowerCase().replace("_", " ")).join(", ")} · certification L{tech.certification_level} · first-time-fix rate {(tech.performance * 100).toFixed(0)}%
        </p>
      )}
      <p className="text-[11px] text-muted">Times are simulation time (UTC). Procedure steps and durations are demo values; an anomaly is a reason to inspect, not a diagnosis.</p>
    </div>
  );
}

function nextStep(status: string) {
  switch (status) {
    case "DRAFT": return "Next: supervisor review";
    case "OPEN": return "Next: dispatch a technician";
    case "ASSIGNED": return "Next: technician starts work on site";
    case "ON_HOLD": return "Next: blocker cleared, job resumes";
    case "IN_PROGRESS": return "Next: repair completed and signed off";
    case "COMPLETED": return "Next: independent verification";
    case "REWORK_REQUIRED": return "Next: technician returns for rework";
    case "VERIFIED": return "Next: supervisor closes the work order";
    default: return "Next step";
  }
}

function Header({ name, id, where }: { name: string; id: string; where: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <div className="text-[15px] font-semibold leading-tight">{name}</div>
        <div className="mono text-muted">{id} · {where}</div>
      </div>
      <button className="btn btn-sm" aria-label="Close panel" onClick={() => useUi.getState().selectAsset(null, false)}>✕</button>
    </div>
  );
}
