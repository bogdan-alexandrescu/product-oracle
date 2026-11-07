import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The Inbox's Review changes lands on the changes it counts, on every subject's page, on the
 * mock layer ("discussions" scenario). The approver has three rows: the open Saved carts
 * discussion on a PRD's section (2 changes), their open goals interview on "Weekly checkout
 * time" (Oracle's 2 versions proposed; its page is the Ground Truth), and a discussion on the
 * priority order they are not in (the commenter's suggested move; its page is Priorities).
 *
 * Card: protects=Review changes opens the thread on its card with the changes it counts, on a
 * document's version, the Ground Truth and Priorities alike, and once none is open the row
 * offers no Review changes; fails_when=a goal's or the priorities' changes make no row (the
 * pending work vanishes) or their page opens no thread on the card; no_claim=the API's rule
 * (api/tests/test_discussion_inbox.py, changes.waits_on).
 */

const APPROVER = "approver@example.com";
const TITLE = "Saved carts: keep carts for guests?";
const GOAL = "Make “Weekly checkout time” measurable";
const ORDER = "Order: put Guest checkout first?";

const rowsOf = (page: Page) => page.getByTestId("inbox-tab-new").getByTestId("inbox-discussions").locator("tr[data-row]");
const review = (page: Page) => page.getByTestId("inbox-tab-new").getByRole("link", { name: "Review changes" });
const cardOf = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true }).getByTestId("changes-card");

async function inbox(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
  await page.goto("/inbox");
}

test("Review changes opens the thread on the changes it counts", async ({ page }) => {
  await inbox(page);
  await expect(rowsOf(page).filter({ hasText: `${TITLE} · 2 changes proposed` })).toBeVisible();
  await expect(review(page)).toHaveCount(3);

  await rowsOf(page).filter({ hasText: TITLE }).getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\?discussion=[^&]+&changes=1/);
  const card = cardOf(page);
  await expect(card).toBeInViewport();
  await expect(card.getByRole("list", { name: "Open changes" }).getByTestId("change-row")).toHaveCount(2);
});

test("Review changes on the priorities opens their thread on Priorities, on the suggested move", async ({ page }) => {
  await inbox(page);
  const row = rowsOf(page).filter({ hasText: `${ORDER} · 1 change proposed` });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\/priorities\?discussion=[^&]+&changes=1/);
  await expect(page.getByRole("heading", { name: "Priorities", level: 1 })).toBeVisible();
  const card = cardOf(page);
  await expect(card).toBeInViewport();
  const open = card.getByRole("list", { name: "Open changes" }).getByTestId("change-row");
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("Move Guest checkout above Saved carts");
});

test("Review changes on a goal opens its thread on the Ground Truth, on Oracle's versions", async ({ page }) => {
  await inbox(page);
  const row = rowsOf(page).filter({ hasText: `${GOAL} · 2 changes proposed` });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\/ground-truth\?discussion=[^&]+&changes=1/);
  const card = cardOf(page);
  await expect(card).toBeInViewport();
  const open = card.getByRole("list", { name: "Open changes" }).getByTestId("change-row");
  await expect(open).toHaveCount(2);
  await expect(open.first()).toContainText("Weekly checkout time");
});

test("with no change open, the row offers no Review changes", async ({ page }) => {
  await inbox(page);
  await rowsOf(page).filter({ hasText: TITLE }).getByRole("link", { name: "Review changes" }).click();
  const open = cardOf(page).getByRole("list", { name: "Open changes" }).getByTestId("change-row");
  await expect(open).toHaveCount(2);
  for (const n of [1, 0]) {
    await open.first().getByRole("button", { name: "Dismiss" }).click();
    await expect(open).toHaveCount(n);
  }

  // Back in the Inbox: the other two rows still offer Review changes, Saved carts' none.
  await page.goto("/inbox");
  const offered = page.getByRole("link", { name: "Review changes" }).filter({ visible: true });
  await expect(offered).toHaveCount(2);
  await expect(page.locator("tr[data-row]").filter({ visible: true, hasText: TITLE }).filter({ hasText: /changes? proposed/ })).toHaveCount(0);
});
