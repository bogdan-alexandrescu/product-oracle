import { expect, test, type Page } from "./test";

import { feedbackState, login, section } from "./helpers";

/*
 * The Inbox's feedback rows, one per item (owner, 2026-10-20), lead to their items. Since the
 * PRD page navigation (I3, 2026-10-20) the review panel's Feedback tab filters by state chips
 * (Open / Staged / Declined / Done) and scope chips (This section / All sections). The
 * "suggestions" mock has a PRD (fleet-next v2) whose open feedback is three Oracle change
 * requests on f-33, f-34 and f-36, none on the first section, plus one addressed item.
 */
const DEEP_LINK = "/documents/fleet-next/v/2?feedback=open#f-33";

async function suggestions(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "suggestions"));
  await login(page);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const items = (page: Page) => page.getByTestId("feedback-item").filter({ visible: true });
const item = (page: Page, key: string) => items(page).filter({ has: page.locator(`[data-section-link="${key}"]`) });
const pressed = (scope: ReturnType<typeof panel>, group: string, name: RegExp) =>
  expect(scope.getByTestId(group).getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");

test("inbox: one feedback row per item, saying what waits and linking to its section", async ({ page }) => {
  await suggestions(page);
  await page.goto("/inbox");
  const fleet = page.getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: "Fleet next version" });
  // One row per open item, no per-document count.
  await expect(fleet).toHaveCount(3);
  await expect(page.getByTestId("inbox-needs")).not.toContainText("to accept or dismiss");
  const row = fleet.filter({ hasText: "#f-33" });
  await expect(row).toContainText("Say what happens when the customer is not home");
  // D14: Oracle's suggestion is decided here (Accept, Decline); Open goes to the item.
  await expect(row.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  const action = row.getByRole("link", { name: /^Open Say what happens/ });
  await expect(action).toHaveText("Open");
  await expect(action).toHaveAttribute("href", DEEP_LINK);

  // A comment without a suggestion: Decline, and Open to its section.
  const checkout = page.getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: "Checkout redesign PRD" });
  await expect(checkout).toContainText("most recently used address");
  await expect(checkout.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
  await expect(checkout.getByRole("link", { name: /^Open Should the most recently used address/ })).toHaveAttribute(
    "href",
    "/documents/checkout-redesign/v/2?feedback=open#s-5-3",
  );

  // Home's Needs you rows are the same rows.
  await page.goto("/home");
  const home = page.getByTestId("home-needs-table").locator("tr[data-row]").filter({ hasText: "Fleet next version" });
  await expect(home.first()).toContainText("#f-3");
  await expect(home.first().getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await expect(home.first().getByRole("link", { name: /^Open / })).toHaveAttribute("href", /^\/documents\/fleet-next\/v\/2\?feedback=open#f-3\d$/);
});

test("arriving from the inbox: Feedback, All + Open, at the first open item with its actions in view", async ({ page }) => {
  await suggestions(page);
  await page.goto("/inbox");
  await page.getByTestId("inbox-feedback").getByRole("link", { name: /^Open Say what happens/ }).click();
  await expect(page).toHaveURL(/\/documents\/fleet-next\/v\/2\?feedback=open#f-33$/);

  await expect(page.getByTestId("document-sections").filter({ visible: true })).toHaveAttribute("data-open", "f-33");
  const review = panel(page);
  await expect(review.getByRole("tab", { name: /^Feedback\s*3$/ })).toHaveAttribute("aria-selected", "true");
  await pressed(review, "inspector-scope", /^All sections/);
  await pressed(review, "feedback-state", /^Open/);
  await expect(items(page)).toHaveCount(3);

  // The header counts open feedback (comments, suggestions and change requests, one definition).
  await expect(review.getByTestId("stat-open-feedback")).toContainText("3");

  // The first open item is in view, its actions at its top.
  const first = item(page, "f-33");
  await expect(first.getByRole("button", { name: "Accept", exact: true })).toBeInViewport();
  await expect(first.getByRole("button", { name: "Edit and accept" })).toBeInViewport();
  await expect(first.getByRole("button", { name: "Dismiss", exact: true })).toBeInViewport();
  await expect(first.locator('[data-section-link="f-33"]')).toHaveText("Go to F-33 Proof of delivery");
  const actionsTop = (await first.getByRole("button", { name: "Accept", exact: true }).boundingBox())!.y;
  const textTop = (await first.getByTestId("suggestion-text").boundingBox())!.y;
  expect(actionsTop).toBeLessThan(textTop);
});

test("feedback items: long text collapsed, Accept, Edit and accept, Dismiss, and Go to its section", async ({ page }) => {
  await suggestions(page);
  await page.goto(DEEP_LINK);
  const first = item(page, "f-33");
  const text = first.getByTestId("suggestion-text");
  await expect(text).toHaveAttribute("data-collapsed", "true");
  const collapsed = (await text.boundingBox())!.height;
  expect(collapsed).toBeLessThanOrEqual(5 * 22);
  await first.getByRole("button", { name: "Show all" }).click();
  await expect(text).toHaveAttribute("data-collapsed", "false");
  expect((await text.boundingBox())!.height).toBeGreaterThan(collapsed);
  await expect(first.getByRole("button", { name: "Show less" })).toBeVisible();

  // Accept stages the proposed text for the next draft (C1e).
  await first.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(first.getByTestId("suggestion")).toContainText("Accepted");
  await expect(first.getByTestId("suggestion-staged")).toHaveText("Staged for the next draft");

  // Edit and accept: the editor opens at the top with the proposed text.
  const second = item(page, "f-34");
  await second.getByRole("button", { name: "Edit and accept" }).click();
  const editor = second.getByLabel("Proposed section text");
  await expect(editor).toBeInViewport();
  await expect(editor).toHaveValue(/A driver marks a stop as failed/);
  await editor.fill("A driver marks a stop as failed; the customer picks a new slot, twice at most.");
  await second.getByRole("button", { name: "Accept edited text" }).click();
  await expect(second.getByTestId("suggestion")).toContainText("Accepted");
  await expect(second.getByTestId("suggestion")).toContainText("(edited)");
  await expect(second.getByTestId("suggestion-text")).toHaveText("A driver marks a stop as failed; the customer picks a new slot, twice at most.");

  // Dismiss asks for an optional reason first.
  const third = item(page, "f-36");
  await third.getByRole("button", { name: "Dismiss", exact: true }).click();
  await third.getByRole("button", { name: "Dismiss suggestion" }).click();
  await expect(third.getByTestId("suggestion")).toContainText("Dismissed");

  // Go to §f-36 opens that section here.
  await third.locator('[data-section-link="f-36"]').click();
  await expect(page).toHaveURL(/#f-36$/);
  await expect(section(page, "f-36")).toBeVisible();

  // The Inbox now says what is left.
  await page.goto("/inbox");
  const rows = page.getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: "Fleet next version" });
  // C1e: the two accepted suggestions are staged for the next draft, not open feedback.
  await expect(rows).toHaveCount(1);
  const left = rows.filter({ hasText: "#f-36" });
  await expect(left).toContainText("Depot handover needs a count check");
  // Its suggestion dismissed, the item waits on a person: Decline or Open (D14).
  await expect(left.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
  await expect(left.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(left.getByRole("link", { name: /^Open Depot handover/ })).toHaveText("Open");
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Staged/ }).click();
  const staged = page.getByTestId("inbox-tab-staged").locator("tr[data-row]").filter({ hasText: "Fleet next version" });
  await expect(staged.getByTestId("staged-row-label")).toHaveText("2 changes staged for draft 3");
  await expect(staged.filter({ hasText: "#f-33" })).toContainText("Draft 3");
  await expect(staged.filter({ hasText: "#f-34" })).toContainText("Draft 3");
});

test("Feedback tab: counts open items, and shows All when the open section has none", async ({ page }) => {
  await suggestions(page);
  await page.goto("/documents/fleet-next/v/2");
  await expect(page.getByTestId("document-sections").filter({ visible: true })).toHaveAttribute("data-open", "summary");
  const review = panel(page);
  const tab = review.getByRole("tab", { name: /^Feedback\s*3$/ });
  await expect(tab).toBeVisible();
  await tab.click();
  await pressed(review, "inspector-scope", /^All sections/);
  // Open first: the three open items; Done holds the addressed one.
  await expect(items(page)).toHaveCount(3);
  await expect(page.getByTestId("feedback-empty")).toHaveCount(0);
  await feedbackState(page, "Done");
  await expect(items(page)).toHaveCount(1);
  await feedbackState(page, "Open");

  // A section with its own item narrows to it, as before.
  await page.goto("/documents/fleet-next/v/2#f-34");
  await panel(page).getByRole("tab", { name: /^Feedback/ }).click();
  await pressed(panel(page), "inspector-scope", /^This section/);
  await expect(items(page)).toHaveCount(1);
  // The tab counts all open feedback; the scope chip counts this section's.
  await expect(panel(page).getByRole("tab", { name: /^Feedback\s*3$/ })).toBeVisible();
  await expect(panel(page).getByTestId("inspector-scope").getByRole("button", { name: /^This section/ })).toHaveText(/This section\s*1/);
});

test("comment feedback items: Resolve and Reopen at the top", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2?feedback=open#s-5-3");
  const comment = item(page, "s-5-3");
  await expect(comment).toContainText("most recently used address");
  const resolve = comment.getByRole("button", { name: "Resolve", exact: true });
  await expect(resolve).toBeInViewport();
  await resolve.click();
  // Open only: the resolved item leaves the list; Done shows it, with Reopen.
  await expect(items(page)).toHaveCount(0);
  await feedbackState(page, "Done");
  const done = item(page, "s-5-3").filter({ hasText: "most recently used address" });
  await expect(done.getByTestId("feedback-state-chip")).toHaveText("Done");
  await done.getByRole("button", { name: "Reopen" }).click();
  await expect(done).toHaveCount(0);
  await feedbackState(page, "Open");
  await expect(item(page, "s-5-3").getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
});

test("phone: arriving from the inbox shows the first open item and its actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await suggestions(page);
  await page.goto(DEEP_LINK);
  const first = item(page, "f-33");
  await expect(first.getByRole("button", { name: "Accept", exact: true })).toBeInViewport();
  await expect(first.getByRole("button", { name: "Dismiss", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
