import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * The walk-fixes review, round 2: the next review's attendees, driven through the UI on the
 * mock's built-in rituals (./lib/api/mock/simple-meetings.ts, ./lib/api/mock/rituals.ts).
 *
 * Card walk-review2-attendees: protects = after an owner holds a ritual's review with an
 * extra attendee, the next review (Home's "Next review meeting") lists who was present;
 * once an owner edits the ritual's attendees in Company > Rituals after that review, it
 * lists the edited ones (the API's rituals.attendees_edited_at), not the past attendees;
 * fails_when = the past attendees stay listed after the edit, or the edit is not what
 * decides (the API read updated_at, which the scheduler moves); no_claim = the scheduler's
 * tick itself (api tests: test_simple_walk_fixes_review2_api). Walk fixes 3 (M2) un-fixed it:
 * the held review leaves Upcoming and the next one reads the ritual's live attendees.
 */

test.use({ viewport: { width: 1366, height: 820 } });

test("the next review lists who was present until the ritual's attendees are edited", async ({ page }) => {
  await login(page);
  // Detailed's rituals first (the mock seeds them on first read).
  await page.goto("/company/rituals");
  await expect(page.getByTestId("ritual-row").first()).toBeVisible();
  await page.goto("/simple/meetings");
  const first = page.getByRole("region", { name: "Upcoming" }).getByTestId("meetings-upcoming-row").first();
  const title = (await first.locator("strong").innerText()).trim();
  await first.getByRole("button", { name: "Start review" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByLabel("Attendees")).toContainText("Theo Brandt");
  // The review is held: end it, so Home's next review is the ritual's next one, not this live one.
  await page.getByRole("button", { name: "End meeting" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByRole("button", { name: "End meeting" })).toHaveCount(0);
  await page.goto("/simple");
  const next = page.getByTestId("home-meeting-next");
  await expect(next).toContainText("Theo Brandt");
  await expect(next).not.toContainText("Lena Ortiz");

  // An owner edits the ritual's attendees after the review: its list is the list.
  await page.goto("/company/rituals");
  const ritualRow = page.getByTestId("ritual-row").filter({ hasText: title });
  await ritualRow.click();
  const panel = page.getByTestId("ritual-inspector").filter({ visible: true });
  await panel.getByRole("checkbox", { name: "viewer@example.com" }).check();
  await expect(panel.getByTestId("ritual-no-changes")).toHaveCount(0);
  await panel.getByRole("button", { name: "Save" }).click();
  // The save has landed when the inspector holds no unsaved change again (the ticked box proves
  // nothing; with the inspector open the table drops its Attendees column, qa-company-22).
  await expect(panel.getByTestId("ritual-no-changes")).toBeVisible();

  await page.goto("/simple");
  await expect(page.getByTestId("home-meeting-next")).toContainText("Lena Ortiz");
  await expect(page.getByTestId("home-meeting-next")).not.toContainText("Theo Brandt");
});
