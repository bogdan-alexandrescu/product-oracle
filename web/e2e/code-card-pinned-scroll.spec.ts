import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * A code chip's card (components/ds/CodeChip.tsx HoverCard) clicked open on desktop stays open
 * while the page scrolls; it closes on a click outside. A short desktop window makes the Plan
 * page scroll; the card listens for a scroll anywhere on the page, the window's or a panel's.
 */

test.use({ viewport: { width: 1440, height: 480 } });

const withCodes = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "named-codes"), MOCK_SCENARIO_KEY);

test("a pinned code card stays open when the page scrolls, and a click outside closes it", async ({ page }) => {
  await withCodes(page);
  await login(page);
  await page.goto("/plan");
  await expect(page.getByTestId("track-check").first()).toBeVisible();
  const chip = page
    .getByTestId("plan-row")
    .filter({ hasText: "Weekly alert digest" })
    .filter({ visible: true })
    .getByTestId("plan-goal")
    .getByTestId("code-chip");
  const card = page.getByTestId("code-card");
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();

  await chip.click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("card-name")).toHaveText("Growth");

  // Note each scroll the page makes from here, so the test knows the page did scroll.
  await page.evaluate(() => {
    (window as unknown as { scrolls: number }).scrolls = 0;
    window.addEventListener("scroll", () => (window as unknown as { scrolls: number }).scrolls++, true);
  });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.mouse.wheel(0, -200);
  await expect.poll(() => page.evaluate(() => (window as unknown as { scrolls: number }).scrolls)).toBeGreaterThan(0);
  // A moment for any close a scroll would make.
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");

  // A click outside the chip and its card closes it.
  await page.getByRole("heading", { level: 1 }).first().click();
  await expect(card).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");
});
