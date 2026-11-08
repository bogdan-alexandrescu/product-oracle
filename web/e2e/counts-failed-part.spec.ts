import { MOCK_FAIL_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * counts-failed-part: a count added up from several reads says when one of them failed: the
 * failed part shows the could-not-load mark (or the count's name and tooltip say it), never a
 * silent 0, and the counts that loaded still show. The Inbox keeps its list in view while a
 * part is on its way, and holds only the count.
 *
 * fails_when: a failed meetings, waiting-list or notifications read is counted 0 with nothing
 * said; a failed waiting list leaves the rail's every count hidden; Decisions says "Nothing waits
 * on you." when the list did not load; the Inbox hides its list until the questions answer, or
 * shows "N waiting" before its webhook notices are read.
 *
 * counts-failed-part follow-ups: a re-read that fails shows no out-of-date number (Decisions'
 * Waiting for you, the rail's Meetings); every Inbox count missing a part says so in its name and
 * tooltip; the rail reads again only the failed part, backing off (15 s, then 30 s), and not while
 * the tab is hidden. fails_when: an old number stays beside Could not load; the Needs you or tab
 * counts carry no mark; a re-read reads every part, or runs every 15 s, or runs in a hidden tab.
 */

/** Every GET of `path` answers 500 from the first page on. */
async function failing(page: Page, path: string) {
  await page.addInitScript(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, path] as const);
}

/** How many GETs of `path` the page has made so far (the mock logs every call). */
function calls(page: Page, path: string): Promise<number> {
  return page.evaluate((p) => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []).filter((c) => c === `GET ${p}`).length, path);
}

/** `path`'s read answers 2.5 s late from the first page on. */
async function slow(page: Page, path: string) {
  await page.addInitScript(
    ([slowKey, msKey, p]) => {
      localStorage.setItem(slowKey, p);
      localStorage.setItem(msKey, "2500");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, path] as const,
  );
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

test("Decisions: a failed waiting list shows Could not load with Try again, and no number", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/simple/decisions/waiting");
  await login(page);
  await page.goto("/simple/decisions");
  const card = page.getByTestId("questions-mine");
  await expect(card.getByTestId("load-error")).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(card.getByTestId("questions-mine-count")).toHaveCount(0);
  await expect(card.getByText("Nothing waits on you.")).toHaveCount(0);
  // Try again reads the list again: once it answers, the mark goes and the count shows.
  await page.evaluate((key) => localStorage.removeItem(key), MOCK_FAIL_KEY);
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByTestId("load-error")).toHaveCount(0, { timeout: 15_000 });
});

test("the rail: a failed waiting list marks Decisions and still shows the Inbox's count", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/simple/decisions/waiting");
  await login(page);
  await page.goto("/simple/one-pagers");
  // The Inbox's count is not hidden for good by the failed list.
  await expect(page.getByTestId("simple-nav-inbox-count")).toBeVisible({ timeout: 15_000 });
  const decisions = page.getByTestId("simple-nav-decisions-count");
  await expect(decisions).toHaveAttribute("title", /could not load/i);
  await expect(decisions).toHaveAttribute("aria-label", /could not load/i);
  await expect(decisions).not.toHaveText(/\d/);
});

test("the rail: a failed meetings read is marked, never counted 0, and More says its sum is partial", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await startMeeting(page);
  await page.evaluate((key) => localStorage.setItem(key, "/v1/simple/meetings"), MOCK_FAIL_KEY);
  await page.goto("/simple/one-pagers");
  const meetings = page.getByTestId("simple-nav-meetings-count");
  await expect(meetings).toHaveAttribute("title", /could not load/i, { timeout: 15_000 });
  await expect(meetings).not.toHaveText(/\d/);
  // The counts that loaded still show.
  await expect(page.getByTestId("simple-nav-inbox-count")).toBeVisible();
  // On a phone, More sums what loaded and says a part of it could not load.
  await page.setViewportSize({ width: 390, height: 844 });
  const more = page.getByTestId("simple-tab-more-count");
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("title", /could not load/i);
});

test("the rail: failed questions asked of me mark the Inbox's count as partial", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/inbox/questions");
  await login(page);
  await page.goto("/simple/one-pagers");
  const inbox = page.getByTestId("simple-nav-inbox-count");
  await expect(inbox).toBeVisible({ timeout: 15_000 });
  await expect(inbox).toHaveAttribute("title", /could not load/i);
});

test("Inbox: failed notifications show Could not load and mark N waiting as partial", async ({ page }) => {
  await failing(page, "/v1/me/notifications");
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  const waiting = page.getByText(/^\d+ waiting$/);
  await expect(waiting).toBeVisible();
  await expect(waiting).toHaveAttribute("title", /could not load/i);
});

test("Inbox: N waiting shows no number until the webhook notices are read", async ({ page }) => {
  await slow(page, "/v1/me/notifications");
  await login(page);
  await page.goto("/inbox");
  const waiting = page.getByText(/^\d+ waiting$/);
  await expect(page.getByTestId("inbox-needs")).toBeVisible({ timeout: 15_000 });
  await expect(waiting).toHaveCount(0);
  await expect(waiting).toBeVisible({ timeout: 15_000 });
});

test("Inbox: the list shows while the questions asked of me are on their way; only the count waits", async ({ page }) => {
  await slow(page, "/v1/inbox/questions");
  await login(page);
  await page.goto("/inbox");
  const needs = page.getByTestId("inbox-needs");
  await expect(needs).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText(/^\d+ waiting$/)).toHaveCount(0);
  await expect(page.getByText(/^\d+ waiting$/)).toBeVisible({ timeout: 15_000 });
});

test("Decisions: a re-read of the waiting list that fails drops its number", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/simple/decisions");
  const card = page.getByTestId("questions-mine");
  await expect(card.getByTestId("questions-mine-count")).toHaveText(/^\d+$/, { timeout: 15_000 });
  // The list fails from now on; confirming a row reads it again.
  await page.evaluate((key) => localStorage.setItem(key, "/v1/simple/decisions/waiting"), MOCK_FAIL_KEY);
  const dates = card.getByRole("listitem", { name: "Dates to confirm: Alert routing by team" });
  await dates.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByTestId("load-error")).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId("questions-mine-count")).toHaveCount(0);
});

test("the rail: a re-read of the meetings that fails shows no number, not the last one", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await startMeeting(page);
  const meetings = page.getByTestId("simple-nav-meetings-count");
  await expect(meetings).toHaveText("1", { timeout: 15_000 });
  // The meetings fail from now on; opening Meetings reads them again.
  await page.evaluate((key) => localStorage.setItem(key, "/v1/simple/meetings"), MOCK_FAIL_KEY);
  await page.getByTestId("simple-nav-meetings").click();
  await expect(page).toHaveURL(/\/simple\/meetings/);
  await expect(meetings).toHaveAttribute("title", "Could not load", { timeout: 15_000 });
  await expect(meetings).toHaveAttribute("aria-label", "Could not load");
  await expect(meetings).not.toHaveText(/\d/);
});

test("Inbox: failed notifications mark the Needs you count and the tab counts as partial", async ({ page }) => {
  await failing(page, "/v1/me/notifications");
  await login(page);
  await page.goto("/inbox");
  const needs = page.getByTestId("inbox-needs");
  await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 15_000 });
  // The count and the tabs read the same as before; only their names and tooltips say a part is missing.
  const count = needs.getByTestId("panel-count").locator("[aria-label]");
  await expect(count).toHaveText(/^\d+$/);
  await expect(count).toHaveAttribute("aria-label", /^\d+; a part could not load$/);
  await expect(count).toHaveAttribute("title", /^\d+; a part could not load$/);
  const tab = needs.getByRole("tab", { selected: true });
  await expect(tab).toHaveAccessibleName(/\d+; a part could not load$/);
  await expect(tab.locator("[title]")).toHaveAttribute("title", /^\d+; a part could not load$/);
  await expect(page.getByText(/^\d+ waiting$/)).toHaveAttribute("aria-label", /^\d+ waiting; a part could not load$/);
});

test("the rail: a failed part is read again alone, after 15 s, then 30 s", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/inbox/questions");
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("simple-nav-inbox-count")).toHaveAttribute("title", /could not load/i, { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  const before = { questions: await calls(page, "/v1/inbox/questions"), meetings: await calls(page, "/v1/simple/meetings"), list: await calls(page, "/v1/simple/decisions/waiting") };
  await page.clock.runFor(16_000);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before.questions + 1);
  await page.waitForTimeout(1_000);
  // Only the failed part was read again.
  expect(await calls(page, "/v1/simple/meetings")).toBe(before.meetings);
  expect(await calls(page, "/v1/simple/decisions/waiting")).toBe(before.list);
  // The next wait is twice as long: nothing at 20 s, the read again at 30 s.
  await page.clock.runFor(20_000);
  await page.waitForTimeout(500);
  expect(await calls(page, "/v1/inbox/questions")).toBe(before.questions + 1);
  await page.clock.runFor(11_000);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before.questions + 2);
  await expect(page.getByTestId("simple-nav-inbox-count")).toHaveAttribute("title", /could not load/i);
});

test("the rail: a hidden tab reads a failed part again only once it is shown", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/inbox/questions");
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("simple-nav-inbox-count")).toHaveAttribute("title", /could not load/i, { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  const before = await calls(page, "/v1/inbox/questions");
  // The person switches to another tab.
  const shown = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await shown(true);
  await page.clock.runFor(60_000);
  await page.waitForTimeout(500);
  expect(await calls(page, "/v1/inbox/questions")).toBe(before);
  // Back on this tab: the failed part is read again at once.
  await shown(false);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before + 1);
});
