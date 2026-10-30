import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 1, docs lane: the Evidence tab of a PRD version (/documents/saved-carts/v/2/evidence),
 * as a person opens it from the version's tabs.
 */

async function openEvidence(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/evidence/);
  await expect(page.getByTestId("evidence-matrix")).toBeVisible();
}

/** WCAG contrast of an element's text against the first opaque background behind it. */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = rgb(getComputedStyle(node).color);
    let bg = [255, 255, 255];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

test("qa-docs-29: the coverage matrix shows names only, no section keys or citation ids", async ({ page }) => {
  await openEvidence(page);
  const matrix = page.getByTestId("evidence-matrix");
  const head = matrix.locator("thead");
  await expect(head).toContainText("Goal trace");
  for (const key of ["summary", "goal-trace", "brief-items"]) await expect(head).not.toContainText(key);
  // Draft citations are named by their title and source, never by their marker id.
  await expect(matrix.getByText("Draft citations")).toBeVisible();
  await expect(page.getByTestId("evidence-coverage")).not.toContainText(/c:c\d/);
});

test("qa-docs-29: the per-section totals and the score legend say what they count", async ({ page }) => {
  await openEvidence(page);
  const totals = page.getByTestId("evidence-totals").locator("td[data-section]");
  expect(await totals.count()).toBeGreaterThan(0);
  for (const t of await totals.all()) await expect(t).toHaveText(/^\d+ links?, \d+ citations?$/);
  await expect(page.getByTestId("evidence-totals")).not.toContainText("0 · 0");

  const legend = page.getByLabel("Legend");
  // qa-docs-53: words, not scores.
  await expect(legend).toContainText("Link confidence:");
  await expect(legend).toContainText("StrongMediumWeak");
  await expect(legend).not.toContainText(/\d\.\d/);
});

test("qa-docs-29: the coverage panel uses no monospace font and words for a missing snapshot", async ({ page }) => {
  await openEvidence(page);
  const panel = page.getByTestId("evidence-coverage");
  await expect(panel).toContainText("The draft does not say when its sources were read.");
  await expect(panel).not.toContainText("Snapshot not recorded");
  const mono = await panel.evaluate((root) =>
    [root, ...root.querySelectorAll("*")].filter((el) => /mono/i.test(getComputedStyle(el).fontFamily) && (el.textContent ?? "").trim()).map((el) => el.textContent),
  );
  expect(mono).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-29: the empty-cell dots are readable in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openEvidence(page);
    const dots = page.getByTestId("evidence-matrix").locator("td[data-section]:not([data-gap]) [data-testid=evidence-empty-cell]");
    await expect(dots.first()).toBeVisible();
    // The old colour was the line-strong border token, too faint for text.
    const old = scheme === "light" ? "rgb(125, 142, 163)" : "rgb(95, 112, 135)";
    await expect(dots.first()).not.toHaveCSS("color", old);
    expect(await contrast(dots.first())).toBeGreaterThanOrEqual(4.5);
  });
}
