import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * One-pager number fix follow-ups (review, Nov 7), on the mock's invented PRD "guided-setup".
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=two number fixes in one section ("one-pager-two-counts": the heading's "Later · 8
 *   items" and "Five features wait for next quarter" under it) each undo: Undo on the older
 *   puts its number back and leaves the newer's, then the newer undoes too; fails_when=the
 *   older's Undo is refused ("Changed by ...") while both show Undo; no_claim=the API's
 *   test_either_of_two_fixes_in_a_section_undoes.
 * - protects=while the PRD's draft is in review an owner's line edit is refused in the API's
 *   words ("This PRD's draft is in review: ..."), and the line stays as it was;
 *   fails_when=the mock applies the edit in review.
 * - protects=a decimal target keeps its number as written: "300.5 per region × 5 regions"
 *   against "1,250.75" company-wide offers "Use 1,502.50" and sets the section to it;
 *   fails_when=the fix drops the separators or the places ("Use 1502.5"); no_claim=the API's
 *   test_a_fix_keeps_a_decimal_as_written.
 * - protects=the look text quotes a target as written ("1,250.75") and writes a sum as a person
 *   does ("0.3", "1,234,567.5"); fails_when=it shows "1250.75", "0.30000000000000004" or
 *   "1234567.5"; no_claim=the API's test_look_numbers_read_as_a_person_writes_them.
 * - protects=a sum that matches as written raises no look: after "Use 0.3" the target reads
 *   "0.3" and "0.1 × 3 teams" no longer shows; fails_when=the float 0.30000000000000004 keeps
 *   "is 0.3, but the company-wide target says 0.3"; no_claim=the API's
 *   test_a_sum_that_matches_as_written_raises_no_look.
 * - protects=an exact half past the 6th place rounds up as the API does ("3.007813" in the
 *   text and the fix); fails_when=it shows "3.007812"; no_claim=the API's
 *   test_an_exact_half_rounds_up_as_the_mock_does.
 * - protects=after the heading's fix, the words under it fixed and Undo on the words, the
 *   heading's own fix still undoes (one undo path for lines and numbers); fails_when=the
 *   second Undo is refused or leaves the heading at 6; no_claim=a heading edited away from
 *   its number (the API's test_heading_fix_whose_number_left_the_heading_is_refused).
 */

const URL = "/simple/one-pagers/guided-setup";
const IN_REVIEW = "This PRD's draft is in review: changes wait until it is approved";

const look = (page: Page) => page.getByRole("region", { name: "Needs a look" });
const fixed = (page: Page) => look(page).getByTestId("needs-look-fixed");
const bar = (page: Page) => page.getByRole("status", { name: "Working draft" });

async function scenario(page: Page, s: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, s] as const);
}

test("either of two number fixes in one section undoes", async ({ page }) => {
  await scenario(page, "one-pager-two-counts");
  await login(page);
  await page.goto(URL);
  // The heading's count first (8 to 6), then the words under it, which now disagree with 6.
  await look(page).getByRole("button", { name: "Use 6" }).click();
  await expect(fixed(page)).toHaveCount(1);
  await look(page).getByRole("button", { name: "Use 6" }).click();
  await expect(fixed(page)).toHaveCount(2);
  await expect(fixed(page).getByRole("button", { name: "Undo" })).toHaveCount(2);
  await expect(bar(page)).toContainText("2 changes");
  // Undo the older: its number goes back, the newer stays.
  await fixed(page).first().getByRole("button", { name: "Undo" }).click();
  await expect(fixed(page)).toHaveCount(1);
  await expect(page.getByRole("alert").filter({ hasText: /Changed/ })).toHaveCount(0);
  await expect(bar(page)).toContainText("1 change");
  // The heading reads 8 again (its fix offered), and the words, now six, disagree with it.
  await expect(look(page).getByRole("button", { name: "Use 6" })).toBeVisible();
  await expect(look(page).getByRole("button", { name: "Use 8" })).toBeVisible();
  await fixed(page).getByRole("button", { name: "Undo" }).click();
  await expect(fixed(page)).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /Changed/ })).toHaveCount(0);
});

test("a line edit while the PRD's draft is in review is refused in the API's words", async ({ page }) => {
  await login(page);
  await page.goto(URL);
  await look(page).getByRole("button", { name: "Use 200" }).click();
  await expect(fixed(page)).toHaveCount(1);
  await bar(page).getByRole("button", { name: "Send for approval…" }).click();
  await page.getByTestId("send-for-approval").getByRole("button", { name: "Send for approval" }).click();
  await expect(bar(page).getByTestId("draft-waits-on")).toContainText("Sent for approval · waiting on");
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert").filter({ hasText: IN_REVIEW })).toBeVisible();
  const line = page.locator('[data-line="bets-1"]');
  await expect(line).not.toHaveAttribute("data-state", "edited");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(line).toContainText("A setup checklist that shows");
  await expect(line).not.toContainText("A setup checklist with the next two steps");
});

test("a decimal target's fix keeps the number as written", async ({ page }) => {
  await scenario(page, "one-pager-two-counts");
  await login(page);
  await page.goto(URL);
  await expect(look(page)).toContainText("is 1,502.5, but the company-wide target says 1,250.75.");
  await look(page).getByRole("button", { name: "Use 1,502.50" }).click();
  await expect(fixed(page)).toHaveCount(1);
  await expect(fixed(page)).toContainText("Fixed: set to 1,502.50 in “Targets”");
  await expect(look(page).getByRole("button", { name: /^Use 1,?502/ })).toHaveCount(0);
});

test("the look text writes its numbers as a person does", async ({ page }) => {
  await scenario(page, "one-pager-two-counts");
  await login(page);
  await page.goto(URL);
  await expect(look(page)).toContainText(
    "300.5 paid workspaces per region × 5 regions is 1,502.5, but the company-wide target says 1,250.75.",
  );
  await expect(look(page)).toContainText(
    "246,913.5 trial seats per region × 5 regions is 1,234,567.5, but the company-wide target says 1,000,000.",
  );
  await expect(look(page)).toContainText(
    "0.1 support hours per team × 3 teams is 0.3, but the company-wide target says 2.",
  );
  await expect(look(page)).not.toContainText(/0\.30000|1234567|1250\.75/);
});

test("a sum that matches as written raises no look", async ({ page }) => {
  await scenario(page, "one-pager-two-counts");
  await login(page);
  await page.goto(URL);
  await expect(look(page)).toContainText("0.1 support hours per team × 3 teams is 0.3, but the company-wide target says 2.");
  await look(page).getByRole("button", { name: "Use 0.3" }).click();
  await expect(fixed(page)).toContainText("Fixed: set to 0.3 in “Targets”");
  await expect(look(page)).toContainText("is 1,502.5, but the company-wide target says 1,250.75.");
  await expect(look(page)).not.toContainText("support hours per team");
  await expect(look(page).getByRole("button", { name: "Use 0.3" })).toHaveCount(0);
});

test("an exact half past the 6th place rounds up as the API does", async ({ page }) => {
  await scenario(page, "one-pager-two-counts");
  await login(page);
  await page.goto(URL);
  await expect(look(page)).toContainText(
    "1.503906 setup minutes per squad × 2 squads is 3.007813, but the company-wide target says 3.",
  );
  await expect(look(page).getByRole("button", { name: "Use 3.007813" })).toBeVisible();
});

test("a heading fix undoes after the words under it were fixed and undone", async ({ page }) => {
  await scenario(page, "one-pager-two-counts");
  await login(page);
  await page.goto(URL);
  await look(page).getByRole("button", { name: "Use 6" }).click();
  await expect(fixed(page)).toHaveCount(1);
  await look(page).getByRole("button", { name: "Use 6" }).click();
  await expect(fixed(page)).toHaveCount(2);
  // The newer (the words) first, then the heading's own fix.
  await fixed(page).last().getByRole("button", { name: "Undo" }).click();
  await expect(fixed(page)).toHaveCount(1);
  await expect(look(page).getByRole("button", { name: "Use 6" })).toBeVisible();
  await fixed(page).getByRole("button", { name: "Undo" }).click();
  await expect(fixed(page)).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /Changed/ })).toHaveCount(0);
  await expect(look(page)).toContainText("“Later · 8 items” says 8 items, but it lists 6.");
});
