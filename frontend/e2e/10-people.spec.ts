import { expect, test } from "@playwright/test";
import { watchErrors } from "./helpers";

/** Prasath, Vaseem and Yasar are spelled the way their owners spell them. */
test("the team: Prasath, Vaseem, Yasar, Kishore, Guru and Mano", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sim");
  await expect(page.getByTestId("people-list")).toBeVisible();
  const list = await page.getByTestId("people-list").innerText();
  for (const name of ["Prasath", "Vaseem", "Yasar", "Kishore", "Guru", "Mano"]) expect(list).toContain(name);
  expect(list).not.toContain("Yasir");
  expect(list).not.toContain("Prasad");
  // they are all in the scene, each at a desk of the open Floor 1 office (no hearts, no separate room)
  for (const id of ["EMP-PRASATH", "EMP-VASEEM", "EMP-YASAR"]) {
    await expect(page.getByTestId(`emp-${id}`)).toBeAttached();
    await expect(page.getByTestId(`emp-${id}`).locator(".hearts")).toHaveCount(0);
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
