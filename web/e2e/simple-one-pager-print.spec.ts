import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * E-13: printing a Simple one-pager (or saving it as PDF) prints the page alone: the Simple
 * left navigation, its phone top bar and tab bar are hidden, and the one-pager spans the
 * page. fails_when = the rail or a bar prints, or the page keeps the rail's width beside it.
 */

const URL = "/simple/prds/guided-setup";

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: printing a one-pager leaves out the navigation`, async ({ page }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await login(page, "viewer@example.com");
    await page.goto(URL);
    await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("simple-nav")).toBeHidden();
    await expect(page.getByTestId("simple-tab-bar")).toBeHidden();
    await expect(page.getByTestId("phone-header")).toBeHidden();
    await expect(page.getByRole("button", { name: "Ask Oracle" })).toHaveCount(0);
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
