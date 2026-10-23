// Visual walk through one incident against the running stack. node scripts/incident.mjs [outDir]
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
import fs from "node:fs";
const out = process.argv[2] ?? "artifacts/incident"; fs.mkdirSync(out, { recursive: true });
const API = "http://127.0.0.1:8000";
const tok = {};
async function call(user, method, path, body) {
  if (!tok[user]) { const r = await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "demo1234" }) }); tok[user] = (await r.json()).access_token; }
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok[user]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const step = (m) => call("operator", "POST", `/api/simulation/step?minutes=${m}`);
console.log("reset", (await call("admin", "POST", "/api/simulation/reset", {})).status);
await call("operator", "POST", "/api/simulation/pause");
const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
page.on("pageerror", (e) => logs.push("pageerror " + e.message));
await page.goto("http://localhost:5173/sim?asset=AHU-02-FAN-01", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${out}/1-healthy.png` });
await call("operator", "POST", "/api/simulation/faults", { asset_id: "AHU-02-FAN-01", fault_type: "bearing_wear" });
for (let i = 0; i < 26; i++) await step(1);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/2-watch-or-anomaly.png` });
for (let i = 0; i < 25; i++) await step(1);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/3-anomaly-wo.png` });
const wos = (await call("operator", "GET", "/api/work-orders")).json;
const wo = wos.items[0];
console.log("wo", wo?.number, wo?.status);
await call("supervisor", "POST", `/api/work-orders/${wo.id}/approve`, { note: "ok" });
await call("supervisor", "POST", `/api/work-orders/${wo.id}/assign`, { technician_id: "TECH-01" });
await page.evaluate(() => { document.querySelector('[data-testid="cam-roof"]')?.click(); });
for (let i = 0; i < 8; i++) { await step(1); await page.waitForTimeout(250); }
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/4-tech-walking.png` });
for (let i = 0; i < 9; i++) await step(1);
await call("tech1", "POST", `/api/work-orders/${wo.id}/start`);
await step(5);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/5-working.png` });
console.log(logs.slice(0, 10).join("\n") || "no console errors");
await browser.close();
