import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * The fix4-plan review's minors, driven through the UI on the mock API as a person would:
 * the Outcomes inspector's eyebrow (qa-plan-33), and Launches and Changelog keeping the Plan
 * tabs' title line, so the strip stands where it does on every Plan tab (qa-plan-25).
 */

const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function start(page: Page, scenario?: string) {
  if (scenario) await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), scenario);
  await login(page);
}

// protects=qa-plan-33: the Outcomes inspector names the kind only; fails_when=it reads
// "Outcome · selected"; no_claim=other inspectors (fix4-plan-main covers the Plan's).
test("qa-plan-33: the Outcomes inspector's eyebrow says Outcome, not 'Outcome · selected'", async ({ page }) => {
  await start(page, "outcomes");
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(/\/plan\/outcomes$/);
  await page.getByTestId("outcome-row").filter({ hasText: "Saved payment methods" }).click();
  const inspector = visible(page, "outcome-inspector");
  await expect(inspector).toContainText("Saved payment methods");
  await expect(inspector).toContainText("Outcome");
  await expect(inspector).not.toContainText("· selected");
});

// protects=qa-plan-25: Launches and Changelog have the Plan tabs' 40 px title line, so the title
// and what is under it do not move when a person switches between them; fails_when=their title
// line is 32 px against the Plan tabs' 40; no_claim=phones (the title line is not padded there).
test("qa-plan-25: the title line is one height on Plan, Dates, Launches and Changelog", async ({ page }) => {
  await start(page);
  await page.goto("/plan");
  const title = () => page.locator("header[data-page-header] > h1").filter({ visible: true }).first();
  const line = async () => (await title().boundingBox())!;
  await expect(title()).toBeVisible();
  const plan = await line();
  expect(plan.height).toBeGreaterThanOrEqual(39);
  await visible(page, "plan-tabs").getByTestId("plan-tab-dates").click();
  await expect(page).toHaveURL(/\/plan\/dates$/);
  for (const name of ["Launches", "Changelog"]) {
    await visible(page, "plan-links").getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/roadmap/${name.toLowerCase()}$`));
    await expect(title()).toBeVisible();
    const l = await line();
    expect(Math.abs(l.height - plan.height), `${name}'s title line`).toBeLessThanOrEqual(1);
    expect(Math.abs(l.y - plan.y), `${name}'s title`).toBeLessThanOrEqual(1);
  }
});
