import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * simple-home-qa-nov17: a visual QA of Simple Home and Meetings, driven through the UI on the
 * mock's invented data, as a person would.
 *
 * #1 protects = on a phone the meeting's Roadmap step fits the screen: an estimate-only date line
 * breaks at its "·"; fails_when = the page scrolls sideways and the date is cut at the right edge.
 * #2 protects = Home's "Waiting for you" header counts only open decisions once one is decided
 * here; fails_when = it keeps the old count while the decided row shows with Undo.
 * #4 protects = Home's "decided here" stamp keeps its zone, as the Questions row and the meeting
 * do; fails_when = "Tue Nov 17, 5:14 AM" with no zone.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = page.getByRole("dialog", { name: "Start a review" });
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("#1 the meeting's Roadmap step fits a phone; an estimate breaks at its dot", async ({ page }) => {
    await login(page);
    await startReview(page);
    await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
    const slice = page.getByRole("region", { name: "Roadmap slice" });
    const est = slice.getByTestId("roadmap-span").filter({ hasText: "No dates yet · estimated" });
    await expect(est.first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const s of await est.all()) {
      const box = await s.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const card = (page: Page) => page.getByTestId("home-prd-waiting").filter({ hasText: "Waiting for you: Guided setup" });

  test("#2 deciding on Home's waiting card drops its count at once", async ({ page }) => {
    await login(page);
    await page.goto("/simple");
    const meta = card(page).locator("header .simple-meta");
    await expect(meta).toContainText(/\d+ decisions? you own/);
    const before = Number((await meta.textContent())!.match(/(\d+) decision/)![1]);
    const q = card(page).getByTestId("home-question").filter({ hasText: "Reminder default time" }).first();
    await tap(q.getByRole("button", { name: "Decide as recommended" }));
    await expect(q.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(meta).toContainText(`${before - 1} ${before - 1 === 1 ? "decision" : "decisions"} you own`);
  });

  test("#4 Home's decided-here stamp keeps its zone", async ({ page }) => {
    await login(page);
    await page.goto("/simple");
    const q = card(page).getByTestId("home-question").filter({ hasText: "Reminder default time" }).first();
    await tap(q.getByRole("button", { name: "Decide as recommended" }));
    await expect(q.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(q).toContainText(/ · \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M (PDT|PST)/);
  });
});
