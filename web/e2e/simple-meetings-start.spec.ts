import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Simple S8 (#723): starting a review meeting, driven through the UI on the mock's invented
 * data (./lib/api/mock/simple-meetings.ts): the Meetings page, the start sheet from the
 * Meetings page, a scheduled review, a one-pager and the roadmap, and who may start one.
 *
 * Card meetings-start: protects = the Meetings page lists Upcoming (a scheduled review with
 * Start review), Live and Past (with its minutes' summary and a link to its decisions);
 * the start sheet shows what is reviewed, the default attendees checked, the change mode
 * and the length, and Start opens the meeting screen; the sheet opens from a scheduled
 * review (its name and length prefilled), a one-pager (the PRD fixed) and the roadmap (a
 * PRD picker); fails_when = a section or an entry point is missing, the defaults are not
 * checked, or Start does not open the meeting; no_claim = the ritual's scheduling (Detailed).
 *
 * Card meetings-who-starts: protects = an owner and the PRD's decider (Dana Decider, an
 * approver, in "simple-deciders") get a Start button; an approver, a commenter and a viewer
 * read "Only <names> can start this review" with no Start, and a commenter joins a live
 * meeting from the sheet and from the meeting screen; fails_when = someone else can start,
 * the starters' names are missing, or Join does not add them; no_claim = the API's 403
 * (api/tests).
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

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });

async function meetings(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("the Meetings page lists upcoming, live and past; an owner starts a review", async ({ page }) => {
        await meetings(page);
        await expect(page.getByRole("region", { name: "Upcoming" })).toContainText("Weekly goals check-in");
        await expect(page.getByRole("region", { name: "Live" })).toContainText("No meeting is on now.");
        const past = page.getByRole("region", { name: "Past" });
        await expect(past).toContainText("Review: Usage alerts");
        // qa-simple-decide-1 / -6: a comment is no decision and the summary is prose.
        await expect(past).not.toContainText("Comment:");
        await expect(past.getByRole("link", { name: "Its decisions" })).toHaveAttribute("href", /\/simple\/decisions\?meeting=/);
        await page.getByRole("button", { name: "Start review" }).first().click();
        const s = sheet(page);
        await expect(s.getByRole("region", { name: "What is reviewed" })).toContainText("The PRD, its roadmap slice, its open decisions");
        await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
        await expect(s.getByRole("checkbox", { name: "Admin" })).toBeChecked();
        await expect(s.getByRole("checkbox", { name: "Approver" })).toBeChecked();
        await expect(s.getByRole("checkbox", { name: "Commenter" })).not.toBeChecked();
        await s.getByRole("checkbox", { name: "Commenter" }).check();
        await s.getByRole("radio", { name: "Presenter plus one or two people" }).check();
        await s.getByLabel("Who else changes things").getByRole("checkbox", { name: "Commenter" }).check();
        await expect(s.getByLabel("Length")).toHaveValue("60");
        await s.getByLabel("Length").selectOption("45");
        await s.getByRole("button", { name: "Start", exact: true }).click();
        await expect(page).toHaveURL(/\/simple\/meetings\/[0-9a-f-]+$/);
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await expect(page.getByRole("timer", { name: "Meeting clock" })).toContainText("/ 45:00");
        // qa-simple-decide-29: on a phone the attendees and the mode fold into one row.
        if (phone) await page.getByTestId("meeting-people-toggle").click();
        await expect(page.getByLabel("Attendees")).toContainText("Commenter");
        await expect(page.getByTestId("change-mode").getByRole("combobox")).toHaveValue("named");
        await page.getByTestId("meeting-screen").getByRole("link", { name: "Meetings" }).click();
        await expect(page.getByRole("region", { name: "Live" })).toContainText("Review: Guided setup");
      });

      test("a scheduled review, a one-pager and the roadmap open the start sheet", async ({ page }) => {
        await meetings(page);
        await page.getByRole("region", { name: "Upcoming" }).getByRole("button", { name: "Start review" }).first().click();
        await expect(sheet(page).getByTestId("start-occurrence")).toContainText(/Weekly goals check-in|Monthly roadmap refresh|Quarterly goals review/);
        // The ritual's attendees (the owners and approvers) are checked.
        await expect(sheet(page).getByRole("checkbox", { name: "Approver" })).toBeChecked();
        await sheet(page).getByRole("button", { name: "Close" }).click();
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Start review" }).click();
        await expect(sheet(page).getByRole("region", { name: "What is reviewed" })).toContainText("Guided setup");
        await expect(sheet(page).getByLabel("PRD")).toHaveCount(0);
        // qa-simple-decide-35: a review needs one attendee besides the presenter.
        await sheet(page).getByRole("checkbox", { name: "Commenter" }).check();
        await sheet(page).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.goto("/simple/roadmap");
        await expect(page.getByTestId("simple-roadmap")).toBeVisible();
        await page.getByRole("button", { name: "Start review" }).click();
        await expect(sheet(page).getByLabel("PRD")).toBeVisible();
        await sheet(page).getByLabel("PRD").selectOption({ label: "Usage alerts" });
        await sheet(page).getByRole("checkbox", { name: "Commenter" }).check();
        await sheet(page).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Usage alerts" })).toBeVisible();
      });

      for (const [email, role] of [["approver@example.com", "an approver"], ["commenter@example.com", "a commenter"], ["viewer@example.com", "a viewer"]] as const) {
        test(`${role} sees who starts a review and cannot start it`, async ({ page }) => {
          await meetings(page, email);
          // qa-simple-decide-8: no dead-end Start review; the reason stands in its place.
          await expect(page.getByTestId("meetings-start-why")).toContainText("An owner or a review's owner starts reviews");
          await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
        });
      }

      test("a commenter joins a live meeting an owner started", async ({ page }) => {
        await meetings(page);
        await page.getByRole("button", { name: "Start review" }).first().click();
        await sheet(page).getByLabel("PRD").selectOption({ label: "Guided setup" });
        await sheet(page).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.goto("/simple/meetings");
        await switchTo(page, "commenter@example.com");
        await page.goto("/simple/meetings");
        await page.getByRole("region", { name: "Live" }).getByRole("link", { name: "Join" }).first().click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await expect(page.getByLabel("Attendees")).not.toContainText("Commenter");
        await page.getByRole("button", { name: "Join" }).click();
        await expect(page.getByLabel("Attendees")).toContainText("Commenter");
        await expect(page.getByRole("button", { name: "Join" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Approve one-pager edits/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "End meeting" })).toHaveCount(0);
      });
    });
  }
}

test.describe("the PRD's decider", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-deciders"), MOCK_SCENARIO_KEY);
  });

  for (const phone of [false, true]) {
    test(`Dana Decider starts Guided setup's review; an approver may not (${phone ? "phone" : "desktop"})`, async ({ page }) => {
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1366, height: 820 });
      await meetings(page, "approver@example.com");
      // qa-simple-decide-8: an approver who starts no review gets the reason, not the button.
      await expect(page.getByTestId("meetings-start-why")).toBeVisible();
      await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
      await switchTo(page, "dana.decider@example.com");
      await page.goto("/simple/meetings");
      await page.getByRole("button", { name: "Start review" }).first().click();
      await sheet(page).getByLabel("PRD").selectOption({ label: "Guided setup" });
      await expect(sheet(page).getByRole("checkbox", { name: "Dana Decider" })).toBeChecked();
      await sheet(page).getByRole("button", { name: "Start", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
      await expect(page.getByLabel("Attendees")).toContainText("decider");
      // qa-simple-decide-2: Approve shows once the meeting has one-pager edits to approve.
      await expect(page.getByRole("button", { name: /^Approve one-pager edits/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "End meeting" })).toBeVisible();
    });
  }
});
