import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * vqa-one-pager (e): a refused draft names its problem and offers its fix, never the bare
 * "draft rejected: 1 problem(s)". Driven through the UI on the mock's invented PRD
 * "guided-setup"; the submit's answer is the API's ImportErrorResponse for a date with no
 * verified source (api/tests/test_one_pager_draft_dates.py), served for this one call.
 *
 * Card one-pager-draft-refused: protects = Send for approval refused for an unbacked date
 * shows the date's problem in words and an "Add a date source" link to Plan › Dates for the
 * PRD, filtered to the day; fails_when = the page says only how many problems there are, or
 * no fix is offered; no_claim = which dates the API refuses (the pytest file above).
 */

const URL = "/simple/prds/guided-setup";
const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });
const PRD_ID = "00000000-0000-4000-8000-0000000000e5";
const MESSAGE =
  'the date Dec 15, 2026 ("What we will build", line 2) is not backed by a confirmed schedule: no verified estimate, capacity or commitment of the PRD "Guided setup" for this item; add a date source on Plan › Dates (or ask the engineering lead to) or drop the date. Oracle never invents dates';

test("a refused draft names its unbacked date and links to its fix", async ({ page }) => {
  await login(page);
  await page.route("**/v1/simple/drafts/*/submit", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        detail: `draft rejected: ${MESSAGE}`,
        errors: [
          {
            code: "unverified_date",
            message: MESSAGE,
            section_key: "build",
            refs: { date: "Dec 15, 2026", shown: "Dec 15, 2026", day: "2026-12-15" },
            fix: { action: "add_date_source", prd_document_id: PRD_ID, days: ["2026-12-15"] },
          },
        ],
      }),
    }),
  );
  await page.goto(URL);
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill("A setup checklist live by Dec 15, 2026");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(bar(page)).toContainText("1 change");
  await bar(page).getByRole("button", { name: "Send for approval…" }).click();
  await page.getByTestId("send-for-approval").getByRole("button", { name: "Send for approval" }).click();

  await expect(page.getByText("is not backed by a confirmed schedule")).toBeVisible();
  await expect(page.getByText("problem(s)")).toHaveCount(0);
  const fix = page.getByTestId("draft-fix");
  await expect(fix).toHaveText("Add a date source");
  await expect(fix).toHaveAttribute("href", `/plan/dates?prd=${PRD_ID}&dates=2026-12-15`);
  await fix.click();
  await expect(page).toHaveURL(/\/plan\/dates\?prd=/);
});
