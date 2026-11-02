import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/**
 * walk-eng-check: a run's engineering check and its run page, from a walk on production. On
 * the mock layer, driven as a person would.
 *
 * Test cards:
 * - "feasibility above the bar" (item 2): protects=at 1512 and 1366 wide the selected
 *   feature's panel, taller than the window, ends above the fixed decision bar (it scrolls on its own), so a verdict
 *   click records the verdict; fails_when=the panel runs under the bar; no_claim=the phone.
 * - "answered" (item 10): protects=the Questions column says Answered once every question of a
 *   feature has an answer; fails_when=it still counts them open; no_claim=suggested answers.
 * - "who decides" (item 9): protects=the run page tells the lead the stop waits for them and an
 *   approver that they read it only; fails_when=the lead reads "you can't decide it".
 * - "title as is" (item 3): protects=the run names its PRD by its title, no "PRD" added;
 *   fails_when=" PRD" follows the title.
 * - "inbox names the PRD" (item 4): protects=a stop's Inbox row names its PRD; fails_when=two
 *   runs' rows read the same; an Engineering check row names its PRD as the run page does;
 *   fails_when=the row shows the PRD's slug.
 * - "note focus" (item 8): protects=focusing Note to the agents keeps the page's scroll and the
 *   selected feature; fails_when=the page jumps to the list's end.
 * - "left out" (item 5): protects=a row left out reads the baseline goal it serves and Left out,
 *   goal chips whole; fails_when=No goal or "0 of 0 kept" shows, or a goal chip is cut.
 * - "plain requirement" (item 6): protects=the agents' stage pointers go, the requirement's own
 *   words stay ("ships in stage 2 of rollout"); fails_when=a pointer shows or own words are cut.
 * - "evidence by name" (item 6): protects=evidence by its source's name; fails_when=a bare id shows.
 * - "one filter name" (item 7): protects=the same person reads the same filter name on a phone
 *   and a desktop; fails_when=the name changes with the width; no_claim=other roles (rirs-13). It guards the
 *   label as built, not a change: whether a commenter should read "Needs you" too is the
 *   owner's question (questions.json).
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

// Windows shorter than the panel with its note open: without its own scroll it runs under the bar.
for (const size of [
  { width: 1512, height: 600 },
  { width: 1366, height: 540 },
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
    // The panel is taller than the room above the bar, so it scrolls on its own.
    expect(await inspector(page).evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
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
  for (const [slug, written] of [
    ["team-workspaces", ""],
    ["usage-alerts-v2", " (written by this run)"],
  ]) {
    await page.goto("/runs");
    await page.locator(`[data-testid="run-row"][data-document="${slug}"]`).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
    const header = page.locator("header[data-page-header]").filter({ visible: true });
    // The heading is "<title> · <flow>": the document line names the same title, as is.
    const title = (await header.getByTestId("run-name").innerText()).split(" · ")[0];
    await expect(header.getByTestId("run-document")).toHaveText(`${title}${written}`);
  }
});

test("inbox names the PRD: a stop's row says which PRD it is for", async ({ page }) => {
  await withScenario(page, "scope-review");
  await login(page, "approver@example.com");
  await page.goto("/inbox");
  const labels = page.getByTestId("inbox-checkpoints").getByTestId("checkpoint-label");
  await expect(labels.first()).toBeVisible();
  const texts = await labels.allInnerTexts();
  const sets = texts.filter((t) => t.startsWith("Feature set and dependencies"));
  expect(sets.length).toBeGreaterThan(0);
  for (const t of sets) expect(t).toMatch(/^Feature set and dependencies · \S/);
  expect(new Set(sets).size).toBe(sets.length);
});

test("inbox names the PRD: an Engineering check row names its PRD as the run page does, never by its slug", async ({ page }) => {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto(RUN);
  const doc = (await page.locator("header[data-page-header]").filter({ visible: true }).getByTestId("run-document").innerText()).replace(/ \(written by this run\)$/, "");
  await page.goto("/inbox");
  const label = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" }).getByTestId("checkpoint-label");
  await expect(label).toHaveText(`Engineering check · ${doc} · 3 features · 1 blocking`);
  await expect(label).not.toContainText("guided-onboarding");
});

test("note focus: focusing Note to the agents keeps the list where it was and the selection", async ({ page }) => {
  await withScenario(page, "scope-review");
  await login(page, "approver@example.com");
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").first().click();
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page.getByTestId("scope-row").first()).toBeVisible();
  await page.getByRole("button", { name: /^All/ }).click();
  const selected = page.locator('[data-testid="scope-row"][aria-selected="true"]');
  const before = await selected.getAttribute("data-key");
  const y = await page.evaluate(() => window.scrollY);
  const note = page.getByRole("textbox", { name: "Note to the agents" });
  // A person clicks where the note shows, in the bar fixed at the window's foot.
  const box = (await note.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await expect(note).toBeFocused();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(y);
  await expect(selected).toHaveAttribute("data-key", before!);
  // From the keyboard too: focus moves to the note (as Tab does) and the page stays put.
  // (Focus leaves the note in place: a click on the title would scroll up to it, the agents'
  // questions atop the review having pushed the table down, and hide a jump.)
  await note.evaluate((el) => (el as HTMLElement).blur());
  await expect(note).not.toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(y);
  await note.evaluate((el) => (el as HTMLElement).focus());
  await expect(note).toBeFocused();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(y);
  await expect(selected).toHaveAttribute("data-key", before!);
  await note.fill("Keep the address book small.");
  await expect(selected).toHaveAttribute("data-key", before!);
});

async function openFeatureSet(page: Page) {
  await withScenario(page, "scope-review");
  await login(page, "approver@example.com");
  await page.getByTestId("nav-runs").filter({ visible: true }).first().click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").first().click();
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page.getByTestId("scope-row").first()).toBeVisible();
}
const scopeRow = (page: Page, key: string) => page.locator(`[data-testid="scope-row"][data-key="${key}"]`);

test("left out: a feature the set leaves out shows the goal it serves and Left out, goal names whole", async ({ page }) => {
  await openFeatureSet(page);
  await page.getByRole("button", { name: /^All/ }).click();
  const out = scopeRow(page, "address-book-export");
  await expect(out.getByTestId("goal-chip")).toHaveText("Raise activation");
  await expect(out).not.toContainText("No goal");
  await expect(out.getByTestId("row-requirements")).toHaveText("Left out");
  await expect(scopeRow(page, "address-sharing").getByTestId("goal-chip")).toHaveText("Grow paid conversion");
  // A goal's name is never cut: the chip is as wide as its text.
  const chip = scopeRow(page, "saved-addresses").getByTestId("goal-chip").first();
  expect(await chip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("evidence by name: the feature panel names each source, never a bare id", async ({ page }) => {
  await openFeatureSet(page);
  await page.getByRole("button", { name: /^All/ }).click();
  await scopeRow(page, "saved-addresses").getByTestId("feature-title").click();
  const evidence = page.getByTestId("inspector-evidence").filter({ visible: true });
  await expect(evidence.getByRole("listitem")).toHaveText(["Checkout interviews, September", "Support tickets: retyped addresses"]);
  await expect(evidence).not.toContainText("58a87cc0");
  await expect(evidence.getByRole("link", { name: "Checkout interviews, September" })).toHaveAttribute("href", "https://example.com/research/checkout-interviews");
});

test("one filter name: the approver's filter reads the same on a phone and a desktop", async ({ page }) => {
  await openFeatureSet(page);
  await expect(page.getByRole("button", { name: /^Needs you/ }).filter({ visible: true })).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: /^Needs you/ }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Needs a decision/ }).filter({ visible: true })).toHaveCount(0);
});

test("plain requirement: a requirement reads without the agents' stage and question pointers", async ({ page }) => {
  await openFeatureSet(page);
  await page.getByRole("button", { name: /^All/ }).click();
  await scopeRow(page, "address-edit").getByTestId("feature-title").click();
  const req = page.getByTestId("inspector-requirements").filter({ visible: true }).getByTestId("requirement-address-edit-inline");
  await expect(req).toContainText("A saved address is edited in place at checkout");
  await expect(req).not.toContainText(/stage 3|Q8|awaiting the founder/);
  // Only the pointers go: "stage 2 of rollout" is the requirement's own words.
  await expect(req).toContainText("A saved address is edited in place at checkout and ships in stage 2 of rollout");
});
