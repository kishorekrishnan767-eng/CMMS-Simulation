import { expect, test } from "@playwright/test";
import { twin, watchErrors } from "./helpers";

/**
 * Kishore on foot. The one-minute anomaly run no longer waits for him to walk to his desk (he approves by
 * himself), but you can still take his eyes: W A S D really move him, the city edge stops him, and he can
 * sit at his BMS desk.
 */
test("Kishore: W A S D move him, the city edge holds him, and he can sit at his BMS desk", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await page.goto("/sim");
  await page.waitForTimeout(3000);
  await page.getByTestId("control-kishore-left").click();
  await expect(page.getByTestId("player-hud")).toBeVisible();
  const start = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z }));
  await page.keyboard.down("d"); // strafe: he starts in the car park facing his car, so straight ahead is blocked
  await expect
    .poll(async () => {
      const p = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z }));
      return Math.hypot(p.x - start.x, p.z - start.z);
    }, { timeout: 20_000 })
    .toBeGreaterThan(1.5);
  // keep holding the key: the city's blocks and curbs stop him
  await page.waitForTimeout(8000);
  await page.keyboard.up("d");
  const moved = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z }));
  expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(1.5);
  // he can walk the city, but never beyond its edge
  expect(Math.abs(moved.x)).toBeLessThanOrEqual(247);
  expect(Math.abs(moved.z)).toBeLessThanOrEqual(247);

  await page.getByRole("button", { name: "Jump to desk" }).click();
  await expect(page.getByTestId("player-prompt")).toContainText("sit at the BMS desk");
  await page.keyboard.press("e");
  await expect.poll(() => twin(page, (w) => w.__twin.playerUi.getState().seated), { timeout: 20_000 }).toBe(true);
  expect(errors, errors.join("\n")).toEqual([]);
});
