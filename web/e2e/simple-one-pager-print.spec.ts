import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * E-13: printing a Simple one-pager (or saving it as PDF) prints the page alone: the Simple
 * left navigation, its phone top bar and tab bar are hidden, and the one-pager spans the
 * page. fails_when = the rail or a bar prints, or the page keeps the rail's width beside it.
 * Fix rounds: an owner's open Ask panel (its dock and its chat) does not print, on a phone too, and in landscape (or with no margins,
 * 1056 px wide) the one-pager's text runs across the sheet, not in its 820 px column beside
 * an empty margin-note column.
 */

const URL = "/simple/prds/guided-setup";

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: printing a one-pager leaves out the navigation`, async ({ page }) => {
    // protects: in print view, on a 1440 px desktop and on a 390 px phone (one test each) with the owner's Ask panel open, the Guided setup one-pager hides the menu, tab bar, phone top bar, dock and Ask chat and spans the whole body; on screen the menu is back
    // fails_when: the side menu, a bar, the dock or the open Ask chat is still shown in print, the page does not start at the left edge or run to the right one, or the menu is gone on screen
    // no_claim: a real printer or PDF file, the page breaks, and any page besides Guided setup
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    // An owner, with the Ask panel open: it is the page's, not the printout's.
    await login(page);
    await page.goto(URL);
    await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
    await page.getByTestId(phone ? "phone-ask" : "simple-ask").click();
    await expect(page.getByTestId("ask-chat").filter({ visible: true })).toHaveCount(1);
    // Still open (on the phone too) when printing.
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("simple-nav")).toBeHidden();
    await expect(page.getByTestId("simple-tab-bar")).toBeHidden();
    await expect(page.getByTestId("phone-header")).toBeHidden();
    await expect(page.getByTestId("hop-dock")).toBeHidden();
    await expect(page.getByTestId("ask-chat").filter({ visible: true })).toHaveCount(0);
    // The page starts at the left edge and runs to the right one (the whole body).
    const main = await page.locator("main#main").boundingBox();
    const body = await page.locator("body").boundingBox();
    expect(main!.x).toBeLessThanOrEqual(body!.x + 1);
    expect(main!.width).toBeGreaterThanOrEqual(body!.width - 1);
    // Back on screen, the navigation is there again.
    await page.emulateMedia({ media: "screen" });
    await expect(page.getByTestId(phone ? "simple-tab-bar" : "simple-nav")).toBeVisible();
  });
}

test("landscape: the printed one-pager's text runs across the sheet", async ({ page }) => {
  // protects: at 1056 px wide (landscape Letter, or no margins) in print view, the Guided setup one-pager's text block is wider than 900 px and within 80 px of the body width
  // fails_when: the text keeps its 820 px column beside an empty margin-note column
  // no_claim: other widths, a real printer or PDF file, and the navigation (the other print test)
  // A landscape Letter page (or one printed with no margins) is about 1056 px wide.
  await page.setViewportSize({ width: 1056, height: 816 });
  await login(page);
  await page.goto(URL);
  await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  const text = await page.getByRole("article", { name: "One-pager" }).boundingBox();
  const body = await page.locator("body").boundingBox();
  // No 820 px column beside an empty margin-note column: the text block spans the page.
  expect(text!.width).toBeGreaterThan(body!.width - 80);
  expect(text!.width).toBeGreaterThan(900);
});
