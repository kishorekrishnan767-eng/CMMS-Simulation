import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const BACKEND_WS = BACKEND.replace(/^http/, "ws");

// The backend runs on :8000; the dev server proxies API + WebSocket so the browser
// only ever talks to one origin (CORS stays locked to the dev origin).
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND_WS, ws: true },
    },
  },
  preview: {
    port: Number(process.env.FRONTEND_PORT ?? 4173),
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND_WS, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          r3f: ["@react-three/fiber", "@react-three/drei"],
          charts: ["recharts"],
        },
      },
    },
  },
});
