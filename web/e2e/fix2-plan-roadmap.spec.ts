import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA plan findings on Launches and Changelog (qa-plan-36, 37, 38, 39, 48) and the mock API's
 * speed (qa-plan-10), driven through the UI on the mock API. The default company has no
 * launches and no changelog entries; the "launches" scenario seeds three launches (one Ready)
 * and entries, two of them published and public.
 *
 * Card: protects=the empty Launches state alone, the card named after the filter, one button
 * height in each header row, a disabled export that reads as disabled in dark, a dialog that
 * covers the phone tab bar, and a page that settles under 2 s; fails_when=filters or table
 * headers show with no launch, "Launches" names the card, a header button is 32 px, a disabled
 * export keeps its outline at full strength, a tap on the tab bar under a dialog leaves the page,
 * or a page takes 2 s or more; no_claim=a real laptop's numbers (headless Chromium on the mock).
 */

/** lib/theme.ts THEME_KEY: the theme the user menu's Theme radio saves. */
const THEME_KEY = "oracle-theme";

async function start(page: Page, opts: { scenario?: string; theme?: "light" | "dark" } = {}) {
  if (opts.scenario) await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, opts.scenario] as const);
  if (opts.theme) await page.addInitScript(([k, t]) => localStorage.setItem(k, t), [THEME_KEY, opts.theme] as const);
  await login(page);
}

const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });

async function height(l: Locator): Promise<number> {
  return (await l.boundingBox())!.height;
}

test("qa-plan-48: with no launch, Launches shows only the empty state and its New launch", async ({ page }) => {
  await start(page);
  await page.goto("/roadmap/launches");
  const empty = page.getByTestId("launches-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No launches yet");
  // No filter chips that each read 0, no table and no column headers.
  await expect(page.getByTestId("launch-filters")).toHaveCount(0);
  await expect(page.getByTestId("launches-table")).toHaveCount(0);
  await expect(page.getByRole("columnheader")).toHaveCount(0);
  // The empty state's action opens New launch.
  await empty.getByTestId("launches-empty-new").click();
  await expect(page.getByRole("dialog", { name: "New launch" })).toBeVisible();
});

test("qa-plan-39: the launches card is named after its filter, not Launches again", async ({ page }) => {
  await start(page, { scenario: "launches" });
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("launch-row").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Launches", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Launches", exact: true })).toHaveCount(0);
  // Ready is the default filter while a launch is ready.
  await expect(page.getByRole("heading", { level: 2, name: "Ready launches", exact: true })).toBeVisible();
  await page.getByTestId("launch-filters").getByRole("button", { name: /^All/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "All launches", exact: true })).toBeVisible();
});

test("qa-plan-38: each header row has one button height, the primary's 40 px", async ({ page }) => {
  await start(page, { scenario: "launches" });
  await page.goto("/roadmap/launches");
  const toChangelog = header(page).getByTestId("changelog-link");
  const newLaunch = header(page).getByTestId("new-launch");
  await expect(newLaunch).toBeVisible();
  expect(await height(newLaunch)).toBe(40);
  expect(await height(toChangelog)).toBe(40);

  await toChangelog.click();
  await expect(page).toHaveURL(/\/roadmap\/changelog$/);
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
  for (const id of ["launches-link", "export-md", "export-html", "new-entry"]) {
    expect(await height(header(page).getByTestId(id)), id).toBe(40);
  }
});

test("qa-plan-37: in dark, a disabled export has no outline and is dimmed, unlike the Launches link", async ({ page }) => {
  await start(page, { theme: "dark" });
  await page.goto("/roadmap/changelog");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("changelog-empty")).toBeVisible();
  const look = (l: Locator) =>
    l.evaluate((el) => {
      el.getAnimations().forEach((a) => a.finish());
      const s = getComputedStyle(el);
      return { border: s.borderTopColor, width: s.borderTopWidth, opacity: Number(s.opacity) };
    });
  const link = await look(header(page).getByTestId("launches-link"));
  expect(link.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(link.opacity).toBe(1);
  for (const id of ["export-md", "export-html"]) {
    const button = header(page).getByTestId(id);
    await expect(button).toBeDisabled();
    const off = await look(button);
    expect(off.border === "rgba(0, 0, 0, 0)" || off.width === "0px", `${id}: no outline`).toBe(true);
    expect(off.opacity, `${id}: dimmed`).toBeLessThan(1);
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-plan-36: the New entry dialog's backdrop covers the tab bar, so a tap there keeps the draft", async ({ page }) => {
    await start(page);
    await page.goto("/roadmap/changelog");
    const tabBar = page.getByTestId("tab-bar");
    await expect(tabBar).toBeVisible();
    await page.getByTestId("new-entry").click();
    const dialog = page.getByRole("dialog", { name: "New entry" });
    await dialog.getByLabel("Title").fill("Faster exports");

    // The backdrop is stacked above the tab bar, and is what sits at the tab bar's middle.
    const z = await page.evaluate(() => {
      const of = (sel: string) => Number(getComputedStyle(document.querySelector(sel)!).zIndex);
      return { backdrop: of('[data-testid="dialog-backdrop"]'), tabs: of('[data-testid="tab-bar"]') };
    });
    expect(z.backdrop).toBeGreaterThan(z.tabs);
    const box = (await tabBar.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const covered = await page.evaluate(([px, py]) => {
      const hit = document.elementFromPoint(px, py);
      return !!hit?.closest('[data-testid="dialog-backdrop"]') && !hit.closest('[data-testid="tab-bar"]');
    }, [x, y] as const);
    expect(covered).toBe(true);

    // A tap there stays on the page and asks before dropping the draft.
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(/\/roadmap\/changelog$/);
    await expect(dialog.getByTestId("dialog-discard")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByLabel("Title")).toHaveValue("Faster exports");
  });

  test("qa-plan-48: at 390 px an empty Launches is the empty state alone, with no sideways scroll", async ({ page }) => {
    await start(page);
    await page.goto("/roadmap/launches");
    await expect(page.getByTestId("launches-empty")).toBeVisible();
    await expect(page.getByTestId("launch-filters")).toHaveCount(0);
    await expect(page.getByRole("columnheader")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

test("qa-plan-10: Launches and Changelog settle in under 2 s on the mock API", async ({ page }) => {
  await start(page, { scenario: "launches" });
  // Warm: the first visit seeds the mock's data and loads the route's code.
  await page.goto("/roadmap/launches");
  await expect(page.getByTestId("launch-inspector").filter({ visible: true })).toContainText("Hard budget caps");
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();

  let t0 = Date.now();
  await page.goto("/roadmap/launches");
  // Settled: the table and the selected launch's inspector (a second request) have drawn.
  await expect(page.getByTestId("launch-inspector").filter({ visible: true })).toContainText("Hard budget caps");
  const launches = Date.now() - t0;

  t0 = Date.now();
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
  const changelog = Date.now() - t0;

  console.log(`qa-plan-10: Launches settled in ${launches} ms, Changelog in ${changelog} ms`);
  expect(launches).toBeLessThan(2000);
  expect(changelog).toBeLessThan(2000);
});
