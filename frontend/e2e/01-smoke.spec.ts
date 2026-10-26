import { expect, test } from "@playwright/test";
import { API, call, watchErrors } from "./helpers";

test("DoD-1 seed building, the golden fan and its sensors are present", async ({ request }) => {
  const tree = await (await request.get(`${API}/api/buildings/TOWER-A/tree`)).json();
  expect(tree.name).toBe("Livewire Digital Solutions");
  expect(tree.floors.map((f: any) => f.level)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6]);
  const ids = tree.floors.flatMap((f: any) => f.assets.map((a: any) => a.id));
  expect(ids).toEqual(expect.arrayContaining(["AHU-02-FAN-01", "AHU-01-FAN-01", "AHU-03-FAN-01", "CHILLER-01", "CHW-PUMP-01", "CHW-PUMP-02", "EXH-FAN-01", "FCU-03-01"]));
  const fan = await (await request.get(`${API}/api/assets/AHU-02-FAN-01`)).json();
  expect(fan.sensors.map((s: any) => s.kind).sort()).toEqual(["CUR", "SPD", "TMP", "VIB"]);
  expect(fan.simulated).toBe(true);
});

const PAGES: [string, string][] = [
  ["/", "launch-sim"], ["/sim", "sim-page"], ["/pipeline", "layer-section-3"], ["/cmms", "kanban"], ["/dispatch", "roster"],
  ["/inventory", "stock-table"], ["/analytics", "kpis"], ["/audit", "dead-letters"], ["/control", "ctl-toggle"], ["/about", "simulated-badge"],
];

for (const [path, marker] of PAGES) {
  test(`every page renders with live data and no console errors: ${path}`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(path);
    await expect(page.getByTestId("simulated-badge").first()).toBeVisible();
    if (path === "/cmms") {
      // empty state is acceptable before any incident exists
      await expect(page.getByText("No work orders yet").or(page.getByTestId(marker))).toBeVisible();
    } else if (path === "/audit") {
      await expect(page.getByTestId(marker)).toBeVisible();
    } else {
      await expect(page.getByTestId(marker).first()).toBeVisible();
    }
    if (path === "/sim") {
      await expect(page.locator("canvas").first()).toBeVisible();
      await expect(page.getByTestId("layer-ribbon")).toBeVisible();
      await expect(page.getByTestId("sim-clock")).toContainText("2026-03-02");
    }
    await page.waitForTimeout(1200);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("header: SIMULATED badge, sim clock, speed control and role switcher", async ({ page, request }) => {
  await page.goto("/sim");
  await expect(page.getByTestId("sim-controls")).toBeVisible();
  await page.getByTestId("role-switcher").click();
  for (const u of ["admin", "operator", "supervisor", "tech1", "tech2", "tech3", "verifier"]) await expect(page.getByTestId(`login-${u}`)).toBeVisible();
  await page.getByTestId("login-supervisor").click();
  await expect(page.getByTestId("role-switcher")).toContainText("SUPERVISOR");
  const me = await call(request, "supervisor", "get", "/api/me");
  expect(me.body.role).toBe("SUPERVISOR");
});

test("validation (DoD-3) through the UI-visible control page: every bad reading is recorded with a reason", async ({ request, page }) => {
  for (const f of [["duplicate", "VIB-001"], ["bad_unit", "TMP-001"], ["unknown_sensor", null], ["late_event", "CUR-001"]] as const) {
    const r = await call(request, "operator", "post", "/api/simulation/faults", { asset_id: "AHU-01-FAN-01", fault_type: f[0], sensor_id: f[0] === "duplicate" ? "VIB-002" : f[0] === "bad_unit" ? "TMP-002" : f[0] === "late_event" ? "CUR-002" : null });
    expect(r.status).toBe(200);
  }
  await call(request, "operator", "post", "/api/simulation/step?minutes=2");
  await page.goto("/control");
  const table = page.getByTestId("rejected-table");
  await expect(table).toBeVisible();
  for (const reason of ["DUPLICATE", "UNIT_MISMATCH", "UNKNOWN_SENSOR", "LATE_EVENT"]) await expect(table).toContainText(reason);
});
