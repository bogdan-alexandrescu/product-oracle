import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
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

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** A review of "Guided setup" on the plan scenario (its items dated by the PRD's slices). */
async function startReview(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

/**
 * Card walkc-moved-drawn-where-it-moved: protects = after a review meeting moves "Sample data
 * import" (F-02, dated by its PRD slice) to Later, the Timeline's and the Gantt's slice bars
 * start where the Waterfall's bar does, the item's new dates, not the plan's Nov 9;
 * fails_when = a moved item is drawn at its slice's old dates; no_claim = an estimated
 * item's slices, which stay on the plan.
 */
for (const where of ["desktop", "phone"] as const) {
  test(`a moved item is drawn where it moved (${where})`, async ({ page }) => {
    await startReview(page);
    await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
    await tap(page.getByRole("button", { name: "Move Sample data import to Later" }));
    await expect(page.getByTestId("roadmap-said")).toHaveText("Moved Sample data import to Later.");
    if (where === "phone") await page.setViewportSize(PHONE);
    await page.goto(`${URL}?roadmap=onboarding-roadmap`);
    await expect(page.getByTestId("simple-chart")).toBeVisible();
    await page.getByTestId("format-waterfall").click();
    const now = await bar(page, "setup-import").getAttribute("data-start");
    expect(now).not.toBe("2026-11-09");
    const formats = where === "phone" ? ["gantt"] : ["timeline", "gantt"];
    for (const f of formats) {
      await page.getByTestId(`format-${f}`).click();
      await expect(page.locator('g[data-testid="slice-bar"][data-code^="F-02"]').first(), f).toHaveAttribute("data-start", now!);
    }
  });
}
