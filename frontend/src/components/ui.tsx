import { useCallback, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import type { Health, WoStatus } from "../api/types";
import { useLive } from "../store/live";

export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`;
};
export const fmtClock = (ms: number) => {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${day} ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
};
export const fmtMin = (m: number | null | undefined) => (m == null ? "—" : m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m.toFixed(m < 10 ? 1 : 0)} min`);
export const fmtMoney = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(2)}`);

export function HealthBadge({ health }: { health: Health | string }) {
  const cls = health === "ANOMALY" ? "badge-bad" : health === "WATCH" ? "badge-watch" : "badge-ok";
  return <span className={`badge ${cls}`}>{health}</span>;
}

const WO_BADGE: Record<string, string> = {
  DRAFT: "badge-muted", OPEN: "badge-watch", ASSIGNED: "badge-info", ON_HOLD: "badge-watch", IN_PROGRESS: "badge-info",
  COMPLETED: "badge-ok", VERIFIED: "badge-ok", REWORK_REQUIRED: "badge-bad", CLOSED: "badge-muted", REJECTED: "badge-muted", CANCELLED: "badge-muted",
};
export function StatusBadge({ status }: { status: WoStatus | string }) {
  return <span className={`badge ${WO_BADGE[status] ?? "badge-muted"}`}>{status.replace("_", " ")}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const cls = priority === "P1" ? "badge-bad" : priority === "P2" ? "badge-watch" : "badge-muted";
  return <span className={`badge ${cls}`}>{priority}</span>;
}

export function Simulated({ className = "" }: { className?: string }) {
  return (
    <span className={`badge badge-watch ${className}`} title="All sensor data in this product is simulated" data-testid="simulated-badge">
      Simulated
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-muted" role="status" aria-live="polite">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" /> {label}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div className="m-4 rounded-lg border border-bad/40 bg-bad/10 p-4 text-sm" role="alert">
      <b className="text-bad">Could not load data.</b> <span className="text-muted">{msg}</span>
      {retry && (
        <button className="btn btn-sm ml-3" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="p-8 text-center text-muted">
      <div className="text-ink">{title}</div>
      {hint && <div className="mt-1 text-xs">{hint}</div>}
    </div>
  );
}

export function PageShell({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-20 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
      {children}
    </main>
  );
}

export function Disclaimer({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] leading-snug text-muted ${className}`}>
      Simulated data. Thresholds are demo values configurable per asset — not taken from any standard. An anomaly is not a diagnosis.
    </p>
  );
}

/** Runs a mutation, surfaces backend denials (403/409/422) as toasts, refreshes server state. */
export function useAct() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) useLive.getState().pushToast({ kind: "ok", title: success });
        qc.invalidateQueries();
        return r;
      } catch (e) {
        const err = e as ApiError;
        useLive.getState().pushToast({
          kind: "bad",
          title: err.status === 403 ? "Denied by the backend (403)" : err.status === 409 ? "Not allowed in this state (409)" : "Request failed",
          body: err.message,
        });
        qc.invalidateQueries({ queryKey: ["audit"] });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [qc],
  );
  return { run, busy };
}

export function Drawer({ open, onClose, title, children, width = 640 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Details">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex h-full w-full flex-col border-l border-line bg-panel shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-base font-semibold">{title}</div>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
