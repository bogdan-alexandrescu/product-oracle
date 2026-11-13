import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ENG_CHECK_RUN, SCOPE_REVIEW_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * QA findings, Nov 12, 2026, fix lane B (invented data only, mock layer):
 * - detailed-b 3: a review stop's feature or item shows its code with its name, through the
 *   app's named()/namedText() (web/lib/codes.ts); a key that is not code-shaped never draws
 *   bare, as if it were one (the Engineering check's pane header used to show "f.guided-setup"
 *   next to "Feature 1 of 3").
 * - detailed-b 4: the ✓ glyph drew as an empty box in Chromium; every "done" mark across the
 *   Feature set and Engineering check review stops is the app's check icon (an svg) instead.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const briefRow = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const engInspector = (page: Page) => page.getByTestId("brief-inspector");
const engBar = (page: Page) => page.getByTestId("decision-bar");
const SANDBOX = "Does the payment sandbox take test orders without a live account?";

async function openCheck(page: Page) {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto(`/runs/${ENG_CHECK_RUN}`);
  const line = page.getByTestId("review-screen-line").filter({ visible: true });
  await line.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(engBar(page)).toBeVisible();
}

async function openScope(page: Page) {
  await withScenario(page, "scope-review");
  await login(page, "approver@example.com");
  await page.goto(`/runs/${SCOPE_REVIEW_RUN}`);
  await page.getByTestId("checkpoint-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Feature set" })).toBeAttached();
}

const scopeRow = (page: Page, title: string) => page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: title }) });

test("eng-check: the pane's header never shows the bare key as if it were a code", async ({ page }) => {
  // protects=detailed-b 3; fails_when=the header's small type shows "f.guided-setup" (or a
  // mangled "ƒ.guided-setup") beside "Feature 1 of 3"; no_claim=a feature whose key really is
  // code-shaped, which still shows it (named()/namedText(), web/lib/codes.ts).
  await openCheck(page);
  await briefRow(page, "f.guided-setup").getByRole("button").first().click();
  await expect(page.locator('[data-testid="brief-row"][data-feature="f.guided-setup"][aria-current="true"]')).toHaveCount(1);

  const position = engInspector(page).getByTestId("brief-position");
  await expect(position).toContainText("Feature 1 of 3");
  await expect(position).not.toContainText("f.guided-setup");
  await expect(position).not.toContainText("ƒ");
  await expect(engInspector(page)).not.toContainText("f.guided-setup");
  // The list row reads by name only, as it did before (qa4-work-53): never regressed by this fix.
  await expect(briefRow(page, "f.guided-setup")).toContainText("Guided setup");
});

test("eng-check: an answered question's check is an icon, never the ✓ glyph", async ({ page }) => {
  // protects=detailed-b 4; fails_when="Answered" shows the literal ✓ character instead of an
  // svg (the character drew as an empty box in Chromium).
  await openCheck(page);
  await briefRow(page, "f.guided-setup").getByRole("button").first().click();
  await engInspector(page).getByRole("textbox", { name: `Answer: ${SANDBOX}` }).fill("Yes, the sandbox takes test orders.");
  await engInspector(page).getByRole("button", { name: "Answer", exact: true }).first().click();

  const check = engInspector(page).getByLabel("Answered");
  await expect(check.locator("svg")).toHaveCount(1);
  await expect(check).toHaveText("");
  await expect(engInspector(page)).not.toContainText("✓");
  await expect(page.locator("main")).not.toContainText("✓");
});

test("scope-review: a decided row's check is an icon, and the page never renders the ✓ glyph", async ({ page }) => {
  // protects=detailed-b 4; fails_when="row-done" reads the literal ✓ character, or any "✓" text
  // shows anywhere on the page.
  await openScope(page);
  const row = scopeRow(page, "Pick address in one step");
  await row.getByRole("button", { name: "Include", exact: true }).click();
  await row.getByRole("button", { name: "Include", exact: true }).click();

  const done = row.getByTestId("row-done");
  await expect(done).toContainText("Included");
  await expect(done.locator("svg")).toHaveCount(1);
  await expect(done).not.toContainText("✓");
  // The feature table and its panel (the agents' questions above are components/review's).
  await expect(page.getByTestId("scope-inspector")).not.toContainText("✓");
});

test("scope-review: the inspector's kept reasons carry the same check icon, never the ✓ glyph", async ({ page }) => {
  // protects=detailed-b 4 in the inspector (a second place the same glyph drew); fails_when=a
  // reason card reads "✓ Included" as literal text instead of the icon.
  await openScope(page);
  const row = scopeRow(page, "Pick address in one step");
  await row.getByRole("button", { name: "Include", exact: true }).click();
  await row.getByRole("button", { name: "Include", exact: true }).click();
  await row.getByTestId("feature-title").click();

  const panel = page.getByTestId("scope-inspector");
  const lowConfidence = panel.getByTestId("reason-low_confidence");
  const newFeature = panel.getByTestId("reason-new_feature");
  await expect(lowConfidence).toContainText("Included");
  await expect(lowConfidence.locator("svg")).toHaveCount(1);
  await expect(newFeature).toContainText("Included");
  await expect(newFeature.locator("svg")).toHaveCount(1);
  await expect(panel).not.toContainText("✓");
});

test("eng-dates: an item and its inspector read by name, never a bare key", async ({ page }) => {
  // protects=detailed-b 3 on the Engineering dates stop too (the same named()/namedText() fix);
  // no_claim=a visible code change here: the "eng-dates" mock gives none of its items a
  // code-shaped key, so this guards against a key ever leaking as text, as the other two stops did.
  await withScenario(page, "eng-dates");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering dates" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);

  const row = page.locator('[data-testid="date-row"][data-item="shipping-step"]');
  await expect(row).toContainText("Shipping step");
  await expect(row).not.toContainText("shipping-step");
  await row.locator("button").first().click();

  const panel = page.getByTestId("dates-inspector");
  await expect(panel).toContainText("Shipping step");
  await expect(panel).not.toContainText("shipping-step");
});
