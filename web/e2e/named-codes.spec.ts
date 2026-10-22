import { expect, test, type Page } from "@playwright/test";

import { login, openSection, outlineRow } from "./helpers";

/*
 * #306 Named codes (owner, 2026-10-22): agents name the codes they write. In the
 * "suggestions" mock, the drafted fleet PRD (fleet-next v2) has a Delivery plan whose
 * milestone sections are titled with their dates, and lists the features each one ships,
 * one per line with its name. The outline and Previous/Next show the same titles.
 */
const DOC = "/documents/fleet-next/v/2";
const M1 = "M1 · Oct 19 – Nov 13";
const M2 = "M2 · Nov 16 – Dec 11";

async function fleet(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "suggestions"));
  await login(page);
  await page.goto(DOC);
}

test("a milestone reads with its dates, and its codes as a named list", async ({ page }) => {
  await fleet(page);

  // The outline names the milestone by its dated title.
  await expect(outlineRow(page, "m1")).toContainText(M1);
  const m1 = await openSection(page, "m1");
  await expect(m1.getByRole("heading", { name: M1 })).toBeVisible();

  // Three codes are a list, one per line, each with its name.
  const shipped = m1.getByRole("listitem");
  await expect(shipped).toHaveText(["F-31 Route planner", "F-32 Live arrival times", "F-33 Proof of delivery"]);

  // Previous/Next carry the same titles.
  const next = page.getByRole("link", { name: `Next section: ${M2}` }).filter({ visible: true });
  await expect(next).toBeVisible();
  await next.click();
  await expect(outlineRow(page, "m2")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("link", { name: `Previous section: ${M1}` }).filter({ visible: true })).toBeVisible();
});
