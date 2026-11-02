import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * walkc-meeting: a live Simple review meeting, as an end-to-end walk ran it, on the mock's
 * invented PRD "Guided setup", as the company's owner, desktop and phone.
 *
 * Card approve-problems: protects = an Approve the importer refuses lists its problems in
 * plain words, each with what to do, at most six and "And 2 more like these", under one
 * line that says it was not approved and how many problems there are; fails_when = the page
 * shows the raw "draft rejected: 8 problem(s)" or nothing; no_claim = the importer's checks
 * (api tests/test_walkc_meeting.py).
 */

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

async function startWithAnEdit(page: Page) {
  await login(page);
  await page.goto("/simple/prds/guided-setup");
  await page.getByRole("button", { name: "Start review" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill("A checklist that names the next step");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 } });

    test(`a refused Approve lists its problems in plain words (${where})`, async ({ page, context }) => {
      await flags(context, "approve-problems");
      await startWithAnEdit(page);
      await page.getByRole("button", { name: /^Approve and publish one-pager edits/ }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Approve and publish" }).click();
      const said = page.getByTestId("approve-problems");
      await expect(said).toContainText("Not approved: the draft has 8 problems to fix first.");
      await expect(said.getByRole("listitem")).toHaveCount(6);
      await expect(said.getByRole("listitem").first()).toContainText("The date Nov 20 (in What we will build) is not backed by a confirmed schedule");
      await expect(said.getByRole("listitem").first()).toContainText("record its basis on the roadmap or drop the date");
      await expect(said).toContainText("And 2 more like these.");
      await expect(page.getByText(/draft rejected/)).toHaveCount(0);
    });
  });
}
