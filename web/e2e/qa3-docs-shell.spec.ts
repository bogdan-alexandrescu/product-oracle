import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 3, Documents across pages: the account menu and Review settings answer a viewer's
 * real pointer clicks (qa-docs-1), one role badge with the same words on every Documents page
 * (qa-docs-22), and on a phone a control scrolled into view is never under the tab bar (qa-docs-31).
 */

const PHONE = { width: 390, height: 844 };

async function clickCentre(page: Page, testIdOrRole: ReturnType<Page["getByTestId"]>) {
  const box = (await testIdOrRole.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("qa-docs-1: a viewer's mouse click opens the account menu with Sign out, and Review settings read-only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "viewer@example.com");
  await page.goto("/documents");
  await page.getByRole("link", { name: "Saved carts PRD" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents\/saved-carts$/);

  const avatar = page.getByTestId("user-menu");
  await clickCentre(page, avatar);
  await expect(avatar).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.keyboard.press("Escape");

  await clickCentre(page, page.getByRole("button", { name: "Review settings" }).filter({ visible: true }).first());
  const sheet = page.getByRole("dialog").filter({ hasText: "Review settings" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("View only", { exact: true })).toBeVisible();
});

const COMMENTER_PAGES = [
  "/documents",
  "/documents/saved-carts",
  "/documents/saved-carts/v/2",
  "/documents/saved-carts/v/2/evidence",
  "/documents/saved-carts/v/2/quality",
  "/documents/saved-carts/v/2/roadmap",
  "/documents/saved-carts/composition",
];

test("qa-docs-22: a commenter reads one role badge, in the same words, on every Documents page", async ({ page }) => {
  await login(page, "commenter@example.com");
  for (const url of COMMENTER_PAGES) {
    await page.goto(url);
    const badge = page.getByTestId("role-badge").filter({ visible: true });
    await expect(badge, url).toHaveCount(1);
    await expect(badge, url).toHaveText("Commenter: can comment");
    await expect(page.getByText("View only", { exact: true }).filter({ visible: true }), url).toHaveCount(0);
    await expect(page.getByText(/Viewing as/).filter({ visible: true }), url).toHaveCount(0);
  }
});

test("qa-docs-22: a viewer reads View only, once, on every Documents page; an owner reads no badge", async ({ page }) => {
  await login(page, "viewer@example.com");
  for (const url of COMMENTER_PAGES) {
    await page.goto(url);
    await expect(page.getByTestId("view-only").filter({ visible: true }), url).toHaveCount(1);
  }
  await page.context().clearCookies();
  await login(page);
  for (const url of COMMENTER_PAGES.slice(0, 3)) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByTestId("role-badge"), url).toHaveCount(0);
    await expect(page.getByTestId("view-only"), url).toHaveCount(0);
  }
});

test("qa-docs-31: on a phone the overview's Edit, scrolled into view, sits clear of the tab bar's More", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/documents/checkout-redesign");
  const edit = page.getByRole("button", { name: /^Edit owner and reviewers/ }).filter({ visible: true }).first();
  await edit.scrollIntoViewIfNeeded();
  const [e, bar] = await Promise.all([edit.boundingBox(), page.getByTestId("tab-bar").boundingBox()]);
  expect(e!.y + e!.height).toBeLessThanOrEqual(bar!.y);
});
