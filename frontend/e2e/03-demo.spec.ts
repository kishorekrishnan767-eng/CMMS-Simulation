import { expect, test } from "@playwright/test";
import { API, watchErrors } from "./helpers";

test("DoD-16: the guided demo plays all 10 steps through the UI with no manual fixes and no console errors", async ({ page, request }) => {
  test.setTimeout(540_000);
  const errors = watchErrors(page);
  await page.goto("/sim?demo=1");
  const director = page.getByTestId("demo-director");
  await expect(director).toBeVisible();
  await page.getByTestId("demo-autoplay").click();
  // follow along: the caption of each step appears in the UI
  const seen = new Set<string>();
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    const title = await page.getByTestId("demo-title").innerText().catch(() => "");
    if (title) seen.add(title.split("Layer")[0].trim());
    if (await page.getByTestId("demo-finish").count()) break;
    await page.waitForTimeout(700);
  }
  await expect(page.getByTestId("demo-finish")).toBeVisible();
  expect(seen.size).toBeGreaterThanOrEqual(8); // captions observed live (some steps are short)
  const state = await (await request.get(`${API}/api/demo/state`)).json();
  expect(state.step).toBe(10);
  expect(state.error).toBeNull();
  const r = state.results;
  expect(r["5"].denied.status_code).toBe(403);
  expect(r["8"].separation_of_duties.code).toBe("separation_of_duties");
  expect(r["9"].first_outcome).toBe("REWORK_REQUIRED");
  expect(r["9"].second_outcome).toBe("VERIFIED");
  expect(r["9"].final).toBe("CLOSED");
  expect(r["10"].maintenance.closed).toBe(2);
  await page.screenshot({ path: "../artifacts/dod16-demo-finished.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});
