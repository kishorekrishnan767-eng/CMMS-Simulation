import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { api } from "../api/client";
import type { SimState } from "../api/types";
import { APP_NAME } from "../config";
import { useLive } from "../store/live";
import { useUi } from "../store/ui";
import { Simulated, useAct } from "./ui";

/** Run / pause the simulated building. There is no sign-in or role to choose: the simulation runs as Kishore. */
function SimControls() {
  const clock = useLive((s) => s.clock);
  const { run, busy } = useAct();
  const toggle = () => run(() => api.post<SimState>(clock.running ? "/api/simulation/pause" : "/api/simulation/start"));
  return (
    <div className="flex items-center gap-1.5" data-testid="sim-controls">
      <button className={`btn btn-sm min-w-[64px] ${clock.running ? "" : "btn-primary"}`} onClick={toggle} disabled={busy} aria-label={clock.running ? "Pause simulation" : "Start simulation"} data-testid="sim-toggle">
        {clock.running ? "Pause" : "Run"}
      </button>
    </div>
  );
}

const NAV: [string, string][] = [
  ["/sim", "Live building"], ["/cmms", "Work orders"], ["/dispatch", "Crew"], ["/inventory", "Spare parts"], ["/analytics", "Results"], ["/control", "Simulation"],
];

export default function Header() {
  const connected = useLive((s) => s.connected);
  const theme = useUi((s) => s.theme);
  const [menu, setMenu] = useState(false);
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-line bg-panel" role="banner">
      <div className="flex h-14 items-center gap-3 px-3 sm:px-5">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label={`${APP_NAME} home`}>
          <span className="grid h-7 w-7 place-items-center rounded-md bg-ink text-panel">
            <svg viewBox="0 0 32 32" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round"><path d="M9 25V11l7-4 7 4v14" /><path d="M13 25v-7h6v7" /></svg>
          </span>
          <span className="hidden sm:inline">{APP_NAME}</span>
        </Link>
        <nav className="hidden items-center gap-0.5 xl:flex" aria-label="Main">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => `whitespace-nowrap rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors ${isActive ? "bg-panel2 text-ink" : "text-muted hover:text-ink"}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <Simulated />
          <span className="hidden items-center gap-1 text-[11px] text-muted xl:flex">
            <i className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-ok" : "bg-bad"}`} />
            {connected ? "connected" : "offline"}
          </span>
          <SimControls />
          <button className="btn btn-sm hidden sm:inline-flex" aria-label="Toggle light or dark theme" onClick={() => useUi.getState().set({ theme: theme === "dark" ? "light" : "dark" })}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button className="btn btn-sm xl:hidden" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>
            ☰
          </button>
        </div>
      </div>
      {menu && (
        <nav className="grid grid-cols-3 gap-1 border-t border-line p-2 xl:hidden" aria-label="Mobile">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} onClick={() => setMenu(false)} className="rounded-md bg-panel2 px-2 py-2 text-center text-xs">
              {label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
}
