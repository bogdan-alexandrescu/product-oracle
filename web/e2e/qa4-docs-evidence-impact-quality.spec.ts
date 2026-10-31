import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * QA pass 4, docs lane: the Evidence, Impact and Quality tabs of Checkout redesign PRD v2,
 * driven as a person would on the mock (invented data).
 */

const DOC = "/documents/checkout-redesign";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openEvidence(page: Page) {
  await login(page);
  await page.goto(`${DOC}/v/2`);
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/evidence/);
}

async function openImpact(page: Page) {
  await login(page);
  await page.goto(`${DOC}/v/2`);
  await page.getByRole("link", { name: "Impact", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
}

const row = (page: Page, key: string) => page.locator(`[data-testid="criterion-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("quality-inspector");

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-18: Coverage cells and the Weakest column say Strong, Medium or Weak, never a score or a kind code", async ({ page }) => {
    await openEvidence(page);
    const matrix = page.getByTestId("evidence-matrix");
    await expect(matrix).toBeVisible();
    const cells = matrix.locator("tbody tr[data-target] td[data-section] button");
    await expect(cells.first()).toBeVisible();
    for (const text of await cells.allInnerTexts()) {
      expect(text).not.toMatch(/\d\.\d|Impl|Evid|Ment/);
      expect(text).toMatch(/^(Strong|Medium|Weak|Unscored|cited)( \+\d+)?$/);
    }
    // The kind is still there, in words, for whoever asks the cell.
    const goal = matrix.locator('tbody tr[data-target] td[data-section="goal-trace"] button').first();
    await expect(goal).toHaveAttribute("aria-label", /Implements, (strong|medium|weak) link/);

    await page.getByRole("group", { name: "Evidence view" }).getByRole("button", { name: "Sections" }).click();
    const table = page.getByRole("grid", { name: "Sections" });
    await expect(table).toBeVisible();
    await expect(table).not.toContainText(/\b0\.\d\d\b/);
    await expect(table.getByRole("row", { name: /Goal trace/ })).toContainText(/(Strong|Medium|Weak) link/);
  });

  test("qa4-docs-13: a section with no links and no citations never reads 'citations only'", async ({ page }) => {
    await openEvidence(page);
    await page.getByRole("group", { name: "Evidence view" }).getByRole("button", { name: "Sections" }).click();
    const table = page.getByRole("grid", { name: "Sections" });
    for (const name of [/Introduction/, /5\. Proposed flow/]) {
      const r = table.getByRole("row", { name });
      await expect(r).toBeVisible();
      await expect(r).not.toContainText("citations only");
      await expect(r).toContainText("in subsections");
    }
  });

  test("qa4-docs-42: Evidence calls the opening section Introduction, not the PRD's title", async ({ page }) => {
    await openEvidence(page);
    await expect(page.getByTestId("evidence-matrix").locator('thead th[data-section="title"]')).toHaveText("Introduction");
    await page.getByRole("group", { name: "Evidence view" }).getByRole("button", { name: "Sections" }).click();
    const table = page.getByRole("grid", { name: "Sections" });
    await expect(table.getByRole("row", { name: /Introduction/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /Checkout redesign PRD/ })).toHaveCount(0);
  });

  test("qa4-docs-56: the column cut at the matrix's right edge fades out into the panel", async ({ page }) => {
    await openEvidence(page);
    const scroller = page.getByTestId("evidence-matrix-scroll");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(true);
    const shadow = page.getByTestId("evidence-scroll-shadow");
    await expect(shadow).toBeAttached();
    const { width, alpha } = await shadow.evaluate((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      // The first colour stop of a gradient "to left" is the one at the right edge.
      const m = /(?:rgba?|oklch|oklab|lab|lch|color|hsla?)\((?:[^()]|\([^()]*\))*\)/.exec(bg);
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const x = cv.getContext("2d")!;
      x.clearRect(0, 0, 1, 1);
      x.fillStyle = "rgba(0,0,0,0)";
      x.fillStyle = m ? m[0] : "rgba(0,0,0,0)";
      x.fillRect(0, 0, 1, 1);
      return { width: el.getBoundingClientRect().width, alpha: x.getImageData(0, 0, 1, 1).data[3] };
    });
    // Solid at the edge, so a header is never seen sliced mid-word; wide enough to fade it.
    expect(alpha).toBeGreaterThan(240);
    expect(width).toBeGreaterThanOrEqual(64);
  });

  test("qa4-docs-9: Impact says an output is already marked stale instead of 'nothing has been marked stale'", async ({ page }) => {
    await openImpact(page);
    await expect(page.getByText(/Preview: v2 marks nothing stale\. \d+ outputs? (was|were) already marked stale by an earlier change\./)).toBeVisible();
    await expect(page.getByText("nothing has been marked stale")).toHaveCount(0);
  });

  test("qa4-docs-44: the changed section in Lineage reads as changed in v2, with its number", async ({ page }) => {
    await openImpact(page);
    const graph = page.getByRole("region", { name: "Lineage" });
    const node = graph.getByTestId("lineage-upstream").filter({ hasText: "Success metrics" });
    await expect(node).toContainText("7. Success metrics");
    const sub = node.getByTestId("lineage-upstream-sub");
    await expect(sub).toHaveText("Section changed in v2");
    await expect(sub).toHaveAttribute("title", "Section changed in v2. Outputs were built on v1.");
    await expect(graph).not.toContainText("Section of Checkout redesign PRD v1");
  });

  test("qa4-docs-15: after Ask Oracle to review, the banner says Oracle is on it", async ({ page }) => {
    await login(page);
    await page.goto(`${DOC}/v/2/quality`);
    await expect(page.getByTestId("no-model-review")).toContainText("No model review for v2 yet");
    await page.getByRole("button", { name: "Ask Oracle to review" }).click();
    await expect(page.getByTestId("job-active")).toContainText(/Oracle will review v2 shortly; asked at \d{1,2}:\d{2} [AP]M/);
    await expect(page.getByTestId("job-active")).toContainText("This page updates when it ends.");
    await expect(page.getByTestId("no-model-review")).toHaveCount(0);
    // When it ends, the banner says Oracle reviewed it.
    await expect(page.getByTestId("job-done")).toContainText(/Oracle reviewed this at/);
    await expect(page.getByTestId("job-active")).toHaveCount(0);
  });

  test("qa4-docs-15: a review already running says when it started", async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "quality-job-running"] as const);
    await login(page);
    await page.goto("/documents/team-workspaces/v/2/quality");
    await expect(page.getByTestId("job-active")).toContainText(/^Oracle is reviewing v2, started [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
    await expect(page.getByTestId("job-active")).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  });

  test("qa4-docs-42: the rating's section picker says Introduction and the saved rating lists its sections", async ({ page }) => {
    await login(page);
    await page.goto(`${DOC}/v/2/quality`);
    await expect(page.getByTestId("criterion-row").first()).toBeVisible();
    await row(page, "alternatives_tradeoffs").click();
    const form = inspector(page).getByTestId("rating-form");
    const picker = form.getByLabel("Add a section");
    await expect(picker.locator("option", { hasText: "Introduction" })).toHaveCount(1);
    await expect(picker.locator("option", { hasText: "Checkout redesign PRD" })).toHaveCount(0);
    await form.getByRole("button", { name: "Warning" }).click();
    await form.getByLabel("Reason").fill("Only one approach is written down.");
    await picker.selectOption({ label: "Introduction" });
    await picker.selectOption({ label: "4. Scope" });
    await expect(form.getByTestId("picked-section")).toHaveText(["Introduction", "4. Scope"]);
    await form.getByRole("button", { name: "Submit rating" }).click();
    await expect(page.getByTestId("rating-stored")).toBeVisible();
    const mine = inspector(page).getByTestId("my-rating");
    await expect(mine).toContainText("Only one approach is written down.");
    await expect(mine.getByTestId("section-tag")).toHaveText(["Introduction", "4. Scope"]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("qa4-docs-18: the phone's coverage list says Strong, Medium or Weak, never a score", async ({ page }) => {
    await openEvidence(page);
    const list = page.getByTestId("evidence-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText(/Goal trace ·\s*(Strong|Medium|Weak)/);
    await expect(list).not.toContainText(/\d\.\d\d|Impl /);
  });
});
