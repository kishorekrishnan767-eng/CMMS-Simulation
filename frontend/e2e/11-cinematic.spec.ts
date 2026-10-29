import { expect, test } from "@playwright/test";
import { call, twin, watchErrors } from "./helpers";

/**
 * The run is a film (letterbox, chapter titles, a chase camera that keeps the walking technician in frame) and the
 * Process tab explains each moment in plain words while it happens.
 */
test("the run is filmed and explained: chapter titles, a tracked walk, a route tracker and a why-it-matters card", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  expect((await call(request, "operator", "post", "/api/walkthrough/reset")).status).toBe(200);
  await page.goto("/sim");
  await page.getByTestId("tree-AHU-02-FAN-01").click();
  await page.getByTestId("tab-asset").click();
  await page.getByTestId("asset-inject").click();

  // the film dressing comes on and the Process tab pins "where are we" above the cards
  await expect(page.getByTestId("cine")).toHaveAttribute("data-on", "true", { timeout: 30_000 });
  await expect(page.getByTestId("cine-caption")).toBeVisible();
  await expect(page.getByTestId("wt-now")).toBeVisible();
  // the building tree folds away for the run, so the 3D view has the room
  expect(await twin(page, (w) => w.__twin.ui.getState().leftPanelOpen)).toBe(false);

  // the live card explains itself: what, why it matters, where to look
  await expect(page.getByTestId("wt-explain")).toContainText("Why it matters");
  await expect(page.getByTestId("wt-explain")).toContainText("In the 3D view");

  // the walk: the camera trails the technician, the route tracker moves, the ring marks the worker
  await expect(page.getByTestId("wt-journey")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("wt-journey").locator("li").first()).toContainText("Crew room");
  await expect(page.getByTestId("wt-journey")).toContainText("Glass lift");
  await expect(page.getByTestId("wt-journey")).toContainText("AHU-02 supply fan");
  expect(await twin(page, (w) => w.__twin.ui.getState().following)).toMatch(/^TECH-/);
  expect(await twin(page, (w) => w.__twin.ui.getState().cinematic)).toBe(true);

  // then the repair: each step is explained and the live one has its own progress
  await expect(page.getByTestId("wt-repair")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("wt-repair").locator("[data-state=now]")).toHaveCount(1);

  // after the last step the tree comes back and the film dressing goes away
  await expect(page.getByTestId("wt-start")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId("cine")).toHaveAttribute("data-on", "false");
  expect(await twin(page, (w) => w.__twin.ui.getState().leftPanelOpen)).toBe(true);
  expect(errors, errors.join("\n")).toEqual([]);
});
