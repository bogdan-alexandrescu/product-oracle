import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * simple-nav-counts-wait: the side menu's counts (and the phone's More, which sums them) wait
 * for every read they add up, the meetings read too, so none shows an early number and then jumps.
 *
 * fails_when: with a meeting live and the meetings read answering last, the rail shows its
 * Roadmap count before the Meetings count arrives, or the phone's More shows a lower number first.
 */

/** Every set of counts the side menu painted, in order ("roadmap=3 meetings=1 more=-"). */
async function watchCounts(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() || "-";
    new MutationObserver(() => {
      const s = `roadmap=${text("simple-nav-roadmap-count")} meetings=${text("simple-nav-meetings-count")} more=${text("simple-tab-more-count")}`;
      if (seen[seen.length - 1] !== s) seen.push(s);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

/** Start the next review from Home, so one meeting is live. */
async function startMeeting(page: Page) {
  await page.goto("/simple");
  await page.getByTestId("home-meeting-next").getByRole("link", { name: "Start now" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: /: Guided setup$/ })).toBeVisible();
}

/** The meetings read answers 2.5 s after the rest from the next page on. */
async function slowMeetings(page: Page) {
  await page.evaluate(
    ([slow, msKey]) => {
      localStorage.setItem(slow, "/v1/simple/meetings");
      localStorage.setItem(msKey, "2500");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
  );
}

const seenOf = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);

test("the rail shows no count until the meetings read answers too", async ({ page }) => {
  // protects: on a 1440 px desktop with a review live and the meetings read slowed by 2.5 s, the side menu paints no Roadmap count until the Meetings count (1) arrives with it
  // fails_when: a set of counts is painted that has a Roadmap number while the Meetings count is still empty
  // no_claim: the numbers' values beyond Meetings being 1, the phone's More, and other pages' counts
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await watchCounts(page);
  await login(page);
  await startMeeting(page);
  await slowMeetings(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  const meetings = page.getByTestId("simple-nav-meetings-count");
  await expect(meetings).toHaveText("1", { timeout: 15_000 });
  const roadmap = page.getByTestId("simple-nav-roadmap-count");
  await expect(roadmap).toBeVisible();
  // While the meetings read was on its way, the rail named no number: the Roadmap's count came with the meeting's.
  const seen = await seenOf(page);
  expect(seen.filter((s) => !s.startsWith("roadmap=-") && s.includes("meetings=-"))).toEqual([]);
});

test("on a phone, More shows one number: none until the meetings read answers", async ({ page }) => {
  // protects: on a 390 px phone with a review live and the meetings read slowed by 2.5 s, the More tab's count ends on one number and never painted a different one on the way
  // fails_when: More shows a lower number first and then jumps to a higher one once the meetings read answers
  // no_claim: that the number is right (only that it is the same every time it is painted), the desktop side menu, and other tabs
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await watchCounts(page);
  await login(page);
  await startMeeting(page);
  await slowMeetings(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  const more = page.getByTestId("simple-tab-more-count");
  await expect(more).toBeVisible({ timeout: 15_000 });
  // The live meeting is in More's sum; wait past the meetings read, then More says one number only.
  await page.waitForTimeout(3_000);
  const n = (await more.innerText()).trim();
  const seen = await seenOf(page);
  const numbers = [...new Set(seen.map((s) => /more=(\d+)/.exec(s)?.[1]).filter(Boolean))];
  expect(numbers).toEqual([n]);
});
