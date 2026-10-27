import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/index.css";
import { useLive } from "./store/live";
import { usePlayer } from "./store/player";
import { useUi } from "./store/ui";
import { drivable } from "./three/cityMap";
import { player } from "./three/player";
import { trafficCars } from "./three/traffic";
import { vehicle } from "./three/vehicle";

// Test/debug hook: lets automated checks read live pipeline state (never used by the app itself).
(window as unknown as { __twin: unknown }).__twin = { live: useLive, ui: useUi, playerUi: usePlayer, player, vehicle, trafficCars, drivable };

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1500, retry: 1, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
