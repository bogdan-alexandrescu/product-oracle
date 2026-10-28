import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 1, docs lane: Present mode of Saved carts v2 (a draft), opened from the version.

async function openPresent(page: Page) {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await page.getByRole("link", { name: "Present" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/present$/);
  await expect(page.getByTestId("slide-counter")).toHaveText("1 / 10");
}

/** The slide's footer banner (in the slide's shadow root; Playwright's locators reach into it). */
const banner = (page: Page) => page.getByTestId("audience-view").locator(".slide-banner");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-30: the slide says when it was imported in words, its status capitalised, once", async ({ page }) => {
    await openPresent(page);
    const text = (await banner(page).innerText()).trim();
    expect(text).toMatch(/· Draft ·/);
    expect(text).toMatch(/Imported [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/· draft|imported /);
    // Not again in the control bar.
    await expect(page.getByRole("navigation", { name: "Presentation" })).not.toContainText("Imported");
    await expect(page.getByRole("navigation", { name: "Presentation" })).not.toContainText("Saved carts PRD");
  });

  test("qa-docs-59: no account button sits over the slide controls", async ({ page }) => {
    await openPresent(page);
    await expect(page.getByTestId("user-menu")).toHaveCount(0);
    await expect(page.getByTestId("app-nav")).toHaveCount(0);
    for (const name of ["Previous slide", "Next slide"]) {
      const button = page.getByRole("button", { name });
      const box = (await button.boundingBox())!;
      const hit = await page.evaluate(
        ([x, y, label]) => {
          const el = document.elementFromPoint(x, y);
          return !!el?.closest(`[aria-label="${label}"]`);
        },
        [box.x + box.width / 2, box.y + box.height / 2, name] as const,
      );
      expect(hit).toBe(true);
    }
    // Exit still leads back to the version, with its rail.
    await page.getByRole("link", { name: "Exit" }).click();
    await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2$/);
    await expect(page.getByTestId("user-menu")).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-6: the slide scales to the screen's width, its title and footer in full", async ({ page }) => {
    await login(page);
    await page.goto("/documents/saved-carts/v/2/present");
    await expect(page.getByTestId("slide-counter")).toHaveText("1 / 10");
    const slide = (await page.getByTestId("audience-view").locator(".current-slide").boundingBox())!;
    expect(slide.x).toBeGreaterThanOrEqual(0);
    expect(slide.x + slide.width).toBeLessThanOrEqual(390);
    // 16:9, letterboxed: the whole slide shows.
    expect(Math.abs(slide.width / slide.height - 16 / 9)).toBeLessThan(0.05);
    for (const part of [page.getByTestId("audience-view").locator(".slide-title").first(), banner(page)]) {
      const box = (await part.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });
});

test("qa-docs-6 / qa-docs-30: dark theme, the phone slide fits and its banner reads in words", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.goto("/documents/saved-carts/v/2/present");
  await expect(page.getByTestId("slide-counter")).toHaveText("1 / 10");
  const slide = (await page.getByTestId("audience-view").locator(".current-slide").boundingBox())!;
  expect(slide.x + slide.width).toBeLessThanOrEqual(390);
  await expect(banner(page)).toContainText(/Imported [A-Z][a-z]{2} \d{1,2}, /);
});
