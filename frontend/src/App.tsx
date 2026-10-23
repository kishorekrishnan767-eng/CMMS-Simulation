import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import type { Me } from "./api/types";
import Header from "./components/Header";
import Toasts from "./components/Toasts";
import { Loading } from "./components/ui";
import { useLiveSocket } from "./hooks/useLiveSocket";
import { useSession } from "./store/session";
import { useUi } from "./store/ui";

const Landing = lazy(() => import("./pages/Landing"));
const SimPage = lazy(() => import("./pages/SimPage"));
const PipelinePage = lazy(() => import("./pages/PipelinePage"));
const CmmsPage = lazy(() => import("./pages/CmmsPage"));
const DispatchPage = lazy(() => import("./pages/DispatchPage"));
const InventoryPage = lazy(() => import("./pages/InventoryPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const AuditPage = lazy(() => import("./pages/AuditPage"));
const ControlPage = lazy(() => import("./pages/ControlPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));

export default function App() {
  useLiveSocket();
  const theme = useUi((s) => s.theme);
  const reduced = useUi((s) => s.reducedMotion);
  const token = useSession((s) => s.token);
  const loc = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.reducedMotion = String(reduced);
  }, [theme, reduced]);

  // Demo convenience: start as the Operator so the simulation can be controlled straight away.
  useEffect(() => {
    if (token) return;
    api.post<{ access_token: string; user: Me }>("/api/auth/login", { username: "operator", password: "demo1234" })
      .then((r) => useSession.getState().login(r.access_token, r.user))
      .catch(() => undefined);
  }, [token]);

  return (
    <>
      <Header />
      <Suspense fallback={<div className="pt-20"><Loading /></div>}>
        <Routes location={loc}>
          <Route path="/" element={<Landing />} />
          <Route path="/sim" element={<SimPage />} />
          <Route path="/pipeline" element={<PipelinePage />} />
          <Route path="/cmms" element={<CmmsPage />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/control" element={<ControlPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toasts />
    </>
  );
}
