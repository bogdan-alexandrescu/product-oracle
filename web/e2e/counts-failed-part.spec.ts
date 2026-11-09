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
 */

/** Every GET of `path` answers 500 from the first page on. */
async function failing(page: Page, path: string) {
  await page.addInitScript(([key, p]) => localStorage.setItem(key, p), [MOCK_FAIL_KEY, path] as const);
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
