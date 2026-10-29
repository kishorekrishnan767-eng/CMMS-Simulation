import { expect, test } from "@playwright/test";
import { call, step, twin, watchErrors } from "./helpers";

/**
 * The one-minute run must not break on what earlier runs left behind, must run one simulation at a time,
 * and must never blank the 3D office (it used to leak a WebGL context on every poll until the browser
 * killed the real one).
 */
test("a dirty building, one simulation at a time, and a 3D office that stays on screen", async ({ page, request }) => {
  test.setTimeout(420_000);
  const errors = watchErrors(page);
  const tooMany: string[] = [];
  page.on("console", (m) => { if (/Too many active WebGL contexts/.test(m.text())) tooMany.push(m.text()); });

  // an earlier run left stuff behind: machines still wearing and a job still open on one of them
  expect((await call(request, "operator", "post", "/api/walkthrough/reset")).status).toBe(200);
  await call(request, "operator", "post", "/api/simulation/pause");
  for (const asset of ["AHU-02-FAN-01", "EXH-FAN-01"]) {
    await call(request, "operator", "post", "/api/simulation/faults", { asset_id: asset, fault_type: "bearing_wear" });
  }
  for (let i = 0; i < 12; i++) await step(request, 5);
  const dirty = await call(request, "operator", "get", "/api/walkthrough/state");
  expect(dirty.body.leftovers.length).toBeGreaterThan(0);

  await page.goto("/sim");
  await page.getByTestId("tree-AHU-02-FAN-01").click();
  // the panel says what will be cleared, and injecting is possible (it used to be refused with a 409)
  await expect(page.getByTestId("wt-leftovers")).toContainText("Earlier runs left");
  await page.getByTestId("tab-asset").click();
  await expect(page.getByTestId("asset-inject")).toBeEnabled();
  await page.getByTestId("asset-inject").click();
  await expect(page.getByTestId("wt-clock")).toBeVisible({ timeout: 30_000 });

  // one simulation at a time: another machine cannot be injected while this one plays, by button or by API.
  // (the building tree folds away while the film plays; the viewer opens it again to pick another machine)
  await page.getByRole("button", { name: "Toggle left panel" }).click();
  await page.getByTestId("tree-CHILLER-01").click();
  await page.getByTestId("tab-asset").click();
  await expect(page.getByTestId("asset-inject")).toBeDisabled();
  await expect(page.getByTestId("asset-repair")).toBeDisabled();
  const second = await call(request, "supervisor", "post", "/api/walkthrough/start", { asset_id: "CHILLER-01", auto: true });
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe("run_in_progress");

  // the run finishes by itself, from a clean building
  await page.getByTestId("tab-process").click();
  await expect(page.getByTestId("wt-step-7")).toHaveAttribute("data-state", "done", { timeout: 360_000 });
  const state = (await call(request, "operator", "get", "/api/walkthrough/state")).body;
  expect(state.error).toBeNull();
  expect(state.asset_id).toBe("AHU-02-FAN-01");
  expect(state.results["7"].outcome).toBe("CLOSED");
  const wos = await call(request, "operator", "get", "/api/work-orders");
  expect(wos.body.total).toBe(1); // the stale job was cleared, this run's work order is the only one

  // the office was never blanked: the real WebGL context is alive and the browser never had to kill one
  expect(await twin(page, () => { const c = document.querySelector("canvas"); const gl = (c?.getContext("webgl2") ?? c?.getContext("webgl")) as WebGLRenderingContext | null; return !!gl && !gl.isContextLost(); })).toBe(true);
  expect(tooMany, tooMany.join("\n")).toEqual([]);

  // after step 7 the tab goes back to idle by itself, ready for the next machine, with one click
  await expect(page.getByTestId("wt-start")).toBeEnabled({ timeout: 40_000 });
  expect(errors, errors.join("\n")).toEqual([]);
});
