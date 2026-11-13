import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * simple-roadmap-count-waits: the Roadmap's Needs a decision button shows no number until every
 * part it adds up is read (the goals' suggested features answer last), as the side menu waits, so
 * it never shows a lower number first; and a working draft whose last change is undone (0 changes)
 * shows no banner and no Approve.
 *
 * The side menu's Roadmap badge says the button's number, and at 0 shows no badge (a 0 is hidden).
 *
 * fails_when: the button shows a number before the suggested features arrive (a jump such as
 * 20 then 23), the side menu shows a 0 badge or another number than the button, or a draft with
 * 0 changes still shows its banner or Approve and publish.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const button = (page: Page) => page.getByTestId("needs-decision");
const badge = (page: Page) => page.getByTestId("simple-nav-roadmap-count").first();

test("Needs a decision shows one number: none until the suggested features are read", async ({ page }) => {
  // protects: on the Roadmap at 1440 px with the goals' suggested features slowed by 2.5 s, the Needs a decision button says no number until they are read, then shows one number that the side menu's Roadmap badge repeats (no badge at 0)
  // fails_when: the button shows a number early and then jumps to another, or the side menu shows a different number than the button or a 0 badge
  // no_claim: that the number is the right count, the phone layout, and what each counted item is
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
  // Once every part is read the button names its number; the side menu says the same one, or,
  // at 0, shows no badge (the product hides a 0).
  await expect(button(page)).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  const n = /·\s*(\d+)$/.exec(await button(page).innerText())![1];
  if (n === "0") await expect(badge(page)).toHaveCount(0);
  else await expect(badge(page)).toHaveText(n);
  // It never showed another number on the way.
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  const numbers = [...new Set(seen.flatMap((t) => /·\s*(\d+)/.exec(t)?.[1] ?? []))];
  expect(numbers).toEqual([n]);
});

test("at 0 the side menu shows no Roadmap badge, never a 0", async ({ page }) => {
  // protects: in the empty mock scenario (a new company with nothing waiting) at 1440 px, the side menu's Roadmap entry shows no count badge, has no description, and no "0" text shows in the menu, even 3 seconds after load
  // fails_when: a 0 badge or a count description appears on the Roadmap entry, or a lone "0" shows anywhere in the side menu
  // no_claim: how the badge looks when something does wait, the button on the Roadmap page, and the phone's tabs
  // A new company: nothing waits on the roadmap.
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "empty"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-nav-roadmap")).toBeVisible();
  // Past every read the side menu makes, still no badge, and no "0" anywhere in it.
  await page.waitForTimeout(3_000);
  await expect(badge(page)).toHaveCount(0);
  await expect(page.getByTestId("simple-nav-roadmap")).not.toHaveAttribute("aria-describedby", /./);
  await expect(page.getByTestId("simple-nav").getByText(/^0$/)).toHaveCount(0);
});

test("a working draft with 0 changes shows no banner and no Approve", async ({ page }) => {
  // protects: on the Roadmap at 1440 px, once the only change in a working draft (Move the dependents for the alert digest) is undone, the draft banner, its publish button and any Approve button are gone, and stay gone after a reload
  // fails_when: a draft with 0 changes still shows its banner, its publish button or Approve
  // no_claim: drafts with changes, the dates the move would have set, and publishing
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
