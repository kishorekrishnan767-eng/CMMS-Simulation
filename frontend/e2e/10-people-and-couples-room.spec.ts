import { expect, test } from "@playwright/test";
import { watchErrors } from "./helpers";

/** Prasath, Vaseem and Yasar are spelled the way their owners spell them; Vaseem and Yasar share the Couples room. */
test("the team: Prasath, Vaseem, Yasar, Kishore, Guru and Mano, and the Couples room on Floor 1", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sim");
  await expect(page.getByTestId("people-list")).toBeVisible();
  const list = await page.getByTestId("people-list").innerText();
  for (const name of ["Prasath", "Vaseem", "Yasar", "Kishore", "Guru", "Mano"]) expect(list).toContain(name);
  expect(list).not.toContain("Yasir");
  expect(list).not.toContain("Prasad");
  // they are all in the scene, each at their desk
  await expect(page.getByTestId("emp-EMP-PRASATH")).toBeAttached();
  await expect(page.getByTestId("emp-EMP-YASAR")).toBeAttached();
  await expect(page.getByTestId("emp-EMP-VASEEM")).toBeAttached();
  // Vaseem and Yasar sit inside the Couples room (Floor 1, south-east), side by side, apart from everyone else
  const seats = await page.evaluate(async () => {
    const url = "/src/three/office.ts"; // served by Vite; resolved in the browser, not by tsc
    const m = await import(/* @vite-ignore */ url);
    const r = m.COUPLES_ROOM;
    const inside = (e: { seat: { level: number; sx: number; sz: number } }) => e.seat.level === 1 && e.seat.sx > r.x0 && e.seat.sx < r.x1 && e.seat.sz > r.z0 && e.seat.sz < r.z1;
    return {
      inRoom: m.EMPLOYEES.filter(inside).map((e: { name: string }) => e.name).sort(),
      route: m.routeToDesk(m.EMPLOYEES.find((e: { name: string }) => e.name === "Yasar")!).length,
    };
  });
  expect(seats.inRoom).toEqual(["Vaseem", "Yasar"]);
  expect(seats.route).toBeGreaterThan(10);
  expect(errors, errors.join("\n")).toEqual([]);
});
