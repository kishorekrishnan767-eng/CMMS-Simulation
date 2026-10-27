import { test } from "@playwright/test";
import { twin } from "./helpers";

test("dbg", async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto("/sim");
  await page.waitForTimeout(3000);
  await page.getByTestId("tree-CHILLER-01").click();
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(2000);
    console.log("T", i, JSON.stringify(await twin(page, (w) => ({ cut: w.__twin.ui.getState().cutaway, fly: w.__twin.camState.flying, goal: w.__twin.ui.getState().cameraGoal.preset, cam: w.__twin.camera.position.toArray().map((n: number) => +n.toFixed(0)), tgt: w.__twin.controls.target.toArray().map((n: number) => +n.toFixed(0)), fps: w.__twin.ui.getState().fps, foll: w.__twin.ui.getState().following }))));
  }
});
