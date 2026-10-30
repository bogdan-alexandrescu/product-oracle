import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login, signOut } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * Simple S8 (#723), the production walk's three meeting findings, driven through the UI on
 * the mock's invented PRD "Guided setup" and its built-in rituals
 * (./lib/api/mock/simple-meetings.ts), desktop and phone, light and dark.
 *
 * Card walk-minutes-failed: protects = when the minutes job fails the end screen says
 * "Oracle could not draft the minutes" (not "Drafting…" forever), the owner's Draft again
 * brings Oracle's minutes into the fields, and Send works on what a person edited; a
 * commenter gets no Draft again; fails_when = the failed state is hidden, Send stays
 * disabled while the job has not answered, or Draft again is offered to a commenter;
 * no_claim = the job runner (api tests: test_simple_meetings_walk).
 *
 * Card walk-minutes-slow: protects = a job still drafting after 2 minutes reads "still
 * drafting" and Send sends what is written; fails_when = Send waits on the job;
 * no_claim = the 2 minutes themselves (the API's MINUTES_SLOW).
 *
 * Card walk-upcoming: protects = Meetings > Upcoming lists the rituals Home shows (Home's
 * "Next review meeting" is its first row, the same title), the rail's Meetings count is
 * the rows not started plus the live meetings and says so ("… reviews live or coming
 * up"), and Home's Start meeting opens the start sheet on that review, whose meeting then
 * shows Open; a viewer reads the same list; fails_when = Upcoming says "No review is
 * scheduled" while Home names one, or the count counts something else; no_claim = the
 * ritual's pre-read (Detailed's rituals).
 *
 * Card walk-approve-refresh: protects = in a meeting, Undo takes the one-pager's draft
 * bar back off its change, and after the decider's Approve the one-pager reads the new
 * version ("Version 4") with no "Working draft" bar and the edited line; fails_when = the
 * screen keeps "Version 3" or the bar after Approve; no_claim = absent reviewers (the
 * meeting screen spec's approve card).
 *
 * Card walk-approve-other-screen (the production sequence): a second screen on the same
 * live meeting (another participant, or the presenter's own second tab) follows the
 * meeting without a reload: after Approve on the first it reads "Version 4" and no draft
 * bar; fails_when = only the screen that pressed Approve reads the new version;
 * no_claim = the poll's interval.
 *
 * Card walk-upcoming-who (review): a viewer reads Upcoming and Home's next review with no
 * Start (only owners and the ritual's owner start a ritual's review: the row's
 * can_start), and Home says whether the review's pre-read is ready; fails_when = a viewer
 * gets the start sheet and only then a 403, or Home drops the pre-read; no_claim = the
 * pre-read itself.
 *
 * Card walk-upcoming-stale (review): a stale Start of a ritual's review (another tab
 * started it already) says "This scheduled review has its meeting already" and makes no
 * next week's meeting; fails_when = the stale Start opens a second meeting on the next
 * occurrence; no_claim = crossing starts on the API (test_simple_meetings_walk).
 *
 * Card walk-rail-count (review): moving between Simple's pages does not read the full
 * meetings list again for the rail's count (the mock's call log); fails_when = every
 * route change reads /v1/simple/meetings; no_claim = the Inbox's own reads.
 */

async function switchTo(page: Page, email: string) {
  // From a fresh page: the full-screen meeting covers the rail's account menu.
  await page.goto("/simple");
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

const minutesRegion = (page: Page) => page.getByRole("region", { name: "Minutes" });
const delivery = (page: Page) => page.getByRole("region", { name: "Delivery" });

async function endOne(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await page.getByRole("button", { name: "Start review" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
  await page.getByRole("button", { name: "Move Setup checklist to Next" }).click();
  await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Moved Setup checklist");
  await page.getByRole("button", { name: "End meeting" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("a failed minutes job: the failed state, Send on the edited minutes, Draft again", async ({ page, context }) => {
        await flags(context, "minutes-failed");
        await endOne(page);
        const minutes = minutesRegion(page);
        await expect(minutes.getByTestId("minutes-failed")).toContainText("Oracle could not draft the minutes");
        await expect(minutes.getByText("Drafting…")).toHaveCount(0);
        await expect(minutes.getByRole("button", { name: "Draft again" })).toBeVisible();
        await minutes.getByLabel("Summary").fill("We moved the setup checklist to Next.");
        await expect(delivery(page).getByRole("button", { name: "Send" })).toBeEnabled();
        const url = page.url();
        // A commenter reads the minutes: no Draft again, nothing to send.
        await switchTo(page, "commenter@example.com");
        await page.goto(url);
        await expect(page.getByTestId("end-screen")).toBeVisible();
        await expect(page.getByRole("button", { name: "Draft again" })).toHaveCount(0);
        await expect(delivery(page)).toContainText("The minutes are not sent yet.");
        // The owner drafts again: Oracle's minutes land in the fields; Send sends them.
        await switchTo(page, "admin@example.com");
        await page.goto(url);
        await minutesRegion(page).getByRole("button", { name: "Draft again" }).click();
        await expect(minutesRegion(page).getByTestId("minutes-failed")).toHaveCount(0);
        await expect(minutesRegion(page).getByLabel("Summary")).toHaveValue("Oracle's minutes of Review: Guided setup: 1 decisions taken.");
        await minutesRegion(page).getByLabel("Summary").fill("Edited after Oracle drafted again.");
        await delivery(page).getByRole("button", { name: "Send" }).click();
        await expect(delivery(page).getByRole("status", { name: "Sent" })).toBeVisible();
        await expect(page.getByTestId("minutes-summary")).toHaveText("Edited after Oracle drafted again.");
      });

      test("a failed minutes job: Send works on what a person wrote, without Draft again", async ({ page, context }) => {
        await flags(context, "minutes-failed");
        await endOne(page);
        await minutesRegion(page).getByLabel("Summary").fill("Written by hand while Oracle failed.");
        await minutesRegion(page).getByLabel("Open questions").fill("Who writes the checklist copy?");
        await minutesRegion(page).getByRole("button", { name: "Add action item" }).click();
        await minutesRegion(page).getByLabel("Action item 1", { exact: true }).fill("Draft the checklist copy");
        await delivery(page).getByRole("button", { name: "Send" }).click();
        await expect(delivery(page).getByRole("status", { name: "Sent" })).toBeVisible();
        await expect(page.getByTestId("minutes-summary")).toHaveText("Written by hand while Oracle failed.");
        await expect(minutesRegion(page)).toContainText("Who writes the checklist copy?");
        await expect(minutesRegion(page)).toContainText("Draft the checklist copy");
      });

      test("a slow minutes job: still drafting, Send what is written", async ({ page, context }) => {
        await flags(context, "minutes-slow");
        await endOne(page);
        await expect(minutesRegion(page).getByTestId("minutes-slow")).toContainText("still drafting");
        await expect(minutesRegion(page).getByRole("button", { name: "Draft again" })).toHaveCount(0);
        await delivery(page).getByRole("button", { name: "Send" }).click();
        await expect(delivery(page).getByRole("status", { name: "Sent" })).toBeVisible();
        // qa-simple-decide-32: the summary does not repeat the title and count.
        // qa-simple-decide-6: a short prose summary, not the decision titles again.
        await expect(page.getByTestId("minutes-summary")).toContainText("1 decision taken.");
        await expect(page.getByTestId("minutes-summary")).not.toContainText("Setup checklist");
      });

      test("Upcoming lists what Home shows; the rail counts what the page lists; Home's Start opens the sheet", async ({ page }) => {
        await login(page);
        await page.goto("/simple/meetings");
        const upcoming = page.getByRole("region", { name: "Upcoming" });
        const rows = upcoming.getByTestId("meetings-upcoming-row");
        await expect(rows.first()).toBeVisible();
        await expect(upcoming).not.toContainText("No review is scheduled");
        const firstTitle = (await rows.first().locator("strong").innerText()).trim();
        const waiting = await upcoming.getByRole("button", { name: "Start review" }).count();
        expect(waiting).toBeGreaterThan(0);
        if (!phone) {
          const badge = page.getByTestId("simple-nav-meetings-count");
          await expect(badge).toHaveText(String(waiting));
          await expect(badge).toHaveAttribute("aria-label", `${waiting} ${waiting === 1 ? "review" : "reviews"} live or coming up`);
        }
        // Home's next review is Upcoming's first row; its Start meeting opens the sheet on it.
        await page.goto("/simple");
        await expect(page.getByTestId("home-meeting-next")).toContainText(firstTitle);
        // fix4 (qa-simple-home-27): days before the meeting, Home's start says it starts now.
        await page.getByTestId("home-meeting-next").getByRole("link", { name: "Start now" }).click();
        const sheet = page.getByRole("dialog", { name: "Start a review" });
        await expect(sheet.getByTestId("start-occurrence")).toContainText(firstTitle);
        const ritual = firstTitle;
        await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
        await sheet.getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: `${ritual}: Guided setup` })).toBeVisible();
        await page.goto("/simple/meetings");
        const live = page.getByRole("region", { name: "Live" });
        await expect(live).toContainText(`${ritual}: Guided setup`);
        // qa-simple-decide-34: a live review is listed under Live only.
        await expect(upcoming.getByRole("link", { name: "Open" })).toHaveCount(0);
        const after = await upcoming.getByRole("button", { name: "Start review" }).count();
        if (!phone) await expect(page.getByTestId("simple-nav-meetings-count")).toHaveText(String(after + 1));
        // A viewer reads the same list, and Home's next is its first row.
        await switchTo(page, "viewer@example.com");
        await page.goto("/simple/meetings");
        // qa-simple-decide-34: the live review is under Live, not Upcoming; Home's next opens it.
        await expect(page.getByRole("region", { name: "Live" })).toContainText(`${ritual}: Guided setup`);
        await page.goto("/simple");
        await expect(page.getByTestId("home-meeting-next")).toContainText(ritual);
        await expect(page.getByTestId("home-meeting-next").getByRole("link", { name: "Open meeting" })).toBeVisible();
      });

      test("Approve and Undo in a meeting: the one-pager reads its new version, no stale draft bar", async ({ page }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Start review" }).click();
        const sheet = page.getByRole("dialog", { name: "Start a review" });
        await sheet.getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        const onePager = page.getByTestId("meeting-screen").getByTestId("one-pager");
        await expect(onePager).toContainText("Version 3");
        await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
        await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
        await page.getByRole("button", { name: "Save" }).click();
        const bar = page.getByRole("status", { name: "Working draft" });
        await expect(bar).toContainText("1 change");
        await page.getByRole("note").filter({ hasText: "You changed “A setup checklist" }).filter({ visible: true }).getByRole("button", { name: "Undo" }).click();
        await expect(bar).toHaveCount(0);
        await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
        await page.getByLabel("New wording for").fill("A checklist that names the next step");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(bar).toContainText("1 change");
        await page.getByRole("button", { name: /^Approve one-pager edits/ }).click();
        await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Approved Guided setup (published)");
        await expect(onePager).toContainText("Version 4");
        await expect(onePager).not.toContainText("Version 3");
        await expect(page.getByRole("status", { name: "Working draft" })).toHaveCount(0);
        await expect(onePager).toContainText("A checklist that names the next step");
      });

      test("A second screen on the meeting reads the new version after Approve, without a reload", async ({ page, context }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Start review" }).click();
        await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
        await page.getByLabel("New wording for").fill("A checklist that names the next step");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
        const other = await context.newPage();
        await other.goto(page.url());
        const otherPager = other.getByTestId("meeting-screen").getByTestId("one-pager");
        await expect(otherPager).toContainText("Version 3");
        await expect(other.getByRole("status", { name: "Working draft" })).toContainText("1 change");
        await page.bringToFront();
        await page.getByRole("button", { name: /^Approve one-pager edits/ }).click();
        await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Approved Guided setup (published)");
        await other.bringToFront();
        await other.clock.runFor(6_000);
        await expect(otherPager).toContainText("Version 4");
        await expect(other.getByRole("status", { name: "Working draft" })).toHaveCount(0);
        await expect(otherPager).toContainText("A checklist that names the next step");
        await expect(other.getByRole("region", { name: "All decisions" })).toContainText("Approved Guided setup (published)");
      });

      test("A viewer reads Upcoming and Home's next review with no Start; Home says if its pre-read is ready", async ({ page }) => {
        await login(page, "viewer@example.com");
        await page.goto("/simple/meetings");
        const upcoming = page.getByRole("region", { name: "Upcoming" });
        await expect(upcoming.getByTestId("meetings-upcoming-row").first()).toBeVisible();
        await expect(upcoming.getByRole("button", { name: "Start review" })).toHaveCount(0);
        await page.goto("/simple");
        const next = page.getByTestId("home-meeting-next");
        await expect(next).toBeVisible();
        await expect(next.getByRole("link", { name: "Start review" })).toHaveCount(0);
        await expect(next.getByText(/Pre-read not ready yet|Open pre-read/)).toBeVisible();
      });

      test("A stale Start of an Upcoming review opens no next week's meeting", async ({ page, context }) => {
        await login(page);
        await page.goto("/simple/meetings");
        const upcoming = page.getByRole("region", { name: "Upcoming" });
        const row = upcoming.getByTestId("meetings-upcoming-row").filter({ hasText: "Weekly goals check-in" });
        await expect(row.getByRole("button", { name: "Start review" })).toBeVisible();
        // Another tab starts that review first; this page still shows its Start.
        const other = await context.newPage();
        await other.goto("/simple/meetings");
        await other.getByRole("region", { name: "Upcoming" }).getByTestId("meetings-upcoming-row").filter({ hasText: "Weekly goals check-in" }).getByRole("button", { name: "Start review" }).click();
        const otherSheet = other.getByRole("dialog", { name: "Start a review" });
        await otherSheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
        await otherSheet.getByRole("button", { name: "Start", exact: true }).click();
        await expect(other.getByRole("heading", { name: "Weekly goals check-in: Guided setup" })).toBeVisible();
        await page.bringToFront();
        await row.getByRole("button", { name: "Start review" }).click();
        const sheet = page.getByRole("dialog", { name: "Start a review" });
        await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
        await sheet.getByRole("button", { name: "Start", exact: true }).click();
        await expect(sheet).toContainText("This scheduled review has its meeting already");
        await page.goto("/simple/meetings");
        await expect(page.getByRole("region", { name: "Live" }).getByRole("link", { name: "Join" })).toHaveCount(1);
      });

      if (!phone) {
        test("Moving between Simple's pages does not read the meetings list again for the rail", async ({ page }) => {
          await login(page);
          await page.goto("/simple/roadmap");
          await expect(page.getByTestId("simple-nav-meetings-count")).toBeVisible();
          await page.evaluate(() => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls = []));
          await page.getByTestId("simple-nav-decisions").filter({ visible: true }).click();
          await expect(page).toHaveURL(/\/simple\/decisions/);
          await page.getByTestId("simple-nav-one-pagers").filter({ visible: true }).click();
          await expect(page).toHaveURL(/\/simple\/one-pagers/);
          await page.getByTestId("simple-nav-roadmap").filter({ visible: true }).click();
          await expect(page).toHaveURL(/\/simple\/roadmap/);
          await expect(page.getByTestId("simple-nav-meetings-count")).toBeVisible();
          const calls = await page.evaluate(() => (globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []);
          expect(calls.filter((c) => c === "GET /v1/simple/meetings")).toEqual([]);
        });
      }
    });
  }
}
