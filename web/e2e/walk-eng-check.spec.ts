import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/**
 * walk-eng-check: a run's engineering check and its run page, from a walk on production. On
 * the mock layer, driven as a person would.
 *
 * Test cards:
 * - "feasibility above the bar" (item 2): protects=at 1512 and 1366 wide the selected
 *   feature's panel ends above the fixed decision bar (it scrolls on its own), so a verdict
 *   click records the verdict; fails_when=the panel runs under the bar; no_claim=the phone.
 * - "answered" (item 10): protects=the Questions column says Answered once every question of a
 *   feature has an answer; fails_when=it still counts them open; no_claim=suggested answers.
 * - "who decides" (item 9): protects=the run page tells the lead the stop waits for them and an
 *   approver that they read it only; fails_when=the lead reads "you can't decide it".
 * - "title as is" (item 3): protects=the run names its PRD by its title, no "PRD" added;
 *   fails_when=" PRD" follows the title.
 * - "inbox names the PRD" (item 4): protects=a stop's Inbox row names its PRD; fails_when=two
 *   runs' rows read the same.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const RUN = "/runs/7a11c0de-0000-4000-8000-0000000000f4";
const row = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const inspector = (page: Page) => page.getByTestId("brief-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");

async function openCheckAsLead(page: Page) {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
}

for (const size of [
  { width: 1512, height: 860 },
  { width: 1366, height: 680 },
]) {
  test(`feasibility above the bar: at ${size.width} px the panel ends above the decision bar and a verdict click records it`, async ({ page }) => {
    await page.setViewportSize(size);
    await openCheckAsLead(page);
    await row(page, "f.guided-setup").getByRole("button").first().click();
    // A tall panel: the note a verdict with changes asks for is open.
    await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: "Feasible with changes", exact: true }).click();
    await expect(inspector(page).getByRole("textbox", { name: "Note: what changes" })).toBeVisible();
    // Scroll the page as a person would, past the table's top: the panel sticks.
    await page.mouse.move(200, 300);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    const panel = await inspector(page).boundingBox();
    const barBox = await bar(page).boundingBox();
    expect(panel && barBox).toBeTruthy();
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(barBox!.y + 1);
    // Every verdict button is clickable: the click lands on it, never on the bar.
    await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: "Feasible", exact: true }).click({ timeout: 5_000 });
    await expect(row(page, "f.guided-setup").getByTestId("brief-verdict")).toHaveText("Feasible");
    await expect(bar(page).getByTestId("eng-tally")).toContainText("1 of 3 decided");
  });
}

test("answered: the Questions column says Answered once each question of a feature is answered", async ({ page }) => {
  await openCheckAsLead(page);
  const questions = row(page, "f.guided-setup").getByTestId("brief-questions");
  await expect(questions).toHaveText("2 open · 1 blocking");
  await row(page, "f.guided-setup").getByRole("button").first().click();
  const boxes = inspector(page).getByRole("textbox", { name: /^Answer: / });
  await boxes.first().fill("Yes, the sandbox takes test orders.");
  await inspector(page).getByRole("button", { name: "Answer", exact: true }).first().click();
  await expect(questions).toHaveText("1 open");
  await expect(boxes).toHaveCount(1);
  await boxes.first().fill("Three steps at most.");
  await inspector(page).getByRole("button", { name: "Answer", exact: true }).first().click();
  await expect(questions).toHaveText("Answered");
});

test("who decides: the run page tells the lead the check waits for them, an approver that they read it only", async ({ page }) => {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto(RUN);
  const you = page.getByTestId("shared-you");
  await expect(you).toHaveText("It waits for you: you can decide it.");
  await expect(page.getByText("you can't decide it")).toHaveCount(0);
  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(RUN);
  await expect(you).toHaveText("You can read it; you can't decide it.");
});

test("title as is: the run names its PRD by its title, with no PRD added", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="team-workspaces"]').getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  const doc = page.locator("header[data-page-header]").filter({ visible: true }).getByTestId("run-document");
  await expect(doc).toHaveText("Team workspaces");
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-v2"]').getByRole("link").first().click();
  await expect(page.locator("header[data-page-header]").filter({ visible: true }).getByTestId("run-document")).toHaveText("Usage alerts v2 (written by this run)");
});

test("inbox names the PRD: a stop's row says which PRD it is for", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const labels = page.getByTestId("inbox-checkpoints").getByTestId("checkpoint-label");
  await expect(labels.first()).toBeVisible();
  const texts = await labels.allInnerTexts();
  console.log("INBOX LABELS", JSON.stringify(texts));
  const plain = texts.filter((t) => /^(Feature set and dependencies|PRD review|Priority order|Baseline proposal)$/.test(t.trim()));
  expect(plain).toEqual([]);
});
