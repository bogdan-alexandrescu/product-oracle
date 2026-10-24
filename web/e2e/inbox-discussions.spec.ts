import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * G6 Discussion rows in the Inbox through the UI, on the mock layer ("discussions" scenario):
 * besides G1's private discussion, the commenter's open discussion on the Saved carts PRD
 * mentions the viewer (an invitation) and, later, the approver (already in it), and has 2
 * changes waiting: Oracle's proposal and the commenter's suggestion.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_discussion_inbox.py.
 * In the default scenario the badge is still 10: e2e/inbox-one.spec.ts pins it.
 */

const TITLE = "Saved carts: keep carts for guests?";
const VIEWER = "viewer@example.com";
const APPROVER = "approver@example.com";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const tabCount = async (page: Page, name: string) => Number((await tab(page, name).innerText()).replace(/\D+/g, "") || "0");
const badge = (page: Page) => page.getByTestId("nav-inbox-badge");
const group = (page: Page, state: string) => page.getByTestId(`inbox-tab-${state}`).getByTestId("inbox-discussions");
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });

async function inboxAs(page: Page, email: string) {
  await withScenario(page);
  await login(page, email);
  await page.goto("/inbox");
  await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
}

// protects=criterion 9.1: a viewer invited by a mention sees "Invited" with Read; opening it
// reads the thread, so the row moves to Done and the rail badge drops by 1; fails_when=no
// row, Join for a viewer, or the row still counted after reading; no_claim=the API's
// done rule (test_a_mention_invites_and_reading_marks_it_done).
test("an invited viewer reads the discussion and the row moves to Done", async ({ page }) => {
  await inboxAs(page, VIEWER);
  const row = group(page, "new").locator("tr[data-row]").filter({ hasText: TITLE });
  await expect(row).toContainText("Invited");
  await expect(row).toContainText("by Commenter");
  await expect(row.getByRole("button", { name: "Join" })).toHaveCount(0);
  const before = Number(await badge(page).innerText());
  await row.getByRole("link", { name: "Read" }).click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\?discussion=/);
  await expect(thread(page)).toContainText(TITLE);
  await page.goto("/inbox");
  await expect(badge(page)).toHaveText(String(before - 1));
  await tab(page, "Done").click();
  await expect(group(page, "done").locator("tr[data-row]").filter({ hasText: TITLE })).toContainText("Invited");
});

// protects=criterion 9.2: an approver in the discussion sees "Discussion" with "<title> · 2
// changes proposed" and Review changes, which opens the thread scrolled to its changes card;
// fails_when=no row, a wrong count, or the thread opens elsewhere; no_claim=staging (G3/G4).
test("an approver reviews the changes proposed in a discussion", async ({ page }) => {
  await inboxAs(page, APPROVER);
  const row = group(page, "new").locator("tr[data-row]").filter({ hasText: `${TITLE} · 2 changes proposed` });
  await expect(row).toContainText("Discussion");
  await row.getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\?discussion=[^&]+&changes=1/);
  // G3's changes card is the thread's one list of changes.
  const card = thread(page).getByTestId("changes-card");
  await expect(card).toBeInViewport();
  await expect(card.getByRole("list", { name: "Open changes" }).getByTestId("change-row")).toHaveCount(2);
});

// protects=criterion 9.3: a participant mentioned again sees "Mentioned you" with the
// message's excerpt in quotes, and Open; fails_when=no row or no quoted excerpt;
// no_claim=the 140-character cut (the API test checks it).
test("a mention shows its excerpt in quotes", async ({ page }) => {
  await inboxAs(page, APPROVER);
  const row = group(page, "new").locator("tr[data-row]").filter({ hasText: "Mentioned you" });
  await expect(row).toContainText("“Approver, can guests keep a cart for 30 days?”");
  await expect(row).toContainText(TITLE);
  await expect(row.getByRole("link", { name: "Open" })).toBeVisible();
});

// protects=criterion 8: with discussion rows present the rail badge equals the New + Open
// tabs, and each discussion row counts; fails_when=a discussion row is counted on one
// surface and not another; no_claim=the visual order of groups.
test("the badge equals New + Open with discussion rows present", async ({ page }) => {
  await inboxAs(page, APPROVER);
  await expect(group(page, "new").locator("tr[data-row]")).toHaveCount(2);
  const total = (await tabCount(page, "New")) + (await tabCount(page, "Open"));
  await expect(badge(page)).toHaveText(String(total));
  await expect(page.getByText(`${total} waiting`)).toBeVisible();
});

// protects=criterion 7 (screen): a question Oracle asked from a discussion says "From
// discussion <title>" and has Open discussion, which opens that thread; fails_when=the row
// shows only its document, or no Open discussion link; no_claim=the title hidden from someone
// who cannot read the discussion (test_discussion_inbox.py checks it).
test("a question asked from a discussion names it and opens it", async ({ page }) => {
  await inboxAs(page, APPROVER);
  const row = page.getByTestId("inbox-tab-new").locator("tr[data-row]").filter({ hasText: "How long should a guest's cart last?" });
  await expect(row).toContainText(`From discussion ${TITLE}`);
  await row.getByRole("link", { name: "Open discussion" }).click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\?discussion=/);
  await expect(thread(page)).toContainText(TITLE);
});
