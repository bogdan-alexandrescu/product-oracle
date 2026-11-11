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
 *
 * counts-failed-part review: a page change drops a re-read already waiting; each partial mark
 * sits on an element with a role. fails_when: after a page change a re-read runs beside the page
 * change's read; a mark is an aria-label on a plain span.
 *
 * counts-failed-part back-off: a part's wait starts again at 15 s only once that part reads
 * again; a page change or a change to what waits reads it too, and while it keeps failing the
 * wait keeps growing. fails_when: a page change, an action or a meetings read sends the failed
 * part's wait back to 15 s; the wait stays long after the part read again.
 *
 * Read again and failed: the rail's counts are read stale-ok (lib/api/shared-reads); when the page's
 * own read of the same list, or the rail's read behind the count it shows, fails, that count drops
 * its number at once, as the page does. fails_when: the rail keeps the last number it read
 * (Decisions, the Inbox, the Roadmap's light count or goal suggestions, Meetings).
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
  // The mark is on an element with a role, so the link's description reads it.
  await expect(inbox).toHaveRole("img");
  await expect(inbox).toHaveAccessibleName(/could not load/i);
  await expect(page.getByTestId("simple-nav-inbox")).toHaveAccessibleDescription(/could not load/i);
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
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("simple-nav-meetings-count")).toHaveText("1", { timeout: 15_000 });
  await failedReRead(page, "/v1/simple/meetings", "simple-nav-meetings", "simple-nav-meetings");
});

/**
 * The review's probe: the rail's counts are read stale-ok (a moment ago, shown as they are), so
 * past the page's own 2 s the page reads `path` again; when that read fails, the rail's count
 * built on it drops its number at once, as the page does, and never keeps the last one.
 */
async function failedReRead(page: Page, path: string, open: string, count: string) {
  const rail = page.getByTestId(`${count}-count`);
  await expect(rail).toHaveText(/^\d+$/, { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  await page.evaluate(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, path] as const);
  const before = await calls(page, path);
  await page.getByTestId(open).click();
  // The page reads it again, and that read fails.
  await expect.poll(() => calls(page, path), { timeout: 15_000 }).toBeGreaterThan(before);
  // At once, not after the rail's back-off (15 s) reads it again.
  await expect(rail).toHaveAttribute("title", "Could not load", { timeout: 3_000 });
  await expect(rail).toHaveAttribute("aria-label", "Could not load");
  await expect(rail).not.toHaveText(/\d/);
}

for (const [name, path, open, count] of [
  ["Decisions", "/v1/simple/decisions/waiting", "simple-nav-decisions", "simple-nav-decisions"],
  ["Inbox (its rows)", "/v1/inbox", "simple-nav-inbox", "simple-nav-inbox"],
  ["Inbox (my questions)", "/v1/inbox/questions", "simple-nav-inbox", "simple-nav-inbox"],
  // The goal suggestions the Roadmap count adds up, read again by Priorities (the Goal map reads none).
  ["Priorities (goal suggestions)", "/v1/simple/goal-suggestions?status=open", "simple-nav-priorities", "simple-nav-roadmap"],
] as const) {
  test(`the rail: ${name}'s read again that fails on its page shows no number, not the last one`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto("/simple/one-pagers");
    await failedReRead(page, path, open, count);
  });
}

test("the rail: a failed read again of the roadmap's light count shows the count without it, not the last one", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const roadmap = page.getByTestId("simple-nav-roadmap-count");
  // What the Roadmap count says when its light count fails (it falls back to the one list).
  await page.evaluate(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, "/v1/simple/roadmap/waiting"] as const);
  await page.goto("/simple/one-pagers");
  await expect(roadmap).toHaveText(/^\d+$/, { timeout: 15_000 });
  const without = await roadmap.getAttribute("title");
  await page.evaluate((key) => localStorage.removeItem(key), MOCK_FAIL_KEY);
  await page.reload();
  await expect(roadmap).toHaveText(/^\d+$/, { timeout: 15_000 });
  expect(await roadmap.getAttribute("title")).not.toBe(without);
  await page.waitForTimeout(2_500);
  await page.evaluate(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, "/v1/simple/roadmap/waiting"] as const);
  const before = await calls(page, "/v1/simple/roadmap/waiting");
  await page.getByTestId("simple-nav-roadmap").click();
  await expect.poll(() => calls(page, "/v1/simple/roadmap/waiting"), { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(roadmap).toHaveAttribute("title", without!, { timeout: 3_000 });
});

test("the rail: a count read again behind the one shown, that fails, shows no number, not the last one", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/simple/one-pagers");
  const inbox = page.getByTestId("simple-nav-inbox-count");
  await expect(inbox).toHaveText(/^\d+$/, { timeout: 15_000 });
  // Past 10 s the rail shows the count it read at once and reads it again behind it.
  await page.waitForTimeout(10_500);
  await page.evaluate(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, "/v1/inbox"] as const);
  const before = await calls(page, "/v1/inbox");
  await page.getByTestId("simple-nav-priorities").click();
  await expect.poll(() => calls(page, "/v1/inbox"), { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(inbox).toHaveAttribute("title", "Could not load", { timeout: 3_000 });
  await expect(inbox).not.toHaveText(/\d/);
});

test("Inbox: failed notifications mark the Needs you count and the tab counts as partial", async ({ page }) => {
  await failing(page, "/v1/me/notifications");
  await login(page);
  await page.goto("/inbox");
  const needs = page.getByTestId("inbox-needs");
  await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 15_000 });
  // The count and the tabs read the same as before; only their names and tooltips say a part is missing,
  // each on an element with a role, so assistive tech reads the mark.
  const count = needs.getByTestId("panel-count").getByRole("img", { name: /^\d+; a part could not load$/ });
  await expect(count).toHaveText(/^\d+$/);
  await expect(count).toHaveAttribute("title", /^\d+; a part could not load$/);
  const tab = needs.getByRole("tab", { selected: true });
  await expect(tab).toHaveAccessibleName(/\d+; a part could not load$/);
  const tabCount = tab.getByRole("img", { name: /^\d+; a part could not load$/ });
  await expect(tabCount).toHaveText(/^\d+$/);
  await expect(tabCount).toHaveAttribute("title", /^\d+; a part could not load$/);
  await expect(page.getByRole("img", { name: /^\d+ waiting; a part could not load$/ })).toHaveText(/^\d+ waiting$/);
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

test("the rail: a page change reads the failed part too, and while it fails the wait keeps growing", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/inbox/questions");
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("simple-nav-inbox-count")).toHaveAttribute("title", /could not load/i, { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  const before = await calls(page, "/v1/inbox/questions");
  // Two failed re-reads: the next wait is 60 s.
  await page.clock.runFor(16_000);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before + 1);
  await page.clock.runFor(31_000);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before + 2);
  // The person opens another page: every part is read again, and the questions fail again.
  await page.getByTestId("simple-nav-goals").click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before + 3);
  await page.waitForTimeout(1_000);
  // The fourth failure in a row: the next re-read waits 120 s, not 15 s nor 60 s.
  await page.clock.runFor(61_000);
  await page.waitForTimeout(500);
  expect(await calls(page, "/v1/inbox/questions")).toBe(before + 3);
  await page.clock.runFor(60_000);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before + 4);
});

test("the rail: changes and meetings reads keep the failed part's wait growing; it starts again once the part reads", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/inbox/questions");
  await login(page);
  await page.goto("/simple/decisions");
  const count = page.getByTestId("simple-nav-inbox-count");
  await expect(count).toHaveAttribute("title", /could not load/i, { timeout: 15_000 });
  const rows = page.getByTestId("waiting-item").filter({ has: page.getByRole("button", { name: "Not this" }) });
  await expect(rows.first()).toBeVisible();
  await page.waitForTimeout(1_000);
  const questions = () => calls(page, "/v1/inbox/questions");
  const meetings = () => calls(page, "/v1/simple/meetings");
  /** The person sets a suggestion aside: what waits changed, so the rail reads every part again. */
  const setAside = async () => {
    const q = await questions();
    const m = await meetings();
    await rows.first().getByRole("button", { name: "Not this" }).click();
    await expect.poll(questions).toBeGreaterThan(q);
    await expect.poll(meetings).toBeGreaterThan(m);
    await page.waitForTimeout(1_000);
  };
  // The first re-read after 15 s fails: the next wait is 30 s.
  let n = await questions();
  await page.clock.runFor(16_000);
  await expect.poll(questions).toBe(n + 1);
  await page.waitForTimeout(1_000);
  // A change arrives; meetings read fine, the questions fail again: the next wait is 60 s.
  await setAside();
  await expect(count).toHaveAttribute("title", /could not load/i);
  await expect(page.getByTestId("simple-nav-meetings-count").and(page.locator('[title*="could not load" i]'))).toHaveCount(0);
  n = await questions();
  await page.clock.runFor(31_000);
  await page.waitForTimeout(500);
  expect(await questions()).toBe(n);
  // Another change before the 60 s are up: the questions fail again, and the wait grows to 120 s.
  await setAside();
  n = await questions();
  await page.clock.runFor(61_000);
  await page.waitForTimeout(500);
  expect(await questions()).toBe(n);
  await page.clock.runFor(60_000);
  await expect.poll(questions).toBe(n + 1);
  await page.waitForTimeout(1_000);
  // The questions answer again: the next change reads them, and the Inbox's count is whole.
  await page.evaluate((key) => localStorage.removeItem(key), MOCK_FAIL_KEY);
  await setAside();
  await expect(count).not.toHaveAttribute("title", /could not load/i);
  // They fail once more: the wait starts again at 15 s.
  await page.evaluate(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, "/v1/inbox/questions"] as const);
  await setAside();
  await expect(count).toHaveAttribute("title", /could not load/i);
  n = await questions();
  await page.clock.runFor(16_000);
  await expect.poll(questions).toBe(n + 1);
});

test("the rail: a page change drops the re-read already waiting, so the failed part is never read twice at once", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await failing(page, "/v1/inbox/questions");
  // The goal suggestions answer 5 s late, so a full read stays on its way that long.
  await page.addInitScript(
    ([slowKey, msKey]) => {
      localStorage.setItem(slowKey, "/v1/simple/goal-suggestions");
      localStorage.setItem(msKey, "5000");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
  );
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("simple-nav-inbox-count")).toHaveAttribute("title", /could not load/i, { timeout: 30_000 });
  // The re-read is due in about 3 s; the person opens another page now, whose full read takes 5 s.
  await page.clock.runFor(12_000);
  const before = await calls(page, "/v1/inbox/questions");
  await page.getByTestId("simple-nav-goals").click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect.poll(() => calls(page, "/v1/inbox/questions")).toBe(before + 1);
  // The re-read that was waiting does not run beside the page change's read.
  await page.waitForTimeout(6_000);
  expect(await calls(page, "/v1/inbox/questions")).toBe(before + 1);
});
