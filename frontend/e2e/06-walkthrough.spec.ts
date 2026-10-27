import { expect, test } from "@playwright/test";
import { API, call, twin, watchErrors } from "./helpers";

/** The step-by-step client demo: one anomaly, one click per step, Kishore walked to his desk with the keyboard. */
test("walkthrough: seven clicks take one anomaly from sensor to closed work order, Kishore approves from his desk", async ({ page, request }) => {
  test.setTimeout(420_000);
  const errors = watchErrors(page);
  expect((await call(request, "operator", "post", "/api/walkthrough/reset")).status).toBe(200);

  await page.goto("/sim");
  await page.getByTestId("watch-demo").click();
  await expect(page.getByTestId("process-panel")).toBeVisible();
  await page.getByTestId("wt-mode-manual").click(); // one click per step (the default plays by itself)
  await page.getByTestId("wt-start").click();
  await expect(page.getByTestId("wt-step-1")).toHaveAttribute("data-state", "next", { timeout: 60_000 });

  const doStep = async (n: number) => {
    await page.getByTestId("wt-next").click();
    await expect(page.getByTestId(`wt-step-${n}`)).toHaveAttribute("data-state", "done", { timeout: 180_000 });
  };

  // 1 · duplicate check: every sensor shows its dropped copy
  await doStep(1);
  await expect(page.getByTestId("wt-step-1")).toContainText("copy dropped");
  // 2 · anomaly found; the wording stays "possible", never "failed"
  await doStep(2);
  const explanation = (await page.getByTestId("wt-explanation").innerText()).toLowerCase();
  expect(explanation).not.toContain("failed");
  // 3 · risk and exactly one work order
  await doStep(3);
  await expect(page.getByTestId("wt-step-3")).toContainText("0 duplicates");

  // 4 · Kishore: WASD really moves him, walls and desks stop him, and sitting at the desk approves the job
  await page.getByTestId("wt-control-kishore").click();
  await expect(page.getByTestId("player-hud")).toBeVisible();
  const start = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z, level: w.__twin.player.level }));
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
  const wall = await twin(page, (w) => ({ x: w.__twin.player.x, z: w.__twin.player.z }));
  // he starts in the car park and can walk the city, but never beyond its edge
  expect(Math.abs(wall.x)).toBeLessThanOrEqual(247);
  expect(Math.abs(wall.z)).toBeLessThanOrEqual(247);

  await page.getByRole("button", { name: "Jump to desk" }).click();
  await expect(page.getByTestId("player-prompt")).toContainText("sit at the BMS desk");
  await page.keyboard.press("e");
  await expect(page.getByTestId("wt-step-4")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
  await expect(page.getByTestId("wt-step-4")).toContainText("refused");
  const approvals = await call(request, "admin", "get", "/api/audit-logs?limit=200");
  expect(approvals.body.items.some((a: any) => a.action === "wo.approve" && a.username === "supervisor" && a.outcome === "ALLOWED")).toBe(true);

  // 5–7 · dispatch, the technician repairs, an independent check closes it
  await doStep(5);
  await doStep(6);
  await doStep(7);
  await expect(page.getByTestId("wt-step-7")).toContainText("Work order closed");

  const state = await (await request.get(`${API}/api/walkthrough/state`)).json();
  expect(state.error).toBeNull();
  expect(state.stage).toBe(7);
  expect(state.results["3"].open_work_orders).toBe(1);
  expect(state.results["7"].outcome).toBe("CLOSED");
  expect(errors, errors.join("\n")).toEqual([]);
});
