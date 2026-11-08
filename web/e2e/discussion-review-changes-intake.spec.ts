import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The Inbox's Review changes on an intake's discussion opens the intake's own page (Before
 * drafting), on the mock layer ("discussion-intake" scenario): the approver's open discussion
 * on the "Saved addresses" intake, where Oracle proposes one way to measure its goal.
 *
 * Card: protects=Review changes on an intake's (or its gap's) discussion lands on the intake's
 * page with the thread open on its changes card and the counted change in it;
 * fails_when=the row links the Tech brief page ("Tech brief not found") or the intake's page
 * opens no thread; no_claim=the API's link (api/tests/test_discussion_inbox.py).
 */

const APPROVER = "approver@example.com";
const TITLE = "Saved addresses: how do we measure it?";

const rowsOf = (page: Page) => page.getByTestId("inbox-tab-new").getByTestId("inbox-discussions").locator("tr[data-row]");
const cardOf = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true }).getByTestId("changes-card");

test("Review changes on an intake's discussion opens its thread on the intake's page", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "discussion-intake"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
  await page.goto("/inbox");
  const row = rowsOf(page).filter({ hasText: `${TITLE} · 1 change proposed` });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Review changes" }).click();

  await expect(page).toHaveURL(/\/intakes\/[^/?]+\?discussion=[^&]+&changes=1/);
  await expect(page.getByRole("heading", { name: "Saved addresses", level: 1 })).toBeVisible();
  await expect(page.getByText("Tech brief not found")).toHaveCount(0);
  const card = cardOf(page);
  await expect(card).toBeInViewport();
  const open = card.getByRole("list", { name: "Open changes" }).getByTestId("change-row");
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("Measure repeat checkout time in seconds");
});
