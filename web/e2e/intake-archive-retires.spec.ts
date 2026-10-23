import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * Archiving a brief retires its questions (issue #307), driven through the UI of the mock build.
 *
 * Test cards:
 * - "archive retires": protects=archiving a brief takes its questions out of Inbox › Needs you
 *   and the badge at once, and its page keeps them as history without Answer, its panel saying
 *   it is archived; fails_when=a row or the count stays, an Answer button is offered, or the
 *   panel still reads "Ready to draft"; no_claim=restoring (the UI offers none).
 * - "critical open": protects=the panel never reads "Ready to draft" while a Critical question
 *   is open, and names what is missing; fails_when=it does; no_claim=the draft gate's rule.
 */

const TITLE = "Saved addresses for repeat buyers";
const badge = (page: Page) => page.getByTestId("nav-inbox-badge").filter({ visible: true });

async function newBrief(page: Page) {
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill(TITLE);
  await page
    .getByRole("textbox", { name: "What problem does it solve?" })
    .fill("Returning buyers retype their address at every checkout. Saved addresses would make repeat checkout faster.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
}

async function openInbox(page: Page) {
  await page.getByTestId("nav-inbox").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
}

const briefRows = (page: Page) =>
  page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("tr[data-row]").filter({ hasText: `Before drafting · ${TITLE}` });

test("archiving a brief takes its questions out of the Inbox and its page offers no Answer", async ({ page }) => {
  await login(page, "approver@example.com");
  await newBrief(page);
  const brief = page.url();
  const panel = page.getByTestId("ready-to-draft");
  await expect(page.getByRole("button", { name: "Answer" }).first()).toBeVisible();
  const asked = await page.getByTestId("question").filter({ has: page.getByRole("button", { name: "Answer" }) }).count();
  expect(asked).toBeGreaterThan(0);

  const questions = await page.getByTestId("question").count();

  // A new brief has Critical questions open, none a blocker: never "Ready to draft"; what is
  // missing is named.
  await expect(panel).not.toContainText("Ready to draft");
  await expect(panel).toContainText(/critical questions? open/);
  await expect(panel.getByTestId("missing-gap").first()).toBeVisible();

  await openInbox(page);
  await expect(briefRows(page)).toHaveCount(asked);
  const before = Number(await badge(page).innerText());

  await page.goBack();
  await expect(page).toHaveURL(brief);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("alertdialog", { name: "Archive" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("intake-status")).toHaveText("Archived");

  // The badge drops at once, before any reload.
  await expect(badge(page)).toHaveText(String(before - asked));
  // Kept as history, without Answer; the panel says it is archived.
  await expect(page.getByTestId("question")).toHaveCount(questions);
  await expect(page.getByTestId("question").first()).toContainText("Retired");
  await expect(page.getByRole("button", { name: "Answer" })).toHaveCount(0);
  await expect(panel).toContainText("Archived");
  await expect(panel).not.toContainText("Ready to draft");

  await openInbox(page);
  await expect(briefRows(page)).toHaveCount(0);
  await expect(badge(page)).toHaveText(String(before - asked));
});
