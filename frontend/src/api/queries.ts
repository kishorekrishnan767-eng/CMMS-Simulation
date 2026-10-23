import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type {
  Anomaly, Asset, AuditRow, BuildingTree, Candidate, Decision, DemoUser, EventEnvelope, InventoryItem, SimState, Technician,
  TelemetrySeries, TimelineItem, VerificationPreview, WorkOrderDetail, WorkOrderSummary,
} from "./types";
import { BUILDING_ID } from "../config";

export const useTree = () => useQuery({ queryKey: ["tree"], queryFn: () => api.get<BuildingTree>(`/api/buildings/${BUILDING_ID}/tree`) });
export const useAssets = () => useQuery({ queryKey: ["assets"], queryFn: () => api.get<Asset[]>("/api/assets"), refetchInterval: 20000 });
export const useAsset = (id: string | null) =>
  useQuery({ queryKey: ["asset", id], queryFn: () => api.get<Asset>(`/api/assets/${id}`), enabled: !!id, refetchInterval: 8000 });
export const useSim = () => useQuery({ queryKey: ["sim"], queryFn: () => api.get<SimState>("/api/simulation"), refetchInterval: 10000 });

export const useTelemetry = (assetId: string | null, metric: string, hours = 3) =>
  useQuery({
    queryKey: ["telemetry", assetId, metric, hours],
    queryFn: () => api.get<TelemetrySeries>(`/api/assets/${assetId}/telemetry?metric=${metric}&hours=${hours}&band=true&max_points=400`),
    enabled: !!assetId,
    refetchInterval: 2500,
  });

export const useAnomalies = (state?: string, assetId?: string | null) =>
  useQuery({
    queryKey: ["anomalies", state, assetId],
    queryFn: () => api.get<{ items: Anomaly[]; total: number }>(`/api/anomalies?limit=100${state ? `&state=${state}` : ""}${assetId ? `&asset_id=${assetId}` : ""}`),
    refetchInterval: 6000,
  });
export const useAnomaly = (id: number | null) =>
  useQuery({ queryKey: ["anomaly", id], queryFn: () => api.get<Anomaly>(`/api/anomalies/${id}`), enabled: id != null });

export const useWorkOrders = (params = "") =>
  useQuery({ queryKey: ["work-orders", params], queryFn: () => api.get<{ items: WorkOrderSummary[]; total: number }>(`/api/work-orders?limit=200${params}`), refetchInterval: 5000 });
export const useWorkOrder = (id: number | null) =>
  useQuery({ queryKey: ["work-order", id], queryFn: () => api.get<WorkOrderDetail>(`/api/work-orders/${id}`), enabled: id != null, refetchInterval: 5000 });
export const useCandidates = (id: number | null, enabled: boolean) =>
  useQuery({ queryKey: ["candidates", id], queryFn: () => api.get<{ candidates: Candidate[]; required_skills: string[] }>(`/api/work-orders/${id}/dispatch-candidates`), enabled: enabled && id != null });
export const useVerification = (id: number | null, enabled: boolean) =>
  useQuery({ queryKey: ["verification", id], queryFn: () => api.get<VerificationPreview>(`/api/work-orders/${id}/verification`), enabled: enabled && id != null, refetchInterval: 3000 });

export const useTechnicians = () => useQuery({ queryKey: ["technicians"], queryFn: () => api.get<Technician[]>("/api/technicians"), refetchInterval: 4000 });
export const useInventory = () =>
  useQuery({ queryKey: ["inventory"], queryFn: () => api.get<{ items: InventoryItem[]; low_stock: string[]; reservations: { id: number; sku: string; work_order: string; quantity: number; status: string; created_at: string }[] }>("/api/inventory") });
export const useMovements = () =>
  useQuery({ queryKey: ["inventory", "movements"], queryFn: () => api.get<{ items: { id: number; sku: string; quantity: number; movement_type: string; balance_after: number; work_order: string | null; note: string | null; occurred_at: string }[] }>("/api/inventory/movements?limit=60") });

export const useTimeline = (incident: string | null) =>
  useQuery({ queryKey: ["timeline", incident], queryFn: () => api.get<{ items: TimelineItem[] }>(`/api/incidents/${incident}/timeline`), enabled: !!incident, refetchInterval: 5000 });
export const useIncidents = () =>
  useQuery({ queryKey: ["incidents"], queryFn: () => api.get<{ incident_id: string; asset_id: string; state: string; severity: string; detected_at: string; work_order: string | null; work_order_status: string | null }[]>("/api/incidents"), refetchInterval: 6000 });

export const useEvents = (query: string) =>
  useQuery({ queryKey: ["events", query], queryFn: () => api.get<{ items: EventEnvelope[]; total: number }>(`/api/events?${query}`), refetchInterval: 4000 });
export const useAudit = (query: string, enabled = true) =>
  useQuery({ queryKey: ["audit", query], queryFn: () => api.get<{ items: AuditRow[]; total: number }>(`/api/audit-logs?${query}`), enabled, refetchInterval: 5000 });
export const useDeadLetters = (enabled = true) =>
  useQuery({ queryKey: ["dead-letters"], queryFn: () => api.get<{ items: { id: number; event_id: string; event_type: string; consumer: string; attempts: number; error: string; created_at: string }[]; total: number }>("/api/dead-letters"), enabled });
export const useRejected = () =>
  useQuery({ queryKey: ["rejected"], queryFn: () => api.get<{ items: { id: number; reason: string; detail: string; sensor_id: string | null; received_at: string }[]; total: number }>("/api/telemetry/rejected?limit=40"), refetchInterval: 6000 });
export const useDecision = (id: number | null) => useQuery({ queryKey: ["decision", id], queryFn: () => api.get<Decision>(`/api/decisions/${id}`), enabled: id != null });
export const useDemoUsers = () => useQuery({ queryKey: ["demo-users"], queryFn: () => api.get<DemoUser[]>("/api/auth/demo-users"), staleTime: Infinity });

export const useAnalytics = () =>
  useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const [maintenance, detector, assets] = await Promise.all([
        api.get<any>("/api/analytics/maintenance"), api.get<any>("/api/analytics/detector"), api.get<any>("/api/analytics/assets"),
      ]);
      return { maintenance, detector, assets };
    },
    refetchInterval: 8000,
  });
