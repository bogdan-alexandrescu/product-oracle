import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * BR seed codes (docs/qa/2026-11-12/simple-goalmap.md PR1, OP1, OP10), driven as a person does
 * against the mock's invented data: the default roadmap's features and the Saved carts PRD's
 * features are Ground Truth features, so each reads its code before its name and none carries
 * "Not in the Ground Truth".
 * protects: the Timeline's Setup checklist row reads "F-90 Setup checklist", Alert rules engine
 * "F-86 Alert rules engine", with no flag; the Saved carts PRD's Features by milestone reads
 * "F-96 Save cart", with no flag. fails_when: a bare name, or the flag, shows on them.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function openRoadmap(page: Page) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("format-timeline").click();
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("the default roadmap's features read their codes, none flagged", async ({ page }) => {
    await openRoadmap(page);
    for (const [key, name] of [["setup-checklist", "F-90 Setup checklist"], ["alert-rules", "F-86 Alert rules engine"], ["alert-sso", "F-89 Alert routing by team"]]) {
      const row = page.locator(`[data-testid="timeline-row"][data-item="${key}"]`).first();
      await row.scrollIntoViewIfNeeded();
      await expect(row.getByTestId("timeline-row-name")).toHaveText(name);
      await expect(row.getByTestId("not-in-gt")).toHaveCount(0);
    }
  });

  test("the Saved carts PRD's features read their codes, none flagged", async ({ page }) => {
    await login(page);
    await page.goto("/simple");
    await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
    await page.getByTestId("simple-one-pagers").getByRole("link", { name: /^Saved carts/ }).first().click();
    const whole = page.getByTestId("prd-whole");
    const table = whole.locator('section[data-prd-sec="brief-items"]').getByRole("region", { name: "Table" });
    await table.scrollIntoViewIfNeeded();
    for (const name of ["F-96 Save cart", "F-97 Cart on every device", "F-98 Reminder email"]) {
      await expect(table.getByRole("cell", { name })).toBeVisible();
    }
    await expect(whole.getByTestId("not-in-gt")).toHaveCount(0);
  });
});
