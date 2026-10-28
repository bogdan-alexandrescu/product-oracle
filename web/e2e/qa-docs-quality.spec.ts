import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 1, docs lane: the Quality screen of Saved carts v2 (no saved check, no model review
// and no ratings in the mock until a test makes them through the screen).

type Role = "viewer" | "commenter" | "approver" | "owner";
const URL = "/documents/saved-carts/v/2/quality";

async function open(page: Page, role: Role = "owner") {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, role] as const);
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
}

const row = (page: Page, key: string) => page.locator(`[data-testid="criterion-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("quality-inspector");
const history = (page: Page) => page.getByRole("region", { name: "History" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-21: a saved check's History row and the criteria counts give the same numbers", async ({ page }) => {
    await open(page, "commenter");
    await page.getByRole("button", { name: "Save this check" }).click();
    const saved = history(page).getByTestId("history-row");
    await expect(saved).toHaveCount(1);
    await expect(saved).toContainText("Saved check");

    const chips = await page.getByTestId("criteria-tally").locator("> *").allInnerTexts();
    const counted = chips.map((c) => Number(c.match(/\d+/)?.[0] ?? 0));
    // Every check is counted, as the saved check counts them: 13, not the 10 advisory ones.
    expect(counted.reduce((a, b) => a + b, 0)).toBe(13);
    const result = (await saved.innerText()).replace(/\s+/g, " ");
    for (const chip of chips) expect(result).toContain(chip.replace(/\s+/g, " ").trim());
  });

  test("qa-docs-22: a picked status with no reason says a reason is needed to submit", async ({ page }) => {
    await open(page, "commenter");
    await row(page, "alternatives_tradeoffs").click();
    const form = inspector(page).getByTestId("rating-form");
    const submit = form.getByRole("button", { name: "Submit rating" });
    await form.getByRole("button", { name: "Warning" }).click();
    await expect(submit).toBeDisabled();
    await expect(form.getByTestId("rating-hint")).toHaveText("Add a reason to submit");
    await form.getByLabel("Reason").fill("Only one approach is written down.");
    await expect(submit).toBeEnabled();
    await expect(form.getByTestId("rating-hint")).not.toContainText("Add a reason");
    await submit.click();
    await expect(page.getByTestId("rating-stored")).toContainText(/Rating saved at \d{1,2}:\d{2} [AP]M/);
  });

  test("qa-docs-31: criterion and section names, plain action labels, a time that does not move", async ({ page }) => {
    await open(page, "owner");
    await expect(page.getByRole("button", { name: "Save this check" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask Oracle to review" })).toBeVisible();
    await expect(page.getByRole("button", { name: /rules snapshot|model review/i })).toHaveCount(0);

    await row(page, "problem_clarity").click();
    const insp = inspector(page);
    await expect(insp.getByRole("heading", { name: "Problem and user clarity" })).toBeVisible();
    await expect(insp).not.toContainText("problem_clarity");
    // The section by its heading, not its anchor.
    await expect(insp.getByTestId("section-tag")).toHaveText(["Problem"]);
    await expect(insp.locator(".font-mono")).toHaveCount(0);

    // No "Evaluated <now>": the line reads the same after time passes and the page reloads.
    const line = page.getByTestId("latest-report");
    await expect(line).toContainText("No saved check yet");
    await expect(line).not.toContainText("Evaluated");
    const before = await line.innerText();
    await page.clock.fastForward("10:00");
    await page.reload();
    await expect(page.getByTestId("criterion-row")).toHaveCount(13);
    await expect(line).toHaveText(before);
  });

  test("qa-docs-32: Oracle's review says when in words; model, tokens, cost and ids are an owner's details", async ({ page }) => {
    await open(page, "owner");
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    const done = page.getByTestId("job-done");
    await expect(done).toContainText(/Oracle reviewed this at \d{1,2}:\d{2} [AP]M/);
    await expect(done.locator(".font-mono")).toHaveCount(0);
    await expect(page.getByTestId("model-disclaimer")).toContainText(/Oracle reviewed this at \d{1,2}:\d{2} [AP]M/);
    await expect(page.getByTestId("model-disclaimer").locator(".font-mono")).toHaveCount(0);
    // The details are folded away until the owner opens them.
    await expect(done.getByTestId("job-details")).not.toHaveAttribute("open", /.*/);
    await done.getByText("Details").click();
    await expect(done.getByTestId("job-details")).toContainText(/\d+(\.\d)?k? tokens in · \d+ out/);
    await expect(done.getByTestId("job-details")).toContainText("$");
    // No report id in History.
    await expect(history(page).getByTestId("history-row").first()).toContainText("Oracle review");
    await expect(history(page).getByTestId("history-row").first()).not.toContainText(/\b[0-9a-f]{8}\b/);
  });

  test("qa-docs-32: an approver sees no model name, tokens, cost or ids", async ({ page }) => {
    await open(page, "approver");
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    const done = page.getByTestId("job-done");
    await expect(done).toContainText(/Oracle reviewed this at \d{1,2}:\d{2} [AP]M/);
    await expect(done.getByTestId("job-details")).toHaveCount(0);
    await expect(done).not.toContainText(/ in · | out|\$/);
    await expect(page.getByTestId("model-disclaimer")).not.toContainText(/claude-/);
    const first = history(page).getByTestId("history-row").first();
    await expect(first).toContainText("Succeeded");
    await expect(first).not.toContainText(/claude-|\$|\b[0-9a-f]{8}\b/);
  });

  test("qa-docs-60: names and questions wrap, Agreement is narrow, a filter with no match keeps the detail panel", async ({ page }) => {
    await open(page, "owner");
    const title = row(page, "validation_plan").getByTestId("criterion-title");
    await expect(title).toHaveText("Validation plan, success metrics and decision thresholds");
    const cut = await title.evaluate((el) => {
      const cell = el.closest("td")!;
      return el.scrollWidth > el.clientWidth || cell.scrollWidth > cell.clientWidth || getComputedStyle(cell).textOverflow === "ellipsis";
    });
    expect(cut).toBe(false);
    const agreement = await page.getByRole("columnheader", { name: "Agreement" }).boundingBox();
    expect(agreement!.width).toBeLessThanOrEqual(140);

    await expect(inspector(page)).toBeVisible();
    const filters = page.getByRole("group", { name: "Show criteria" });
    await filters.getByRole("button", { name: /Model disagrees/ }).click();
    await expect(page.getByTestId("criterion-row")).toHaveCount(0);
    await expect(page.getByTestId("inspector-none")).toContainText("No criteria match this filter");

    // A criterion the reader picked stays shown under a filter that hides it.
    await filters.getByRole("button", { name: /^All/ }).click();
    await row(page, "scope_testability").click();
    await filters.getByRole("button", { name: /Model disagrees/ }).click();
    await expect(inspector(page).getByRole("heading", { name: "Scope, non-goals and testable requirements" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-22 / qa-docs-60: the sheet says a reason is needed; names wrap with no sideways scroll", async ({ page }) => {
    await open(page, "commenter");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
    await row(page, "validation_plan").click();
    const sheet = page.getByTestId("sheet-criterion");
    const form = sheet.getByTestId("rating-form");
    await expect(form.getByTestId("rating-hint")).toHaveText("Pick a status and add a reason to submit");
    await form.getByRole("button", { name: "Pass" }).click();
    await expect(form.getByTestId("rating-hint")).toHaveText("Add a reason to submit");
  });
});

test("qa-docs-32: dark theme, the review line reads in words", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, "owner");
  await page.getByRole("button", { name: "Ask Oracle to review" }).click();
  await expect(page.getByTestId("job-done")).toContainText(/Oracle reviewed this at \d{1,2}:\d{2} [AP]M/);
});
