import { MINUTES_LATER_MS, MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * Simple S8 (#723), two production findings after train W, driven through the UI on the
 * mock's invented PRD "Guided setup" (./lib/api/mock/simple-meetings.ts), desktop and
 * phone, light and dark, as the company's owner (who approves and ends a meeting).
 *
 * Card approve-publishes: protects = on a PRD with no required reviewer (started from an
 * empty skeleton) the meeting's Approve publishes: the banner reads "published", the
 * decision "Approved Guided setup (published)", and the PRD's one-pager, opened again
 * outside the meeting, reads "Version 4" with the edited line and no working draft;
 * fails_when = the banner says published while the one-pager stays on Version 3 or keeps
 * its draft; no_claim = the review policy itself: the mock publishes here whatever the API
 * does, so this card pins the screen and the mock together, and the API's real fix is
 * test_simple_meetings_approve's (test_required_sections_without_reviewers_publish).
 *
 * Card approve-waits-on-reviewer: protects = with the required reviewer marked absent,
 * Approve says "not yet published: Waiting on Approver's approval" in the banner and the
 * decision, and the one-pager stays on Version 3 with its working draft, whose bar says the
 * same; fails_when = the banner or decision says "published" for a version that is not, or
 * the decision or the bar words it otherwise than the banner; no_claim = the reviewer's own
 * approve (api tests).
 *
 * Card approve-section-reviewer: protects = a required section whose named reviewer is
 * absent holds publishing and the draft waits on them (their Inbox request): "Waiting on
 * Commenter's approval" in the banner, the decision and the one-pager's draft bar;
 * fails_when = the banner says "published" or the draft does not wait on them;
 * no_claim = how the API words several sections.
 *
 * Card approve-needs-reviewer: protects = a decider's approval held only by a required
 * section with nobody to approve it shows on the one-pager's draft bar ("Sections What we
 * will build need a reviewer"); fails_when = the bar shows nothing for it.
 *
 * Card minutes-later: protects = the end screen reads the meeting again until the
 * minutes job ends, with no reload: "Drafting…" turns into Oracle's minutes in the
 * Summary with Send enabled a few seconds after the job answers (20 s after End on the
 * mock clock); fails_when = "Drafting…" stays until a reload, or the screen reads again
 * only every 15 s; no_claim = the job runner.
 *
 * Card minutes-later-failed: protects = a job that fails after End turns the end screen
 * into the failed state with Draft again, with no reload; fails_when = "Drafting…" stays;
 * no_claim = Draft again itself (simple-meetings-walk).
 */

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

async function startWithAnEdit(page: Page, absent?: string) {
  await login(page);
  await page.goto("/simple/prds/guided-setup");
  await page.getByRole("button", { name: "Start review" }).click();
  // qa-simple-decide-35: a review needs one attendee besides the presenter.
  await page.getByRole("dialog", { name: "Start a review" }).getByRole("checkbox", { name: "Commenter" }).check();
  await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  if (absent) {
    const here = page.getByRole("button", { name: `${absent} is here` });
    await here.click();
    await expect(here).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.getByTestId("meeting-screen").getByTestId("one-pager")).toContainText("Version 3");
  await page.getByRole("button", { name: "Edit line 2" }).click();
  await page.getByLabel("Line 2").fill("A checklist that names the next step");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
  await page.getByRole("button", { name: /^Approve one-pager edits/ }).click();
}

async function onePagerOutside(page: Page) {
  await page.goto("/simple/prds/guided-setup");
  const pager = page.getByTestId("one-pager");
  await expect(pager).toBeVisible();
  return pager;
}

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

const minutesRegion = (page: Page) => page.getByRole("region", { name: "Minutes" });

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("Approve on a PRD with no required reviewer publishes: the banner, the decision and the one-pager agree", async ({ page, context }) => {
        await flags(context, "no-reviewers");
        await startWithAnEdit(page);
        await expect(page.getByTestId("approved-banner")).toHaveText("Approved in Review: Guided setup · published");
        await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Approved Guided setup (published)");
        const pager = await onePagerOutside(page);
        await expect(pager).toContainText("Version 4");
        await expect(pager).toContainText("A checklist that names the next step");
        await expect(page.getByRole("status", { name: "Working draft" })).toHaveCount(0);
      });

      test("Approve with the required reviewer absent says what it waits on, and the one-pager stays published", async ({ page }) => {
        await startWithAnEdit(page, "Approver");
        const banner = page.getByTestId("approved-banner");
        await expect(banner).toHaveText("Approved in Review: Guided setup · not yet published: Waiting on Approver's approval");
        await expect(banner).not.toContainText("· published");
        await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Approved Guided setup (not yet published: Waiting on Approver's approval)");
        await expect(page.getByRole("region", { name: "All decisions" })).not.toContainText("(published)");
        const pager = await onePagerOutside(page);
        await expect(pager).toContainText("Version 3");
        await expect(pager).not.toContainText("Version 4");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText(
          "Approved in Review: Guided setup · not yet published: Waiting on Approver's approval",
        );
      });

      test("Approve with a required section's reviewer absent waits on that person", async ({ page, context }) => {
        await flags(context, "section-reviewer");
        await startWithAnEdit(page);
        await expect(page.getByTestId("approved-banner")).toHaveText(
          "Approved in Review: Guided setup · not yet published: Waiting on Commenter's approval",
        );
        await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Approved Guided setup (not yet published: Waiting on Commenter's approval)");
        const pager = await onePagerOutside(page);
        await expect(pager).toContainText("Version 3");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText(
          "Approved in Review: Guided setup · not yet published: Waiting on Commenter's approval",
        );
      });

      test("Approve held by a required section with nobody to approve it says so on the one-pager", async ({ page, context }) => {
        await flags(context, "section-needs-reviewer");
        await startWithAnEdit(page);
        await expect(page.getByTestId("approved-banner")).toHaveText(
          "Approved in Review: Guided setup · not yet published: Sections What we will build need a reviewer",
        );
        const pager = await onePagerOutside(page);
        await expect(pager).toContainText("Version 3");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText(
          "Approved in Review: Guided setup · not yet published: Sections What we will build need a reviewer",
        );
      });

      test("The end screen shows Oracle's minutes when the job answers later, without a reload", async ({ page, context }) => {
        await flags(context, "minutes-later");
        await endOne(page);
        const minutes = minutesRegion(page);
        await expect(minutes.getByText("Drafting…")).toBeVisible();
        await page.clock.runFor(MINUTES_LATER_MS + 4_000);
        await expect(minutes.getByText("Drafting…")).toHaveCount(0);
        await expect(minutes.getByLabel("Summary")).toHaveValue("Oracle's minutes of Review: Guided setup: 1 decisions taken.");
        await expect(page.getByRole("region", { name: "Delivery" }).getByRole("button", { name: "Send" })).toBeEnabled();
      });

      test("The end screen turns to the failed state with Draft again when the job fails later, without a reload", async ({ page, context }) => {
        await flags(context, "minutes-later-failed");
        await endOne(page);
        const minutes = minutesRegion(page);
        await expect(minutes.getByText("Drafting…")).toBeVisible();
        await page.clock.runFor(MINUTES_LATER_MS + 4_000);
        await expect(minutes.getByText("Drafting…")).toHaveCount(0);
        await expect(minutes.getByTestId("minutes-failed")).toContainText("Oracle could not draft the minutes");
        await expect(minutes.getByRole("button", { name: "Draft again" })).toBeVisible();
      });
    });
  }
}
