import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #329 New request: a person files a request on the Requests screen, driven through the UI
 * as a person would, on the mock API. Synthetic placeholders only.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const TITLE = "Reorder a past basket in one click";
const WHY = "Buyers order the same things every week and build the basket again by hand each time.";

async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
}

const row = (page: Page, title: string) => page.getByTestId("request-row").filter({ hasText: title });

test("New request: file one with a goal; it shows as New with its goal chip, selected, and survives a reload", async ({ page }) => {
  // protects=#329 Done when 1 (New request opens the dialog, File request creates it as New in
  // the In app channel, selected in the list with its goal chip, kept after a reload);
  // fails_when=the dialog is missing, the request is not listed as New with its goal, or it is
  // gone after a reload; no_claim=the real API (tests/test_requests.py) and triage.
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();

  const dialog = page.getByRole("dialog", { name: "New request" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Channel").locator("option:checked")).toHaveText("In app");
  await expect(dialog.getByLabel("Requester")).toHaveValue("Admin");
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog.getByText("Give the request a title")).toBeVisible();

  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog.getByText("Say what it is and why")).toBeVisible();
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("checkbox", { name: "Raise activation" }).check();
  await dialog.getByRole("button", { name: "File request" }).click();

  await expect(dialog).toBeHidden();
  const filed = row(page, TITLE);
  await expect(filed).toHaveAttribute("aria-current", "true");
  await expect(filed).toContainText("New");
  await expect(filed).toContainText("In app");
  await expect(filed.getByTestId("goal-chip")).toHaveText(["Raise activation"]);

  await page.reload();
  await expect(row(page, TITLE)).toContainText("New");
  await expect(row(page, TITLE).getByTestId("goal-chip")).toHaveText(["Raise activation"]);
});

test("New request: a viewer is not shown it (#370)", async ({ page }) => {
  // protects=#329 rule 4 (a viewer cannot file) and #370 (a control a role can never use is
  // hidden, not disabled); fails_when=a viewer sees New request; no_claim=the API's 403
  // (tests/test_requests.py).
  await login(page, "viewer@example.com");
  await openRequests(page);
  await expect(page.getByTestId("view-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "New request" })).toHaveCount(0);
});

test("New request: only an owner names someone else as the requester", async ({ page }) => {
  // protects=#329 rule 1 (Requester defaults to the signed-in member; an owner can name
  // someone else); fails_when=a commenter can change it; no_claim=the API check.
  await login(page, "commenter@example.com");
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await expect(dialog.getByLabel("Requester")).toHaveValue("Commenter");
  await expect(dialog.getByLabel("Requester")).not.toBeEditable();
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, TITLE)).toContainText("Commenter");
});

test("Empty Requests: the empty state points to New request", async ({ page }) => {
  // protects=#329 Done when 3; fails_when=the empty state does not lead to New request;
  // no_claim=the seeded company. qa-shell-10: the header's New request is the one button.
  await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
  await login(page);
  await openRequests(page);
  const empty = page.getByTestId("requests-empty");
  await expect(empty).toContainText("No requests yet. Add one with New request.");
  await page.getByTestId("requests-actions").getByRole("button", { name: "New request" }).click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(row(page, TITLE)).toContainText("New");
  await expect(page.getByTestId("requests-empty")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("New request: the dialog is a full-height sheet at 390 px", async ({ page }) => {
    // protects=#329 rule 5 (and New request fits the phone header); fails_when=the dialog is
    // shorter than the screen, or it or the header overflows;
    // no_claim=other widths.
    await login(page);
    await page.getByTestId("tab-bar").getByTestId("tab-more").click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Requests" }).click();
    await expect(page).toHaveURL(/\/requests$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "New request" }).first().click();
    const box = (await page.getByRole("dialog", { name: "New request" }).boundingBox())!;
    expect(box.y).toBeLessThanOrEqual(0.5);
    expect(box.height).toBeGreaterThanOrEqual(843.5);
    expect(box.width).toBeLessThanOrEqual(390.5);
  });
});
