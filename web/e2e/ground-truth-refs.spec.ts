import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, openTab } from "./helpers";

/**
 * PR 1248, fix round 1: a citation of Oracle's own graph keeps the ref "baseline <kind> <key>"
 * (the citation contract's identifier), but a person reads it as "Ground Truth decision D-12"
 * everywhere it shows: the chip's name and hover card, the review panel's Sources tab (text and
 * tooltip) and the Evidence tab's matrix and inspector. The mock's "oracle://baseline/goals"
 * source reads the same way. Hover cards, Ask Oracle answers and the Ground Truth's Approve
 * notice say no "baseline" either. Mock API; made-up data.
 */

const DOC = "/documents/checkout-redesign/v/2";
const SHOWN = "Ground Truth decision D-12";
/** "baseline" naming the graph; a goal measure's starting value would read "Baseline value". */
const OLD_NAME = /\bbaseline\b(?! value)/i;

/** Version 2 of Checkout redesign cites a Ground Truth decision, with no title, in Problem. */
async function citeDecision(page: Page) {
  await login(page);
  await page.evaluate(() => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    const doc = db.documents.find((d: { slug: string }) => d.slug === "checkout-redesign");
    const v = db.versions.find((x: { document_id: string; number: number }) => x.document_id === doc.id && x.number === 2);
    v.citations.push({
      id: crypto.randomUUID(),
      cite_key: "o-d12",
      source: "oracle",
      ref: "baseline decision D-12",
      title: null,
      excerpt: "Show the shipping cost before the address step.",
      retrieved_at: "2026-10-20T17:02:00Z",
    });
    const problem = v.sections.find((s: { section_key: string }) => s.section_key === "problem");
    problem.body_md += " Decided in D-12 [c:o-d12].";
    problem.citation_keys.push("o-d12");
    localStorage.setItem(key, JSON.stringify(db));
  });
}

test("a cited Ground Truth decision reads 'Ground Truth decision D-12' on its chip, card and Sources row", async ({ page }) => {
  await citeDecision(page);
  await page.goto(DOC);

  const chip = (await openSection(page, "problem")).getByTestId("cite-o-d12");
  await expect(chip).toHaveAccessibleName(new RegExp(SHOWN));
  await expect(chip).not.toHaveAccessibleName(OLD_NAME);
  await chip.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText(SHOWN);
  await expect(card.getByTestId("cite-ref")).toHaveText(SHOWN);
  expect(await card.innerText()).not.toMatch(OLD_NAME);

  await openTab(page, "Sources");
  const title = page.getByTestId("sources-list").filter({ visible: true }).getByTestId("source-title").filter({ hasText: "D-12" });
  await expect(title).toHaveText(SHOWN);
  await expect(title).toHaveAttribute("title", SHOWN);
});

test("the Evidence tab names the cited decision 'Ground Truth decision D-12' in its matrix and inspector", async ({ page }) => {
  await citeDecision(page);
  await page.goto(DOC);
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  const matrix = page.getByTestId("evidence-matrix");
  await expect(matrix).toBeVisible();
  const row = matrix.locator("tr[data-target='cite:o-d12']");
  await expect(row).toContainText(SHOWN);
  await row.locator("td").first().click();
  const inspector = page.getByTestId("evidence-citation-inspector").filter({ visible: true });
  await expect(inspector).toContainText(SHOWN);
  expect(await inspector.innerText()).not.toMatch(OLD_NAME);
});

test("the update's Oracle source 'oracle://baseline/goals' reads as the Ground Truth's goals", async ({ page }) => {
  await login(page);
  await page.goto("/documents/investor-update-2026-09/v/1");
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  const matrix = page.getByTestId("evidence-matrix");
  await expect(matrix).toBeVisible();
  await matrix.locator("tr[data-target]", { hasText: "Goals in the Ground Truth" }).locator("td").first().click();
  const inspector = page.getByTestId("evidence-citation-inspector").filter({ visible: true });
  await expect(inspector.getByTestId("evidence-citation")).toContainText("Ground Truth goals");
  expect(await inspector.innerText()).not.toMatch(OLD_NAME);
});

test("an Ask Oracle answer about the Ground Truth, and the Ground Truth's Approve, say no 'baseline'", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "baseline-review"] as const);
  await login(page);
  await page.goto("/home");
  await expect(page.getByTestId("hop-strip")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await panel.getByRole("textbox", { name: "Ask Oracle" }).fill("What is in the Ground Truth, and what is still open?");
  await panel.getByRole("button", { name: "Send" }).click();
  const answer = panel.getByTestId("oracle-reply").first();
  await expect(answer).toHaveAttribute("data-status", "complete");
  expect(await answer.innerText()).not.toMatch(OLD_NAME);
  // Every hover card in the answer (its citations) too.
  const chips = answer.locator("[aria-describedby], [aria-haspopup]");
  for (let i = 0; i < (await chips.count()); i++) {
    await chips.nth(i).hover();
    const card = page.getByRole("tooltip");
    if (await card.count()) expect(await card.first().innerText()).not.toMatch(OLD_NAME);
  }

  await page.goto("/ground-truth?run=7a11c0de-0000-4000-8000-0000000000b2");
  await page.getByTestId("from-run-bar").getByRole("button", { name: "Approve the Ground Truth" }).click();
  // The notice or toast it leaves.
  await expect(page.getByRole("status").or(page.getByRole("alert")).filter({ visible: true }).first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(OLD_NAME);
});
