import { expect, test, type Page } from "./test";

import { ADMIN, login } from "./helpers";

// qa-shell-3, 4, 24, 25, 26: a wrong URL is the app's own "Page not found" (title, sentence,
// Go to Home, a link back to its section), without a hydration error, without a vertical
// scroll on a phone; a missing document says so once with no actions; /company has one H1.

const PHONE = { width: 390, height: 844 };

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Errors in the console and uncaught ones (React's hydration error #418 among them). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    // The 404 status of the page itself is not an app error.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function expectNoVerticalScroll(page: Page) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.scrollingElement!.scrollHeight,
    inner: window.innerHeight,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.beforeEach(async ({ page }) => {
      if (phone) await page.setViewportSize(PHONE);
      await login(page);
    });

    test("a wrong URL is the app's Page not found, with Go to Home", async ({ page }) => {
      const appBg = await bodyBg(page);
      const errors = collectErrors(page);
      await page.goto("/this-page-does-not-exist");
      await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toHaveCount(1);
      await expect(page.getByText("This page doesn't exist or has moved.")).toBeVisible();
      await expect(page).toHaveTitle("Page not found · Product Oracle");
      expect(await bodyBg(page)).toBe(appBg);
      // Not under a known section: no back link.
      await expect(page.getByTestId("not-found-back")).toHaveCount(0);
      if (phone) await expectNoVerticalScroll(page);
      expect(errors).toEqual([]);
      await page.getByRole("link", { name: "Go to Home" }).click();
      await expect(page).toHaveURL(/\/home$/);
    });

    for (const [path, label, href] of [
      ["/settings/nope", "Back to Settings", "/settings"],
      ["/company/nope", "Back to Company", "/company"],
    ] as const) {
      test(`${path}: no console error, and a link back to the section`, async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toHaveCount(1);
        const back = page.getByRole("link", { name: label });
        await expect(back).toBeVisible();
        await expect(back).toHaveAttribute("href", href);
        await expect(page.getByRole("link", { name: "Go to Home" })).toBeVisible();
        if (phone) await expectNoVerticalScroll(page);
        expect(errors).toEqual([]);
      });
    }

    test("a missing document's version says so once, with Back to PRDs and no actions", async ({ page }) => {
      await page.goto("/documents/no-such-doc/v/9");
      const message = page.getByText("This document doesn't exist or was deleted.").filter({ visible: true });
      await expect(message).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Back to PRDs" }).filter({ visible: true })).toHaveAttribute("href", "/documents");
      await expect(page.getByRole("button", { name: /Export/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /Compare with/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Comment on the whole draft/ })).toHaveCount(0);
      if (phone) await expectNoVerticalScroll(page);
    });

    test("/company opens Strategy with one H1", async ({ page }) => {
      await page.goto("/company");
      await expect(page).toHaveURL(/\/company\/strategy$/);
      await expect(page.getByRole("heading", { level: 1, name: "Company" })).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);
    });
  });
}

test("Go to Home takes a Simple user to Simple's home, not Detailed's", async ({ page }) => {
  // protects=Go to Home follows the person's landing (fix-shell review); fails_when=it always
  // opens /home, Detailed's; no_claim=the landing rule itself (simple-mode.spec.ts).
  await page.goto("/login");
  await page.getByLabel("Email").fill("viewer@example.com");
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  await page.goto("/this-page-does-not-exist");
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/\/simple$/);
});
