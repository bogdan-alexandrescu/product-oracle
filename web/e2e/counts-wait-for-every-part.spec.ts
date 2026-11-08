import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * counts-wait-for-every-part: a count a page adds up from several reads shows no number until
 * every read has answered, so it never shows a lower number first: the Inbox's "N waiting" and
 * Needs you count (with the questions asked of me), Home's "N waiting" and Needs you count (the
 * same), and Simple Decisions' Waiting for you count (with the one list of what waits on me).
 *
 * fails_when: with one part's read answering 2.5 s late, the count first shows the other parts'
 * number (11 waiting less the questions, say) and then jumps.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** Slows `path`'s read by 2.5 s and records every text the `selectors` show, in order ("waiting": each "N waiting" on the page). */
async function watch(page: Page, path: string, selectors: string[] | "waiting") {
  await page.addInitScript(
    ([slow, msKey, p, sels]) => {
      localStorage.setItem(slow, p);
      localStorage.setItem(msKey, "2500");
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        const s =
          sels === "waiting"
            ? (document.body?.textContent?.match(/\d+ waiting/g) ?? []).join(" | ")
            : (sels as string[]).map((sel) => document.querySelector(sel)?.textContent?.trim() || "-").join(" | ");
        if (seen[seen.length - 1] !== s) seen.push(s);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, path, selectors] as const,
  );
}

/** Every number painted in each recorded text, per selector. */
async function numbersSeen(page: Page, at: number): Promise<string[]> {
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  return [...new Set(seen.map((s) => /\d+/.exec(s.split(" | ")[at])?.[0]).filter((n): n is string => !!n))];
}

for (const where of ["/inbox", "/home"] as const) {
  test(`${where}: N waiting shows one number, none until the questions asked of me are read`, async ({ page }) => {
    await watch(page, "/v1/inbox/questions", "waiting");
    await login(page);
    await page.goto(where);
    const waiting = page.getByText(/^\d+ waiting$/);
    // While the questions are on their way, no "N waiting" shows.
    await page.waitForTimeout(1_000);
    await expect(waiting).toHaveCount(0);
    // Once they answer, one number, never another before it.
    await expect(waiting).toBeVisible({ timeout: 15_000 });
    const n = /^(\d+)/.exec(await waiting.innerText())![1];
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    const said = [...new Set(seen.flatMap((s) => [...s.matchAll(/(\d+) waiting/g)].map((m) => m[1])))];
    expect(said).toEqual([n]);
  });
}

test("Decisions: Waiting for you shows one number, none until what waits on me is read", async ({ page }) => {
  await watch(page, "/v1/simple/decisions/waiting", ['[data-testid="questions-mine-count"]']);
  await login(page);
  await page.goto("/simple/decisions");
  const card = page.getByTestId("questions-mine");
  await expect(card).toBeVisible();
  const count = page.getByTestId("questions-mine-count");
  // While the list is on its way, the card names no number.
  await page.waitForTimeout(1_000);
  await expect(count).toHaveCount(0);
  await expect(count).toBeVisible({ timeout: 15_000 });
  const n = (await count.innerText()).trim();
  expect(await numbersSeen(page, 0)).toEqual([n]);
});
