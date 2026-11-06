import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * build-feature-panel (AN PR 1204 review 5), ported onto this line's one feature panel: a
 * meeting's Roadmap step names its features, and each name opens the same feature panel the
 * Roadmap does, over the meeting. Mock data (Guided setup, invented), desktop 1440 and phone 390.
 */

const SIZES = [
  { name: "1440", use: { viewport: { width: 1440, height: 900 } } },
  { name: "390", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = page.getByRole("dialog", { name: "Start a review" });
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);

    test("a meeting's Roadmap step opens a feature's panel from its name", async ({ page }) => {
      await startReview(page);
      await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
      const row = page.locator('li[data-item="setup-checklist"]');
      await tap(row.getByRole("button", { name: "Setup checklist" }));
      const panel = page.getByTestId("floating-card");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("card-name")).toContainText("Setup checklist");
      await expect(panel.getByTestId("card-dates")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
    });
  });
}
