// Ad-hoc screenshot helper: node scripts/shot.mjs <url> <out.png> [waitMs] [--gpu]
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
const [url, out, wait = "6000"] = process.argv.slice(2);
const args = process.argv.includes("--gpu") ? ["--use-angle=default", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(logs.slice(0, 15).join("\n") || "no console errors/warnings");
await browser.close();
