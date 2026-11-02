import { expect, test, type Page } from "./test";

import { login, openSection } from "./helpers";

// walkb-roadmap 2: a roadmap version's approval checks only its schedule dates. The usage
// alerts roadmap (built from its PRD) says "As of Oct 2, 2026" under its title and has a
// "Changes since last version" section with a date: neither is a schedule date. Its Beta date
// rests on a verified basis; only its GA date (its basis withdrawn) holds the approval.

const ROADMAP = "/documents/usage-alerts-roadmap/v/1";
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    // Card entry: protects = the as-of line and the changes section never hold Approve version;
    // fails_when = they count as dates not backed by a confirmed schedule; no_claim = the GA date.
    test("only schedule dates hold the approval", async ({ page }) => {
      await login(page);
      await page.goto(`${ROADMAP}/items`);
      const blocked = visible(page, "approve-blocked");
      await expect(blocked).toContainText("1 date is not backed by a confirmed schedule");
      await expect(blocked).not.toContainText("Oct 2, 2026");
      await page.goto(ROADMAP);
      await expect(visible(page, "approve-blocked")).toContainText("1 date is not backed by a confirmed schedule");
    });

    // Card entry (walkb-roadmap review): protects = a roadmap whose schedule dates are all
    // verified can be approved, though its as-of line and changes section write dates;
    // fails_when = Approve version stays disabled after the last date is verified;
    // no_claim = the approval itself.
    test("once every schedule date is verified, Approve version is enabled", async ({ page }) => {
      await login(page);
      await page.goto(ROADMAP);
      await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
      const item = await openSection(page, "item-behaviour");
      await item.locator('[data-date-mark="withdrawn"]').click();
      await page.getByTestId("date-mark-popover").getByRole("button", { name: "Add a new date source" }).click();
      const dialog = page.getByTestId("date-basis-dialog");
      await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-12-15");
      await dialog.getByLabel("Reference").fill("ENG-414");
      await dialog.getByRole("button", { name: "Record and verify" }).click();
      await expect(dialog).toBeHidden();
      await expect(item.locator("[data-date-mark]")).toHaveCount(0);
      await page.goto(`${ROADMAP}/items`);
      await expect(visible(page, "approve-version")).toBeEnabled();
      await expect(page.getByTestId("approve-blocked")).toHaveCount(0);
    });
  });
}
