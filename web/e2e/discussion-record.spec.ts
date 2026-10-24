import { expect, test, type Page } from "./test";

import { DISCUSSION_RECORD } from "../lib/api/mock/discussions";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * G3 Record (basis_record) through the UI, on the mock layer ("discussion-record" scenario):
 * in the open discussion on checkout-redesign v2's guest-checkout item, Oracle proposed
 * recording a date basis. The discussion's link (as the Inbox gives it) opens its thread in
 * the PRD's Feedback tab. Record follows F3 Date bases' rights (leads.date_rights): with no
 * engineering lead named an approver records it verified; a commenter who is not the lead
 * has no date rights, and Record says why.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_discussion_changes.py.
 */

const DOC = "/documents/checkout-redesign/v/2";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const RECORD = "Record a date basis: Team estimate supports 2026-12-15";
const RECORDERS = "Engineering leads and approvers record date bases";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussion-record"), MOCK_SCENARIO_KEY);
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const card = (page: Page) => thread(page).getByTestId("changes-card");
const change = (page: Page, label: string) => card(page).getByTestId("change-row").filter({ hasText: label });

async function openDiscussion(page: Page) {
  await page.goto(`${DOC}?discussion=${DISCUSSION_RECORD}`);
  await expect(thread(page)).toBeVisible();
}

// protects=criterion 8 (Record, F3 with no lead named): an approver's Record records the
// basis, the row moves to "1 handled" as Done, and the thread says who recorded what;
// fails_when=Record is missing or disabled for an approver, or the change stays open;
// no_claim=whether the basis is verified or proposed (the API's date rights, pytest).
test("an approver records the date basis Oracle proposed", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page);
  const row = change(page, RECORD);
  await expect(row.getByTestId("change-by")).toHaveText("Proposed by Oracle");
  await row.getByRole("button", { name: "Record" }).click();
  await expect(card(page).getByTestId("changes-handled").locator("summary")).toHaveText("1 handled");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Approver recorded: ${RECORD}`);
});

// protects=criterion 8 and #370: a commenter who is not the engineering lead has no date
// rights, so Record shows disabled with F3's reason; fails_when=a commenter can Record, or
// the reason is missing; no_claim=the API's 403 (pytest).
test("a commenter without date rights cannot record and sees why", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page);
  const record = change(page, RECORD).getByRole("button", { name: "Record" });
  await expect(record).toBeDisabled();
  await expect(record).toHaveAttribute("title", RECORDERS);
});
