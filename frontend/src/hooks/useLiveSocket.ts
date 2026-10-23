import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Asset, EventEnvelope, SimState } from "../api/types";
import { useLive } from "../store/live";

const WO_EVENTS = /^(WorkOrder|Technician|Parts|Work|Verification|Rework|Evidence|PriorityEscalation|StockReceived|RepairApplied|EvaluationRecorded|RiskAssessed)/;
const ANOMALY_EVENTS = /^(Anomaly|HealthStateChanged|DataQuality)/;

/** One WebSocket for the whole app: feeds the live store and invalidates server-state queries. */
export function useLiveSocket() {
  const qc = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    const pending = new Set<string>();
    let flush: number | undefined;

    const invalidate = (...keys: string[]) => {
      keys.forEach((k) => pending.add(k));
      if (flush) return;
      flush = window.setTimeout(() => {
        flush = undefined;
        pending.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        pending.clear();
      }, 250);
    };

    const bootstrap = async () => {
      try {
        const [sim, assets, counters, stats] = await Promise.all([
          api.get<SimState>("/api/simulation"),
          api.get<Asset[]>("/api/assets"),
          api.get<{ by_layer: Record<string, number> }>("/api/events/counters"),
          api.get<{ stored: number; rejected_total: number }>("/api/telemetry/stats"),
        ]);
        useLive.getState().applySimState(sim);
        useLive.getState().seedAssets(assets);
        useLive.getState().setCounts(counters.by_layer, { 1: assets.length, 2: stats.stored + stats.rejected_total });
      } catch {
        /* backend not up yet — the reconnect loop will retry */
      }
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/events`);
      ws.onopen = () => {
        retry = 0;
        useLive.getState().setConnected(true);
        void bootstrap();
      };
      ws.onmessage = (m) => {
        let msg: { type: string; event?: EventEnvelope };
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        if (msg.type !== "event" || !msg.event) return;
        const e = msg.event;
        useLive.getState().ingest(e);
        const t = e.event_type;
        if (WO_EVENTS.test(t)) invalidate("work-orders", "work-order", "technicians", "inventory", "analytics", "incidents", "verification", "timeline", "audit");
        if (ANOMALY_EVENTS.test(t)) invalidate("anomalies", "assets", "tree", "incidents", "anomaly");
        if (t === "TelemetryRejected") invalidate("rejected", "telemetry-stats");
        if (t === "SimulationControl" || t === "FaultInjected" || t === "SimulationReset") invalidate("sim");
        if (t === "SimulationReset") qc.invalidateQueries();
      };
      ws.onclose = () => {
        useLive.getState().setConnected(false);
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        timer = window.setTimeout(connect, 500 * 2 ** retry);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    const keepAlive = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 20000);
    const resync = window.setInterval(() => void bootstrap(), 15000);
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(keepAlive);
      window.clearInterval(resync);
      ws?.close();
    };
  }, [qc]);
}
