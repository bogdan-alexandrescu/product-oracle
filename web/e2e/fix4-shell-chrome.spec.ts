import { expect, test, type Page } from "./test";

import { ADMIN, login, signOut } from "./helpers";

/*
 * QA fixes on the Detailed shell's chrome, driven through the UI against the mock.
 *
 * Card fix4-shell-chrome: protects = signing in from the plain sign-in page lands on the
 * person's home at its own address, with one H1 (qa-shell-1); the browser tab reads
 * "<page> · <section> · Product Oracle", never a count, the same on a desktop and a phone
 * (qa-shell-16); on a phone Tab meets the top bar, the page, then the tab bar, and Skip to
 * content lands past the top bar (qa-shell-31); below 1600 px the open Ask drawer dims the page
 * and its own Close is the one control that closes it (qa-shell-13); fails_when = any of those
 * regresses; no_claim = the real API, Simple's shell.
 */

const PHONE = { width: 390, height: 844 };

/** Where the focused element sits: the phone's top bar, the page, the tab bar, or elsewhere. */
function focusedRegion(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "none";
    if (el.closest('[data-testid="phone-header"]')) return "header";
    if (el.closest('[data-testid="tab-bar"]')) return "tabs";
    if (el.closest("main")) return "page";
    if (el.closest('[data-testid="skip-link"]')) return "skip";
    return "other";
  });
}

test("qa-shell-1: signing in from the plain sign-in page lands on Home at /home, with one H1", async ({ page }) => {
  await login(page);
  await signOut(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  // Not a hidden Sign in kept under Home.
  await expect(page.locator("h1", { hasText: "Sign in" })).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page).toHaveTitle("Home · Product Oracle");
});

test("qa-shell-1: signing in straight after signing out, without reopening sign-in, also changes the address", async ({ page }) => {
  await login(page);
  await signOut(page);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator("h1", { hasText: "Sign in" })).toHaveCount(0);
});

/** The browser tab of each page, as a person reads it. */
const TITLES: [string, string][] = [
  ["/requests", "All requests · Requests · Product Oracle"],
  ["/requests/themes", "Themes · Requests · Product Oracle"],
  ["/settings/templates/new", "New template · Templates · Settings · Product Oracle"],
  ["/plan/dates", "Dates · Plan · Product Oracle"],
  ["/plan/documents", "Roadmap documents · Plan · Product Oracle"],
];

async function checkTitles(page: Page) {
  for (const [path, title] of TITLES) {
    await page.goto(path);
    // Themes' tab counts the themes: wait for the count, so a title that took it in shows.
    if (path === "/requests/themes") await expect(page.getByTestId("requests-tab-themes-count").filter({ visible: true })).toHaveText(/^\d+$/);
    await expect(page, path).toHaveTitle(title);
  }
}

test("qa-shell-16: the browser tab names the page, then its section, with no counts (desktop)", async ({ page }) => {
  await login(page);
  await checkTitles(page);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-shell-16: the browser tab reads the same on a phone", async ({ page }) => {
    await login(page);
    await checkTitles(page);
  });

  test("qa-shell-31: Tab meets the top bar, the page, then the tab bar; Skip to content lands past the top bar", async ({ page }) => {
    await login(page);
    await page.goto("/inbox");
    await expect(page.getByTestId("tab-bar")).toBeVisible();
    await expect(page.getByTestId("phone-header")).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    const seen: string[] = [];
    for (let i = 0; i < 400; i++) {
      await page.keyboard.press("Tab");
      const at = await focusedRegion(page);
      if (seen[seen.length - 1] !== at) seen.push(at);
      if (at === "tabs") break;
    }
    expect(seen.slice(0, 3)).toEqual(["header", "page", "tabs"]);

    // Skip to content: the next Tab is the page's first control, not the top bar's.
    await page.goto("/inbox");
    await expect(page.getByTestId("tab-bar")).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await focusedRegion(page)).toBe("page");
  });
});

for (const width of [1440, 1512]) {
  test(`qa-shell-13: at ${width} px the open Ask drawer dims the page, and its own Close is the one control`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    const strip = page.getByTestId("hop-strip");
    await expect(strip).toBeVisible();
    await strip.click();
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await expect(panel).toBeVisible();
    // The page under it is dimmed: a press on Home's right-hand side meets the backdrop, not the page.
    const backdrop = page.getByTestId("hop-backdrop");
    await expect(backdrop).toBeVisible();
    const drawer = (await page.getByTestId("hop-drawer").boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-testid") ?? null, [drawer.x - 40, 450]);
    expect(hit).toBe("hop-backdrop");
    // One control closes it: the panel's own, not the strip beside it as well.
    await expect(strip).toBeHidden();
    await expect(page.getByRole("button", { name: "Close Ask Oracle" })).toHaveCount(1);
    await panel.getByRole("button", { name: "Close Ask Oracle" }).click();
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
    await expect(strip).toBeFocused();
    // A press on the dimmed page closes it too.
    await strip.click();
    await expect(panel).toBeVisible();
    await backdrop.click({ position: { x: 200, y: 450 } });
    await expect(page.getByTestId("hop-panel")).toHaveCount(0);
    await expect(backdrop).toHaveCount(0);
  });
}

test.describe("qa-shell-31 on a phone, drawn after the page", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-shell-31: the tab bar stays under a page's own sheet, whose buttons can be pressed", async ({ page }) => {
    await login(page);
    await page.goto("/baseline");
    await page.getByRole("button", { name: "Add item" }).click();
    const form = page.getByRole("dialog", { name: "Add an item" });
    await form.getByLabel("Kind").selectOption("assumption");
    await form.getByLabel("Title").fill("Shops sell mostly on phones");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeHidden();
  });
});
