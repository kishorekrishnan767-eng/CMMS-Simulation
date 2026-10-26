import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAnomalies, useTelemetry } from "../api/queries";
import type { Asset } from "../api/types";
import { useUi } from "../store/ui";
import { Empty, Loading } from "./ui";

const ms = (iso: string) => Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
const hhmm = (v: number) => new Date(v).toISOString().slice(11, 16);

export const METRIC_LABEL: Record<string, string> = {
  vibration_velocity: "Vibration velocity",
  bearing_temperature: "Bearing temperature",
  motor_current: "Motor current",
  speed_command: "VFD speed command",
};

/** Live telemetry with the load-adjusted baseline band, alarm limits and anomaly markers. */
export default function TelemetryChart({ asset, metric, height = 210 }: { asset: Asset; metric: string; height?: number }) {
  const { data, isLoading, error } = useTelemetry(asset.id, metric, 3);
  const { data: anomalies } = useAnomalies(undefined, asset.id);
  const theme = useUi((s) => s.theme);
  const c = theme === "dark"
    ? { line: "#629af0", band: "#629af0", grid: "#323840", bad: "#ec5e58", watch: "#e2a038", text: "#969ea8" }
    : { line: "#1f5fbf", band: "#1f5fbf", grid: "#e1e4e8", bad: "#c4302b", watch: "#b06a00", text: "#606974" };

  const rows = useMemo(
    () => (data?.points ?? []).map((p) => ({ t: ms(p.t), v: p.v, band: p.lo !== undefined && p.hi !== undefined ? [p.lo, p.hi] : undefined, bad: p.q !== "GOOD" ? p.v : undefined })),
    [data],
  );
  const markers = useMemo(() => (anomalies?.items ?? []).filter((a) => rows.length && ms(a.detected_at) >= rows[0].t).map((a) => ({ t: ms(a.detected_at), id: a.incident_id })), [anomalies, rows]);

  if (isLoading) return <Loading label="Loading telemetry…" />;
  if (error) return <Empty title="Telemetry unavailable" hint={(error as Error).message} />;
  if (!rows.length) return <Empty title="No readings yet" hint="Start the simulation to stream simulated telemetry." />;
  const isVib = metric === "vibration_velocity";
  const hasBand = isVib && rows.some((r) => r.band);
  const vals = rows.map((r) => r.v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals, isVib ? asset.limits.warn : -Infinity);

  return (
    <div style={{ height }} data-testid={`chart-${metric}`} role="img" aria-label={`${METRIC_LABEL[metric]} over the last three simulated hours`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={hhmm} stroke={c.text} tick={{ fontSize: 11 }} minTickGap={36} />
          <YAxis stroke={c.text} tick={{ fontSize: 11 }} domain={[Math.floor(lo * 0.9 * 10) / 10, Math.ceil(hi * 1.1 * 10) / 10]} tickFormatter={(v: number) => v.toFixed(1)} width={44} />
          <Tooltip
            contentStyle={{ background: theme === "dark" ? "#191c20" : "#fff", border: `1px solid ${c.grid}`, borderRadius: 6, fontSize: 12 }}
            labelFormatter={(v) => `${hhmm(v as number)} UTC (sim)`}
            formatter={(v: unknown, name: string) => [Array.isArray(v) ? `${(v[0] as number).toFixed(2)} – ${(v[1] as number).toFixed(2)}` : (v as number).toFixed(2), name === "band" ? "baseline band (±3.5σ)" : data?.unit ?? ""]}
          />
          {hasBand && <Area dataKey="band" stroke="none" fill={c.band} fillOpacity={0.14} isAnimationActive={false} name="band" />}
          <Line dataKey="v" stroke={c.line} strokeWidth={2} dot={false} isAnimationActive={false} name={METRIC_LABEL[metric]} />
          <Line dataKey="bad" stroke={c.watch} strokeWidth={0} dot={{ r: 3, fill: c.watch }} isAnimationActive={false} name="suspect" />
          {isVib && <ReferenceLine y={asset.limits.alarm} stroke={c.bad} strokeDasharray="5 4" label={{ value: `alarm ${asset.limits.alarm}`, fill: c.bad, fontSize: 10, position: "insideTopRight" }} />}
          {isVib && <ReferenceLine y={asset.limits.warn} stroke={c.watch} strokeDasharray="3 4" label={{ value: `warn ${asset.limits.warn}`, fill: c.watch, fontSize: 10, position: "insideBottomRight" }} />}
          {markers.map((m) => (
            <ReferenceLine key={m.id} x={m.t} stroke={c.bad} label={{ value: m.id, fill: c.bad, fontSize: 10, position: "insideTopLeft" }} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
