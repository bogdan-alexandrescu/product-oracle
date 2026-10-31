import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

// QA pass 4, docs lane: the Roadmap tab of a PRD version (Checkout redesign PRD v2, seeded in
// lib/api/mock/draft-roadmap.ts: 4 items, 3 Now and 1 Next; Saved addresses carries a GA date
// with no confirmed schedule; v1's One-tap wallet pay was dropped), driven as a person.

const VERSION = "/documents/checkout-redesign/v/2";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// Next keeps recently visited routes mounted (hidden): only the visible page's elements.
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`).filter({ visible: true });
const group = (page: Page, horizon: string) => page.locator(`[data-testid="roadmap-group"][data-horizon="${horizon}"]`).filter({ visible: true });
const box = async (l: Locator) => (await l.boundingBox())!;

async function openRoadmap(page: Page, email?: string) {
  await login(page, email);
  await page.goto(VERSION);
  await visible(page, "version-tab-roadmap").click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/roadmap/);
  await expect(visible(page, "draft-roadmap-status")).toHaveAttribute("data-status", "ready");
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-3: the milestone shows Dec 15, 2026 and the whole Not in Now chip, clear of Confidence", async ({ page }) => {
    await openRoadmap(page);
    const saved = row(page, "saved-addresses");
    await expect(saved).toContainText("GA");
    await expect(saved.getByTestId("refused-date")).toHaveText("Dec 15, 2026");
    await expect(saved).not.toContainText("2026-12-15");
    const chip = saved.getByText("Not in Now", { exact: true });
    await expect(chip).toBeVisible();
    // The chip is whole inside its own cell: not cut, not under the Confidence pill.
    const fits = await chip.evaluate((el) => {
      const td = el.closest("td")!;
      const c = el.getBoundingClientRect();
      const cell = td.getBoundingClientRect();
      const next = (td.nextElementSibling as HTMLElement).getBoundingClientRect();
      return { inside: c.left >= cell.left - 0.5 && c.right <= cell.right + 0.5, clear: c.right <= next.left + 0.5, whole: el.scrollWidth <= el.clientWidth + 1 };
    });
    expect(fits).toEqual({ inside: true, clear: true, whole: true });

    // The inspector writes the day the same way.
    await saved.click();
    const milestone = visible(page, "roadmap-item-inspector").getByTestId("item-milestone");
    await expect(milestone).toContainText("Dec 15, 2026");
    await expect(milestone).not.toContainText("2026-12-15");
  });

  test("qa4-docs-4: the warning names the item and the day in words, with no item key or ISO date", async ({ page }) => {
    await openRoadmap(page);
    const notice = visible(page, "draft-roadmap-problem");
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText("Date unverified · Saved addresses: the Dec 15, 2026 date has no confirmed schedule behind it yet");
    await expect(notice).not.toContainText("saved-addresses");
    await expect(notice).not.toContainText("2026-12-15");
  });

  test("qa4-docs-5: the group headers match the rows and the summary, with the dropped item counted apart", async ({ page }) => {
    await openRoadmap(page);
    await expect(visible(page, "draft-roadmap-status")).toContainText(/^4 items · 3 Now · 1 Next/);
    // The tab opens on Changed: 3 of the 4 items, so the numbers start at 2; the page says so.
    await expect(group(page, "now")).toHaveText("Now 2 of 3");
    await expect(group(page, "next")).toHaveText("Next 1");
    await expect(group(page, "later")).toHaveText("Later 0 · 1 dropped");
    await expect(visible(page, "items-filter-note")).toHaveText("Showing 3 of 4 items · # is each item's place in the full list");

    await visible(page, "items-filter").getByRole("button", { name: /^All/ }).click();
    await expect(group(page, "now")).toHaveText("Now 3");
    await expect(group(page, "later")).toHaveText("Later 0 · 1 dropped");
    await expect(page.getByTestId("items-filter-note")).toHaveCount(0);
  });

  test("qa4-docs-46: Approved plan looks unavailable and says why in words", async ({ page }) => {
    await openRoadmap(page);
    const approved = visible(page, "compare-approved");
    await expect(approved).toBeDisabled();
    expect(Number(await approved.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
    // The enabled option keeps full strength.
    expect(Number(await visible(page, "compare-previous").evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    await expect(visible(page, "compare-unavailable")).toHaveText("No approved roadmap yet");
  });

  test("qa4-docs-47: after Build again the status says the table is the last build, and Compared with stays", async ({ page }) => {
    await openRoadmap(page, "approver@example.com");
    await expect(visible(page, "items-compare")).toBeVisible();
    const status = visible(page, "draft-roadmap-status");
    await status.getByRole("button", { name: "Build again" }).click();
    await expect(status).toHaveAttribute("data-status", "queued");
    await expect(status).toHaveText("Building again: starts within a minute. The table shows the last build until the new one is ready.");
    await expect(status).not.toContainText(/deriv/i);
    await expect(visible(page, "items-compare")).toBeVisible();
    await expect(visible(page, "items-compare-summary")).toHaveText("Since draft v1: 1 new · 1 dropped · 1 moved · 1 changed");
    await expect(row(page, "saved-addresses")).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-docs-3: on a phone the milestone reads GA Dec 15, 2026 with Not in Now", async ({ page }) => {
    await openRoadmap(page);
    const saved = row(page, "saved-addresses");
    await expect(saved.getByTestId("refused-date")).toHaveText("Dec 15, 2026");
    await expect(saved).not.toContainText("2026-12-15");
    await expect(saved.getByText("Not in Now", { exact: true })).toBeVisible();
  });

  test("qa4-docs-48: a card shows one dash per empty field, and the info icon stays beside its label", async ({ page }) => {
    await openRoadmap(page);
    await visible(page, "items-filter").getByRole("button", { name: /^All/ }).click();
    for (const key of ["cart-review", "guest-checkout", "shipping-step"]) {
      const text = await row(page, key).evaluate((el) => (el as HTMLElement).innerText.replace(/\s+/g, " "));
      expect(text, key).toContain("Depends on");
      expect(text, key).not.toMatch(/—\s*—/);
    }

    const auto = visible(page, "draft-roadmap-auto");
    const label = await box(auto.getByTestId("draft-roadmap-auto-label"));
    const info = await box(auto.getByRole("button", { name: "About refreshing with each new version" }));
    // On the label's line, to its right, not alone on a line below.
    expect(info.x).toBeGreaterThan(label.x + label.width - 1);
    expect(info.y + info.height / 2).toBeGreaterThan(label.y);
    expect(info.y + info.height / 2).toBeLessThan(label.y + label.height);
    expect(info.x + info.width).toBeLessThanOrEqual(PHONE.width);
  });
});
