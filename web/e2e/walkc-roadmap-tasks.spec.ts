import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * walkc-roadmap-tasks: after a roadmap changes, on the mock with two roadmaps ("Usage
 * alerts" and "Guided setup"): a working draft belongs to one roadmap, a moved item is drawn
 * where it now is, an item's tasks reach their owner, and its decisions say who, when and
 * where the minutes are. Each test's card is in its comment.
 */

const URL = "/simple/roadmap";
const PHONE = { width: 390, height: 844 };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

async function drag(page: Page, key: string, dx: number) {
  const body = bar(page, key).locator("rect[data-body]");
  await body.scrollIntoViewIfNeeded();
  const box = (await body.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

/**
 * Card walkc-drafts-per-roadmap: protects = a change staged on "Usage alerts" shows in that
 * roadmap's working draft only; "Guided setup"'s page has no draft banner (desktop and
 * phone); fails_when = one person's draft lists every roadmap's changes on every roadmap's
 * page; no_claim = the all-roadmaps view, which lists every draft.
 */
for (const where of ["desktop", "phone"] as const) {
  test(`a working draft belongs to one roadmap (${where})`, async ({ page }) => {
    await login(page);
    await page.goto(`${URL}?roadmap=alerts-roadmap`);
    await page.getByTestId("format-gantt").click();
    await expect(bar(page, "alert-export")).toBeVisible();
    await drag(page, "alert-export", 90);
    await expect(page.getByTestId("draft-count")).toHaveText("1");
    if (where === "phone") await page.setViewportSize(PHONE);
    await page.goto(`${URL}?roadmap=onboarding-roadmap`);
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await expect(page.getByText("Setup checklist").first()).toBeVisible();
    await expect(page.getByTestId("draft-banner")).toHaveCount(0);
    await page.goto(`${URL}?roadmap=alerts-roadmap`);
    await expect(page.getByTestId("draft-count")).toHaveText("1");
  });
}
