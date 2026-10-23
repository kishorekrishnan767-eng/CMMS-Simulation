import { defineConfig } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end UI suite. It starts its OWN backend (isolated SQLite file, port 8765) and Vite server
 * (port 5199), so it never touches the development database. The specs are order-dependent
 * (smoke → incident workflow → guided demo → analytics) and run in a single worker.
 */
const root = path.resolve(here, "..");
const isWin = process.platform === "win32";
const py = path.join(root, "backend", ".venv", isWin ? "Scripts/python.exe" : "bin/python");
// The config is evaluated again inside every worker; the DB path is therefore fixed once via the environment.
if (!process.env.E2E_DB) {
  for (const f of fs.readdirSync(path.join(root, "backend"))) {
    if (/^e2e-.*\.db(-wal|-shm)?$/.test(f)) {
      try { fs.rmSync(path.join(root, "backend", f)); } catch { /* still in use by a previous run */ }
    }
  }
  process.env.E2E_DB = path.join(root, "backend", `e2e-${Date.now()}.db`);
}
const dbFile = process.env.E2E_DB;

const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8765);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5199);

export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: path.join(root, "artifacts", "playwright-report.json") }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    viewport: { width: 1600, height: 900 },
    screenshot: "off",
    trace: "off",
    launchOptions: {
      args: process.env.E2E_SOFTWARE_GL
        ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        : ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
    },
  },
  webServer: [
    {
      command: `"${py}" -m uvicorn app.main:app --host 127.0.0.1 --port ${BACKEND_PORT}`,
      cwd: path.join(root, "backend"),
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { DATABASE_URL: `sqlite:///${dbFile.replace(/\\/g, "/")}`, DEMO_PACE: "0.12", CORS_ORIGINS: `http://localhost:${FRONTEND_PORT}` },
    },
    {
      command: `npx vite --port ${FRONTEND_PORT} --strictPort`,
      cwd: here,
      url: `http://localhost:${FRONTEND_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`, FRONTEND_PORT: String(FRONTEND_PORT) },
    },
  ],
});
