import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Simple S8 (#723): the meeting screen (direction A), driven through the UI on the mock's
 * invented PRD "Guided setup" (./lib/api/mock/simple-meetings.ts), desktop and phone, light
 * and dark.
 *
 * Card meeting-steps: protects = the top bar's steps "1 One-pager", "2 Roadmap", "3
 * Decisions" switch the stage (the one-pager, the PRD's roadmap slice, its open decisions
 * and pending proposals) with the current one pressed, the clock counts elapsed over the
 * length, and the chat column ("Chat", "All decisions") stays beside or under the stage;
 * fails_when = a step shows the wrong stage, the clock does not run, or the chat column is
 * missing; no_claim = the real chat (another lane's MeetingChat).
 *
 * Card meeting-decide: protects = a roadmap Move, a one-pager line edit, an accepted
 * proposal and a comment made through the meeting each become a row under All decisions
 * ("Moved Setup checklist", "New wording for a line of Guided setup", "Accepted: Moved Team
 * invite nudges", "Comment: …"), and the one-pager's note says ", in Review: Guided setup";
 * fails_when = a change does not carry the meeting's session (no row) or the note keeps
 * the old wording; no_claim = the change engine's own rules (simple-roadmap specs).
 *
 * Card meeting-approve: protects = the presenter marks the required reviewer absent, the
 * owner approves, and the screen reads "Approved in Review: Guided setup · not yet
 * published: Waiting on Approver's approval" (the one-pager's draft bar and the decision
 * say the same); a commenter gets no Approve, no
 * End and no presence or change-mode control; fails_when = the waiting text is missing or
 * someone without `can` gets the controls; no_claim = the Inbox request to the reviewer.
 */

/** Signs in as someone else: the account menu lives in the desktop rail, so switch people
 * there, then back to the test's width. */
async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

const allDecisions = (page: Page) => page.getByRole("region", { name: "All decisions" });
const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });

async function start(page: Page) {
  await login(page);
  await page.goto("/simple/prds/guided-setup");
  await page.getByRole("button", { name: "Start review" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("checkbox", { name: "Commenter" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("the three steps, the clock and the chat column", async ({ page }) => {
        await start(page);
        await expect(steps(page).getByRole("button", { name: "1 One-pager" })).toHaveAttribute("aria-pressed", "true");
        const stage = page.getByRole("region", { name: "Stage" });
        await expect(stage.getByRole("article", { name: "One-pager" })).toBeVisible();
        const clock = page.getByRole("timer", { name: "Meeting clock" });
        await expect(clock).toHaveText(/^0:0\d \/ 60:00$/);
        await page.clock.runFor(65_000);
        await expect(clock).toHaveText(/^1:0\d \/ 60:00$/);
        await steps(page).getByRole("button", { name: "2 Roadmap" }).click();
        await expect(steps(page).getByRole("button", { name: "2 Roadmap" })).toHaveAttribute("aria-pressed", "true");
        await expect(stage.getByRole("region", { name: "Roadmap slice" })).toContainText("Setup checklist");
        await expect(stage.getByRole("region", { name: "Roadmap slice" })).not.toContainText("Weekly alert digest");
        await steps(page).getByRole("button", { name: "3 Decisions" }).click();
        await expect(stage.getByRole("region", { name: "Pending proposals" })).toContainText("Commenter proposes: ");
        // prd-decisions A3: the Decisions step opens on "On the agenda"; "Open decisions" shows only when some are open.
        await expect(stage.getByRole("region", { name: "On the agenda" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
        await expect(allDecisions(page)).toContainText("None yet.");
        if (phone) {
          // The stage, then the chat column under it.
          const s = (await stage.boundingBox())!;
          const c = (await page.getByRole("complementary", { name: "Chat column" }).boundingBox())!;
          expect(c.y).toBeGreaterThan(s.y + s.height - 1);
        }
      });

      test("changes, an accepted proposal and a comment become the meeting's decisions", async ({ page }) => {
        await start(page);
        await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
        await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(allDecisions(page)).toContainText("New wording for a line of Guided setup: “A setup checklist with the next two steps”");
        await expect(page.getByRole("note").filter({ hasText: "You changed “A setup checklist" }).filter({ visible: true })).toContainText(", in Review: Guided setup");
        await steps(page).getByRole("button", { name: "2 Roadmap" }).click();
        await page.getByRole("button", { name: "Move Setup checklist to Next" }).click();
        await expect(allDecisions(page)).toContainText("Moved Setup checklist");
        await steps(page).getByRole("button", { name: "3 Decisions" }).click();
        const pending = page.getByRole("region", { name: "Pending proposals" });
        await pending.getByRole("button", { name: "Accept" }).click();
        await expect(allDecisions(page)).toContainText("Accepted: Moved Team invite nudges");
        await expect(pending).toContainText("No proposal waits.");
        await page.getByRole("textbox", { name: "Comment" }).fill("Keep the checklist to five steps");
        await page.getByRole("button", { name: "Add comment" }).click();
        // qa-simple-decide-1: the comment is the meeting's comment, not a decision.
        await expect(page.getByTestId("meeting-comment")).toContainText("Keep the checklist to five steps");
        const rows = allDecisions(page).getByTestId("meeting-decision");
        await expect(rows).toHaveCount(3);
        await expect(allDecisions(page)).not.toContainText("Comment:");
        await expect(rows.first()).toContainText(/D-\d+/);
      });

      test("approve with an absent reviewer waits on them; a commenter has no controls", async ({ page }) => {
        await start(page);
        // qa-simple-decide-29: on a phone the attendees fold behind one row.
        if (await page.getByTestId("meeting-people-toggle").isVisible()) await page.getByTestId("meeting-people-toggle").click();
        await page.getByRole("button", { name: "Approver is here" }).click();
        await expect(page.getByLabel("Attendees").locator('[data-present="false"]')).toContainText("Approver");
        await page.getByRole("button", { name: "Edit “Invite suggestions from the admin's" }).click();
        await page.getByLabel("New wording for").fill("Invite suggestions from a shared calendar");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(allDecisions(page)).toContainText("New wording for a line of Guided setup");
        await page.getByRole("button", { name: /^Approve one-pager edits/ }).click();
        await expect(page.getByRole("status").filter({ hasText: "Approved in Review: Guided setup" }).first()).toContainText("not yet published: Waiting on Approver's approval");
        await expect(allDecisions(page)).toContainText("Approved Guided setup (not yet published: Waiting on Approver's approval)");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("Approved in Review: Guided setup · not yet published: Waiting on Approver's approval");
        const url = page.url();
        await page.goto("/simple/meetings");
        await switchTo(page, "commenter@example.com");
        await page.goto(url);
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await expect(page.getByRole("button", { name: /^Approve one-pager edits/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "End meeting" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /is here/ })).toHaveCount(0);
        await expect(page.getByTestId("change-mode")).toHaveText("Who changes things: Everyone except viewers");
      });

      test("the presenter lets only named people change things", async ({ page }) => {
        await start(page);
        if (await page.getByTestId("meeting-people-toggle").isVisible()) await page.getByTestId("meeting-people-toggle").click();
        const mode = page.getByTestId("change-mode");
        await mode.getByRole("combobox").selectOption("named");
        await expect(mode.getByRole("button", { name: "Approver changes things" })).toHaveAttribute("aria-pressed", "true");
        await mode.getByRole("button", { name: "Commenter changes things" }).click();
        await expect(mode.getByRole("button", { name: "Commenter changes things" })).toHaveAttribute("aria-pressed", "true");
        await mode.getByRole("combobox").selectOption("presenter");
        await expect(mode.getByRole("combobox")).toHaveValue("presenter");
        const url = page.url();
        await page.goto("/simple/meetings");
        await switchTo(page, "commenter@example.com");
        await page.goto(url);
        await expect(page.getByTestId("change-mode")).toHaveText("Who changes things: Only the presenter");
        await steps(page).getByRole("button", { name: "2 Roadmap" }).click();
        await expect(page.getByRole("region", { name: "Roadmap slice" })).toContainText("Setup checklist");
        await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
      });
    });
  }
}
