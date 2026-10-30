import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 3, docs lane: the Quality screen of Saved carts v2 (no saved check, no model review
// and no ratings in the mock until a test makes them through the screen), and its Publish page.

const URL = "/documents/saved-carts/v/2/quality";
const PEOPLE = { owner: undefined, commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;
type Who = keyof typeof PEOPLE;

async function open(page: Page, who: Who = "owner") {
  await login(page, PEOPLE[who]);
  await page.goto(URL);
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
}

const row = (page: Page, key: string) => page.locator(`[data-testid="criterion-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("quality-inspector");
const history = (page: Page) => page.getByRole("region", { name: "History" });

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const phone = viewport.width < 600;
    const detail = (page: Page) => (phone ? page.getByTestId("sheet-criterion") : inspector(page));

    test("qa-docs-2: a criterion's Owner is the same for every reader, never the reader's role", async ({ browser }) => {
      const owners: string[] = [];
      for (const who of ["owner", "viewer", "commenter"] as const) {
        const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const p = await ctx.newPage();
        await open(p, who);
        await row(p, "problem_clarity").click();
        const insp = detail(p);
        await expect(insp.getByRole("heading", { name: "Problem and user clarity" }).first()).toBeVisible();
        const owner = insp.getByTestId("criterion-owner");
        const text = (await owner.count()) ? (await owner.innerText()).trim() : "";
        expect(text).not.toMatch(/^(Admin|Owner|Viewer|Commenter|Approver)$/);
        owners.push(text);
        await ctx.close();
      }
      expect(new Set(owners).size).toBe(1);
    });

    test("qa-docs-55: a rule note counts evidence in pieces", async ({ page }) => {
      await open(page);
      await row(page, "problem_clarity").click();
      await expect(detail(page)).toContainText("its pain is backed by 2 pieces of evidence.");
      await expect(detail(page)).not.toContainText("by 2 evidence");
    });

    test("qa-docs-57: a hard check says Rules only once, and Critical blockers says what it checks", async ({ page }) => {
      await open(page);
      const hard = row(page, "critical_blockers");
      await expect(hard.getByTestId("model-cell")).toHaveText("Rules only");
      await expect(hard.getByTestId("people-cell")).toHaveText("");
      expect((await hard.innerText()).match(/Rules only/g)).toHaveLength(1);
      await hard.click();
      await expect(detail(page)).not.toContainText("registered by Oracle");
      await expect(detail(page)).toContainText("Is any critical blocker still unresolved");
    });

    test("qa-docs-22: a commenter may save a check, as the API lets them; a viewer sees no Save", async ({ page, browser }) => {
      await open(page, "commenter");
      const save = page.getByRole("button", { name: "Save this check to History" });
      await expect(save).toBeEnabled();
      await save.click();
      await expect(history(page).getByTestId("history-row")).toHaveCount(1);
      await expect(page.getByTestId("latest-report")).toContainText("Last saved check");

      const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const viewer = await ctx.newPage();
      await open(viewer, "viewer");
      await expect(viewer.getByRole("button", { name: /Save this check/ })).toHaveCount(0);
      await ctx.close();
    });

    test("qa-docs-59: a submitted rating is confirmed and shown under Your rating", async ({ page }) => {
      await open(page, "commenter");
      await row(page, "alternatives_tradeoffs").click();
      const insp = detail(page);
      const form = insp.getByTestId("rating-form");
      await form.getByRole("button", { name: "Warning" }).click();
      await form.getByLabel("Reason").fill("Only one approach is written down.");
      await form.getByRole("button", { name: "Submit rating" }).click();
      await expect(insp.getByTestId("rating-stored")).toContainText(/Rating saved at \d{1,2}:\d{2} [AP]M/);
      const mine = insp.getByTestId("my-rating");
      await expect(mine).toContainText("You rated this");
      await expect(mine).toContainText("Warning");
      await expect(mine).toContainText("Only one approach is written down.");
      // The footer says a rating is not a saved check, so "No saved check yet" is not a contradiction.
      await expect(page.getByTestId("latest-report")).toContainText("Ratings are kept on their own");
      await expect(history(page).getByTestId("history-row").first()).toContainText("Human rating");
    });

    test("qa-docs-60: empty History and dash tiles say what to do; Save says where it goes", async ({ page }) => {
      await open(page, "commenter");
      await expect(history(page).getByTestId("history-empty")).toContainText("No evaluation reports for v2 yet");
      await expect(history(page).getByTestId("history-empty")).toContainText("To add one, save this check or rate a criterion.");
      await expect(page.getByRole("button", { name: "Save this check to History" })).toBeVisible();
      await expect(page.getByTestId("latest-report")).toContainText("Save this check to History keeps this result");
      await row(page, "alternatives_tradeoffs").click();
      await expect(detail(page).getByTestId("stat-model-agrees")).toContainText("An approver can ask Oracle");
      await expect(detail(page).getByTestId("stat-people-agree")).toContainText("Rate it below");
      await expect(detail(page).getByTestId("stat-people-agree")).not.toContainText("—");
    });

    test("qa-docs-60: Publish and Quality name the same verdict the same way", async ({ page }) => {
      await open(page);
      await expect(page.getByTestId("blocked-chip")).toHaveText("Not blocked");
      await page.goto("/documents/saved-carts/publish");
      await expect(page.getByTestId("publish-readiness")).toBeVisible();
      await expect(page.getByTestId("blocks-chip")).toHaveText("Not blocked");
    });
  });
}

test.describe("desktop only", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-56: after Ask Oracle one banner says Oracle reviewed this, with one Details", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    await expect(page.getByTestId("job-done")).toContainText(/Oracle reviewed this at \d{1,2}:\d{2} [AP]M/);
    // The page reloads the dashboard (model column fills); still one banner.
    await expect(row(page, "problem_clarity").getByTestId("model-cell")).toHaveText("Pass");
    await expect(page.getByText(/Oracle reviewed this at/)).toHaveCount(1);
    await expect(page.locator("details").filter({ has: page.locator("summary", { hasText: "Details" }) })).toHaveCount(1);
    await expect(page.getByTestId("model-disclaimer")).toContainText("not independent ground truth");
  });

  test("qa-docs-58: the Agreement cell keeps each part on its own labelled line", async ({ page }) => {
    await open(page);
    // Oracle's review passes Problem and user clarity, as the rules do; then a person agrees.
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    await expect(row(page, "problem_clarity").getByTestId("model-cell")).toHaveText("Pass");
    await row(page, "problem_clarity").click();
    const form = inspector(page).getByTestId("rating-form");
    await form.getByRole("button", { name: "Pass" }).click();
    await form.getByLabel("Reason").fill("The users and the pain are both named.");
    await form.getByRole("button", { name: "Submit rating" }).click();
    const cell = row(page, "problem_clarity").getByTestId("agreement-cell");
    await expect(cell).toHaveText(/^Model agrees\s*People 1\/1$/);
    const lines = cell.locator("> span");
    for (const line of await lines.all()) {
      const box = await line.boundingBox();
      // One line each: no "Model agrees ·" broken from its count.
      expect(box!.height).toBeLessThanOrEqual(28);
    }
  });

  test("qa-docs-56: dark theme, one review banner", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page);
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    await expect(page.getByTestId("job-done")).toBeVisible();
    await expect(row(page, "problem_clarity").getByTestId("model-cell")).toHaveText("Pass");
    await expect(page.getByText(/Oracle reviewed this at/)).toHaveCount(1);
  });
});
