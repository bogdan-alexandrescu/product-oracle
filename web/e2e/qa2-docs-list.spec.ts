import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 2, docs lane: the PRDs list (/documents), a PRD's overview, its Review settings
// sheet, its Publish page and a roadmap's Public version, driven as a person.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** Errors in the console and uncaught ones (React's hydration error #418 among them). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function openList(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/documents");
  await expect(page.getByTestId("document-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("document-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("document-inspector");

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  // qa-onboarding-15: a first brief sits under Ideas; the empty PRDs tab says so and opens it.
  test(`qa-onboarding-15: the first brief is pointed to from an empty PRDs tab (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
    await login(page);
    await page.getByRole("link", { name: "New PRD" }).filter({ visible: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeAttached();
    await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
    await page
      .getByRole("textbox", { name: "What problem does it solve?" })
      .fill("Returning buyers retype their address at every checkout.");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);

    await page.goto("/documents");
    const empty = page.getByTestId("prds-empty-ideas");
    await expect(empty).toContainText("No PRDs yet. 1 brief waits in Ideas.");
    await empty.getByRole("button", { name: "Open Ideas" }).click();
    await expect(page.getByTestId("idea-row").filter({ hasText: "Saved addresses at checkout" })).toBeVisible();
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  // qa-docs-19: the PRDs title's (i) opens below when there is no room above.
  test("qa-docs-19: the PRDs info tip stays inside the window", async ({ page }) => {
    await openList(page);
    await page.getByRole("button", { name: "About PRDs" }).filter({ visible: true }).first().click();
    const tip = page.getByRole("tooltip").filter({ visible: true });
    await expect(tip).toContainText("Every PRD and the briefs");
    const box = await tip.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
  });

  // qa-docs-20: the sort headers are 24 px tall targets at the least.
  test("qa-docs-20: the sort headers are at least 24 px tall", async ({ page }) => {
    await openList(page);
    for (const k of ["title", "status", "latest", "updated"]) {
      const box = await page.getByTestId(`sort-${k}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
    // No sort menu beside the headers on a wide window.
    await expect(page.getByTestId("sort-menu")).toBeHidden();
  });

  // qa-docs-34: the table and the panel write dates one way, in the Company time zone.
  test("qa-docs-34: the panel's Created and Updated read as the table's dates", async ({ page }) => {
    await openList(page);
    const r = row(page, "Saved carts PRD");
    await r.locator("td").last().click({ position: { x: 4, y: 4 } });
    await expect(inspector(page)).toContainText("Saved carts PRD");
    const tableDate = (await r.locator("td").nth(4).innerText()).trim();
    const day = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
    expect(tableDate).toMatch(day);
    await expect(inspector(page).getByTestId("inspector-updated")).toHaveText(tableDate);
    await expect(inspector(page).getByTestId("inspector-created")).toHaveText(day);
  });

  // qa-docs-6: the title names the version the panel shows.
  test("qa-docs-6: picking v1 in Versions makes the title read v1", async ({ page }) => {
    await login(page);
    await page.goto("/documents/saved-carts");
    const table = page.getByTestId("versions-table");
    await expect(table).toBeVisible();
    const suffix = page.getByRole("heading", { level: 1 }).locator("[data-title-suffix]");
    await expect(suffix).toHaveText("v2");
    await table.getByRole("row").filter({ has: page.getByRole("link", { name: "Version 1" }) }).locator("td").last().click();
    await expect(page.getByTestId("version-inspector")).toContainText("v1");
    await expect(suffix).toHaveText("v1");
  });

  // qa-docs-17: the empty Engineering specs card says what unlocks a spec.
  test("qa-docs-17: with no approved version, the specs card says to approve one", async ({ page }) => {
    await login(page);
    await page.goto("/documents/saved-carts");
    await expect(page.getByTestId("engineering-specs-empty")).toHaveText(
      "No engineering spec yet. Approve a version to request a spec.",
    );
  });

  // qa-docs-27: no hydration error on the first load after the theme is set.
  test("qa-docs-27: a PRD's page loads with no console error after a theme is picked", async ({ page }) => {
    await login(page);
    await page.getByTestId("user-menu").filter({ visible: true }).first().click();
    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const errors = collectErrors(page);
    await page.goto("/documents/saved-carts");
    await expect(page.getByTestId("versions-table")).toBeVisible();
    await page.goto("/documents");
    await expect(page.getByTestId("document-row").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  // qa-docs-31: Publish shows the same crumb as the document's other pages.
  test("qa-docs-31: the Publish page's breadcrumb names the PRD and its status", async ({ page }) => {
    await login(page);
    await page.goto("/documents/saved-carts/publish");
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb.getByRole("link", { name: "PRDs" })).toBeVisible();
    await expect(crumb.getByRole("link", { name: "Saved carts PRD" })).toHaveAttribute("href", "/documents/saved-carts");
    await expect(crumb).toContainText(/Draft|In review|Approved/);
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`review settings (${scheme})`, () => {
    test.use({ viewport: DESKTOP, colorScheme: scheme });

    // qa-docs-18: Required sections tick in the app's own box, not the browser's.
    test(`qa-docs-18: Required sections use the app's tick box (${scheme})`, async ({ page }) => {
      await login(page);
      await page.goto("/documents/checkout-redesign");
      await page.getByRole("button", { name: "Review settings" }).click();
      const sheet = page.getByRole("dialog", { name: "Review settings" });
      const box = sheet.getByTestId("required-sections").getByRole("checkbox").first();
      await expect(box).toBeVisible();
      expect(await box.evaluate((el) => getComputedStyle(el).appearance)).toBe("none");
      await box.check();
      await expect(box).toBeChecked();
      const [bg, accent] = await box.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const a = getComputedStyle(probe).color;
        probe.remove();
        return [getComputedStyle(el).backgroundColor, a];
      });
      expect(bg).toBe(accent);
      // The tick shows on the accent.
      await expect(box.locator("xpath=following-sibling::*[1]")).toBeVisible();
    });
  });
}

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  // qa-docs-20: a phone sorts from a menu above the list.
  test(`qa-docs-20: the list sorts from a menu (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openList(page);
    const menu = page.getByTestId("sort-menu");
    if (name === "desktop") {
      await expect(menu).toBeHidden();
      return;
    }
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const firstRow = await page.getByTestId("document-row").first().boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(firstRow!.y);
    await menu.selectOption({ label: "Document, A to Z" });
    const titles = (await page.getByTestId("document-row").locator("td:first-child").allInnerTexts()).map((t) => t.trim());
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    await menu.selectOption({ label: "Document, Z to A" });
    const back = (await page.getByTestId("document-row").locator("td:first-child").allInnerTexts()).map((t) => t.trim());
    expect(back).toEqual([...titles].reverse());
  });

  // qa-docs-4: a commenter or viewer sees the Publish page's locked state on the Public version.
  for (const email of ["commenter@example.com", "viewer@example.com"]) {
    test(`qa-docs-4: ${email.split("@")[0]} sees a locked Public version with the way back (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await login(page, email);
      await page.goto("/documents/usage-alerts-roadmap/public");
      const locked = page.getByTestId("public-check-locked");
      await expect(locked).toContainText("Only an approver or owner can check the Public version");
      await expect(locked.locator("svg").first()).toBeVisible();
      const back = locked.getByRole("link", { name: "Back to the roadmap" });
      await expect(back).toHaveAttribute("href", "/documents/usage-alerts-roadmap");
      await back.click();
      await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap$/);
    });
  }
}
