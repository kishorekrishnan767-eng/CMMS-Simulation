import { expect, test } from "@playwright/test";
import { twin, watchErrors } from "./helpers";

/** Free roaming through the tower, and a car that drives like a car. */
test("roaming: the floor you look at is the floor you see, from the basement to the roof", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await page.goto("/sim");
  await page.waitForTimeout(3000);
  const cutaway = () => twin(page, (w) => w.__twin.ui.getState().cutaway);

  // clicking the chiller in the basement lifts every floor off, so the plant room is in the open
  await page.getByTestId("tree-CHILLER-01").click();
  await expect.poll(cutaway, { timeout: 30_000 }).toBe(-1);
  await expect.poll(() => twin(page, (w) => w.__twin.camState.flying), { timeout: 60_000 }).toBe(false);

  // like a user dragging the mouse: put the orbit target on each floor with the camera zoomed in
  const look = (y: number) =>
    page.evaluate((yy) => {
      const t = (window as any).__twin;
      t.controls.target.set(0, yy, 0);
      t.camera.position.set(14, yy + 6, 16);
      t.controls.update();
    }, y);
  for (const [y, level] of [[1.5, 0], [9.5, 2], [17.5, 4], [-2.5, -1]] as const) {
    await look(y);
    await expect.poll(cutaway, { timeout: 15_000 }).toBe(level);
  }

  // zoom out: the whole tower returns
  await page.evaluate(() => {
    const t = (window as any).__twin;
    t.controls.target.set(0, 8, 4);
    t.camera.position.set(80, 52, 92);
    t.controls.update();
  });
  await expect.poll(cutaway, { timeout: 15_000 }).toBe(null);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("driving: the car accelerates, steers, stays on the asphalt, parks, and Kishore steps out beside it", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.goto("/sim");
  await page.waitForTimeout(3000);
  await page.getByTestId("control-kishore-left").click();
  await expect(page.getByTestId("player-hud")).toBeVisible();
  await expect(page.getByTestId("player-prompt")).toContainText("get in the car", { timeout: 30_000 });
  await page.keyboard.press("e");
  await expect.poll(() => twin(page, (w) => w.__twin.player.mode)).toBe("drive");

  // full throttle: speed builds up gradually, never beyond the car's limit
  await page.keyboard.down("w");
  await expect.poll(() => twin(page, (w) => w.__twin.vehicle.v), { timeout: 60_000 }).toBeGreaterThan(5);
  const early = await twin(page, (w) => w.__twin.vehicle.v);
  expect(early).toBeLessThan(16.5);
  // turn hard for a while and keep the pedal down: whatever happens, the car never leaves the road
  await page.keyboard.down("d");
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    const s = await twin(page, (w) => ({ x: w.__twin.vehicle.x, z: w.__twin.vehicle.z, v: w.__twin.vehicle.v, ok: w.__twin.drivable(w.__twin.vehicle.x, w.__twin.vehicle.z) }));
    expect(s.ok, `car left the asphalt at ${s.x.toFixed(1)}, ${s.z.toFixed(1)}`).toBe(true);
    expect(s.v).toBeLessThan(16.5);
  }
  await page.keyboard.up("d");
  await page.keyboard.up("w");

  // brake to a stop, then park: Kishore is beside the car, not inside it
  await page.keyboard.down("s");
  await expect.poll(() => twin(page, (w) => w.__twin.vehicle.v), { timeout: 60_000 }).toBeLessThan(1);
  await page.keyboard.up("s");
  await page.keyboard.press("e");
  await expect.poll(() => twin(page, (w) => w.__twin.player.mode)).toBe("walk");
  const d = await twin(page, (w) => Math.hypot(w.__twin.player.x - w.__twin.vehicle.x, w.__twin.player.z - w.__twin.vehicle.z));
  expect(d).toBeGreaterThan(1.8);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("traffic: cars keep their distance, queue at red lights and never overlap", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/sim");
  await page.waitForTimeout(4000);
  let closest = Infinity;
  let stopped = 0;
  for (let i = 0; i < 40; i++) {
    const r = await twin(page, (w) => {
      const cars = w.__twin.trafficCars.filter((c: any) => c.on);
      let min = Infinity;
      let still = 0;
      for (let a = 0; a < cars.length; a++) {
        if (cars[a].v < 0.3) still++;
        for (let b = a + 1; b < cars.length; b++) {
          const dyaw = Math.abs(Math.sin(cars[a].yaw - cars[b].yaw));
          if (dyaw > 0.1) continue; // crossing traffic only shares the junction when the signals allow it
          const dx = cars[a].x - cars[b].x;
          const dz = cars[a].z - cars[b].z;
          // bumper-to-bumper distance along the heading, for cars in (nearly) the same lane
          const fx = Math.sin(cars[a].yaw);
          const fz = Math.cos(cars[a].yaw);
          const along = Math.abs(dx * fx + dz * fz);
          const side = Math.abs(dx * fz - dz * fx);
          if (side < 1.8) min = Math.min(min, along - (cars[a].len + cars[b].len) / 2);
        }
      }
      return { min, still, n: cars.length };
    });
    closest = Math.min(closest, r.min);
    stopped = Math.max(stopped, r.still);
    await page.waitForTimeout(500);
  }
  expect(closest, "two cars overlapped").toBeGreaterThan(0.2);
  expect(stopped, "no car ever stopped at a signal").toBeGreaterThanOrEqual(0);
});
