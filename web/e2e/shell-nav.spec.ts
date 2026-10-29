import { expect, test, type Page } from "./test";

import { switchTarget } from "../lib/experience-paths";
import { login } from "./helpers";

/*
 * The shell's navigation fixes, through the UI on the mock (desktop 1366x820 unless a test
 * says otherwise, and a phone 390x844):
 * qa-shell-2 page titles; qa-plan-19, qa-shell-14, 15 the active rail item; qa-shell-5 the
 * Simple/Detailed lists' pair; qa-shell-10, 27 the phone More sheet; qa-shell-12, 18 the user
 * menu's focus; qa-plan-63, qa-shell-17 the skip link; qa-shell-19 the Ask panel's focus;
 * qa-shell-8 where it docks; qa-shell-16 one Ask control on Simple; qa-shell-22, 23 the phone
 * header. protects=what a keyboard, a screen reader and a phone see; fails_when=a title, an
 * active item, a focus move or a dismiss gesture is missing; no_claim=the pages' own content.
 */

const PHONE = { width: 390, height: 844 };
const DOC = "/documents/checkout-redesign";

const rail = (page: Page) => page.getByTestId("app-nav");

test.describe("switchTarget (qa-shell-5)", () => {
  test("the PRDs list and the One-pagers list match both ways; a PRD and its one-pager still do", () => {
    expect(switchTarget("/documents", "simple")).toBe("/simple/one-pagers");
    expect(switchTarget("/simple/one-pagers", "detailed")).toBe("/documents");
    expect(switchTarget("/documents/checkout-redesign", "simple")).toBe("/simple/one-pagers/checkout-redesign");
    expect(switchTarget("/documents/checkout-redesign/v/2", "simple", "/documents")).toBe("/simple/one-pagers/checkout-redesign");
    expect(switchTarget("/simple/one-pagers/checkout-redesign", "detailed")).toBe("/documents/checkout-redesign");
    // A roadmap's document page has no one-pager: Plan's match, Simple's Roadmap.
    expect(switchTarget("/documents/usage-alerts-roadmap", "simple", "/plan")).toBe("/simple/roadmap");
    expect(switchTarget("/documents/vision", "simple", "/company/strategy")).toBe("/simple");
    // The rest as before.
    expect(switchTarget("/plan/dates", "simple")).toBe("/simple/roadmap");
    expect(switchTarget("/runs", "simple")).toBe("/simple");
    expect(switchTarget("/simple", "detailed")).toBe("/home");
    expect(switchTarget("/simple/decisions", "detailed")).toBe("/company/decisions");
    expect(switchTarget("/home", "detailed")).toBe("/home");
  });
});

test("the browser tab names the page: signed out, Home, a document", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("Sign in · Product Oracle");
  await login(page);
  await expect(page).toHaveTitle("Home · Product Oracle");
  await page.goto(DOC);
  await expect(page.getByRole("heading", { level: 1, name: /Checkout redesign PRD/ })).toBeVisible();
  await expect(page).toHaveTitle("Checkout redesign PRD · Product Oracle");
  // A section's tab is named for itself in the tab, for its section on the phone header.
  await page.goto("/plan/dates");
  const h1 = (await page.getByRole("heading", { level: 1 }).first().innerText()).trim();
  await expect(page).toHaveTitle(`${h1} · Product Oracle`);
});

test("the active rail item: Plan for the Roadmap's tabs and a new roadmap, the avatar on My account", async ({ page }) => {
  await login(page);
  const plan = rail(page).getByTestId("nav-plan");
  for (const path of ["/roadmap/changelog", "/roadmap/launches", "/plan/dates", "/documents/new?kind=roadmap"]) {
    await page.goto(path);
    await expect(plan, path).toHaveAttribute("aria-current", "page");
    await expect(rail(page).getByTestId("nav-prds"), path).not.toHaveAttribute("aria-current", "page");
  }
  await page.goto("/documents/new?kind=prd");
  await expect(rail(page).getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
  await expect(plan).not.toHaveAttribute("aria-current", "page");

  await page.getByTestId("user-menu").click();
  await page.getByTestId("nav-my-account").click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId("user-menu")).toHaveAttribute("aria-current", "page");
  await expect(rail(page).locator('a[aria-current="page"]')).toHaveCount(0);
});

test("the user menu: focus moves to the checked theme, Escape closes it and returns to the avatar", async ({ page }) => {
  await login(page);
  const avatar = page.getByTestId("user-menu");
  await avatar.click();
  const menu = page.getByRole("dialog", { name: "Account" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("radio", { checked: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(avatar).toBeFocused();
});

test("the skip link is the first Tab stop and moves to the page", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  expect((await skip.boundingBox())!.width).toBeGreaterThan(20);
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("Ask at 1440: opening focuses the question box, closing returns to the strip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const strip = page.getByTestId("hop-strip");
  await strip.click();
  const box = page.getByTestId("hop-panel").filter({ visible: true }).getByRole("textbox", { name: "Ask Oracle" });
  await expect(box).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("hop-panel")).toHaveCount(0);
  await expect(strip).toBeVisible();
  await expect(strip).toBeFocused();
  // ⌘J / Ctrl+J too.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(box).toBeFocused();
});

test("Ask overlays at 1512 (the page keeps its width) and docks at 1700", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await login(page);
  const main = page.locator("main");
  // Measure once the shell is in place (its rail and the Ask dock beside the page): measured
  // while Home is still loading, the page spans the window.
  await expect(page.getByTestId("hop-strip")).toBeVisible();
  await expect(page.getByRole("navigation").first()).toBeVisible();
  const before = (await main.boundingBox())!.width;
  expect(before).toBeLessThan(1512);
  await page.getByTestId("hop-strip").click();
  await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
  expect((await main.boundingBox())!.width).toBe(before);
  expect((await page.getByTestId("hop-dock").boundingBox())!.width).toBe(45);
  await expect(page.getByTestId("hop-drawer")).toHaveCSS("position", "fixed");

  await page.setViewportSize({ width: 1700, height: 900 });
  await expect(page.getByTestId("hop-dock")).toHaveAttribute("data-open", "true");
  await expect.poll(async () => (await page.getByTestId("hop-dock").boundingBox())!.width).toBe(400);
  await expect(page.getByTestId("hop-drawer")).toHaveCSS("position", "static");
  await expect(page.getByTestId("hop-strip")).toBeHidden();
});

test("Simple: one Ask control, and the PRDs and One-pagers lists switch both ways", async ({ page }) => {
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("simple-nav")).toBeVisible();
  await expect(page.getByTestId("simple-ask")).toBeVisible();
  await expect(page.getByTestId("hop-strip")).toHaveCount(0);
  // Simple's Ask Oracle still opens the panel.
  await page.getByTestId("simple-ask").click();
  await expect(page.getByTestId("hop-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("hop-drawer")).toHaveCount(0);

  const mode = page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true });
  await mode.getByRole("radio", { name: "Detailed" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByTestId("hop-strip")).toBeVisible();
  await mode.getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers$/);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("sign-in has its own heading and no app header", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    expect((await page.getByRole("heading", { level: 1, name: "Sign in" }).boundingBox())!.height).toBeGreaterThan(20);
    await expect(page.getByTestId("phone-header")).toHaveCount(0);
  });

  test("the header names the section on its tabs, the page elsewhere", async ({ page }) => {
    await login(page);
    const title = page.getByTestId("phone-title");
    for (const [path, name] of [
      ["/plan/dates", "Plan"],
      ["/plan", "Plan"],
      ["/roadmap/changelog", "Plan"],
      // qa-settings-40: Settings' pages name themselves.
      ["/settings/members", "Members"],
      ["/settings/themes", "Themes"],
      ["/company/decisions", "Company"],
    ] as const) {
      await page.goto(path);
      await expect(title, path).toHaveText(name);
    }
    await page.goto(DOC);
    await expect(title).toContainText("Checkout redesign PRD");
  });

  test("More: a backdrop, Escape, a tap outside and a swipe down close it; focus goes in and back; no account controls", async ({ page }) => {
    await login(page);
    const moreButton = page.getByTestId("tab-more");
    const sheet = page.getByRole("dialog", { name: "More" });

    await moreButton.click();
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("more-sheet").getByTestId("sheet-scrim")).toBeVisible();
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // The account lives in the header's avatar only.
    await expect(sheet.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(sheet.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
    await expect(sheet.getByRole("link", { name: "My account" })).toHaveCount(0);
    // The tab bar stays in reach below it.
    const sheetBox = (await sheet.boundingBox())!;
    const barBox = (await page.getByTestId("tab-bar").boundingBox())!;
    expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(barBox.y + 1);

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(moreButton).toBeFocused();

    await moreButton.click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(195, 60);
    await expect(sheet).toHaveCount(0);

    await moreButton.click();
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 30;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 40, { steps: 4 });
    await page.mouse.move(x, y + 120, { steps: 4 });
    await page.mouse.up();
    await expect(sheet).toHaveCount(0);

    // A tap on a destination still navigates.
    await moreButton.click();
    await sheet.getByRole("link", { name: "Runs" }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expect(sheet).toHaveCount(0);
  });

  test("the header's avatar menu: focus in, Escape back; marked on My account", async ({ page }) => {
    await login(page);
    const avatar = page.getByTestId("phone-user-menu");
    await avatar.click();
    const menu = page.getByRole("dialog", { name: "Account" });
    await expect(menu.getByRole("radio", { checked: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(avatar).toBeFocused();
    await avatar.click();
    await menu.getByRole("link", { name: "My account" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(avatar).toHaveAttribute("aria-current", "page");
  });
});
