import { expect, test, type Page } from "@playwright/test";
import { call, step, twin, watchErrors } from "./helpers";

/** The golden incident, observed through the browser while the backend does the real work. */
test.describe.serial("golden incident on AHU-02-FAN-01", () => {
  let woId = 0;
  let woNumber = "";
  let incident = "";
  let page: Page;
  let errors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    errors = watchErrors(page);
    await page.goto("/sim?asset=AHU-02-FAN-01");
    await expect(page.getByTestId("asset-panel")).toBeVisible();
  });
  test.afterAll(async () => {
    expect(errors, errors.join("\n")).toEqual([]);
    await page.close();
  });

  const tag = (id: string) => page.getByTestId(`tech-${id}`).locator(".tech-tag-text");

  test("DoD-4 / DoD-15: bearing wear is detected with evidence, and the ribbon pulses in order", async ({ request }) => {
    const before = await twin(page, (w) => ({ ...w.__twin.live.getState().layerCounts }));
    await call(request, "operator", "post", "/api/simulation/faults", { asset_id: "AHU-02-FAN-01", fault_type: "bearing_wear" });
    for (let i = 0; i < 70; i++) {
      await step(request, 1);
      if (i % 10 === 9 && (await page.getByTestId("evidence-card").count())) break;
    }
    await expect(page.getByTestId("evidence-card")).toBeVisible();
    const text = await page.getByTestId("anomaly-explanation").innerText();
    expect(text).toContain("consistent with possible bearing degradation");
    expect(text.toLowerCase()).not.toContain("fail");
    await expect(page.getByTestId("chip-AHU-02-FAN-01").locator(".dot-anomaly")).toBeVisible();
    await expect(page.getByTestId("floor-badge-6")).toContainText("anomaly");
    const anomalies = await call(request, "operator", "get", "/api/anomalies?state=ACTIVE");
    incident = anomalies.body.items[0].incident_id;
    expect(anomalies.body.items[0].z).toBeGreaterThan(3.5);
    expect(anomalies.body.items[0].observed_value).toBeLessThan(7.1); // detected before the alarm limit
    // ribbon: layers 2 and 3 pulse with telemetry; first occurrence of 2 → 4 → 5 → 6… is in pipeline order
    const after = await twin(page, (w) => ({ ...w.__twin.live.getState().layerCounts }));
    for (const l of [2, 3, 4, 5]) expect(after[l]).toBeGreaterThan(before[l]);
    const seq: number[] = await twin(page, (w) => w.__twin.live.getState().layerSequence.map((s: any) => s.layer));
    const first = (l: number) => seq.indexOf(l);
    expect(first(2)).toBeGreaterThanOrEqual(0);
    expect(first(2)).toBeLessThan(first(4));
    expect(first(4)).toBeLessThan(first(5));
    await expect(page.getByTestId("layer-5")).toHaveAttribute("data-count", /[1-9]/);
  });

  test("DoD-5: exactly one draft work order; later alerts attach as evidence", async ({ request }) => {
    for (let i = 0; i < 25; i++) await step(request, 1);
    const wos = await call(request, "operator", "get", "/api/work-orders");
    expect(wos.body.items).toHaveLength(1);
    woId = wos.body.items[0].id;
    woNumber = wos.body.items[0].number;
    const detail = await call(request, "operator", "get", `/api/work-orders/${woId}`);
    expect(detail.body.status).toBe("DRAFT");
    expect(detail.body.evidence.length).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId(`pin-${woNumber}`)).toHaveAttribute("data-status", "DRAFT");
    await expect(page.getByTestId("wo-link")).toContainText(woNumber);
  });

  test("DoD-6: the operator is denied by the backend (403, audited); the supervisor approves", async ({ request }) => {
    await page.goto(`/cmms?wo=${woId}`);
    await expect(page.getByTestId("wo-drawer")).toBeVisible();
    await page.getByRole("button", { name: /Try any action/ }).click();
    await page.getByTestId("try-approve").click();
    await expect(page.getByTestId("toasts")).toContainText("Denied by the backend (403)");
    const denied = await call(request, "admin", "get", "/api/audit-logs?outcome=DENIED&action=wo.approve");
    expect(denied.body.items[0]).toMatchObject({ username: "operator", outcome: "DENIED", target_id: woNumber });
    // role switch through the UI, then approve with the real button
    await page.getByTestId("role-switcher").click();
    await page.getByTestId("login-supervisor").click();
    await expect(page.getByTestId("act-approve")).toBeVisible();
    await page.getByTestId("act-approve").click();
    await expect(page.getByTestId("wo-drawer").getByText("OPEN", { exact: true }).first()).toBeVisible();
    const wo = await call(request, "supervisor", "get", `/api/work-orders/${woId}`);
    expect(wo.body.status).toBe("OPEN");
  });

  test("DoD-7 / DoD-8: dispatch ranks eligible technicians, rejects the ineligible one, reserves parts", async ({ request }) => {
    await expect(page.getByTestId("dispatch-candidates")).toBeVisible();
    await expect(page.getByTestId("cand-TECH-03")).toContainText("Ineligible");
    await page.getByTestId("assign-TECH-03").click();
    await expect(page.getByTestId("toasts")).toContainText("409");
    await page.getByTestId("assign-TECH-01").click();
    await expect(page.getByTestId("wo-drawer")).toContainText("ASSIGNED");
    const wo = await call(request, "supervisor", "get", `/api/work-orders/${woId}`);
    expect(wo.body.status).toBe("ASSIGNED");
    expect(wo.body.parts.map((p: any) => [p.sku, p.reserved])).toEqual(expect.arrayContaining([["BRG-001", 1], ["GRS-001", 1]]));
  });

  test("DoD-9: the technician avatar walks to the fan, works, and the work-order pin changes state live", async ({ request }) => {
    await page.goto("/sim?asset=AHU-02-FAN-01");
    await expect(page.getByTestId(`pin-${woNumber}`)).toHaveAttribute("data-status", "ASSIGNED");
    for (let i = 0; i < 6; i++) await step(request, 1);
    await expect(tag("TECH-01")).toHaveAttribute("data-phase", "walking");
    await expect(tag("TECH-01")).toContainText("walking to AHU-02-FAN-01");
    for (let i = 0; i < 12; i++) await step(request, 1);
    const started = await call(request, "tech1", "post", `/api/work-orders/${woId}/start`);
    expect(started.status).toBe(200);
    await step(request, 2);
    await expect(page.getByTestId(`pin-${woNumber}`)).toHaveAttribute("data-status", "IN_PROGRESS");
    await expect(tag("TECH-01")).toHaveAttribute("data-phase", "working");
    await page.screenshot({ path: "../artifacts/dod9-technician-working.png" });
    await step(request, 8);
    const done = await call(request, "tech1", "post", `/api/work-orders/${woId}/complete`, {
      findings: "Bearing replaced and re-greased.", parts_used: [{ sku: "BRG-001", quantity: 1 }, { sku: "GRS-001", quantity: 1 }],
      checklist: { lockout_tagout: true },
    });
    expect(done.status).toBe(200);
    await step(request, 1);
    await expect(page.getByTestId(`pin-${woNumber}`)).toHaveAttribute("data-status", "COMPLETED");
  });

  test("DoD-10: the technician cannot verify own work; verifier passes; closure clears the anomaly", async ({ request }) => {
    for (let i = 0; i < 70; i += 5) {
      const v = await call(request, "operator", "get", `/api/work-orders/${woId}/verification`);
      if (v.body.ready) break;
      await step(request, 5);
    }
    const sod = await call(request, "tech1", "post", `/api/work-orders/${woId}/verify`, { outcome: "pass" });
    expect(sod.status).toBe(403);
    expect(sod.body.error.code).toBe("separation_of_duties");
    const ok = await call(request, "verifier", "post", `/api/work-orders/${woId}/verify`, { outcome: "auto" });
    expect(ok.body.status).toBe("VERIFIED");
    await expect(page.getByTestId(`pin-${woNumber}`)).toHaveAttribute("data-status", "VERIFIED");
    const closed = await call(request, "supervisor", "post", `/api/work-orders/${woId}/close`, {
      checklist: { work_verified: true, area_safe_and_clean: true, documentation_complete: true, parts_reconciled: true },
    });
    expect(closed.body.status).toBe("CLOSED");
    const a = await call(request, "operator", "get", "/api/anomalies");
    expect(a.body.items[0].state).toBe("CLEARED");
    await expect(page.getByTestId(`pin-${woNumber}`)).toHaveAttribute("data-status", "CLOSED");
    // the ribbon saw layers 6 and 7 after 4 and 5
    const seq: number[] = await twin(page, (w) => w.__twin.live.getState().layerSequence.map((s: any) => s.layer));
    expect(seq.indexOf(7)).toBeGreaterThan(seq.indexOf(6));
    expect(seq.indexOf(6)).toBeGreaterThan(seq.indexOf(5));
  });

  test("DoD-15: the incident timeline shows the whole journey by correlation id", async ({ request }) => {
    await page.goto("/pipeline");
    await expect(page.getByTestId("timeline-items")).toBeVisible();
    const items = page.getByTestId("timeline-items").locator("li");
    await expect(items.first()).toContainText("Fault injected");
    const types = await items.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.type));
    for (const t of ["AnomalyDetected", "RiskAssessed", "WorkOrderDrafted", "WorkOrderApproved", "TechnicianAssigned", "WorkStarted", "WorkCompleted", "VerificationPassed", "WorkOrderClosed", "AnomalyCleared"]) expect(types).toContain(t);
    const order = (t: string) => types.indexOf(t);
    expect(order("AnomalyDetected")).toBeLessThan(order("WorkOrderDrafted"));
    expect(order("WorkOrderDrafted")).toBeLessThan(order("WorkOrderApproved"));
    expect(order("WorkCompleted")).toBeLessThan(order("VerificationPassed"));
    expect(order("VerificationPassed")).toBeLessThan(order("AnomalyCleared"));
    expect(incident).toMatch(/^INC-/);
    await page.screenshot({ path: "../artifacts/dod15-timeline.png", fullPage: true });
  });
});
