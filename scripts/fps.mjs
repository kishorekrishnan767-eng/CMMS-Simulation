// Measure FPS of the live twin on the real GPU (headed Chromium). node scripts/fps.mjs [quality] [url]
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
const quality = process.argv[2] ?? "medium";
const url = process.argv[3] ?? "http://localhost:5173/sim";
const browser = await chromium.launch({ headless: false, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript((q) => { try { localStorage.setItem("twincmms.quality", JSON.stringify(q)); localStorage.setItem("twincmms.autoQuality", "false"); } catch {} }, quality);
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => { const c = document.createElement("canvas"); const gl = c.getContext("webgl2"); const e = gl?.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "unknown"; });
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 >= 8000) res((n * 1000) / (performance.now() - t0)); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
console.log(JSON.stringify({ quality, renderer: info, fps: Math.round(fps * 10) / 10 }));
await browser.close();
