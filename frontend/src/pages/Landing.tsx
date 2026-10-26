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
    const { showLabels, showPins } = useUi.getState();
    useUi.setState({ showLabels: false, showPins: false });
    return () => useUi.setState({ showLabels, showPins });
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
            <span className="badge badge-watch mb-3">Simulated building · demo data</span>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Find the problem <span className="text-accent">before it breaks</span>.
            </h1>
            <p className="mt-4 text-base text-muted">
              {APP_NAME} is a live 3D model of the Livewire Digital Solutions building: every fan, pump, chiller and AC unit, and the people who work and maintain it.
              Watch a machine start to wear, the system warn early, a supervisor approve the job, a technician repair it and an independent check prove it worked.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/sim" className="btn btn-primary px-5 py-2.5 text-base" data-testid="launch-sim">Open the live building</Link>
              <Link to="/sim?demo=1" className="btn px-5 py-2.5 text-base" data-testid="launch-demo">▶ Watch the demo</Link>
            </div>
            <p className="mt-4 text-xs text-muted">No sign-in needed. You start as an operator and can switch roles from the top bar.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8" aria-labelledby="layers-h">
        <h2 id="layers-h" className="text-2xl font-semibold tracking-tight">From a sensor reading to a verified repair</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">Seven steps, each one lights up when something passes through it. The counters are live.</p>
        <ol className="mt-5 flex flex-col gap-3 lg:flex-row" data-testid="flow">
          {LAYERS.map((l) => <FlowNode key={l.n} n={l.n} />)}
        </ol>
      </section>

      <section className="mx-auto grid max-w-[1400px] gap-4 px-5 pb-16 sm:px-8 md:grid-cols-2">
        <div className="card p-5">
          <h3 className="text-lg font-semibold">What you get</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>An early warning when a machine starts to drift from its normal behaviour, with the evidence and the time left.</li>
            <li>One work order per problem, approved by a supervisor, assigned to the right technician, with parts reserved.</li>
            <li>An independent check that the repair worked, and the cost and response time of every job.</li>
            <li>Everyone sees the same picture: the control room, the crew and the machines.</li>
          </ul>
        </div>
        <div className="card p-5">
          <h3 className="text-lg font-semibold">Good to know</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>All sensor data, people and schedules here are simulated; nothing is connected to real equipment.</li>
            <li>A warning means "inspect this", never "this has failed".</li>
            <li>Thresholds are demo values and can be set per machine.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
