import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Inbox "Discussion · N changes proposed" rows lead to the changes they count, each with its
 * action, on the mock layer ("discussions" scenario). Besides the open Saved carts discussion
 * (2 changes waiting on the approver), the approver's goals interview on "Weekly saved carts"
 * was closed once their pick made the goal measurable, leaving Oracle's other 3 versions
 * proposed: a closed discussion's card offers no action, so it must make no row.
 *
 * Card: protects=every changes row's Review changes opens a card whose open changes match the
 * row's count, each with an action, and the closed interview makes no row; fails_when=the
 * closed discussion's leftovers are counted (a row whose Review changes leads to nothing to
 * act on); no_claim=the API's rule (api/tests/test_discussion_inbox.py).
 */

const APPROVER = "approver@example.com";
const OPEN_TITLE = "Saved carts: keep carts for guests?";
const CLOSED_TITLE = "Make “Weekly saved carts” measurable";

const rowsOf = (page: Page) => page.getByTestId("inbox-tab-new").getByTestId("inbox-discussions").locator("tr[data-row]");

test("every changes row leads to the changes it counts, and a closed discussion makes none", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
  await page.goto("/inbox");
  const open = rowsOf(page).filter({ hasText: `${OPEN_TITLE} · 2 changes proposed` });
  await expect(open).toBeVisible();
  // The closed interview's leftover versions are not counted: no row, nothing that cannot be cleared.
  await expect(rowsOf(page).filter({ hasText: CLOSED_TITLE })).toHaveCount(0);
  await expect(rowsOf(page).filter({ hasText: /changes? proposed/ })).toHaveCount(1);

  await open.getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\?discussion=[^&]+&changes=1/);
  const card = page.getByTestId("discussion-thread").filter({ visible: true }).getByTestId("changes-card");
  const changes = card.getByRole("list", { name: "Open changes" }).getByTestId("change-row");
  await expect(changes).toHaveCount(2);
  for (const c of await changes.all()) await expect(c.getByTestId("change-actions").getByRole("button").first()).toBeEnabled();
});
