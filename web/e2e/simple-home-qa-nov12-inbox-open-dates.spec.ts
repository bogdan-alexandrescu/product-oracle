import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-home.md #5), driven as a person does against
 * the mock's invented data: in the Inbox, a Dates row's Open goes to the roadmap and opens Oracle's
 * date suggestion for that feature there, scrolled into view and centred, never below the fold.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "inbox-reviewer"), MOCK_SCENARIO_KEY);
});

test("#5: a Dates row's Open shows Oracle's suggestion in view, centred", async ({ page }) => {
  // protects: Inbox > a Dates row > Open lands on the roadmap with the item's date suggestion on screen, its middle near the window's middle
  // fails_when: the suggestion opens below the fold and the page stays at its top
  await login(page);
  // The roadmap is read once, so Oracle's dates for it wait in the Inbox.
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.goto("/inbox");
  const row = page.getByRole("row").filter({ has: page.getByTestId("date-suggestion-context") }).first();
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: /^Open Oracle's dates for / }).click();
  await expect(page).toHaveURL(/\/simple\/roadmap\?.*dates=/);
  const pop = page.getByTestId("suggestion-popover");
  await expect(pop).toBeVisible();
  await expect(pop).toBeInViewport();
  // Centred, or as near as the page scrolls: at its end, the whole suggestion in view.
  await expect
    .poll(
      async () => {
        const b = (await pop.boundingBox())!;
        const [y, max, h] = await page.evaluate(() => [window.scrollY, document.scrollingElement!.scrollHeight - innerHeight, innerHeight]);
        const whole = b.y >= 0 && b.y + b.height <= h;
        return whole && (Math.abs(b.y + b.height / 2 - h / 2) < 120 || y >= max - 1);
      },
      { message: "its middle is near the window's middle, or the page is scrolled to its end with it whole in view" },
    )
    .toBe(true);
});
