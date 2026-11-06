import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * E-13: printing a Simple one-pager (or saving it as PDF) prints the page alone: the Simple
 * left navigation, its phone top bar and tab bar are hidden, and the one-pager spans the
 * page. fails_when = the rail or a bar prints, or the page keeps the rail's width beside it.
 * Fix round: an owner's open Ask panel does not print, and in landscape (or with no margins,
 * 1056 px wide) the one-pager's text runs across the sheet, not in its 820 px column beside
 * an empty margin-note column.
 */

const URL = "/simple/prds/guided-setup";

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: printing a one-pager leaves out the navigation`, async ({ page }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    // An owner, with the Ask panel open: it is the page's, not the printout's.
    await login(page);
    await page.goto(URL);
    await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
    await page.getByTestId(phone ? "phone-ask" : "simple-ask").click();
    await expect(page.getByTestId("ask-chat").filter({ visible: true })).toHaveCount(1);
    if (phone) await page.keyboard.press("Escape");
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("simple-nav")).toBeHidden();
    await expect(page.getByTestId("simple-tab-bar")).toBeHidden();
    await expect(page.getByTestId("phone-header")).toBeHidden();
    await expect(page.getByTestId("hop-dock")).toBeHidden();
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
