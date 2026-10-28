import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * I3 rule 3: one primary action per page, top-right, drawn as primary (filled), even while
 * it is disabled (New PRD's Create draft, a theme's Save, a template's Save as new version).
 */
const PAGES = [
  "/documents",
  "/documents/new",
  "/documents/new?kind=roadmap",
  "/priorities",
  "/plan/documents",
  "/runs",
  "/settings/members",
  "/settings/sources",
  "/settings/claude-accounts",
  "/settings/themes",
  "/settings/themes/new",
  "/settings/themes/clean-document",
  "/settings/templates",
  "/settings/templates/new",
  "/settings/templates/ai-feature",
];

const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** The visible page header's buttons and links that carry a Button variant. */
async function headerButtons(page: Page) {
  const header = page.locator("header[data-page-header]").filter({ visible: true });
  await expect(header).toHaveCount(1);
  // Wait for the header's action, which some pages draw once their data loads.
  await expect(header.locator('[data-variant="primary"]').first()).toBeVisible();
  return header.locator("[data-variant]").filter({ visible: true }).evaluateAll((els) => {
    const surface = getComputedStyle(document.body).backgroundColor;
    return els.map((el) => {
      const s = getComputedStyle(el);
      return {
        name: el.textContent?.trim() ?? "",
        variant: el.getAttribute("data-variant"),
        background: s.backgroundColor,
        border: s.borderTopWidth,
        surface,
      };
    });
  });
}

async function expectOneFilledPrimary(page: Page, path: string) {
  const buttons = await headerButtons(page);
  const primary = buttons.filter((b) => b.variant === "primary");
  expect(primary, `${path}: one primary action`).toHaveLength(1);
  const [p] = primary;
  // Filled: a fill of its own, no outline.
  expect(p.background, `${path}: ${p.name} is filled`).not.toBe(TRANSPARENT);
  expect(p.background, `${path}: ${p.name} is filled`).not.toBe(p.surface);
  expect(p.border, `${path}: ${p.name} has no outline`).toBe("0px");
  // Nothing else in the header is filled.
  for (const b of buttons.filter((x) => x !== p)) {
    expect(["primary", "solid"], `${path}: ${b.name} is not filled`).not.toContain(b.variant);
  }
}

/** The whole page, outside any dialog: exactly one filled primary. */
async function expectOnePrimaryOnPage(page: Page, path: string) {
  const primary = page.locator('main [data-variant="primary"]').filter({ visible: true });
  await expect(primary, `${path}: one primary on the page`).toHaveCount(1);
}

for (const scheme of ["light", "dark"] as const) {
  test(`each page header has exactly one filled primary button (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await login(page);
    for (const path of PAGES) {
      await page.goto(path);
      await expectOneFilledPrimary(page, path);
      await expectOnePrimaryOnPage(page, path);
    }
    // Sources is a search page: its one primary is the search form's Search. It sits under
    // Settings › Sources already, so its header has no Manage link (qa-work-53).
    await page.goto("/sources");
    await expectOnePrimaryOnPage(page, "/sources");
    await expect(page.locator("header[data-page-header]").filter({ visible: true }).getByRole("link", { name: "Manage" })).toHaveCount(0);
    // A run waiting at a checkpoint: Decide.
    await page.goto("/runs");
    await page.getByTestId("run-row").filter({ hasText: "team onboarding" }).getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
    await expectOneFilledPrimary(page, "run waiting at a checkpoint");
  });
}
