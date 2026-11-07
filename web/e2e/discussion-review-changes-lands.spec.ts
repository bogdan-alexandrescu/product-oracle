import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The Inbox's Review changes appears only when the thread's changes card will show a change,
 * and lands on it, on the mock layer ("discussions" scenario). Besides the open Saved carts
 * discussion (2 changes waiting on the approver), the approver's open goals interview on
 * "Weekly checkout time" has Oracle's 2 versions proposed, but its page (/ground-truth) opens
 * no thread: Review changes there would land on no change, so it makes no row.
 *
 * Card: protects=Review changes opens the thread on its card with the changes it counts, and
 * once none is open the Inbox offers no Review changes; fails_when=a discussion whose page
 * shows no changes card is counted (the interview's row); no_claim=the API's rule
 * (api/tests/test_discussion_inbox.py, changes.waits_on).
 */

const APPROVER = "approver@example.com";
const TITLE = "Saved carts: keep carts for guests?";
const AWAY = "Make “Weekly checkout time” measurable";

const rowsOf = (page: Page) => page.getByTestId("inbox-tab-new").getByTestId("inbox-discussions").locator("tr[data-row]");
const review = (page: Page) => page.getByTestId("inbox-tab-new").getByRole("link", { name: "Review changes" });

async function inbox(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
  await page.goto("/inbox");
}

test("Review changes opens the thread on the changes it counts", async ({ page }) => {
  await inbox(page);
  await expect(rowsOf(page).filter({ hasText: `${TITLE} · 2 changes proposed` })).toBeVisible();
  await expect(rowsOf(page).filter({ hasText: AWAY })).toHaveCount(0);
  await expect(review(page)).toHaveCount(1);

  await review(page).click();
  await expect(page).toHaveURL(/\?discussion=[^&]+&changes=1/);
  const card = page.getByTestId("discussion-thread").filter({ visible: true }).getByTestId("changes-card");
  await expect(card).toBeInViewport();
  await expect(card.getByRole("list", { name: "Open changes" }).getByTestId("change-row")).toHaveCount(2);
});

test("with no change open, the Inbox offers no Review changes", async ({ page }) => {
  await inbox(page);
  await review(page).click();
  const card = page.getByTestId("discussion-thread").filter({ visible: true }).getByTestId("changes-card");
  const open = card.getByRole("list", { name: "Open changes" }).getByTestId("change-row");
  await expect(open).toHaveCount(2);
  for (const n of [1, 0]) {
    await open.first().getByRole("button", { name: "Dismiss" }).click();
    await expect(open).toHaveCount(n);
  }

  // Back in the Inbox (on Seen now, the thread having been read): no row offers Review changes.
  await page.goto("/inbox");
  await expect(page.getByRole("tab", { name: /^Seen/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "Checkpoints" })).toBeVisible();
  await expect(page.getByText(/changes? proposed/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review changes" })).toHaveCount(0);
});
