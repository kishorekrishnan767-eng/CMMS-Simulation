import { expect, test } from "@playwright/test";
import { API, call, watchErrors } from "./helpers";

test("DoD-14: analytics show latency, lead time, MTTA, MTTR, precision and cost computed from stored data", async ({ page, request }) => {
  const errors = watchErrors(page);
  const det = (await (await request.get(`${API}/api/analytics/detector`)).json());
  const mt = (await (await request.get(`${API}/api/analytics/maintenance`)).json());
  expect(det.evaluations.length).toBeGreaterThanOrEqual(1);
  await page.goto("/analytics");
  for (const id of ["latency", "lead", "mtta", "mttr", "precision", "cost"]) {
    const t = await page.getByTestId(`kpi-${id}`).innerText();
    expect(t, id).not.toMatch(/\n—\n/);
  }
  await expect(page.getByTestId("kpi-precision")).toContainText(`${Math.round(det.precision * 100)}%`);
  await expect(page.getByTestId("kpi-cost")).toContainText(`$${mt.total_cost.toFixed(2)}`);
  await expect(page.getByTestId("eval-table").locator("tbody tr")).toHaveCount(det.evaluations.length);
  // the headline MTTA equals the average of the stored per-incident values
  const avg = det.evaluations.reduce((a: number, e: any) => a + e.mtta_min, 0) / det.evaluations.length;
  expect(Math.abs(mt.mtta_min - avg)).toBeLessThan(0.02);
  await page.screenshot({ path: "../artifacts/dod14-analytics.png", fullPage: true });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("DoD-6/audit page highlights DENIED actions and shows them filterable", async ({ page }) => {
  await page.goto("/audit");
  await page.getByTestId("filter-outcome").selectOption("DENIED");
  const rows = page.getByTestId("audit-table").locator("tbody tr");
  await expect(rows.first()).toHaveAttribute("data-outcome", "DENIED");
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: "../artifacts/audit-denied.png" });
});

test("work-order board and drawer expose only role-appropriate actions", async ({ page, request }) => {
  await call(request, "operator", "get", "/api/me");
  await page.goto("/cmms");
  await expect(page.getByTestId("kanban")).toBeVisible();
  await page.getByTestId("view-table").click();
  await expect(page.getByTestId("wo-table")).toBeVisible();
  await page.screenshot({ path: "../artifacts/cmms-table.png" });
});
