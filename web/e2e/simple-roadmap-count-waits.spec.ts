import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * simple-roadmap-count-waits: the Roadmap's Needs a decision button shows no number until every
 * part it adds up is read (the goals' suggested features answer last), as the side menu waits, so
 * it never shows a lower number first; and a working draft whose last change is undone (0 changes)
 * shows no banner and no Approve.
 *
 * fails_when: the button shows a number before the suggested features arrive (a jump such as
 * 20 then 23), or a draft with 0 changes still shows its banner or Approve and publish.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const button = (page: Page) => page.getByTestId("needs-decision");
const badge = (page: Page) => page.getByTestId("simple-nav-roadmap-count").first();

test("Needs a decision shows one number: none until the suggested features are read", async ({ page }) => {
  await page.addInitScript(
    ([slow, msKey]) => {
      localStorage.setItem(slow, "/v1/simple/goal-suggestions");
      localStorage.setItem(msKey, "2500");
      // Every text the button shows, in order.
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        const t = document.querySelector('[data-testid="needs-decision"]')?.textContent;
        if (t && seen[seen.length - 1] !== t) seen.push(t);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
  );
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  // While the suggested features are on their way, the button names no number.
  await expect(button(page)).toHaveText("Needs a decision");
  // The side menu waits for every read; the button then says the same number.
  await expect(badge(page)).toBeVisible({ timeout: 15_000 });
  const n = await badge(page).innerText();
  await expect(button(page)).toHaveText(`Needs a decision · ${n}`);
  // It never showed another number on the way.
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  const numbers = [...new Set(seen.flatMap((t) => /·\s*(\d+)/.exec(t)?.[1] ?? []))];
  expect(numbers).toEqual([n]);
});

test("a working draft with 0 changes shows no banner and no Approve", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("conflicts").locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  const banner = page.getByTestId("draft-banner");
  await expect(banner.getByTestId("draft-publish")).toBeVisible();
  // Undo the only change: the draft has 0 changes, so nothing is left to approve.
  await banner.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("draft-publish")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  // Read again, the page still shows none.
  await page.reload();
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(button(page)).toContainText("·");
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
});
