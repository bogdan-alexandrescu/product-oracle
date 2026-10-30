import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple Definition of Done, item 4 (docs/simple-dod-actions-meet.md): the review meeting's
 * own decisions, driven through the UI on the mock's invented PRD "Guided setup", desktop
 * (1440x900) and phone (390x844).
 *
 * Card dod-meet-decisions: protects = in one meeting a one-pager line edit, the owner's
 * Approve, a roadmap Move and a Cut (asked first) each become a row under All decisions
 * naming who took it and when (a day and a time in the company's zone), and a comment
 * shows with who wrote it and when; fails_when = a decision has no row, or a row (or the
 * comment) has no name or no time; no_claim = the minutes (simple-meeting-end.spec.ts).
 *
 * Card dod-meet-cut-draft: protects = Cut in the meeting on a draft item (Team invite
 * nudges, not confirmed yet) shows it cut with Restore, as any cut item; fails_when = the
 * item keeps its horizon and its Cut button though the cut is recorded (its status read
 * "draft" over "cut"), or Restore does not bring it back with its Cut; no_claim = merged
 * drafts.
 *
 * Card dod-meet-decider-approve: protects = the PRD's decider (Dana Decider, who owns
 * nothing) starts the review, edits a line and approves in the meeting, and that Approve is
 * the working draft's approval: the meeting reads "Approved in Review: Guided setup" and,
 * with no reviewer required, the one-pager reads its new version with the edit and no draft
 * bar; fails_when = the decider gets no Approve, or the one-pager does not carry the
 * meeting's approval; no_claim = the reviewers' Inbox rows.
 */

const allDecisions = (page: Page) => page.getByRole("region", { name: "All decisions" });
const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });
const WHO_WHEN = /^\S.* · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M( [A-Z]{2,5})?$/;

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await page.goto("/simple/prds/guided-setup");
  await tap(page.getByRole("button", { name: "Start review" }));
  await tap(page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function editLine(page: Page, from: string, to: string) {
  await tap(page.getByRole("button", { name: `Edit “${from}` }));
  await page.getByLabel("New wording for").fill(to);
  await tap(page.getByRole("button", { name: "Save" }));
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // card: dod-meet-decisions
    test(`approve, move and cut in a meeting are decisions with who and when; a comment too (${where})`, async ({ page }) => {
      await login(page);
      await startReview(page);
      await editLine(page, "A setup checklist that shows", "A setup checklist with the next two steps");
      await expect(allDecisions(page)).toContainText("New wording for a line of Guided setup");
      await tap(page.getByRole("button", { name: /^Approve one-pager edits/ }));
      await expect(allDecisions(page)).toContainText("Approved Guided setup");

      await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
      await tap(page.getByRole("button", { name: "Move Setup checklist to Next" }));
      await expect(allDecisions(page)).toContainText("Moved Setup checklist");
      const slice = page.getByRole("region", { name: "Roadmap slice" });
      const title = "Welcome video";
      await tap(slice.getByRole("button", { name: `Cut ${title}`, exact: true }));
      await tap(page.getByRole("alertdialog").getByRole("button", { name: "Cut", exact: true }));
      await expect(slice.getByRole("button", { name: `Restore ${title}` })).toBeVisible();
      await expect(allDecisions(page)).toContainText(`Cut ${title}`);

      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      await page.getByRole("textbox", { name: "Comment" }).fill("Keep the checklist to five steps");
      await tap(page.getByRole("button", { name: "Add comment" }));
      const comment = page.getByTestId("meeting-comment");
      await expect(comment).toContainText("Keep the checklist to five steps");
      await expect(comment.locator("span")).toHaveText(/^\S.* · /);

      const rows = allDecisions(page).getByTestId("meeting-decision");
      await expect(rows).toHaveCount(4);
      for (const row of await rows.all()) await expect(row.locator("span")).toHaveText(WHO_WHEN);
    });

    // card: dod-meet-cut-draft
    test(`a draft item cut in the meeting reads Cut with Restore (${where})`, async ({ page }) => {
      await login(page);
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
      const slice = page.getByRole("region", { name: "Roadmap slice" });
      await tap(slice.getByRole("button", { name: "Cut Team invite nudges", exact: true }));
      await tap(page.getByRole("alertdialog").getByRole("button", { name: "Cut", exact: true }));
      await expect(allDecisions(page)).toContainText("Cut Team invite nudges");
      await expect(slice.getByRole("listitem").filter({ hasText: "Team invite nudges" })).toContainText("· Cut ·");
      await tap(slice.getByRole("button", { name: "Restore Team invite nudges" }));
      await expect(slice.getByRole("button", { name: "Cut Team invite nudges", exact: true })).toBeVisible();
      await expect(slice.getByRole("listitem").filter({ hasText: "Team invite nudges" })).not.toContainText("· Cut ·");
    });
  });
}

test.describe("the PRD's decider", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-deciders"), MOCK_SCENARIO_KEY);
  });

  for (const phone of [false, true]) {
    const where = phone ? "phone" : "desktop";
    // card: dod-meet-decider-approve
    test(`the decider's Approve in the meeting is the working draft's approval (${where})`, async ({ page }) => {
      await login(page, "dana.decider@example.com");
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await startReview(page);
      await editLine(page, "A setup checklist that shows", "A setup checklist with the next two steps");
      await tap(page.getByRole("button", { name: /^Approve one-pager edits/ }));
      await expect(page.getByRole("status").filter({ hasText: "Approved in Review: Guided setup" }).first()).toBeVisible();
      await expect(allDecisions(page)).toContainText("Approved Guided setup");
      // No reviewer is required here, so the approved working draft is the one-pager's new version.
      await page.goto("/simple/prds/guided-setup");
      const pager = page.getByTestId("one-pager");
      await expect(pager).toContainText("Version 4");
      await expect(pager).toContainText("A setup checklist with the next two steps");
      await expect(page.getByRole("status", { name: "Working draft" })).toHaveCount(0);
    });
  }
});

