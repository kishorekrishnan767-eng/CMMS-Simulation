import { expect, test } from "@playwright/test";
import { API, call, twin, watchErrors } from "./helpers";

test("an anomaly injected from the Machine tab plays the whole demonstration by itself", async ({ page, request }) => {
  test.setTimeout(540_000);
  const errors = watchErrors(page);
  expect((await call(request, "operator", "post", "/api/walkthrough/reset")).status).toBe(200);
  await page.goto("/sim");
  // nobody is "not in yet": the product has no working day
  await expect(page.getByTestId("people-list")).not.toContainText("not in yet");
  await page.getByTestId("role-switcher").click();
  await page.getByTestId("login-operator").click();
  await page.getByTestId("tree-AHU-02-FAN-01").click();
  await page.getByTestId("tab-asset").click();
  await page.getByTestId("asset-inject").click();

  // the right-hand tab switches to the process by itself and shows every step
  await expect(page.getByTestId("process-panel")).toBeVisible();
  await expect(page.getByTestId("wt-steps")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("wt-step-7")).toBeVisible();
  // no clicks from here on: every step must finish on its own, in order
  await expect(page.getByTestId("wt-step-7")).toHaveAttribute("data-state", "done", { timeout: 480_000 });
  for (let n = 1; n <= 7; n++) await expect(page.getByTestId(`wt-step-${n}`)).toHaveAttribute("data-state", "done");

  const state = await (await request.get(`${API}/api/walkthrough/state`)).json();
  expect(state.error).toBeNull();
  expect(state.results["3"].open_work_orders).toBe(1);
  expect(state.results["7"].outcome).toBe("CLOSED");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("first person: the camera is Kishore's eyes, the mouse looks around and W A S D move relative to the view", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await page.goto("/sim");
  await page.waitForTimeout(3000);
  await page.getByTestId("control-kishore-left").click();
  await expect(page.getByTestId("player-hud")).toBeVisible();
  await expect.poll(() => twin(page, (w) => w.__twin.camera.fov), { timeout: 30_000 }).toBeGreaterThan(60);
  // his own body is not drawn
  const eyeY = await twin(page, (w) => w.__twin.camera.position.y);
  expect(eyeY).toBeGreaterThan(1.4);
  expect(eyeY).toBeLessThan(2);

  // drag the mouse: he turns
  const yaw0 = await twin(page, (w) => w.__twin.player.yaw);
  const box = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const yaw1 = await twin(page, (w) => w.__twin.player.yaw);
  expect(Math.abs(yaw1 - yaw0)).toBeGreaterThan(0.3);

  // walk forward: the direction he moves is the direction he looks
  const before = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z, yaw: w.__twin.player.yaw }));
  await page.keyboard.down("a"); // strafe left of the new view (free space; straight ahead may be his car)
  await expect
    .poll(async () => {
      const p = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z }));
      return Math.hypot(p.x - before.x, p.z - before.z);
    }, { timeout: 30_000 })
    .toBeGreaterThan(1.5);
  await page.keyboard.up("a");
  const after = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z }));
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const left = [Math.cos(before.yaw), -Math.sin(before.yaw)]; // the walker's left
  const cos = (dx * left[0] + dz * left[1]) / Math.hypot(dx, dz);
  expect(cos).toBeGreaterThan(0.9);

  // Esc gives the camera back
  await page.keyboard.press("Escape");
  await expect.poll(() => twin(page, (w) => w.__twin.camera.fov), { timeout: 30_000 }).toBeLessThan(50);
  expect(errors, errors.join("\n")).toEqual([]);
});
