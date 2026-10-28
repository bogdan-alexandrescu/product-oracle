import { expect, test, type Locator, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";

import { login, openSeeded, seedRoadmapReview } from "./helpers";

/*
 * QA pass on the Roadmap items review (/runs/<id>/review/<checkpoint>): qa-work-3, 4, 13, 14,
 * 18, 19, 31, 32, 33, 34, driven through the UI on the mock's seeded roadmap review run (nine
 * items in the file, one dropped since the base: ten items need a person).
 */

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;

const rows = (page: Page): Locator => page.locator('[data-testid="roadmap-item-row"]').filter({ visible: true });
const row = (page: Page, key: string): Locator => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`).filter({ visible: true });
const bar = (page: Page): Locator => page.getByTestId("decision-bar");

async function open(page: Page) {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
}

/** The seeded run with its wait over: the run stopped waiting for the decision (qa-work-13). */
async function seedWaitEnded(page: Page) {
  const run = JSON.parse(JSON.stringify(ROADMAP_REVIEW_RUN.run)) as typeof ROADMAP_REVIEW_RUN.run;
  const cp = run.checkpoints[0];
  cp.payload = { ...cp.payload, wait: { workflow_id: "mock-wf-roadmap-items", ended: "2026-10-21T09:00:00Z" } };
  return page.evaluate(
    (seed) => {
      type Db = { runs: { runs: { id: string }[]; artifacts: Record<string, string> } };
      const write = (globalThis as { __poMockWrite?: (change: (db: Db) => string) => Promise<string> }).__poMockWrite;
      if (!write) throw new Error("The mock API is not loaded: sign in before seeding");
      return write((db) => {
        db.runs.runs = db.runs.runs.filter((r) => r.id !== seed.run.id);
        db.runs.runs.push(seed.run);
        Object.assign(db.runs.artifacts, seed.artifacts);
        return seed.run.id;
      });
    },
    { run, artifacts: ROADMAP_REVIEW_RUN.artifacts },
  );
}

/** The first row whose bottom is under the screen's bottom edge: it has to scroll into view. */
async function rowBelowFold(page: Page): Promise<Locator> {
  const vh = page.viewportSize()!.height;
  const all = rows(page);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const box = (await all.nth(i).boundingBox())!;
    if (box.y + box.height > vh) return all.nth(i);
  }
  throw new Error("Every row fits on the screen: make the viewport shorter");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 640 } });

  test("qa-work-3: one count of items: 9 items + 1 dropped, Needs you 10, All 10, 0 of 10 handled", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("review-items-count")).toHaveText("9 items + 1 dropped");
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button", { name: /^Needs you/ })).toHaveText(/^Needs you\s*10$/);
    await expect(show.getByRole("button", { name: /^All/ })).toHaveText(/^All\s*10$/);
    await expect(bar(page).getByTestId("decision-tally")).toContainText("0 of 10 handled");
  });

  test("qa-work-4: the review and the run page give the same blocking and to-confirm counts, before and after a fix", async ({ page }) => {
    await open(page);
    const summary = page.getByTestId("review-summary");
    await expect(summary).toHaveText("3 blocking · 7 to confirm");
    await page.getByRole("link", { name: /^(.+ · )?Roadmap from an approved PRD$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
    await expect(page.getByTestId("items-review-line").getByTestId("items-open")).toHaveText("3 blocking · 7 to confirm");

    await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
    await row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true }).click();
    await expect(row(page, "slack-alerts").getByTestId("row-done")).toBeVisible();
    await expect(summary).toHaveText("2 blocking · 7 to confirm");
    await expect(bar(page).getByTestId("decision-tally")).toContainText("1 of 10 handled");
    await page.getByRole("link", { name: /^(.+ · )?Roadmap from an approved PRD$/ }).click();
    await expect(page.getByTestId("items-review-line").getByTestId("items-open")).toHaveText("2 blocking · 7 to confirm");
  });

  test("qa-work-13: an ended wait and who decides read in plain words", async ({ page }) => {
    await login(page);
    await openSeeded(page, seedWaitEnded, SCREEN);
    await expect(page.getByTestId("review-status")).toHaveText("The run stopped waiting; your decision starts a follow-up run");
    await expect(page.getByTestId("review-deciders")).toHaveText("Approvers and owners decide");
    await expect(page.getByText("approver+")).toHaveCount(0);
  });

  test("qa-work-14: a row scrolled into view stops clear of the sticky decision bar", async ({ page }) => {
    await open(page);
    const target = await rowBelowFold(page);
    await target.evaluate((el) => el.scrollIntoView({ block: "end" }));
    const r = (await target.boundingBox())!;
    const b = (await bar(page).boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(b.y + 1);
  });

  test("qa-work-18: Your call is one column: buttons end at one edge and ⋯ sits in one place on every row", async ({ page }) => {
    await open(page);
    const ends = await page.getByTestId("your-call-buttons").filter({ visible: true }).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().right)));
    expect(ends.length).toBe(10);
    expect(new Set(ends).size).toBe(1);
    const menus = await page.getByRole("button", { name: /^More actions for / }).filter({ visible: true }).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(menus.length).toBeGreaterThan(1);
    expect(new Set(menus).size).toBe(1);
  });

  test("qa-work-19: a reason's date reads in words", async ({ page }) => {
    await open(page);
    await row(page, "slack-alerts").locator('[data-phone="title"]').click();
    const card = page.getByTestId("roadmap-item-inspector").getByTestId("reason-card");
    await expect(card).toContainText("No verified estimate, capacity or commitment supports Nov 30, 2026.");
    await expect(card).not.toContainText("2026-11-30");
  });

  test("qa-work-32: no out-of-order row numbers; every horizon in one chip style", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("columnheader", { name: "#" })).toHaveCount(0);
    const chip = (key: string) => row(page, key).locator('[data-phone="action"] > *').first();
    const now = await chip("slack-alerts").getAttribute("class");
    await expect(chip("slack-alerts")).toHaveText("Now");
    await expect(chip("cost-forecast")).toHaveText("Next");
    await expect(chip("anomaly-detection")).toHaveText("Later");
    expect(await chip("cost-forecast").getAttribute("class")).toBe(now);
    expect(await chip("anomaly-detection").getAttribute("class")).toBe(now);
  });

  test("qa-work-33: From the PRD names the section, not its key", async ({ page }) => {
    await open(page);
    await row(page, "slack-alerts").locator('[data-phone="title"]').click();
    const prd = page.getByTestId("roadmap-item-inspector").getByTestId("item-prd").getByRole("link");
    await expect(prd).toContainText("Slack alerts");
    await expect(prd).not.toContainText("alerts-slack");
    await expect(prd).toHaveAttribute("href", "/documents/usage-alerts/v/1#alerts-slack");
  });

  test("qa-work-34: the decision bar's text keeps the card's inner padding", async ({ page }) => {
    await open(page);
    const b = (await bar(page).boundingBox())!;
    const t = (await bar(page).getByTestId("decision-tally").boundingBox())!;
    expect(t.x - b.x).toBeGreaterThanOrEqual(16);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("qa-work-31: nothing runs off the side, the table's header included", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const head = (await page.locator('table[aria-label="Roadmap items"] thead').boundingBox())!;
    expect(head.x + head.width).toBeLessThanOrEqual(390);
  });

  test("qa-work-31/14: the decision bar sits above the tab bar, and a row scrolled into view clears both", async ({ page }) => {
    await open(page);
    const tabs = (await page.getByTestId("tab-bar").boundingBox())!;
    const b = (await bar(page).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(tabs.y + 1);
    const target = await rowBelowFold(page);
    await target.evaluate((el) => el.scrollIntoView({ block: "end" }));
    const r = (await target.boundingBox())!;
    const now = (await bar(page).boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(now.y + 1);
  });

  test("qa-work-18: on a phone ⋯ sits at one place on every row", async ({ page }) => {
    await open(page);
    const menus = await page.getByRole("button", { name: /^More actions for / }).filter({ visible: true }).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().right)));
    expect(menus.length).toBeGreaterThan(1);
    expect(new Set(menus).size).toBe(1);
  });
});
