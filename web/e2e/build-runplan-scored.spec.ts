import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITY_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * RP1 'Scored with the rest' (build-runplan): the run's order stop scores the features its
 * PRD adds on the same formula and goals as the baseline's and ranks them among the rest,
 * each marked New in this PRD; approving the order adds them to the baseline as proposed.
 *
 * Test cards (protects / fails_when / no_claim):
 * - "the new features are ranked among the rest and approving adds them": protects=the
 *   picked frames rp1-a-rest, rp1-a-open and rp1-a-done at 1440; fails_when=a new feature
 *   sits unranked at the bottom, lacks its chip, its score, steps or Depends on, or the notes are not
 *   said; no_claim=the real API (api/tests/test_priority_run_order.py).
 * - "at 390 px each row card carries the chip": protects=frame rp1-a-rest-390;
 *   fails_when=the chip is missing on a phone or the page scrolls sideways.
 */

const ORDER = ["F-5", "F-4", "F-2", "N-1", "N-2", "N-3", "F-1", "N-4", "N-5", "F-7", "N-6"];
const NEW = ["N-1", "N-2", "N-3", "N-4", "N-5", "N-6"];

async function openOrder(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "priority-order"), MOCK_SCENARIO_KEY);
  await login(page, "approver@example.com");
  await page.goto(`/runs/${PRIORITY_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page).toHaveURL(/\/priorities\?snapshot=/);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the new features are ranked among the rest and approving adds them", async ({ page }) => {
    await openOrder(page);
    const note = page.getByTestId("new-features-note");
    await expect(note).toHaveText(
      "This order ranks the 6 features Saved addresses adds, scored on the same formula and goals as the rest. Approving the order adds them to the baseline as proposed.",
    );
    const rows = page.locator('tr[data-testid^="priority-row-"]');
    await expect(rows).toHaveCount(11);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("priority-row-", "")))).toEqual(ORDER);
    for (const key of ORDER) {
      const chip = page.getByTestId(`priority-row-${key}`).getByText("New in this PRD");
      await expect(chip).toHaveCount(NEW.includes(key) ? 1 : 0);
    }
    // A new feature is scored like any other row: #4 at 4.20, no Live rank.
    const first = page.getByTestId("priority-row-N-1");
    await expect(first).toContainText("Address book per account");
    await expect(first).toContainText("4.20");
    await expect(first.getByTestId("live-rank")).toHaveText("—");
    // What a new feature depends on, as the run's feature set says (frames rp1-a-rest, rp1-a-open).
    for (const key of ["N-2", "N-3", "N-4"]) await expect(page.getByTestId(`priority-row-${key}`).getByTestId("row-deps")).toHaveText("Address book per account");
    await expect(first.getByTestId("row-deps")).toHaveText("—");

    // Opened: Import addresses is #8 at 1.80, worked out on the formula; 60% set by the run.
    await page.getByTestId("priority-row-N-4").getByRole("button", { name: /Import addresses from a spreadsheet/ }).click();
    const panel = page.getByTestId("priority-inspector");
    await expect(panel).toContainText("Import addresses from a spreadsheet, with a preview before saving");
    await expect(panel).toContainText("#8");
    await expect(panel.getByTestId("inspector-score")).toContainText("1.80");
    await expect(panel).toContainText("60%");
    const steps = page.getByTestId("explanation-N-4").getByRole("list", { name: "Steps" });
    await expect(steps).toContainText("Goal value = 3×2");
    await expect(steps).toContainText(/Score = 6 × 60% ÷ 2 = 1\.80$/);

    // Approve order: saved, and the 6 new features joined the baseline as proposed.
    const band = page.getByTestId("snapshot-band");
    await band.getByRole("button", { name: "Approve order" }).click();
    await expect(band).toContainText("Saved for Saved addresses");
    await expect(note).toHaveText("Order approved. The 6 new features joined the baseline as proposed, at the ranks you approved.");
    await expect(page.getByTestId("priority-row-N-1").getByText("New in this PRD")).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("at 390 px each row card carries the chip", async ({ page }) => {
    await openOrder(page);
    await expect(page.getByTestId("new-features-note")).toContainText("This order ranks the 6 features Saved addresses adds");
    for (const key of NEW) await expect(page.getByTestId(`priority-row-${key}`).getByText("New in this PRD")).toBeVisible();
    await expect(page.getByTestId("priority-row-F-5").getByText("New in this PRD")).toHaveCount(0);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
});
