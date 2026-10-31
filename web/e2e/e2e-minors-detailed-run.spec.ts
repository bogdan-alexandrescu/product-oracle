import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { decisionLine } from "../lib/labels";
import { login } from "./helpers";

/**
 * A Detailed run page reads true (production pass, 2026-10-30), on a desktop and on a phone:
 * - "reused baseline": protects=a reused (skipped) segment counts as done, and the run's title
 *   is "<document title> · <flow>" with the title as typed; fails_when=the count leaves the
 *   reused segment out, or the title is slug words or gets a kind word appended.
 * - "decisions": protects=the Decisions list names who decided, and a send-back without entries
 *   says what was sent back; fails_when="approved by an owner" or "Sent back · 0 entries".
 * - "delete": protects=Delete is secondary and its confirm says what goes (the run's record, not
 *   its PRD); fails_when=Delete is drawn as danger or the dialog does not say the PRD stays.
 * - "feature set approve": protects=Approve with features still under Needs you asks first,
 *   naming how many; fails_when=Approve goes through without a word.
 * Invented example data only.
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];
const PROBLEM = "Shoppers retype their address on every order.";

const inspector = (page: Page) => page.getByRole("complementary", { name: "Run" }).filter({ visible: true });

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport });

    test("reused baseline: the reused segment counts as done, and the run's title is the PRD's own", async ({ page }) => {
      await login(page);
      await page.goto("/documents/new");
      await page.getByRole("textbox", { name: "Title" }).fill("Example test · Saved carts");
      await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
      await page.getByRole("button", { name: "Continue" }).first().click();
      await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
      await page.getByRole("button", { name: "Draft with Oracle" }).click();
      const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
      await expect(sheet.getByRole("radio", { name: /^Use the current baseline/ })).toBeChecked();
      await sheet.getByRole("button", { name: "Estimate" }).click();
      await sheet.getByRole("button", { name: "Start drafting" }).click();
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

      await expect(page.getByTestId("segment-baseline").getByTestId("segment-state")).toHaveText(/^Reused/);
      await expect(page.getByTestId("segments-done")).toHaveText(/^1 of \d+ done$/);
      await expect(page.getByTestId("run-name").filter({ visible: true }).first()).toHaveText("Example test · Saved carts · Baseline to PRD");
      await expect(page.getByTestId("run-document")).toContainText("Example test · Saved carts");
      // Never the slug in words ("Example test saved carts").
      await expect(page.getByTestId("run-document")).not.toContainText(/Example test saved carts/i);
    });

    test("decisions: the list names who decided, and a send-back says what it sent", async ({ page }) => {
      await login(page);
      await page.goto("/runs");
      await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
      await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();

      const baseline = page.getByTestId("checkpoint-baseline_confirm");
      await baseline.getByLabel("Note for the agents").fill("Name an owner for every goal");
      await baseline.getByRole("button", { name: "Approve and continue" }).click();
      const items = inspector(page).getByTestId("run-decisions").getByTestId("run-decision");
      await expect(items).toHaveCount(1);
      await expect(items.nth(0)).toHaveText("Baseline · approved by Admin · note: Name an owner for every goal");

      await page.getByRole("button", { name: "Refresh progress" }).click();
      const featureSet = page.getByTestId("checkpoint-feature_set").filter({ hasText: "Waiting" });
      await featureSet.getByLabel("Note for the agents").fill("Split bulk import into its own feature");
      await featureSet.getByRole("button", { name: "Request changes" }).click();
      await expect(items).toHaveCount(2);
      await expect(items.nth(1)).toHaveText("Feature set · changes requested by Admin · note: Split bulk import into its own feature");
      const sent = page.getByTestId("sent-review").filter({ visible: true }).first();
      await expect(sent).toContainText("Sent back · Split bulk import into its own feature · View review");
      await expect(sent).not.toContainText("0 entries");
    });

    test("delete: a secondary button whose confirm says the run's record goes and its PRD stays", async ({ page }) => {
      await login(page);
      await page.goto("/runs");
      await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
      await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
      await page.getByTestId("run-cancel").filter({ visible: true }).first().click();
      await page.getByRole("alertdialog", { name: "Cancel run" }).getByRole("button", { name: "Cancel run" }).click();
      const del = page.getByTestId("run-delete").filter({ visible: true }).first();
      await expect(del).toHaveAttribute("data-variant", "secondary");
      await del.click();
      const dialog = page.getByRole("dialog", { name: "Delete the Team onboarding PRD run" });
      await expect(dialog.getByTestId("delete-what")).toHaveText(/^This removes the run's record: its steps, decisions and spend\./);
      await dialog.getByRole("button", { name: "Back" }).click();
      await expect(dialog).toHaveCount(0);
    });

    test("feature set approve: open calls are named before Approve goes through", async ({ page }) => {
      await page.addInitScript((key) => localStorage.setItem(key, "scope-review"), MOCK_SCENARIO_KEY);
      await login(page, "approver@example.com");
      await page.goto("/runs");
      await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").first().click();
      await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+/);
      const row = page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: "Bulk edit" }) });
      await row.getByRole("button", { name: "Include dependency" }).click();
      const bar = page.getByTestId("decision-bar");
      if (size.name === "phone") await bar.getByRole("button", { name: /Approve$/ }).click();
      await page.getByRole("button", { name: "Approve with 1 edit" }).filter({ visible: true }).click();
      const ask = page.getByRole("alertdialog", { name: "Approve with 1 edit" });
      await expect(ask).toContainText(/\d+ features? still needs? you\. Approving leaves (it|them) as the agents proposed\./);
      await ask.getByRole("button", { name: "Back" }).click();
      // Not approved: the review is still open.
      await expect(page).toHaveURL(/\/review\//);
      await expect(page.getByRole("button", { name: "Approve with 1 edit" }).filter({ visible: true })).toBeVisible();
    });
  });
}

test("review minors 2: the decider's name stands in for the role whatever the role phrase reads", () => {
  // Another wording of the role than "by an owner": the name still replaces it, never the role kept.
  const d = { summary: "Feature set · approved by the engineering lead · note: Keep bulk import out", status: "approved", via: "oracle" } as const;
  expect(decisionLine(d, "Ana Example")).toBe("Feature set · approved by Ana Example · note: Keep bulk import out");
  expect(decisionLine({ summary: "Baseline · changes requested in SwarmCloud's console", status: "changes_requested", via: "swarmcloud_console" }, "Ana Example")).toBe(
    "Baseline · changes requested by Ana Example in SwarmCloud's console",
  );
  expect(decisionLine(d, null)).toBe(d.summary);
});
