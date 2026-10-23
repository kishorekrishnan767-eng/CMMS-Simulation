import { chromium, expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
import { API, call } from "./helpers";

/**
 * DoD-17: measure the frame rate of the Medium-quality scene while the simulation is running and a
 * fault is active. Vsync/frame limiting is disabled so the figure is the achievable rate, not the
 * monitor refresh rate. The machine and GPU are recorded in docs/PERFORMANCE.md.
 */
test("DoD-17: the 3D scene holds >= 60 fps at Medium on this machine", async ({ request }) => {
  test.setTimeout(180_000);
  await call(request, "admin", "post", "/api/simulation/reset", {});
  await call(request, "operator", "post", "/api/simulation/faults", { asset_id: "AHU-02-FAN-01", fault_type: "bearing_wear" });
  await call(request, "operator", "patch", "/api/simulation", { speed: 60 });
  await call(request, "operator", "post", "/api/simulation/start");
  const browser = await chromium.launch({
    headless: !process.env.E2E_HEADED,
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem("twincmms.quality", JSON.stringify("medium"));
    localStorage.setItem("twincmms.autoQuality", "false");
  });
  await page.goto("/sim?asset=AHU-02-FAN-01");
  await page.waitForTimeout(30_000); // let the fault develop: wobble, halo, sensor tags, work-order pin
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2")!;
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    samples.push(
      await page.evaluate(
        () => new Promise<number>((res) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n++;
            if (performance.now() - t0 >= 6000) res((n * 1000) / (performance.now() - t0));
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      ),
    );
  }
  await page.screenshot({ path: "../artifacts/dod17-medium-scene.png" });
  const fps = Math.min(...samples);
  const record = { measured_at: new Date().toISOString(), quality: "medium", fps_min: Math.round(fps * 10) / 10, samples: samples.map((s) => Math.round(s * 10) / 10), renderer, headless: !process.env.E2E_HEADED, viewport: "1600x900", simulation: "running at 60x with an active bearing-wear fault", api: API };
  fs.mkdirSync(path.resolve(here, "../../artifacts"), { recursive: true });
  fs.writeFileSync(path.resolve(here, "../../artifacts/fps.json"), JSON.stringify(record, null, 2));
  await call(request, "operator", "post", "/api/simulation/pause");
  await browser.close();
  expect(fps, JSON.stringify(record)).toBeGreaterThanOrEqual(60);
});
