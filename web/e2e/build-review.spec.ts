import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The PRD review and publish flow the owner picked on Nov 1 (mk-qa4-review), driven as a
 * person would on the mock's invented PRDs and roadmap, desktop and phone. Invented people:
 * Avery Stone (owner), Priya Raman (approver, Guided setup's required reviewer), Theo Brandt
 * (commenter), Lena Ortiz (viewer).
 *
 * Card send-for-approval (QV1 a): protects = the draft bar's "Send for approval…" opens a
 * dialog with the changes (old and new words) and who approves (the required reviewer,
 * already there), "+ Add a reviewer" adds a person by name, and sending names everyone it
 * waits on; the header says "Start a review meeting"; fails_when = it sends without asking,
 * an added reviewer is dropped, or the header says "Start review"; no_claim = the Inbox note.
 *
 * Card changes-list (QV2 a): protects = a viewer's bar says how many changes are in review
 * with "See the N changes", listing each edit, who made it and who it waits on; a commenter
 * on a PRD's overview has "Give feedback" on the open campaign, which opens its version;
 * fails_when = the list is missing or wrong, or there is no way in to give feedback.
 *
 * Card ask-what-to-present (QV3 a): protects = with a working draft, Present asks Published
 * vN or the Working draft; the page is shown without editing colours and a top line says
 * which; published shows the old words; fails_when = Present starts without asking, or the
 * line or the words are wrong.
 *
 * Card one-publish-step (QV4 a): protects = once every date of a roadmap has a verified
 * source, Publish v1 approves it and makes it ready to share in one step; Share a link opens
 * the link form at once (PDF download unticked); before, Share roadmap lists everything left,
 * each with its fix link; an approved version reads "Approved" in the crumb; fails_when =
 * Publish leaves the roadmap unshared, cannot be pressed with verified dates, or Share hides
 * what is left.
 */

const PRD = "/simple/prds/guided-setup";
const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });

async function switchTo(page: Page, email?: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

async function ownerEdits(page: Page) {
  await login(page);
  await page.goto(PRD);
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(bar(page)).toContainText("1 change");
}

async function sendWithTheo(page: Page) {
  await bar(page).getByRole("button", { name: "Send for approval…" }).click();
  const dialog = page.getByTestId("send-for-approval");
  await expect(dialog.getByRole("heading", { name: "Send 1 change for approval" })).toBeVisible();
  await dialog.getByRole("button", { name: "+ Add a reviewer" }).click();
  await dialog.getByLabel("Find a person").fill("Theo");
  await dialog.getByRole("option", { name: /Theo Brandt/ }).click();
  await dialog.getByRole("button", { name: "Send for approval" }).click();
  await expect(dialog).toBeHidden();
  await expect(bar(page).getByTestId("draft-waits-on")).toHaveText("· Sent for approval · waiting on Priya Raman, Theo Brandt");
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("QV1: Send for approval… asks first, in a dialog, and names everyone it waits on", async ({ page }, info) => {
      await ownerEdits(page);
      await expect(page.getByRole("button", { name: "Start a review meeting" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start review", exact: true })).toHaveCount(0);
      await bar(page).getByRole("button", { name: "Send for approval…" }).click();
      const dialog = page.getByTestId("send-for-approval");
      await expect(dialog.getByRole("heading", { name: "Send 1 change for approval" })).toBeVisible();
      await expect(dialog).toContainText("Published v3 stays live until they approve.");
      const change = dialog.getByRole("list", { name: "Changes to send" }).getByRole("listitem");
      await expect(change).toHaveCount(1);
      await expect(change.locator("s")).toHaveText("A setup checklist that shows the next step");
      await expect(change.locator(".font-semibold")).toHaveText("A setup checklist with the next two steps");
      await expect(dialog.getByTestId("approvers")).toContainText("Priya Raman · required for this PRD");
      await info.attach("dialog", { body: await page.screenshot(), contentType: "image/png" });
      // Cancel sends nothing.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(bar(page).getByTestId("draft-waits-on")).toHaveCount(0);
      await sendWithTheo(page);
      await expect(bar(page).getByRole("button", { name: "Send for approval…" })).toHaveCount(0);
      // The owner's own change still reads "You changed".
      await expect(page.getByRole("note").filter({ hasText: "You changed" }).first()).toBeAttached();
    });

    test("QV2: a viewer sees the changes list; a commenter has Give feedback on the overview", async ({ page }) => {
      await ownerEdits(page);
      await sendWithTheo(page);
      await switchTo(page, "viewer@example.com");
      await page.goto(PRD);
      const status = page.getByRole("status").filter({ hasText: "1 change in review" });
      await expect(status).toContainText("1 change in review · you read the published version");
      await expect(page.getByRole("list", { name: "Changes in review" })).toHaveCount(0);
      await status.getByRole("button", { name: "See the 1 change" }).click();
      const item = page.getByRole("list", { name: "Changes in review" }).getByRole("listitem");
      await expect(item).toHaveCount(1);
      await expect(item).toContainText("edited by Avery Stone · waiting on Priya Raman, Theo Brandt");
      await expect(item.locator("s")).toHaveText("A setup checklist that shows the next step");
      await expect(item).toContainText("A setup checklist with the next two steps");
      // The page itself stays the published version.
      await expect(page.getByTestId("one-pager-line-text").filter({ hasText: "A setup checklist that shows the next step" })).toBeVisible();

      await switchTo(page, "commenter@example.com");
      await page.goto("/documents/checkout-redesign");
      const give = page.getByRole("link", { name: "Give feedback" }).first();
      await expect(give).toBeVisible();
      await give.click();
      await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/\d+/);
    });

    test("QV3: Present asks what to present and shows it clean with a top line", async ({ page }) => {
      await ownerEdits(page);
      await page.getByRole("button", { name: "Present" }).click();
      const menu = page.getByRole("menu", { name: "What to present" });
      await expect(menu.getByRole("menuitem")).toHaveText(["Published v3What everyone has approved", "Working draftWith your 1 change, not yet approved"]);
      await expect(page.getByTestId("one-pager")).not.toHaveAttribute("data-presenting", "true");
      await menu.getByRole("menuitem", { name: /Working draft/ }).click();
      await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
      await expect(page.getByTestId("presenting-what")).toHaveText("Showing the working draft · 1 change not yet approved");
      await expect(page.getByTestId("one-pager-draft-chip")).toHaveCount(0);
      const line = page.locator('[data-line="bets-1"] > div').first();
      await expect(line).toContainText("A setup checklist with the next two steps");
      await expect(line).not.toHaveClass(/simple-edited/);
      await page.getByRole("button", { name: "Stop presenting" }).click();

      await page.getByRole("button", { name: "Present" }).click();
      await page.getByRole("menuitem", { name: /Published v3/ }).click();
      await expect(page.getByTestId("presenting-what")).toHaveText("Showing published v3");
      await expect(page.locator('[data-line="bets-1"]')).toContainText("A setup checklist that shows the next step");
    });

    test("QV4: one Publish step approves and readies a roadmap whose dates are verified; Share a link opens the form", async ({ page }) => {
      await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, DATE_BASES_SCENARIO] as const);
      await login(page);
      // Before: Share roadmap lists everything left, each with its fix link.
      await page.goto("/documents/usage-alerts-roadmap");
      await page.getByRole("button", { name: /^Share/ }).first().click();
      await expect(page.getByTestId("share-not-published")).toHaveText("Before you can share v1, 2 things are left:");
      const left = page.getByTestId("share-left");
      await expect(left.nth(0)).toContainText("Pick where dates come from: 1 date has no source yet");
      await expect(left.nth(0).getByRole("link", { name: "Fix in Plan › Dates" })).toHaveAttribute("href", "/plan/dates");
      // This roadmap's v1 is approved already, so the row does not add "(this approves it too)".
      await expect(left.nth(1)).toHaveText("Publish v1Fix on Publish page");
      await expect(left.nth(1).getByRole("link", { name: "Fix on Publish page" })).toHaveAttribute("href", "/documents/usage-alerts-roadmap/publish");

      // The date gets a verified source, as a person records it.
      await page.goto("/documents/usage-alerts-roadmap/v/1");
      await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
      const item = await openSection(page, "item-behaviour");
      await item.locator('[data-date-mark="unverified"]').click();
      await page.getByTestId("date-mark-popover").getByRole("button", { name: "Add a date source" }).click();
      const basis = page.getByTestId("date-basis-dialog");
      await basis.getByRole("button", { name: "Record and verify" }).click();
      await expect(basis).toBeHidden();

      await page.goto("/documents/usage-alerts-roadmap/publish");
      await expect(page.getByTestId("publish-share-note")).toHaveText("Publish v1 approves it and makes it ready to share, in one step.");
      const publish = page.getByTestId("publish-button");
      await expect(publish).toBeEnabled();
      await publish.click();
      const confirm = page.getByRole("dialog", { name: "Publish v1?" });
      await expect(confirm.getByTestId("on-publish")).toContainText("v1 ready to share as a link");
      await confirm.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
      await expect(page.getByTestId("publish-share-note")).toContainText("v1 is published. You can share it as a link now.");
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Approved");

      await page.getByTestId("publish-share-note").getByRole("link", { name: "Share a link" }).click();
      await expect(page.getByTestId("share-shares")).toContainText("Shares the published v1");
      await expect(page.getByLabel("Label")).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /Allow PDF download/ })).not.toBeChecked();
    });
  });
}
