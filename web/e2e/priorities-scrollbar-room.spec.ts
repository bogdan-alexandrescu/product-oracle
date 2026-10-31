import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * qa-plan-5 where a page scrollbar takes space. Windows and Linux draw one of about 15 px; a Mac's
 * floats over the page, and Playwright hides scrollbars. This file shows them and styles one, so it
 * takes its space here too. protects=the Feature column keeps more than 130 px beside the docked
 * inspector; fails_when=the other columns grow back (the train review measured 118 px).
 */

const DESKTOP = { width: 1440, height: 900 };

test.use({ viewport: DESKTOP, launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("qa-plan-5: the Feature column keeps its room beside the docked inspector when the scrollbar takes space", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]')).toHaveCount(8);
  await page.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #999; }" });
  // Docked, at its full width: before that the table still has the inspector's room.
  const inspector = page.getByTestId("priority-inspector");
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await expect.poll(() => page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)).toBeGreaterThanOrEqual(15);
  // Every column filled (goal chips and flags come with the explanations), so the widths have settled.
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("priority-row-F-5").getByTestId("row-goals")).toBeVisible();
  const cell = page.getByTestId("priority-row-F-5").locator("td").filter({ has: page.locator("button[aria-controls]") });
  expect((await cell.boundingBox())!.width).toBeGreaterThan(130);
});
