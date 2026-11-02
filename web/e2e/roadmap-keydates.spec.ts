import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

// roadmap-keydates (the owner, Nov 1: "Read-only from the PRD"): the onboarding roadmap is
// built from the Guided setup PRD, whose approved version states two milestones (M1 Prove it
// ends Nov 27, M2 Scale volume Dec 25). Simple > Roadmap's Key dates lists both "From the
// PRD", with no Edit or Remove and the PRD named as where they change, beside the roadmap's
// own Board meeting, which keeps Edit and Remove. Publishing the PRD's next version, which
// moves M2 to Jan 8, moves its key date. Invented data ("roadmap-keydates" scenario).

const row = (page: Page, name: string) => page.getByTestId("key-dates-editor").locator(`[data-testid="key-date-row"][data-name="${name}"]`);

async function openKeyDates(page: Page) {
  await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
  await page.getByTestId("key-dates-open").click();
  await expect(page.getByTestId("key-dates-editor")).toBeVisible();
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("a PRD's milestones show as read-only key dates and follow the PRD", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-keydates"] as const);
      await login(page);
      await openKeyDates(page);
      await expect(page.getByTestId("key-dates-open")).toContainText("Key dates · 3");

      for (const [name, day] of [
        ["M1 · Prove it", "Nov 27"],
        ["M2 · Scale volume", "Dec 25"],
      ] as const) {
        await expect(row(page, name).getByTestId("key-date-day")).toHaveText(`· ${day}`);
        await expect(row(page, name).getByTestId("key-date-from-prd")).toHaveText("From the PRD");
        await expect(row(page, name).getByTestId("key-date-where")).toHaveText("Change it in the PRD, Guided setup");
        await expect(row(page, name).getByRole("link", { name: "Guided setup" })).toHaveAttribute("href", "/documents/guided-setup");
        await expect(row(page, name).getByRole("button", { name: `Edit ${name}` })).toHaveCount(0);
        await expect(row(page, name).getByRole("button", { name: `Remove ${name}` })).toHaveCount(0);
      }
      // The roadmap's own key date keeps Edit and Remove, and is not from the PRD.
      await expect(row(page, "Board meeting").getByRole("button", { name: "Edit Board meeting" })).toBeVisible();
      await expect(row(page, "Board meeting").getByRole("button", { name: "Remove Board meeting" })).toBeVisible();
      await expect(row(page, "Board meeting").getByTestId("key-date-from-prd")).toHaveCount(0);

      // The PRD changes: its next version, moving M2 to Jan 8, is published.
      await page.goto("/documents/guided-setup/publish");
      const publish = page.getByTestId("publish-button");
      await expect(publish).toHaveText("Publish v4");
      await publish.click();
      await page.getByRole("dialog", { name: "Publish v4?" }).getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByTestId("published-chip")).toHaveText("Published v4");

      await openKeyDates(page);
      await expect(row(page, "M2 · Scale volume").getByTestId("key-date-day")).toHaveText("· Jan 8, 2027");
      await expect(row(page, "M1 · Prove it").getByTestId("key-date-day")).toHaveText("· Nov 27");
      await expect(row(page, "M2 · Scale volume").getByRole("button", { name: "Edit M2 · Scale volume" })).toHaveCount(0);
    });
  });
}

// roadmap-keydates review: the onboarding track's milestone named without its code, "Prove
// it", falls on the day the PRD's M1 · Prove it ends (Nov 27): the chart draws it once (the
// track's), while Key dates still lists the PRD's M1. Invented data ("roadmap-keydates-uncoded").
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px, a milestone named without its code`, () => {
    test.use({ viewport });

    test("the chart draws a PRD milestone the track already has by name once", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-keydates-uncoded"] as const);
      await login(page);
      await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
      await expect(page.locator('[data-testid="track-milestone"]', { hasText: "Prove it" })).toHaveCount(1);
      await expect(page.locator('[data-testid="key-date-marker"][data-name="M2 · Scale volume"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="key-date-marker"][data-name="M1 · Prove it"]')).toHaveCount(0);

      await page.getByTestId("key-dates-open").click();
      await expect(row(page, "M1 · Prove it").getByTestId("key-date-from-prd")).toHaveText("From the PRD");
    });
  });
}
