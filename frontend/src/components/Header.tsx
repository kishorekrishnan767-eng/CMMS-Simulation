import { useEffect, useRef, useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { api } from "../api/client";
import { useDemoUsers } from "../api/queries";
import type { Me, SimState } from "../api/types";
import { APP_NAME } from "../config";
import { useLive } from "../store/live";
import { useSession } from "../store/session";
import { useUi } from "../store/ui";
import { Simulated, useAct } from "./ui";

function SimControls() {
  const clock = useLive((s) => s.clock);
  const { run, busy } = useAct();
  const me = useSession((s) => s.me);
  const can = !!me && ["ADMIN", "OPERATOR", "SUPERVISOR"].includes(me.role);
  const toggle = () => run(() => api.post<SimState>(clock.running ? "/api/simulation/pause" : "/api/simulation/start"));
  return (
    <div className="flex items-center gap-1.5" data-testid="sim-controls">
      <button className={`btn btn-sm min-w-[64px] ${clock.running ? "" : "btn-primary"}`} onClick={toggle} disabled={busy || !can} title={can ? "" : "Sign in as Operator, Supervisor or Admin to control the simulation"} aria-label={clock.running ? "Pause simulation" : "Start simulation"} data-testid="sim-toggle">
        {clock.running ? "Pause" : "Run"}
      </button>
    </div>
  );
}

function RoleSwitcher() {
  const me = useSession((s) => s.me);
  const [open, setOpen] = useState(false);
  const { data: users } = useDemoUsers();
  const ref = useRef<HTMLDivElement>(null);
  const { run } = useAct();
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const login = async (username: string, password: string) => {
    const r = await run(() => api.post<{ access_token: string; user: Me }>("/api/auth/login", { username, password }), undefined);
    if (r) {
      useSession.getState().login(r.access_token, r.user);
      setOpen(false);
    }
  };
  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} data-testid="role-switcher">
        <span className="h-2 w-2 rounded-full bg-ok" />
        {me ? `${me.display_name.split(" ")[0]} · ${me.role}` : "Sign in"}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-md border border-line bg-panel p-2 shadow-lg" role="menu">
          <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wider text-muted">Demo users — permissions are enforced by the backend</div>
          {(users ?? []).map((u) => (
            <button key={u.username} role="menuitem" onClick={() => login(u.username, u.password)} data-testid={`login-${u.username}`}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel2 ${me?.username === u.username ? "bg-panel2" : ""}`}>
              <span>
                {u.display_name}
                <span className="block text-[11px] text-muted">{u.username}{u.technician_id ? ` · ${u.technician_id}` : ""}</span>
              </span>
              <span className="badge badge-muted">{u.role}</span>
            </button>
          ))}
          {me && (
            <button className="btn btn-sm mt-1 w-full" onClick={() => { useSession.getState().logout(); setOpen(false); }}>
              Sign out
            </button>
          )}
          <div className="px-2 pt-2 text-[11px] text-muted">Demo password for all users: <code>demo1234</code></div>
        </div>
      )}
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
          <RoleSwitcher />
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
