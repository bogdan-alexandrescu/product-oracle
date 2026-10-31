import { expect, test, type BrowserContext, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, signOut } from "./helpers";

/**
 * e2e-review-live: a PRD version's review page shows other reviewers' work without a reload.
 * Two reviewers on one version: the owner in one tab, the approver in a second tab of the same
 * browser (the mock's data is the browser's, each tab keeps its own sign-in). The owner's page
 * refreshes its review state on window focus, and every few seconds while a run review is
 * open; a form being typed in keeps its text. Desktop and phone. Each test states its card:
 * protects / fails_when / no_claim.
 */

const RUN_VERSION = "/documents/usage-alerts/v/2";
const PLAIN_VERSION = "/documents/checkout-redesign/v/2";
const bar = (page: Page) => page.getByTestId("run-review-bar").filter({ visible: true });
const barText = (page: Page) => bar(page).getByTestId("run-review-text");

/** The approver, signed in in a second tab of the owner's browser (on a desktop's width). */
async function approverTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage();
  await other.setViewportSize({ width: 1366, height: 820 });
  await other.goto("/home");
  await signOut(other);
  await login(other, "approver@example.com");
  return other;
}

async function verdict(page: Page, key: string, action: "Approve" | "Request changes", note?: string) {
  const review = (await openSection(page, key)).getByTestId("review-bar");
  await review.getByRole("button", { name: action, exact: true }).click();
  if (note) await review.getByRole("textbox").fill(note);
  await review.getByTestId("verdict-submit").click();
  await expect(review.getByTestId("verdict-pending")).toHaveCount(0);
}

/** The owner's typed-in form: Request changes on a section, a note half written. */
async function startNote(page: Page, key: string, text: string) {
  const review = (await openSection(page, key)).getByTestId("review-bar");
  await review.getByRole("button", { name: "Request changes", exact: true }).click();
  const box = review.getByRole("textbox", { name: "What should change?" });
  await box.fill(text);
  return box;
}

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    if (device === "phone") test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("while a run review is open, a section another reviewer approves shows on the owner's page", async ({ page, context }) => {
      // protects=the run review page refreshes on an interval; fails_when=the owner's bar keeps
      // "0 of 3" or the section reads Not reviewed until a reload, or the owner's half-written
      // note is reset; no_claim=the API's reviewed count (api tests).
      await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"]);
      await login(page);
      await page.goto(RUN_VERSION);
      await expect(barText(page)).toContainText("0 of 3 sections reviewed");
      const note = await startNote(page, "title", "Name the team that owns the alert.");

      const other = await approverTab(context);
      await other.goto(RUN_VERSION);
      await verdict(other, "behaviour", "Approve");
      await expect(barText(other)).toContainText("1 of 3 sections reviewed");

      // The owner's page, never reloaded and its section never changed.
      await page.bringToFront();
      await expect(barText(page)).toContainText("1 of 3 sections reviewed", { timeout: 15_000 });
      await expect(note).toHaveValue("Name the team that owns the alert.");
      await expect(note).toBeFocused();
      await expect(page.locator("section[data-section-key]").filter({ visible: true })).toHaveAttribute("data-section-key", "title");
      await page.getByRole("button", { name: "Cancel" }).filter({ visible: true }).first().click();
      await expect((await openSection(page, "behaviour")).getByTestId("verdict-state")).toContainText("Approved");
    });

    test("another reviewer's change request and Oracle's suggestion reach the owner's Feedback without a reload", async ({ page, context }) => {
      // protects=feedback and Oracle's suggestions refresh while open; fails_when=the owner's
      // panel lacks the approver's item or its suggestion until a reload; no_claim=how Oracle
      // writes a suggestion (llm-jobs specs).
      await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"]);
      await login(page);
      await page.goto(RUN_VERSION);
      await openSection(page, "metrics");
      if (device === "phone") await page.getByTestId("phone-review").click();
      const panel = page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("feedback-item")).toHaveCount(0);

      const other = await approverTab(context);
      await other.goto(RUN_VERSION);
      await verdict(other, "metrics", "Request changes", "Say how often a person is alerted.");

      await page.bringToFront();
      const item = panel.getByTestId("feedback-item").filter({ hasText: "Say how often a person is alerted." });
      await expect(item).toHaveCount(1, { timeout: 15_000 });
      // Oracle's suggestion answering it, on the item itself.
      await expect(item.getByTestId("suggestion")).toContainText("Oracle", { timeout: 15_000 });
    });

    test("coming back to the window shows another reviewer's approval, the typed note kept", async ({ page, context }) => {
      // protects=a refresh on window focus (no run review, so no interval); fails_when=the owner's
      // page keeps the section Not reviewed after focus, or the note being typed is reset;
      // no_claim=the interval (the tests above).
      await login(page);
      await page.goto(PLAIN_VERSION);
      const note = await startNote(page, "title", "Say which checkout this replaces.");

      const other = await approverTab(context);
      await other.goto(PLAIN_VERSION);
      await verdict(other, "problem", "Approve");

      // The person comes back to the owner's window.
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(note).toHaveValue("Say which checkout this replaces.");
      await page.getByRole("button", { name: "Cancel" }).filter({ visible: true }).first().click();
      await expect((await openSection(page, "problem")).getByTestId("verdict-state")).toContainText("Approved", { timeout: 4_000 });
    });
  });
}
