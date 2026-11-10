import { stableUuid } from "../lib/api/mock/ids";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * vqa-one-pager (e): a refused draft names its problem and offers its fix, never the bare
 * "draft rejected: 1 problem(s)". Driven through the UI on the mock's invented PRD
 * "guided-setup"; the mock's submit refuses the edited line's date, which has no date source,
 * with the API's ImportErrorResponse (api/tests/test_one_pager_draft_dates.py).
 *
 * Card one-pager-draft-refused: protects = Send for approval refused for an unbacked date
 * shows the date's problem in words and an "Add a date source" link to Plan › Dates for the
 * PRD, filtered to the day; fails_when = the page says only how many problems there are, or
 * no fix is offered; no_claim = which dates the API refuses (the pytest file above).
 */

const URL = "/simple/prds/guided-setup";
const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });
// The mock's PRD "guided-setup" (web/lib/api/mock/simple-one-pager.ts DOC_ID).
const PRD_ID = stableUuid("simple-one-pager-doc");

test("a refused draft names its unbacked date and links to its fix", async ({ page }) => {
  await login(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill("A setup checklist live by Dec 15, 2026");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(bar(page)).toContainText("1 change");
  await bar(page).getByRole("button", { name: "Send for approval…" }).click();
  await page.getByTestId("send-for-approval").getByRole("button", { name: "Send for approval" }).click();

  await expect(page.getByText('the date Dec 15, 2026 ("What we will build", line 1) is not backed by a confirmed schedule')).toBeVisible();
  await expect(page.getByText("problem(s)")).toHaveCount(0);
  const fix = page.getByTestId("draft-fix");
  await expect(fix).toHaveText("Add a date source");
  await expect(fix).toHaveAttribute("href", `/plan/dates?prd=${PRD_ID}&dates=2026-12-15`);
  await fix.click();
  await expect(page).toHaveURL(/\/plan\/dates\?prd=/);
});
