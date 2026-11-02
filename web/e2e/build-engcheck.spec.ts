import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * build-engcheck: the Engineering check review page as the owner picked it on the mock-up
 * picks page (Nov 1): EC1 b "List and reading pane" and EC2 b "Beside the verdict". On the
 * mock layer ("eng-check-shop": nine invented shop features, "eng-check-shop-15": fifteen),
 * driven as the engineering lead would, desktop and phone.
 *
 * Test cards:
 * - "list and pane" (EC1 b): protects=a list of the features on the left, the picked one on the
 *   right with Feature n of N, its key by its title, verdict and size on top; a row click opens
 *   it; the picked verdict fills in at once; Save verdict turns the row and the tally; the
 *   arrows step through; fails_when=the old table and side panel, or a verdict that does not
 *   record; no_claim=other review pages (they keep their table).
 * - "hard case" (EC1 b): protects=15 features at 1512 wide: the list scrolls on its own and ends
 *   above the bar, the last feature's verdict click records; fails_when=the list runs under the
 *   bar or the click misses.
 * - "short window" (walk-eng-check item 2): protects=at 1512x600 and 1366x540 the verdict
 *   buttons sit in the first screen above the bar and a click records; fails_when=a verdict
 *   button is under the bar.
 * - "phone" (EC1 b): protects=at 390 the list comes first; a tapped feature fills the screen
 *   with All features to go back; no sideways scroll; fails_when=both show at once.
 * - "questions beside the verdict" (EC2 b): protects=the questions sit right under the verdict
 *   and size, above the approach; an answered one shrinks to a tick, the question, the answer,
 *   who gave it and Change, no box; the count moves in the pane and the row; fails_when=the
 *   questions sit under the approach, or an answered one keeps its box.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const RETURNS = "f.returns-portal";
const REGIONS = "Does the shipping provider's returns endpoint work in every region we ship to?";

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const list = (page: Page) => page.getByRole("region", { name: "Features" });
const row = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const pane = (page: Page) => page.getByTestId("brief-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");
const verdicts = (page: Page) => pane(page).getByRole("group", { name: "Verdict" });
const box = async (l: Locator) => (await l.boundingBox())!;

/** The lead opens the Engineering check from the Inbox's Review. */
async function openCheck(page: Page, scenario = "eng-check-shop", count = 9) {
  await withScenario(page, scenario);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" }).filter({ visible: true });
  await inboxRow.getByRole("link", { name: "Review" }).first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(count);
}

test("list and pane: the lead picks a feature from the list, decides it at the top of the pane, and the list and bar follow", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openCheck(page);
  await expect(list(page)).toContainText("9 features");
  // At rest: the first feature in the pane, its verdict and size on top.
  await expect(pane(page).getByTestId("brief-position")).toHaveText("Feature 1 of 9f.guided-setup");
  await expect(pane(page).getByRole("heading", { level: 2 })).toHaveText("Guided setup");
  await expect(row(page, "f.guided-setup").getByTestId("brief-verdict")).toHaveText("Not decided");
  await expect(row(page, "f.guided-setup").getByTestId("brief-questions")).toHaveText("1 blocking0 of 2 answered");
  const listBox = await box(list(page));
  const paneBox = await box(pane(page));
  expect(listBox.x + listBox.width, "the list sits left of the pane").toBeLessThanOrEqual(paneBox.x);
  await expect(verdicts(page)).toBeInViewport();
  await expect(pane(page).getByRole("group", { name: "Size" })).toBeInViewport();

  // The lead clicks Self-serve returns in the list.
  await row(page, RETURNS).getByRole("button").click();
  await expect(pane(page).getByTestId("brief-position")).toContainText("Feature 7 of 9");
  await expect(pane(page).getByRole("heading", { level: 2 })).toHaveText("Self-serve returns");
  await expect(row(page, RETURNS)).toHaveAttribute("aria-current", "true");

  // Feasible with changes is filled in as soon as it is clicked; the questions stay just below.
  const changes = verdicts(page).getByRole("button", { name: "Feasible with changes" });
  await changes.click();
  await expect(changes).toHaveAttribute("aria-pressed", "true");
  await pane(page).getByRole("textbox", { name: "What changes" }).fill("Labels only in the regions the provider serves; the rest get a printable address slip.");
  await expect(pane(page).getByTestId("brief-question").first()).toBeInViewport();
  await pane(page).getByRole("button", { name: "Save verdict" }).click();
  await expect(row(page, RETURNS).getByTestId("brief-verdict")).toHaveText("Feasible with changes");
  await expect(bar(page).getByTestId("eng-tally")).toContainText("1 of 9 decided");
  await expect(pane(page).getByTestId("verdict-note")).toContainText("Changes: Labels only in the regions");

  // The arrows step through the features.
  await pane(page).getByRole("button", { name: "Next feature" }).click();
  await expect(pane(page).getByTestId("brief-position")).toContainText("Feature 8 of 9");
  await pane(page).getByRole("button", { name: "Previous feature" }).click();
  await expect(pane(page).getByTestId("brief-position")).toContainText("Feature 7 of 9");
});

test("hard case: 15 features at 1512 wide, the list scrolls on its own above the bar and the last one's verdict records", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await openCheck(page, "eng-check-shop-15", 15);
  expect(await list(page).evaluate((el) => el.scrollHeight > el.clientHeight + 1), "the list scrolls on its own").toBe(true);
  await row(page, "f.invoice-pdf").getByRole("button").click();
  await expect(pane(page).getByTestId("brief-position")).toContainText("Feature 15 of 15");
  await verdicts(page).getByRole("button", { name: "Feasible", exact: true }).click();
  await expect(row(page, "f.invoice-pdf").getByTestId("brief-verdict")).toHaveText("Feasible");
  await expect(bar(page).getByTestId("eng-tally")).toContainText("1 of 15 decided");
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const l = await box(list(page));
  const b = await box(bar(page));
  expect(l.y + l.height, "the list ends above the bar").toBeLessThanOrEqual(b.y + 1);
  await expect(row(page, "f.invoice-pdf")).toBeInViewport();
});

for (const size of [
  { width: 1512, height: 600 },
  { width: 1366, height: 540 },
]) {
  test(`short window: at ${size.width}x${size.height} the verdict buttons sit above the bar and a click records`, async ({ page }) => {
    await page.setViewportSize(size);
    await openCheck(page);
    await row(page, RETURNS).getByRole("button").click();
    const feasible = verdicts(page).getByRole("button", { name: "Feasible", exact: true });
    const v = await box(feasible);
    const b = await box(bar(page));
    expect(v.y + v.height, "the verdict buttons sit above the bar").toBeLessThanOrEqual(b.y);
    await feasible.click({ timeout: 5_000 });
    await expect(row(page, RETURNS).getByTestId("brief-verdict")).toHaveText("Feasible");
    await expect(bar(page).getByTestId("eng-tally")).toContainText("1 of 9 decided");
  });
}

test("phone: the list comes first, a tapped feature fills the screen, All features goes back", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openCheck(page);
  await expect(list(page)).toBeVisible();
  await expect(pane(page)).toBeHidden();
  await row(page, RETURNS).getByRole("button").click();
  await expect(pane(page)).toBeVisible();
  await expect(list(page)).toBeHidden();
  await expect(pane(page).getByTestId("brief-position")).toContainText("Feature 7 of 9");
  await verdicts(page).getByRole("button", { name: "Feasible", exact: true }).click();
  await expect(row(page, RETURNS).getByTestId("brief-verdict")).toHaveText("Feasible");
  await expect(bar(page).getByTestId("eng-tally")).toContainText("1 of 9 decided");
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  await pane(page).getByRole("button", { name: "‹ All features" }).click();
  await expect(list(page)).toBeVisible();
  await expect(pane(page)).toBeHidden();
});

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`questions beside the verdict (${name}): right under verdict and size; an answered one shrinks to two short lines`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openCheck(page);
    await row(page, RETURNS).getByRole("button").click();
    const questions = pane(page).getByTestId("brief-question");
    await expect(questions).toHaveCount(3);
    await expect(pane(page).getByText("Architect's questions · 0 of 3 answered")).toBeVisible();
    // Verdict and size, then the questions, then the approach.
    const size = await box(pane(page).getByRole("group", { name: "Size" }));
    const first = await box(questions.first());
    const approach = await box(pane(page).getByRole("heading", { name: "Approach" }));
    expect(first.y).toBeGreaterThan(size.y + size.height);
    expect(approach.y).toBeGreaterThan(first.y + first.height);
    await expect(questions.first()).toBeInViewport();

    const open = await box(questions.nth(1));
    await pane(page).getByRole("textbox", { name: `Answer: ${REGIONS}` }).fill("Yes in 11 of our 14 regions; the other 3 fall back to the address slip.");
    await questions.first().getByRole("button", { name: "Answer", exact: true }).click();
    const answered = questions.first();
    await expect(answered).toHaveAttribute("data-answered", "true");
    await expect(answered.getByRole("textbox")).toHaveCount(0);
    await expect(answered.getByLabel("Answered")).toHaveText("✓");
    await expect(answered.getByTestId("answer")).toContainText("Yes in 11 of our 14 regions; the other 3 fall back to the address slip.");
    await expect(answered.getByRole("button", { name: `Change the answer: ${REGIONS}` })).toHaveText("Change");
    await expect(pane(page).getByText("Architect's questions · 1 of 3 answered")).toBeVisible();
    // Two short lines: shorter than a question still open, with its box.
    expect((await box(answered)).height).toBeLessThan(open.height);
    await expect(row(page, RETURNS).getByTestId("brief-questions")).toHaveText("1 blocking1 of 3 answered");
    await expect(bar(page).getByTestId("eng-tally")).toContainText("3 blocking questions");

    // Change opens the box again with the answer in it.
    await answered.getByRole("button", { name: `Change the answer: ${REGIONS}` }).click();
    await expect(answered.getByRole("textbox", { name: `Answer: ${REGIONS}` })).toHaveValue("Yes in 11 of our 14 regions; the other 3 fall back to the address slip.");
  });
}
