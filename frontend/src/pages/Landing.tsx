import { Suspense, lazy, useEffect } from "react";
import { Link } from "react-router-dom";
import WebGLGuard from "../components/WebGLGuard";
import { Loading } from "../components/ui";
import { APP_NAME, LAYERS } from "../config";
import { useLive } from "../store/live";
import { useUi } from "../store/ui";

const TwinScene = lazy(() => import("../three/Scene"));

function FlowNode({ n }: { n: number }) {
  const l = LAYERS[n - 1];
  const count = useLive((s) => s.layerCounts[n] ?? 0);
  const pulse = useLive((s) => s.layerPulse[n]);
  const recent = pulse !== undefined && performance.now() - pulse < 1500;
  return (
    <li className={`card relative flex-1 p-3 transition-colors ${recent ? "border-accent" : ""}`} data-testid={`flow-${n}`}>
      <div className="flex items-center justify-between">
        <span className="grid h-6 w-6 place-items-center rounded bg-accent text-xs font-bold text-white">{n}</span>
        <span className="text-[11px] tabular-nums text-muted" title="live event count from the backend">{count.toLocaleString()}</span>
      </div>
      <div className="mt-2 text-sm font-semibold">{l.name}</div>
      <div className="mt-0.5 text-xs text-muted">{l.blurb}</div>
      <style>{`.flow-dot-${n}{animation:flow 3.4s linear infinite;animation-delay:${n * 0.45}s}`}</style>
      <span className={`flow-dot-${n} absolute -right-2 top-1/2 hidden h-2 w-2 rounded-full bg-accent lg:block`} aria-hidden />
    </li>
  );
}

export default function Landing() {
  // the hero twin is a backdrop: no machine / pin / technician labels over the headline
  useEffect(() => {
    const { showLabels, showPins, showTechnicians } = useUi.getState();
    useUi.setState({ showLabels: false, showPins: false, showTechnicians: false });
    return () => useUi.setState({ showLabels, showPins, showTechnicians });
  }, []);
  return (
    <div className="pt-14">
      <style>{`@keyframes flow{0%{opacity:0;transform:translateX(-14px)}20%{opacity:1}80%{opacity:1}100%{opacity:0;transform:translateX(14px)}}`}</style>
      <section className="relative h-[calc(100vh-3.5rem)] min-h-[560px] overflow-hidden" aria-label="Hero">
        <div className="absolute inset-0" data-testid="hero-scene">
          <WebGLGuard>
            <Suspense fallback={<Loading label="Loading the 3D twin…" />}>
              <TwinScene orbit interactive={false} />
            </Suspense>
          </WebGLGuard>
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-bg/90 via-bg/40 to-transparent" />
        <div className="relative z-10 mx-auto flex h-full max-w-[1400px] items-center px-5 sm:px-8">
          <div className="pointer-events-auto max-w-xl">
            <span className="badge badge-watch mb-3">Simulated data · demo thresholds</span>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              From sensor data to a <span className="text-accent">verified repair</span>.
            </h1>
            <p className="mt-4 text-base text-muted">
              {APP_NAME} is a fully working CMMS simulation on a live 3D digital twin of an office tower. Watch a fan bearing degrade, the system detect it and explain why, a work order get approved, a technician walk to the roof, repair it — and an independent verifier confirm recovery. Every number comes from a real database through a real backend.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/sim" className="btn btn-primary px-5 py-2.5 text-base" data-testid="launch-sim">Launch live simulation</Link>
              <Link to="/sim?demo=1" className="btn px-5 py-2.5 text-base" data-testid="launch-demo">▶ Watch guided demo</Link>
            </div>
            <p className="mt-4 text-xs text-muted">No account needed — you start as an Operator and can switch roles from the header.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8" aria-labelledby="layers-h">
        <h2 id="layers-h" className="text-2xl font-semibold tracking-tight">Seven layers, one incident</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">Each node lights up when an event passes through it; the counters are live from the backend.</p>
        <ol className="mt-5 flex flex-col gap-3 lg:flex-row" data-testid="flow">
          {LAYERS.map((l) => <FlowNode key={l.n} n={l.n} />)}
        </ol>
      </section>

      <section className="mx-auto grid max-w-[1400px] gap-4 px-5 pb-16 sm:px-8 md:grid-cols-2">
        <div className="card p-5">
          <h3 className="text-lg font-semibold">What this is</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>A complete maintenance loop on a procedural 3D building, driven by a seeded simulator.</li>
            <li>Transparent detection (baseline, z-score, slope, persistence) with evidence and a plain-language explanation.</li>
            <li>A work-order state machine with roles enforced in the backend, explainable dispatch, and a stock ledger.</li>
            <li>Independent verification and metrics computed from stored data.</li>
          </ul>
        </div>
        <div className="card p-5">
          <h3 className="text-lg font-semibold">What it isn’t</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Not connected to real equipment — all sensor data is simulated.</li>
            <li>Not a diagnosis: an anomaly means “inspection recommended”, never “failed”.</li>
            <li>Thresholds are demo values, configurable per asset — not taken from any standard.</li>
            <li>Not evidence of real-world detection accuracy.</li>
          </ul>
          <Link to="/about" className="mt-3 inline-block text-sm text-accent hover:underline">Architecture & limitations →</Link>
        </div>
      </section>
    </div>
  );
}
