import { LAYERS } from "../config";
import { PageShell } from "../components/ui";

function Arch() {
  const box = (x: number, y: number, w: number, label: string, sub: string, hl = false) => (
    <g key={label}>
      <rect x={x} y={y} width={w} height={54} rx={10} fill="rgb(var(--panel2))" stroke={hl ? "rgb(var(--accent))" : "rgb(var(--line))"} strokeWidth={hl ? 2 : 1} />
      <text x={x + w / 2} y={y + 23} textAnchor="middle" fontSize="13" fontWeight="600" fill="rgb(var(--ink))">{label}</text>
      <text x={x + w / 2} y={y + 41} textAnchor="middle" fontSize="10.5" fill="rgb(var(--muted))">{sub}</text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number) => <line key={`${x1}${y1}${x2}${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(var(--accent))" strokeWidth={1.6} markerEnd="url(#a)" />;
  return (
    <svg viewBox="0 0 960 330" role="img" aria-label="Architecture: simulator, ingestion, monitoring, decision, workflow, verification, with an event bus and database" className="w-full">
      <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="rgb(var(--accent))" /></marker></defs>
      {box(10, 20, 150, "Simulator", "seeded physics + faults (L2)")}
      {box(190, 20, 150, "Ingestion", "validation (L3)", true)}
      {box(370, 20, 150, "Monitoring", "detector (L4)", true)}
      {box(550, 20, 150, "Decision", "risk + dedup (L5)", true)}
      {box(730, 20, 210, "CMMS workflow", "work orders, dispatch, stock (L6)", true)}
      {box(730, 150, 210, "Verification", "post-repair window (L7)", true)}
      {box(370, 150, 330, "Event bus · transactional outbox", "idempotent consumers · retries · dead letters", true)}
      {box(10, 150, 330, "SQLite / PostgreSQL", "raw readings kept separate from derived analysis")}
      {box(10, 260, 340, "FastAPI + WebSocket", "JWT roles enforced in the backend; audit incl. DENIED")}
      {box(380, 260, 560, "React + three.js digital twin", "live 3D scene, layer ribbon, guided demo director")}
      {arrow(160, 47, 190, 47)}{arrow(340, 47, 370, 47)}{arrow(520, 47, 550, 47)}{arrow(700, 47, 730, 47)}
      {arrow(835, 74, 835, 150)}{arrow(530, 74, 530, 150)}{arrow(200, 74, 200, 150)}{arrow(700, 177, 700, 177)}
      {arrow(370, 177, 340, 177)}{arrow(520, 204, 520, 260)}{arrow(180, 204, 180, 260)}
    </svg>
  );
}

export default function AboutPage() {
  return (
    <PageShell title="About this product" subtitle="A fully working CMMS simulation: from sensor data to a verified repair, on a procedural 3D digital twin. Everything on screen except the sensor values is real application logic backed by a real database.">
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-4 lg:col-span-2">
          <h2 className="mb-2 text-lg font-semibold">Architecture</h2>
          <Arch />
          <p className="mt-2 text-sm text-muted">A modular monolith: strict internal modules, one database, no message broker. The simulator cannot import monitoring, decision or CMMS code (enforced by a test); it only publishes telemetry through the same ingestion interface a real adapter would use.</p>
        </section>
        <section className="card p-4">
          <h2 className="mb-2 text-lg font-semibold">What this is</h2>
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
            <li>A demonstration of the whole maintenance loop: detect → decide → approve → dispatch → repair → verify → learn.</li>
            <li>Deterministic and explainable: statistics, rules and templates — no black-box model.</li>
            <li>Permissions enforced in the backend; refused actions are audited.</li>
          </ul>
          <h2 className="mb-2 mt-4 text-lg font-semibold">What it isn’t</h2>
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
            <li>Not connected to real equipment. <b>All sensor data is simulated.</b></li>
            <li>Not a diagnosis tool: an anomaly means “persistent deviation, inspection recommended”, never “failed”.</li>
            <li>Thresholds, weights and limits are <b>demo values, configurable per asset — not taken from any standard</b>.</li>
            <li>No claim of real-world detection accuracy or regulatory compliance.</li>
          </ul>
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-2 text-lg font-semibold">Building systems context</h2>
          <p className="text-sm text-muted">A Building Management System (BMS) monitors and controls HVAC, pumps, lighting, fire safety and electrical systems: sensors report, controllers decide, actuators act. Field devices commonly speak <b>BACnet</b> (objects such as analog inputs for temperature or vibration) or <b>Modbus</b> (registers on drives, meters and chillers). In production an adapter or MQTT bridge would map those points to the telemetry schema and call the ingestion endpoint — exactly what the simulator does here. An <code>MqttAdapter</code> interface stub is included but unused.</p>
          <p className="mt-2 text-sm text-muted">A CMMS (Computerized Maintenance Management System) then manages the work: what to do, who does it, with which parts, and whether it worked.</p>
        </section>
        <section className="card p-4">
          <h2 className="mb-2 text-lg font-semibold">Honest limitations</h2>
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted">
            <li>One building, eight assets and one modelled failure mode (vibration rise consistent with possible bearing degradation).</li>
            <li>Sampling is one simulated minute; real vibration analysis uses much higher-rate data and spectra.</li>
            <li>Technician travel times and shifts are simple models; stock is a single store.</li>
            <li>An explanation text is template-based; an optional LLM explainer interface exists but is off and needs no keys.</li>
            <li>The evaluation metrics describe this detector on simulated, injected faults only.</li>
          </ul>
        </section>
      </div>

      <section className="card mt-4 p-4">
        <h2 className="mb-3 text-lg font-semibold">The seven layers</h2>
        <ol className="grid gap-2 md:grid-cols-2">
          {LAYERS.map((l) => (
            <li key={l.n} className="flex gap-3 rounded-lg border border-line p-3 text-sm"><span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-accent font-bold text-[#04201c]">{l.n}</span><span><b>{l.name}</b><br /><span className="text-muted">{l.blurb}</span></span></li>
          ))}
        </ol>
      </section>
    </PageShell>
  );
}
