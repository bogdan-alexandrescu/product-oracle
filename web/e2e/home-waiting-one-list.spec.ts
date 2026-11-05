import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * home-waiting-one-list: a production QA of Simple Home, Decisions and the rail found them
 * disagreeing about what waits on a person. Driven through the UI on the mock's invented data
 * (lib/api/mock, its waiting list in waiting-list.ts), desktop and phone.
 *
 * Card one-list: protects = Decisions' "Waiting for you" holds the run stop, the dates to confirm
 * and the goal suggestion Home shows, each with its action in place; confirming the dates on
 * Decisions removes them there at once and, with no reload, from Home and the rail's count;
 * fails_when = Decisions says "Nothing waits on you" while Home lists things, or the confirmed
 * dates stay on either page or in the count; no_claim = the API's own list (pytest
 * test_simple_waiting_list.py).
 *
 * Card tiles-loading: protects = while the waiting list is still on its way, Home's top tiles
 * say they are loading and never show a count; fails_when = "0 decisions waiting for you" or a
 * "–" shows before the true number.
 *
 * Card badges: protects = the rail's counts are only what waits on the person: Meetings shows no
 * count with no meeting live; Decisions' count is the Decisions page's own "Waiting for you"
 * count; each count says what it counts in its accessible name and title; fails_when = Meetings
 * counts upcoming meetings or the Decisions count differs from its page.
 *
 * Card plan: protects = Home's "The plan this quarter" is the company roadmap's, every milestone
 * by its name across PRDs, never one PRD's "M1 · …" plan milestones; fails_when = a row is a
 * PRD's milestone code or the strip is drawn for one PRD.
 *
 * Card proposed-goals: protects = Home lists each proposed goal with Confirm and Not this;
 * confirming one puts it in the goal band; fails_when = the line only counts them.
 *
 * Card act-on-home: protects = confirming dates in Home's "Also waiting for you" takes the row
 * off Home and the rail's count down at once, with no navigation; fails_when = the row stays on
 * Home with greyed buttons while only the count drops.
 *
 * Card decision-calls: protects = a decision-log call proposed to the approver is in the one
 * list: Home's tile, Decisions' "Waiting for you" and the rail count it alike, and Decide on
 * Decisions decides it in place and drops every count; fails_when = Home counts a call that
 * Decisions and the rail leave out.
 *
 * Card broken-tile: protects = Home's broken-links tile counts only links on items the person
 * decides, as the list does (Decisions' "Broken link" rows); a commenter, who decides none, reads a
 * tile that says it counts the links they can propose fixes for; each broken-link row on Decisions names its own flag; fails_when = the tile
 * counts every broken link on the roadmap or two rows read alike.
 */

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Simple" }).getByRole("link", { name, exact: true }).filter({ visible: true });
const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const decisionsCount = (page: Page) => page.locator("[data-testid='simple-nav-decisions-count'], [data-testid='simple-tab-decisions-count']").filter({ visible: true });

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    test("Decisions and Home read one list; acting on Decisions removes it from Home and the count", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const also = page.getByTestId("home-also-waiting");
      await expect(also.getByRole("listitem", { name: "Dates to confirm: Alert routing by team" })).toBeVisible();
      await expect(page.getByTestId("home-run-stop").first()).toContainText("Confirm the baseline");

      await nav(page, "Decisions").click();
      await expect(page).toHaveURL(/\/simple\/decisions/);
      const mine = page.getByTestId("questions-mine");
      await expect(mine).not.toContainText("Nothing waits on you");
      await expect(mine.getByRole("listitem", { name: /^Run stop: Confirm the baseline/ }).first()).toBeVisible();
      await expect(mine.getByRole("listitem", { name: /^Goal suggestion: / }).first()).toBeVisible();
      const before = Number(await page.getByTestId("questions-mine-count").textContent());
      await expect(decisionsCount(page)).toHaveText(String(before));

      const dates = mine.getByRole("listitem", { name: "Dates to confirm: Alert routing by team" });
      await dates.getByRole("button", { name: "Confirm" }).click();
      await expect(dates).toHaveCount(0);
      await expect(page.getByTestId("questions-mine-count")).toHaveText(String(before - 1));
      await expect(decisionsCount(page)).toHaveText(String(before - 1));

      await nav(page, "Home").click();
      await expect(page).toHaveURL(/\/simple$/);
      await expect(page.getByRole("listitem", { name: "Dates to confirm: Alert routing by team" })).toHaveCount(0);
    });

    test("Acting on Home's 'Also waiting for you' takes the row off Home and the count down at once", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const also = page.getByTestId("home-also-waiting");
      const dates = also.getByRole("listitem", { name: "Dates to confirm: Alert routing by team" });
      await expect(dates).toBeVisible();
      await expect(decisionsCount(page)).toHaveText(/^\d+$/);
      const before = Number(await decisionsCount(page).textContent());
      await dates.getByRole("button", { name: "Confirm" }).click();
      await expect(dates).toHaveCount(0);
      await expect(decisionsCount(page)).toHaveText(String(before - 1));
      await expect(page).toHaveURL(/\/simple$/);
    });

    test("A decision-log call waiting on the approver is counted alike on Home, Decisions and the rail, and decided in place", async ({ page }) => {
      await login(page, APPROVER);
      await page.goto("/simple");
      const tile = page.getByTestId("home-summary-decisions").locator(".simple-number");
      await expect(tile).toHaveText(/^\d+$/);
      const n = (await tile.textContent())!;
      await expect(decisionsCount(page)).toHaveText(n);
      await expect(page.getByTestId("home-decisions").getByTestId("home-decision").filter({ hasText: "Ship usage caps before anomaly detection" })).toBeVisible();

      await nav(page, "Decisions").click();
      await expect(page).toHaveURL(/\/simple\/decisions/);
      const mine = page.getByTestId("questions-mine");
      await expect(page.getByTestId("questions-mine-count")).toHaveText(n);
      const call = mine.getByRole("listitem", { name: "Decision: Ship usage caps before anomaly detection" });
      await expect(call).toBeVisible();
      await call.getByRole("button", { name: "Decide: Caps first" }).click();
      await expect(call).toHaveCount(0);
      await expect(page.getByTestId("questions-mine-count")).toHaveText(String(Number(n) - 1));
      await expect(decisionsCount(page)).toHaveText(String(Number(n) - 1));
    });

    test("Home's broken-links tile counts only the links on items you decide", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      const rows = page.getByTestId("questions-mine").getByRole("listitem", { name: /^Broken link: / });
      await expect(rows.first()).toBeVisible();
      const names = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      // Each row names its own flag, even when one item has two.
      expect(new Set(names).size).toBe(names.length);
      await nav(page, "Home").click();
      await expect(page.getByTestId("home-summary-broken-links").locator(".simple-number")).toHaveText(String(names.length));

      await page.context().clearCookies();
      await login(page, COMMENTER);
      await page.goto("/simple");
      // A commenter decides none: the tile says it counts the links they can propose fixes for.
      const rowsShown = page.getByTestId("home-broken");
      await expect(rowsShown.first()).toBeVisible();
      const tile = page.getByTestId("home-summary-broken-links");
      await expect(tile).toContainText(phone ? /fix(es)? to propose/ : /you can propose (a fix|fixes) for/);
      await expect(tile.locator(".simple-number")).toHaveText(String(await rowsShown.count()));
    });

    test("Home's tiles say they are loading until the waiting list is read, never a 0", async ({ page }) => {
      await login(page);
      await page.evaluate(
        ([slowKey, msKey]) => {
          localStorage.setItem(slowKey, "/v1/simple/decisions/waiting");
          localStorage.setItem(msKey, "2500");
        },
        [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
      );
      await page.addInitScript(() => {
        const seen: string[] = ((window as unknown as { __tiles: string[] }).__tiles = []);
        const look = () => {
          const n = document.querySelector("[data-testid='home-summary-decisions'] .simple-number")?.textContent;
          if (n && seen.at(-1) !== n) seen.push(n);
          requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
      await page.goto("/simple");
      await expect(page.getByRole("status", { name: "Loading what waits on you" })).toBeVisible();
      await expect(page.getByTestId("home-summary")).toHaveCount(0);
      await expect(page.getByTestId("home-summary-decisions")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("home-summary-loading")).toHaveCount(0);
      const seen = await page.evaluate(() => (window as unknown as { __tiles: string[] }).__tiles);
      expect(seen.length).toBe(1);
      expect(seen[0]).not.toBe("0");
      expect(seen[0]).not.toBe("–");
    });

    test("The rail counts only what waits on you and says what it counts", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      const count = decisionsCount(page);
      await expect(count).toHaveText(/^\d+$/);
      const n = (await count.textContent())!;
      await expect(page.getByTestId("questions-mine-count")).toHaveText(n);
      await expect(count).toHaveAttribute("title", `${n} waiting on you`);
      await expect(count).toHaveAccessibleName(`${n} waiting on you`);
      // No meeting is live: an upcoming meeting waits on nobody, so Meetings has no count.
      await expect(page.locator("[data-testid='simple-nav-meetings-count'], [data-testid='simple-tab-meetings-count'], [data-testid='simple-more-meetings-count']").filter({ visible: true })).toHaveCount(0);
      const roadmap = page.locator("[data-testid='simple-nav-roadmap-count'], [data-testid='simple-tab-roadmap-count']").filter({ visible: true });
      await expect(roadmap).toHaveAttribute("title", /^\d+ on the roadmap waiting on you: broken links, dates, proposals and drafts$/);
    });

    test("The plan this quarter is the company roadmap's, its milestones by name", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const labels = page.getByTestId("home-plan").getByTestId("home-strip-label");
      await expect(labels.first()).toBeVisible();
      const texts = await labels.allTextContents();
      expect(texts.some((t) => t.startsWith("Beta · "))).toBe(true);
      for (const t of texts) expect(t).not.toMatch(/^(Milestone )?M\d+\b/);
      await expect(page.getByTestId("home-plan").getByRole("link").first()).toHaveAttribute("href", "/simple/roadmap");
    });

    test("Home lists a proposed goal with Confirm and Not this", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const proposed = page.getByTestId("home-goal-proposed").filter({ hasText: "Cut early churn" });
      await expect(proposed.getByRole("button", { name: "Not this" })).toBeVisible();
      await proposed.getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByTestId("home-goals-proposed-list")).toHaveCount(0);
      await expect(page.getByTestId("home-goals")).toContainText("Cut early churn");
    });
  });
}

// Card meeting-year: protects = a review meeting in another year says its day with the year
// (the date tile alone read "Nov 22"); fails_when = the card's day has no year.
test("A review meeting next year says its year on Home", async ({ page }) => {
  await page.clock.setSystemTime(new Date("2026-12-30T17:00:00Z"));
  await login(page);
  await page.goto("/simple");
  const next = page.getByTestId("home-meeting-next");
  await expect(next).toBeVisible();
  await expect(next).toContainText(/Jan \d{1,2}, 2027/);
  // The date tile itself says the year too.
  await expect(next.locator(".simple-date-tile")).toContainText("2027");
});
