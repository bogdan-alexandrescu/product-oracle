import type { Page } from "@playwright/test";

import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * X-3: printing a Detailed version page (a roadmap or a PRD saved as PDF) prints the document
 * alone: no navigation rail, Ask panel, version toolbar, Outline, section switcher or review
 * panel, the document across the sheet in light colours whatever the theme.
 * fails_when = any of those prints, the document keeps the review panel's column beside it, or
 * a dark theme prints light text on a white sheet (or dark panels).
 */

const PAGES = [
  { name: "roadmap", url: "/documents/usage-alerts-roadmap/v/1" },
  { name: "PRD", url: "/documents/saved-carts/v/2" },
];

const CHROME = ["app-nav", "version-tabs", "hop-dock", "version-toolbar", "outline-rail", "section-switcher", "review-panel-column"];

// A transparent box shows the white sheet.
function luminance(rgb: string): number {
  const m = rgb.match(/[\d.]+/g)!.map(Number);
  if (m.length === 4 && m[3] === 0) return 255;
  return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000;
}

async function open(page: Page, url: string, theme: "light" | "dark" | "system-dark") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.evaluate((t) => (t === "system-dark" ? localStorage.removeItem("oracle-theme") : localStorage.setItem("oracle-theme", t)), theme);
  await page.goto(url);
  await expect(page.getByRole("article", { name: "Document" })).toBeVisible();
  await expect(page.getByTestId("version-toolbar")).toBeVisible();
  await expect(page.getByTestId("review-panel-column")).toBeVisible();
  await expect(page.getByTestId("app-nav")).toBeVisible();
  if (theme !== "system-dark") await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

for (const p of PAGES) {
  for (const theme of ["light", "dark", "system-dark"] as const) {
    test(`${p.name} version: printing leaves out the app, in light colours (${theme})`, async ({ page }) => {
      await open(page, p.url, theme);
      // A PRD says on screen which part it shows (Brief or Full); that note is not part of the document.
      const note = page.getByTestId("view-note");
      if (p.name === "PRD") await expect(note).toBeVisible();
      await page.emulateMedia({ media: "print", colorScheme: theme === "system-dark" ? "dark" : "light" });
      if (p.name === "PRD") await expect(note).toBeHidden();
      for (const id of CHROME) {
        await expect(page.getByTestId(id), id).toBeHidden();
      }
      await expect(page.getByTestId("doc-header").locator("[data-page-action]")).toBeHidden();
      await expect(page.getByTestId("phone-bar")).toBeHidden();
      // Nor the section's own buttons: its review bar, its actions menu, its feedback button.
      await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^(Expand|Collapse) / })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Open feedback on this section/ })).toHaveCount(0);

      // The document is there, from the left edge to the right one (inside the page's own margin).
      const article = page.getByRole("article", { name: "Document" });
      await expect(article).toBeVisible();
      await expect(page.getByTestId("document-sections")).toBeVisible();
      const body = (await page.locator("body").boundingBox())!;
      const main = (await page.locator("main#main").boundingBox())!;
      const box = (await article.boundingBox())!;
      expect(main.x).toBeLessThanOrEqual(body.x + 1);
      expect(main.width).toBeGreaterThanOrEqual(body.width - 1);
      expect(box.width).toBeGreaterThan(body.width - 60);

      // Light colours: a white-ish sheet and dark text, whatever the theme.
      const colours = await page.evaluate(() => {
        const css = (el: Element | null, prop: "backgroundColor" | "color") => (el ? getComputedStyle(el)[prop] : "");
        const heading = document.querySelector('[data-testid="document-sections"] h2, [data-testid="document-sections"] h1');
        return {
          page: css(document.body, "backgroundColor"),
          article: css(document.querySelector('article[aria-label="Document"]'), "backgroundColor"),
          text: css(heading, "color"),
          title: css(document.querySelector("h1"), "color"),
        };
      });
      expect(luminance(colours.article)).toBeGreaterThan(240);
      expect(luminance(colours.page)).toBeGreaterThan(220);
      expect(luminance(colours.text)).toBeLessThan(90);
      expect(luminance(colours.title)).toBeLessThan(90);

      // Back on screen, the app is there again.
      await page.emulateMedia({ media: "screen" });
      await expect(page.getByTestId("app-nav")).toBeVisible();
      await expect(page.getByTestId("version-toolbar")).toBeVisible();
      await expect(page.getByTestId("review-panel-column")).toBeVisible();
    });
  }

  test(`${p.name} version: on a Letter sheet the document fits the width and tables wrap`, async ({ page }) => {
    await open(page, p.url, "light");
    await page.setViewportSize({ width: 816, height: 1056 });
    await page.emulateMedia({ media: "print" });
    for (const id of ["app-nav", "hop-dock", "version-toolbar", "outline-rail", "section-switcher", "review-panel-column"]) {
      await expect(page.getByTestId(id), id).toBeHidden();
    }
    const box = (await page.getByRole("article", { name: "Document" }).boundingBox())!;
    expect(box.width).toBeGreaterThan(816 - 60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const tables = await page.locator('[data-testid="document-sections"] table').count();
    for (let i = 0; i < tables; i++) {
      const t = (await page.locator('[data-testid="document-sections"] table').nth(i).boundingBox())!;
      expect(t.x + t.width).toBeLessThanOrEqual(816 + 1);
    }
  });
}

// A Letter sheet's printable width (page margins taken off) is about 720 px.
test("roadmap version: the Items tab prints whole, names wrapping between words", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 1056 });
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1/items");
  const table = page.getByTestId("roadmap-items-table");
  await expect(table).toBeVisible();
  await page.emulateMedia({ media: "print" });
  for (const id of ["app-nav", "version-toolbar", "version-tabs"]) await expect(page.getByTestId(id), id).toBeHidden();
  const names = table.locator('td[data-phone="title"]');
  await expect(names).toHaveCount(2);
  const cut = await names.evaluateAll((cells) => cells.filter((c) => c.scrollWidth > c.clientWidth).map((c) => c.textContent));
  expect(cut, "item names cut off").toEqual([]);
  // Each name has room for its longest word, and the table stays inside the sheet.
  for (const name of ["Behaviour", "Success"]) {
    const w = await names.filter({ hasText: name }).evaluate((c, text) => {
      const r = document.createRange();
      r.selectNodeContents(c);
      return { cell: c.clientWidth, text: r.getBoundingClientRect().width, label: text };
    }, name);
    expect(w.cell, name).toBeGreaterThanOrEqual(w.text - 1);
  }
  const t = (await table.locator("table").boundingBox())!;
  expect(t.x + t.width).toBeLessThanOrEqual(720 + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ media: "screen" });
  await expect(page.getByTestId("app-nav")).toBeVisible();
});
