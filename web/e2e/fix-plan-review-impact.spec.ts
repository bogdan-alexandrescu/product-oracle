import { expect, test, type Page } from "./test";

import { LEGACY_OVERRIDE_SCENARIO } from "../lib/api/mock/lane-f";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Review minors on /impact and /priorities, driven through the UI as a person would:
 * 1. qa-plan-10: the lineage's upstream sub-line names a baseline item's kind, in words,
 *    never its raw key; "What if … changed?" names it too.
 * 2. The lineage's grouped (past-15) view keeps the same names when it builds a category's
 *    upstream edges as it does when it builds the ones the subject column shows.
 * 3. A recorded change's impact highlights the rail by what the change is about, not always PRDs.
 * 4. qa-plan-40: a feature's score steps read the same number style as the Score column, their
 *    arithmetic is true, and confidence reads one way in every step: a percent ("90%").
 * 5. The owner's "Percent everywhere": confidence reads as one percent wherever it is shown.
 * 6. A stored change whose anchor feature is no longer anyone's still names it by the API's
 *    own title in the Changes log, not by its bare key.
 */

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openImpact(page: Page, n = 2) {
  await login(page);
  await page.goto(`/documents/checkout-redesign/v/${n}/impact`);
}

test("impact: the lineage names a baseline item's kind, not its raw key", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  // A version's preview reaches only that document's sections (as the API's): a baseline
  // item is an upstream on its own what-if, opened from its drawer as a person would.
  await page.goto("/baseline");
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  await page.getByRole("dialog", { name: "Guided setup" }).getByRole("link", { name: "What if it changed?" }).click();
  await expect(page).toHaveURL(/\/impact\/entities\/[^/]+$/);
  const graph = page.getByRole("region", { name: "Lineage" });
  const upstream = graph.getByTestId("lineage-upstream").filter({ hasText: "Guided setup" });
  await expect(upstream).toBeVisible();
  // The sub-line names the kind in words ("Feature", locked), never "f.guided-setup".
  await expect(upstream.getByTestId("lineage-upstream-sub")).toHaveText("Feature · locked");
  await expect(upstream).not.toContainText("f.guided-setup");
  // The link to the what-if names the item too.
  await expect(upstream.getByRole("link", { name: "What if Guided setup changed?" })).toBeVisible();
  await expect(upstream.getByRole("link", { name: /f\.guided-setup/ })).toHaveCount(0);
});

test("impact: a recorded change highlights the rail by what it is about, not always PRDs", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2/impact");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  const table = page.getByRole("grid", { name: "Affected outputs" });
  const nav = page.getByRole("navigation", { name: "Oracle" });

  // A change on a deleted baseline item (a requirement) belongs with Baseline, never PRDs,
  // when it is opened on its own (qa-plan-12: opened from a PRD's Impact, it stays with PRDs).
  await table.getByText("Acceptance tests").first().click();
  await page.getByRole("complementary", { name: /Acceptance tests/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await page.goto(new URL(page.url()).pathname);
  await expect(page.getByTestId("lineage-subject").filter({ visible: true })).toContainText("Requirement “Guest checkout keeps the cart” deleted");
  await expect(nav.getByTestId("nav-baseline")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");

  // A change on a source's permission belongs with neither PRDs nor Baseline: the rail stays quiet.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await table.getByText("Early shipping cost brief").first().click();
  await page.getByRole("complementary", { name: /Early shipping cost brief/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await page.goto(new URL(page.url()).pathname);
  await expect(page.getByText(/^Impact:/).filter({ visible: true })).toBeVisible();
  await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-baseline")).not.toHaveAttribute("aria-current", "page");

  // A change on a PRD section still belongs with PRDs, as before.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await table.getByText("Saved addresses tech brief").first().click();
  await page.getByRole("complementary", { name: /Saved addresses tech brief/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await expect(page.getByTestId("lineage-subject").filter({ visible: true })).toContainText("Checkout redesign PRD v2");
  await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
});

test("impact: past 15 outputs, a category still finds its upstream once names are loaded", async ({ page }) => {
  await scenario(page, "impact-large");
  await openImpact(page);
  const graph = page.getByRole("region", { name: "Lineage" });
  // Give the document and section names (loaded after the first paint) time to settle before
  // the grouped nodes' edges are read, so the two lists this item keeps in step are both named.
  await expect(graph.getByText("Scope", { exact: true }).first()).toBeVisible();
  const group = graph.getByTestId("lineage-group").filter({ hasText: "Wireframe" });
  await expect(group).toBeVisible();
  await group.click();
  const output = graph.getByTestId("lineage-output").first();
  await expect(output).toBeVisible();
  await output.click();
  // Picking an output highlights its upstream's path: only possible when the category node's
  // edges (built without names until this fix) and the subject column's (built with them)
  // keyed the same upstream the same way.
  await expect(graph.locator('[data-testid="lineage-upstream"][data-on-path="true"]').first()).toBeVisible();
});

// The mock's features (lib/api/mock/lane-f.ts) by key and title, as their rows name them.
const FEATURES: [string, string][] = [
  ["F-1", "Saved addresses at checkout"],
  ["F-2", "Shipping cost shown in the cart"],
  ["F-3", "Shared projects"],
  ["F-4", "Usage alerts"],
  ["F-5", "Address lookup service"],
  ["F-6", "Dark mode"],
  ["F-7", "Bulk export"],
  ["F-8", "Scheduled exports"],
];

/** The Score column's number style (scoreText: whole for RICE and MoSCoW, else two decimals), worked out here from the shown figures. */
const scoreStyle = (n: number, method: string) => {
  const places = method === "RICE" || method === "MoSCoW" ? 0 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
};
/** A step's shown arithmetic, as a person would key it into a calculator: "6,000 × 1 × 90% ÷ 1". */
const worked = (expr: string) => {
  const js = expr.replace(/,/g, "").replace(/(\d+(?:\.\d+)?)%/g, "($1/100)").replace(/×/g, "*").replace(/÷/g, "/");
  expect(js, `"${expr}" is plain arithmetic`).toMatch(/^[\d.\s()+*/]+$/);
  return Function(`"use strict"; return (${js});`)() as number;
};

async function pickMethod(page: Page, name: string) {
  await page.getByRole("radiogroup", { name: "Ranking method" }).getByRole("radio", { name, exact: true }).click();
  await expect(page.getByRole("radio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
}

async function stepsOf(page: Page, key: string, title: string) {
  await page.getByTestId(`priority-row-${key}`).getByRole("button", { name: title, exact: true }).click();
  const steps = page.getByTestId(`explanation-${key}`).getByRole("list", { name: "Steps" });
  await expect(steps).toBeVisible();
  return steps.getByRole("listitem").allInnerTexts();
}

/**
 * Every feature's steps under every method the mock offers: a score step's shown product is
 * the score it states and the Score column shows, and confidence is a percent wherever it is
 * a factor ("90%"), never a fraction ("0.9") or a bare 0-100 figure ("90").
 */
async function stepsAddUp(page: Page) {
  for (const method of ["Goal-weighted", "RICE", "WSJF", "MoSCoW"]) {
    await pickMethod(page, method);
    for (const [key, title] of FEATURES) {
      const score = (await page.getByTestId(`priority-row-${key}`).getByTestId("score").innerText()).trim();
      for (const step of await stepsOf(page, key, title)) {
        const s = step.trim();
        const sum = s.match(/^Score = (.+) = (\S+)$/);
        if (sum) {
          expect(scoreStyle(worked(sum[1]!), method), `${method} ${key}: "${s}"`).toBe(sum[2]);
          expect(sum[2], `${method} ${key}: the step states the Score column's score`).toBe(score);
        }
        const conf = s.match(/^Confidence = (\S+) × track record (\S+) = (\S+)$/);
        if (conf) {
          expect(conf[1], `${method} ${key}: "${s}"`).toMatch(/^\d+(\.\d)?%$/);
          expect(conf[3], `${method} ${key}: "${s}"`).toMatch(/^\d+(\.\d)?%$/);
          // The API rounds the product to three places: true to the shown tenth of a percent.
          expect(Math.abs(worked(`${conf[1]} × ${conf[2]}`) - worked(conf[3]!)), `${method} ${key}: "${s}"`).toBeLessThan(0.0006);
        }
      }
    }
  }
}

test("priorities: a score step's arithmetic is true, confidence a percent in every step", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible();

  const f2 = (m: string) => pickMethod(page, m).then(() => stepsOf(page, "F-2", "Shipping cost shown in the cart"));
  expect(await f2("RICE")).toEqual(["Score = 6,000 × 1 × 90% ÷ 1 = 5,400"]);
  await expect(page.getByTestId("priority-row-F-2").getByTestId("score")).toHaveText("5,400");
  expect(await f2("Goal-weighted")).toEqual([
    "Goal value = 3×3 (Raise activation) = 9",
    "Score = 9 × 90% ÷ 1 = 8.10",
  ]);
  expect(await f2("WSJF")).toEqual(["Cost of delay = 5 + 8 + 2 = 15", "Score = 15 ÷ 2 = 7.50"]);
  expect(await f2("MoSCoW")).toEqual(["Should have = 3; ties broken by goal value 9"]);

  await stepsAddUp(page);
});

test("priorities: with a track record, the confidence step and the formula read confidence alike", async ({ page }) => {
  await scenario(page, "outcomes");
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.getByTestId("track-record")).toContainText("Track record ×0.77");

  await pickMethod(page, "Goal-weighted");
  const steps = await stepsOf(page, "F-1", "Saved addresses at checkout");
  expect(steps).toContain("Confidence = 75% × track record 0.77 = 57.8%");
  expect(steps).toContain("Score = 6 × 57.8% ÷ 2 = 1.73");
  await pickMethod(page, "RICE");
  expect(await stepsOf(page, "F-1", "Saved addresses at checkout")).toEqual([
    "Confidence = 75% × track record 0.77 = 57.8%",
    "Score = 4,000 × 2 × 57.8% ÷ 2 = 2,312.00",
  ]);

  await stepsAddUp(page);
});

/**
 * The owner's "Percent everywhere" (2026-10-28): one confidence figure, to the tenth where it
 * is computed, reads the same in the ring, the Confidence section and its words, the Inputs
 * table, the score steps and the Confidence column; each evidence item is a percent too.
 */
async function confidenceReads(page: Page, key: string, title: string, shown: string) {
  const row = page.getByTestId(`priority-row-${key}`);
  // The bar's figure beside it, in the Confidence column.
  await expect(row.getByRole("meter", { name: `Confidence ${shown}` }).locator("..")).toHaveText(shown);
  // Whole, not clipped by its column ("46." for "46.2%").
  const cell = row.getByRole("meter", { name: `Confidence ${shown}` }).locator("xpath=ancestor::td[1]");
  const fit = await cell.evaluate((td) => {
    const figure = td.querySelector("b")!.getBoundingClientRect();
    const box = td.getBoundingClientRect();
    return figure.right <= box.right + 0.5 && td.scrollWidth <= td.clientWidth + 1;
  });
  expect(fit, "the Confidence figure fits its column").toBe(true);
  await row.getByRole("button", { name: title, exact: true }).click();
  const inspector = page.getByTestId("priority-inspector");
  const ring = inspector.getByRole("img", { name: `Confidence ${shown}` });
  await expect(ring).toBeVisible();
  await expect(ring).toHaveText(shown);
  const why = page.getByTestId(`explanation-${key}`);
  await expect(why.getByTestId("confidence-figure")).toHaveText(shown);
  await expect(why.getByTestId("confidence-explain")).toContainText(shown);
  await expect(why.getByRole("row", { name: /^Confidence/ }).getByRole("cell").nth(1)).toHaveText(shown);
  const steps = (await why.getByRole("list", { name: "Steps" }).getByRole("listitem").allInnerTexts()).join("\n");
  expect(steps).toContain(shown);
  for (const ev of await why.getByTestId("evidence-confidence").allInnerTexts()) expect(ev.trim()).toMatch(/^\d+(\.\d)?%$/);
}

test("priorities: confidence reads as one percent in the ring, the section, the Inputs and the steps", async ({ page }) => {
  // A laptop's width, where the table keeps its Confidence column beside the inspector.
  await page.setViewportSize({ width: 1512, height: 900 });
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible();
  await pickMethod(page, "Goal-weighted");
  await confidenceReads(page, "F-2", "Shipping cost shown in the cart", "90%");
});

test("priorities: with a track record, confidence reads as the same percent to the tenth everywhere", async ({ page }) => {
  // A laptop's width, where the table keeps its Confidence column beside the inspector.
  await page.setViewportSize({ width: 1512, height: 900 });
  await scenario(page, "outcomes");
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.getByTestId("track-record")).toContainText("Track record ×0.77");
  await pickMethod(page, "Goal-weighted");
  await confidenceReads(page, "F-1", "Saved addresses at checkout", "57.8%");
  // The words say where the figure came from: the evidence's average, then the track record.
  await expect(page.getByTestId("explanation-F-1").getByTestId("confidence-explain")).toHaveText(
    "Average of 7 evidence items: 75%; after the track record ×0.77, 57.8%",
  );
});

test("priorities: the Changes log names a retired override's anchor by the API's title, not its key", async ({ page }) => {
  await scenario(page, LEGACY_OVERRIDE_SCENARIO);
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible();
  const log = page.getByTestId("change-log");
  const row = log.getByRole("listitem").filter({ hasText: "Saved addresses at checkout" });
  await expect(row).toContainText("Moved above Shipping carrier picker");
  await expect(row).not.toContainText("F-99");
});
