// Screenshot tour of every page + console error collection. node scripts/tour.mjs [outDir]
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
const out = process.argv[2] ?? "artifacts/tour";
import fs from "node:fs"; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(`[console.error] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
for (const [name, path, wait] of [["landing", "/", 5000], ["sim", "/sim", 5000], ["pipeline", "/pipeline", 2500], ["cmms", "/cmms", 2000], ["dispatch", "/dispatch", 2000], ["inventory", "/inventory", 2000], ["analytics", "/analytics", 2500], ["audit", "/audit", 2500], ["control", "/control", 2000], ["about", "/about", 1500]]) {
  await page.goto("http://localhost:5173" + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
}
console.log(logs.join("\n") || "no console errors");
await browser.close();
