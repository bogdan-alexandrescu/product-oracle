import { expect, test, type Page } from "@playwright/test";

import { login, signOut } from "./helpers";

/*
 * #519 item 2: an approvers-only document's checkpoint records stay with it. An owner drafts
 * an investor update with Oracle (an approvers-only document, H8) and approves its run's
 * Update review stop through the run page; the record "Approve Update review · <update> run"
 * is in Company › Decisions for an approver, and absent for a commenter and a viewer, in the
 * list and at its own address. Each test states its card: protects / fails_when / no_claim.
 */

const rows = (page: Page) => page.getByTestId("decision-row");
const chip = (page: Page, group: string, name: string) => page.getByRole("group", { name: group }).getByRole("button", { name: new RegExp(`^${name}`) });

async function checkpointsOnDecisions(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-decisions").click();
  await expect(page).toHaveURL(/\/company\/decisions/);
  await chip(page, "State", "Any state").click();
  await chip(page, "Kind", "Checkpoints").click();
}

for (const who of ["commenter", "viewer"]) {
  test(`a ${who} does not see the checkpoint records of an approvers-only update`, async ({ page }) => {
    // protects=the stop record of an update's run is listed for an approver and absent for a
    // ${who}, in Company › Decisions (Checkpoints, All) and at the record's own address, while
    // the other checkpoint records stay listed; fails_when=the ${who} reads the update's title
    // through its run's stop record; no_claim=the mock stands in for the API (its rule mirrors
    // oracle.docs.visibility._decision_visible).
    test.setTimeout(90_000);
    await login(page);
    await page.getByTestId("app-nav").getByTestId("nav-company").click();
    await expect(page).toHaveURL(/\/company\/strategy$/);
    await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-updates").click();
    await page.getByRole("button", { name: "New update" }).click();
    const sheet = page.getByRole("dialog", { name: "New update" });
    await sheet.getByRole("radio", { name: /Investor update/ }).check();
    const title = await sheet.getByLabel("Title").inputValue();
    await sheet.getByRole("button", { name: "Draft with Oracle" }).click();
    await expect(page).toHaveURL(/\/documents\/investor-update-[a-z0-9-]+$/);

    await page.getByTestId("nav-runs").click();
    await page.getByTestId("run-row").filter({ hasText: "Update draft" }).getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Update draft" })).toBeVisible();
    await page.getByTestId("checkpoint-update_review").getByRole("button", { name: "Approve and continue" }).click();
    await expect(page.getByTestId("run-decision")).toHaveCount(1);
    // Another run's stop, on a company document, for contrast.
    await page.getByTestId("nav-runs").click();
    await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").first().click();
    await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
    await expect(page.getByTestId("run-decision")).toHaveCount(1);
    await signOut(page);

    const record = `Approve Update review · ${title} run`;
    await login(page, "approver@example.com");
    await checkpointsOnDecisions(page);
    await expect(rows(page).filter({ hasText: record })).toBeVisible();
    await rows(page).filter({ hasText: record }).click();
    await expect(page.getByRole("complementary", { name: new RegExp(record) })).toBeVisible();
    const address = page.url();
    await signOut(page);

    await login(page, `${who}@example.com`);
    await checkpointsOnDecisions(page);
    await expect(rows(page).filter({ hasText: "Approve Baseline confirm · team-onboarding run" })).toBeVisible();
    await expect(rows(page).filter({ hasText: title })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Investor update");
    await page.goto(address);
    await expect(page.locator("main")).not.toContainText(title);
  });
}
