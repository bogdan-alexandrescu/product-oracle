import { login } from "./helpers";
import { expect, test, type Page } from "./test";

import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";

/*
 * QA fixes on Simple's shell (qa-shell-17, 18, 20), driven through the UI against the mock.
 *
 * Card fix4-shell-simple-shell: protects = Simple's phone More sheet is Detailed's sheet (a
 * backdrop, a handle, the title "More" and a close button); a member with no name sees their
 * email in the rail broken at its "@", never mid-word; while a Simple page loads, the rail's
 * skeleton holds the Mode switch's place (the destinations never move down) and the page shows
 * a skeleton, not a blank area; fails_when = any of those regresses; no_claim = the real API.
 */

const PHONE = { width: 390, height: 844 };

/** The lines an element's text is drawn on, as the person reads them. */
function lines(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const out: { top: number; text: string }[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.textContent ?? "";
      for (let i = 0; i < t.length; i++) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const top = Math.round(r.getBoundingClientRect().top);
        const last = out[out.length - 1];
        if (last && Math.abs(last.top - top) <= 2) last.text += t[i];
        else out.push({ top, text: t[i] });
      }
    }
    return out.map((l) => l.text);
  });
}

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-shell-17: Simple's More sheet has Detailed's backdrop, handle, title and close button", async ({ page }) => {
    await login(page);
    await page.goto("/simple");
    await expect(page.getByTestId("simple-tab-bar")).toBeVisible();
    const more = page.getByTestId("simple-tab-more");
    await more.click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "More" })).toBeVisible();
    await expect(page.getByTestId("simple-more-sheet").getByTestId("sheet-handle")).toBeVisible();
    await expect(page.getByTestId("simple-more-sheet").getByTestId("sheet-scrim")).toBeVisible();
    // The tab bar stays in reach below the sheet.
    const bar = (await page.getByTestId("simple-tab-bar").boundingBox())!;
    const panel = (await sheet.boundingBox())!;
    expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y + 1);
    await expect(sheet.getByRole("link", { name: "Meetings", exact: true })).toBeVisible();

    await sheet.getByRole("button", { name: "Close More" }).click();
    await expect(sheet).toBeHidden();
    await expect(more).toHaveAttribute("aria-expanded", "false");

    // A tap on the backdrop closes it too.
    await more.click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(195, 80);
    await expect(sheet).toBeHidden();
  });
});

test("qa-shell-18: a member with no name sees their email broken at its @, never mid-word", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, "viewer@example.com");
  await page.goto("/simple");
  const name = page.getByTestId("simple-person-name");
  await expect(name).toHaveText("viewer@example.com");
  await expect(name).toHaveAttribute("title", "viewer@example.com");
  const drawn = await lines(page, "simple-person-name");
  expect([["viewer@example.com"], ["viewer", "@example.com"]]).toContainEqual(drawn);
});

test("qa-shell-20: while a Simple page loads, the rail keeps the switch's place and the page shows a skeleton (dark)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((key) => localStorage.setItem(key, "dark"), THEME_KEY);
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.addInitScript(
    ([slow, ms]) => {
      if (!sessionStorage.getItem("fix4-slow")) {
        localStorage.setItem(slow, "/v1/me/capabilities");
        localStorage.setItem(ms, "4000");
        sessionStorage.setItem("fix4-slow", "1");
      }
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY],
  );
  await page.goto("/simple/decisions");
  const skeleton = page.getByTestId("simple-nav-skeleton");
  await expect(skeleton).toBeVisible({ timeout: 2500 });
  await expect(skeleton.getByTestId("simple-nav-skeleton-switch")).toBeVisible();
  await expect(page.getByTestId("simple-page-skeleton")).toBeVisible();
  // Where the first destination sits in the skeleton and once the rail has loaded.
  const before = (await skeleton.locator("> span[aria-hidden]:not([data-testid])").first().boundingBox())!;
  const sw = (await skeleton.getByTestId("simple-nav-skeleton-switch").boundingBox())!;

  await expect(page.getByTestId("simple-nav")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("simple-nav-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("simple-page-skeleton")).toHaveCount(0);
  const after = (await page.getByTestId("simple-nav-home").boundingBox())!;
  const loaded = (await page.getByTestId("mode-switch").boundingBox())!;
  expect(Math.abs(sw.y - loaded.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(sw.height - loaded.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
});
