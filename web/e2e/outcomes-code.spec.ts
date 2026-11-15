import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * outcomes-code: Outcomes names each roadmap item as every other page does, its Ground Truth
 * code before its title ("F-21 Saved payment methods"), in the Item column and the side panel's
 * header; an item with no code keeps its name with the "Not in the Ground Truth" flag. On the
 * mock API ("outcomes" scenario, synthetic: Saved payment methods is F-21, Order status emails
 * has no code, the earlier bets are of no roadmap item).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function openOutcomes(page: Page, scenario = "outcomes") {
  await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), scenario);
  await login(page);
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(/\/plan\/outcomes$/);
  // Every outcome, the measuring and the assessed ones too (a scenario with none shows neither table nor filters).
  if (scenario !== "outcomes") return;
  await expect(page.getByTestId("outcomes-table")).toBeVisible();
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });

test("the Item column and the panel show the item's code before its title", async ({ page }) => {
  // protects=a coded item reads "F-21 Saved payment methods" in its row and in the panel's
  // header, the code first; fails_when=the title shows alone or the code comes after it;
  // no_claim=how the API finds the code (its pytest).
  await openOutcomes(page);
  const saved = row(page, "Saved payment methods");
  await expect(saved.locator(".simple-code")).toHaveText("F-21");
  await expect(saved).toContainText("F-21 Saved payment methods");
  await expect(saved.getByTestId("not-in-gt")).toHaveCount(0);

  await saved.click();
  const header = inspector(page).getByRole("heading").first();
  await expect(header.locator(".simple-code")).toHaveText("F-21");
  await expect(header).toHaveText(/^F-21\s+Saved payment methods$/);
  await expect(inspector(page).getByTestId("not-in-gt")).toHaveCount(0);
});

test("the Track outcome form's Item picker names each item by its code and name", async ({ page }) => {
  // protects=the Item picker lists a coded item as "F-31 Alert routing by team" (the code once;
  // the "plan-section-code" scenario) and flags each uncoded one ("Threshold alerts on spend ·
  // Not in the Ground Truth"), as the table names them; fails_when=an option shows its title
  // alone; no_claim=which code an item has (the API's pytest).
  await openOutcomes(page, "plan-section-code");
  await page.getByRole("button", { name: "Track outcome" }).click();
  const options = page.getByTestId("track-outcome-form").getByLabel("Item").locator("option:not([value=''])");
  await expect(options.first()).toBeAttached();
  const words = await options.allTextContents();
  expect(words).toContain("Threshold alerts on spend · Not in the Ground Truth");
  expect(words).toContain("F-31 Alert routing by team");
  for (const w of words) expect(w, `${w} reads its code or its flag`).toMatch(/^F-\d+[a-z]? (?!F-)\S| · Not in the Ground Truth$/);
});

test("an item with no code keeps its name and is flagged Not in the Ground Truth", async ({ page }) => {
  // protects=an uncoded roadmap item's outcome shows its name with the flag, in the row and the
  // panel, and an outcome of no roadmap item carries none; fails_when=the flag is missing, or
  // every outcome is flagged; no_claim=the flag's fixes (the Roadmap's).
  await openOutcomes(page);
  const emails = row(page, "Order status emails");
  await expect(emails.getByTestId("not-in-gt")).toBeVisible();
  await expect(emails.locator(".simple-code")).toHaveCount(0);
  await expect(row(page, "Earlier activation bet 1").getByTestId("not-in-gt")).toHaveCount(0);

  await emails.click();
  await expect(inspector(page).getByTestId("not-in-gt")).toBeVisible();
  await expect(inspector(page).getByRole("heading").first()).toHaveText(/^Order status emails/);
});

test("an outcome tracked for an item with no code is flagged at once", async ({ page }) => {
  // protects=a row Track outcome adds names its item as the API gives it: Threshold alerts on
  // spend has no code (its feature's key and its PRD section are none), so it is flagged in
  // the row and the panel; fails_when=the new row shows no flag; no_claim=a coded item's (above).
  await openOutcomes(page);
  await page.getByRole("button", { name: "Track outcome" }).click();
  const form = page.getByTestId("track-outcome-form");
  await form.getByLabel("Item").selectOption({ label: "Threshold alerts on spend · Not in the Ground Truth" });
  await form.getByLabel("Expected effect").fill("+5 weekly active teams");
  await form.getByLabel("Metric").fill("Weekly active teams");
  await form.getByRole("button", { name: "Track outcome" }).click();
  await expect(form).toHaveCount(0);
  const tracked = row(page, "Threshold alerts on spend");
  await expect(tracked.getByTestId("not-in-gt")).toBeVisible();
  await expect(tracked.locator(".simple-code")).toHaveCount(0);
  await tracked.click();
  await expect(inspector(page).getByRole("heading").first()).toHaveText(/^Threshold alerts on spend/);
  await expect(inspector(page).getByTestId("not-in-gt")).toBeVisible();
});

test("an item whose title leads with its code reads the code once", async ({ page }) => {
  // protects=Track outcome on "F-31 Alert routing by team" (the "plan-section-code" scenario:
  // its PRD section is f-31) names the row "F-31 Alert routing by team", the code once and not
  // flagged; fails_when="F-31 F-31 Alert routing by team" or the flag shows; no_claim=other codes.
  await openOutcomes(page, "plan-section-code");
  await page.getByRole("button", { name: "Track outcome" }).click();
  const form = page.getByTestId("track-outcome-form");
  await form.getByLabel("Item").selectOption({ label: "F-31 Alert routing by team" });
  await form.getByLabel("Goal").selectOption({ index: 1 });
  await form.getByLabel("Expected effect").fill("+5 weekly active teams");
  await form.getByLabel("Metric").fill("Weekly active teams");
  await form.getByRole("button", { name: "Track outcome" }).click();
  await expect(form).toHaveCount(0);
  const tracked = row(page, "Alert routing by team");
  await expect(tracked.locator(".simple-code")).toHaveText("F-31");
  await expect(tracked).not.toContainText("F-31 F-31");
  await expect(tracked.getByTestId("not-in-gt")).toHaveCount(0);
  await tracked.click();
  await expect(inspector(page).getByRole("heading").first()).toHaveText(/^F-31\s+Alert routing by team$/);
});
