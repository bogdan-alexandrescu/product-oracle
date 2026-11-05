import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { MOCK_DRAFTING_MS_KEY } from "../lib/api/mock/simple-changes";
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
 *
 * Card roadmap-rail: protects = accepting a date in the Roadmap's "Needs a decision" drops the
 * rail's Roadmap and Decisions counts at once, with no navigation; fails_when = the counts stay
 * until the person moves to another page.
 *
 * Card fix-the-link: protects = a broken-link row on Decisions fixes in place (its fixes shown on
 * "Fix the link", acting clears the row and every count), and its Roadmap link opens that item's
 * panel with the fixes in view; fails_when = "Fix the link" leads to a Roadmap that shows neither
 * the item nor its fix, or the row and counts stay after the fix.
 *
 * Card goal-dates: protects = confirming a goal suggestion on Home brings its dates to confirm
 * onto Home and into the rail's count once Oracle has drafted it, with no navigation;
 * fails_when = the new dates row shows only after leaving Home.
 *
 * Card decide-on-home: protects = deciding a decision-log call on Home takes it off Home and the
 * rail's count down at once; fails_when = the call stays or the count does not drop.
 *
 * Card goal-waits: protects = a proposed goal waits in the one list: Decisions lists it with
 * Confirm and Not this, the rail counts it, and confirming it on Decisions drops the rail's count
 * at once and takes it off Home's proposed goals; confirming it on Home drops the count too;
 * fails_when = Home shows a goal to confirm that Decisions and the rail leave out.
 *
 * Card all-words: protects = Home's "In all" line names only the kinds that wait, each with its
 * number; fails_when = it names kinds that are not there.
 *
 * Card drafting-cap: protects = while Oracle drafts a new item Home reads again, backing off, and
 * stops after a while with a short line and Refresh; fails_when = it keeps reading forever.
 *
 * Card roadmap-badge: protects = the rail's Roadmap count is the Roadmap's "Needs a decision"
 * count and its tooltip says what it counts; fails_when = the two numbers differ.
 *
 * Card tile-words: protects = Home's decisions tile says plainly that the rail's Decisions count
 * holds more than the decisions; fails_when = two different numbers with no word on why.
 */

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Simple" }).getByRole("link", { name, exact: true }).filter({ visible: true });
const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const roadmapCount = (page: Page) => page.locator("[data-testid='simple-nav-roadmap-count'], [data-testid='simple-tab-roadmap-count']").filter({ visible: true });
const num = async (l: ReturnType<Page["locator"]>) => Number((await l.textContent()) ?? "0");
/** Home's "In all" line's words per kind, in its order. */
const ALL_WORDS: [string, string, string][] = [
  ["run_stop", "run stop", "run stops"],
  ["broken_link", "broken link", "broken links"],
  ["date", "date to confirm", "dates to confirm"],
  ["draft", "draft", "drafts"],
  ["proposal", "proposal", "proposals"],
  ["goal_suggestion", "goal suggestion", "goal suggestions"],
  ["goal", "proposed goal", "proposed goals"],
];
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
      const onHome = Number(await tile.textContent());
      await expect(page.getByTestId("home-decisions").getByTestId("home-decision").filter({ hasText: "Ship usage caps before anomaly detection" })).toBeVisible();

      await nav(page, "Decisions").click();
      await expect(page).toHaveURL(/\/simple\/decisions/);
      const mine = page.getByTestId("questions-mine");
      const call = mine.getByRole("listitem", { name: "Decision: Ship usage caps before anomaly detection" });
      await expect(call).toBeVisible();
      const n = Number(await page.getByTestId("questions-mine-count").textContent());
      await expect(decisionsCount(page)).toHaveText(String(n));
      await call.getByRole("button", { name: "Decide: Caps first" }).click();
      await expect(call).toHaveCount(0);
      await expect(page.getByTestId("questions-mine-count")).toHaveText(String(n - 1));
      await expect(decisionsCount(page)).toHaveText(String(n - 1));

      await nav(page, "Home").click();
      await expect(page.getByTestId("home-decision").filter({ hasText: "Ship usage caps" })).toHaveCount(0);
      if (onHome > 1) await expect(tile).toHaveText(String(onHome - 1));
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
    });

    test("A commenter's broken-links tile says it counts the links they can propose fixes for", async ({ page }) => {
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
      await expect(roadmap).toHaveAttribute("title", /^\d+ on the roadmap waiting on you: items with broken links, dates to confirm and proposals$/);
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
      await expect(decisionsCount(page)).toHaveText(/^\d+$/);
      const before = await num(decisionsCount(page));
      await proposed.getByRole("button", { name: "Confirm" }).click();
      await expect(decisionsCount(page)).toHaveText(String(before - 1));
      await expect(page.getByTestId("home-goals-proposed-list")).toHaveCount(0);
      await expect(page.getByTestId("home-goals")).toContainText("Cut early churn");
    });
    test("Accepting a date on the Roadmap drops the rail's Roadmap and Decisions counts at once", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(decisionsCount(page)).toHaveText(/^\d+$/);
      await expect(roadmapCount(page)).toHaveText(/^\d+$/);
      const decisions = await num(decisionsCount(page));
      const roadmap = await num(roadmapCount(page));
      await page.getByTestId("needs-decision").click();
      const tray = page.getByTestId("decision-tray");
      const date = tray.getByTestId("tray-date").filter({ hasText: "Alert routing by team" });
      await date.getByRole("button", { name: "Accept" }).click();
      await expect(date).toHaveCount(0);
      await expect.poll(() => num(decisionsCount(page))).toBeLessThan(decisions);
      await expect.poll(() => num(roadmapCount(page))).toBeLessThan(roadmap);
      await expect(page).toHaveURL(/\/simple\/roadmap/);
    });

    test("'Fix the link' on Decisions shows the fixes in place; acting clears the row and every count", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      const mine = page.getByTestId("questions-mine");
      const row = mine.getByRole("listitem", { name: /^Broken link: In-app tour/ }).first();
      await expect(row).toBeVisible();
      const name = (await row.getAttribute("aria-label"))!;
      const n = Number(await page.getByTestId("questions-mine-count").textContent());
      await expect(decisionsCount(page)).toHaveText(String(n));
      await row.getByRole("button", { name: "Fix the link" }).click();
      const fixes = row.getByTestId("waiting-fixes");
      await expect(fixes.getByRole("button", { name: "Accept as risk" })).toBeVisible();
      await fixes.getByRole("button", { name: "Accept as risk" }).click();
      await fixes.getByRole("textbox", { name: "Why the risk is acceptable" }).fill("The tour can wait for the next release");
      await fixes.getByRole("button", { name: "Accept as risk" }).click();
      await expect(mine.getByRole("listitem", { name, exact: true })).toHaveCount(0);
      await expect(page.getByTestId("questions-mine-count")).toHaveText(String(n - 1));
      await expect(decisionsCount(page)).toHaveText(String(n - 1));
    });

    test("A broken-link row's Roadmap link opens the item's panel with its fixes in view", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      const row = page.getByTestId("questions-mine").getByRole("listitem", { name: /^Broken link: In-app tour/ }).first();
      await row.getByRole("button", { name: "Fix the link" }).click();
      await row.getByRole("link", { name: "Open it on the Roadmap" }).click();
      await expect(page).toHaveURL(/\/simple\/roadmap\?item=/);
      const card = page.getByTestId("floating-card");
      await expect(card).toContainText("In-app tour");
      const fixes = card.getByTestId("card-flags").getByTestId("fixes").first();
      await expect(fixes).toBeInViewport();
      await expect(fixes.getByRole("button").first()).toBeVisible();
    });

    test("A 'Confirm the dates' link opens the item's panel on Oracle's dates", async ({ page }) => {
      await login(page);
      // The item's own link, as a "Confirm the dates" row's link reads it (/simple/roadmap?item=<id>).
      await page.goto("/simple/roadmap");
      await page.getByTestId("needs-decision").click();
      const item = await page.getByTestId("decision-tray").getByTestId("tray-date").filter({ hasText: "Alert routing by team" }).getAttribute("data-item");
      await page.goto(`/simple/roadmap?item=${item}`);
      const suggestion = page.getByTestId("floating-card").getByTestId("card-suggestion");
      await expect(suggestion).toBeInViewport();
      const before = await num(decisionsCount(page));
      await suggestion.getByRole("button", { name: "Accept" }).click();
      await expect(page.getByTestId("floating-card").getByTestId("card-suggestion")).toHaveCount(0);
      await expect.poll(() => num(decisionsCount(page))).toBeLessThan(before);
    });

    test("Confirming a goal suggestion on Home brings its dates onto Home and the count, with no navigation", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      const also = page.getByTestId("home-also-waiting-list");
      const goal = also.getByRole("listitem", { name: /^Goal suggestion: / }).first();
      await expect(goal).toBeVisible();
      const title = (await goal.getAttribute("aria-label"))!.replace(/^Goal suggestion: /, "");
      await expect(decisionsCount(page)).toHaveText(/^\d+$/);
      const before = await num(decisionsCount(page));
      await goal.getByRole("button", { name: "Confirm" }).click();
      await expect(also.getByRole("listitem", { name: `Goal suggestion: ${title}` })).toHaveCount(0);
      // Oracle drafts the new item; its dates to confirm then wait on me, here and in the rail.
      await expect(also.getByRole("listitem", { name: `Dates to confirm: ${title}` })).toBeVisible({ timeout: 15_000 });
      await expect(decisionsCount(page)).toHaveText(String(before));
      await expect(page).toHaveURL(/\/simple$/);
    });

    test("Deciding a decision-log call on Home takes it off Home and the count down at once", async ({ page }) => {
      await login(page, APPROVER);
      await page.goto("/simple");
      const call = page.getByTestId("home-decisions").getByTestId("home-decision").filter({ hasText: "Ship usage caps before anomaly detection" });
      await expect(call).toBeVisible();
      await expect(decisionsCount(page)).toHaveText(/^\d+$/);
      const before = await num(decisionsCount(page));
      await call.getByRole("button", { name: /^Decide/ }).first().click();
      await expect(call).toHaveCount(0);
      await expect(decisionsCount(page)).toHaveText(String(before - 1));
      await expect(page).toHaveURL(/\/simple$/);
    });

    test("Home's decisions tile says what the rail's Decisions count holds besides", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      await expect(decisionsCount(page)).toHaveText(/^\d+$/);
      const all = await num(decisionsCount(page));
      const line = page.getByTestId("home-summary-all");
      await expect(line).toContainText(`In all, ${all} things wait on you`);
      await expect(page.getByTestId("home-also-waiting")).toHaveCount(1);
      // Only the kinds that wait are named, each with its number (as Decisions lists them).
      await nav(page, "Decisions").click();
      const rows = page.getByTestId("questions-mine").getByTestId("waiting-item");
      await expect(rows).toHaveCount(all);
      const kinds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      const named = ALL_WORDS.flatMap(([kind, one, many]) => {
        const n = kinds.filter((k) => k === kind).length;
        return n ? [`${n} ${n === 1 ? one : many}`] : [];
      });
      const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
      await nav(page, "Home").click();
      await expect(line).toContainText(`the Decisions count also counts ${list}.`);
      for (const [kind, , many] of ALL_WORDS) if (!kinds.includes(kind)) await expect(line).not.toContainText(many);
    });

    test("A proposed goal waits on Decisions; confirming it there drops the rail's count and takes it off Home", async ({ page }) => {
      await login(page);
      await page.goto("/simple");
      await expect(page.getByTestId("home-goal-proposed").filter({ hasText: "Cut early churn" })).toBeVisible();
      await nav(page, "Decisions").click();
      await expect(page).toHaveURL(/\/simple\/decisions/);
      const mine = page.getByTestId("questions-mine");
      const goal = mine.getByRole("listitem", { name: "Proposed goal: Cut early churn" });
      await expect(goal).toBeVisible();
      await expect(goal.getByRole("button", { name: "Not this" })).toBeVisible();
      const before = Number(await page.getByTestId("questions-mine-count").textContent());
      await expect(decisionsCount(page)).toHaveText(String(before));
      await goal.getByRole("button", { name: "Confirm" }).click();
      await expect(goal).toHaveCount(0);
      await expect(decisionsCount(page)).toHaveText(String(before - 1));
      await expect(page).toHaveURL(/\/simple\/decisions/);
      await nav(page, "Home").click();
      await expect(page).toHaveURL(/\/simple$/);
      await expect(page.getByTestId("home-goals")).toContainText("Cut early churn");
      await expect(page.getByTestId("home-goal-proposed").filter({ hasText: "Cut early churn" })).toHaveCount(0);
    });

    test("The rail's Roadmap count is the Roadmap's Needs a decision count, and says what it counts", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      const button = page.getByTestId("needs-decision");
      await expect(button).toHaveText(/Needs a decision · \d+/);
      const n = Number((await button.textContent())!.replace(/\D+/g, ""));
      await expect(roadmapCount(page)).toHaveText(String(n));
      await expect(roadmapCount(page)).toHaveAttribute("title", `${n} on the roadmap waiting on you: items with broken links, dates to confirm and proposals`);
    });

    test("While Oracle drafts a new item Home reads again for a while, then offers Refresh", async ({ page }) => {
      await login(page);
      await page.evaluate((k) => localStorage.setItem(k, String(30 * 60_000)), MOCK_DRAFTING_MS_KEY);
      await page.goto("/simple");
      const also = page.getByTestId("home-also-waiting-list");
      const first = also.getByRole("listitem", { name: /^Goal suggestion: / }).first();
      await expect(first).toBeVisible();
      const name = (await first.getAttribute("aria-label"))!;
      await first.getByRole("button", { name: "Confirm" }).click();
      await expect(also.getByRole("listitem", { name })).toHaveCount(0);
      await expect(page.getByTestId("home-drafting-slow")).toHaveCount(0);
      // Past two minutes of reading again, Home stops and says so, with Refresh.
      await page.clock.fastForward(10 * 60_000);
      const slow = page.getByTestId("home-drafting-slow");
      await expect(slow).toBeVisible({ timeout: 15_000 });
      await expect(slow).toContainText("Oracle is still drafting");
      await page.clock.fastForward(5 * 60_000);
      await expect(slow).toBeVisible();
      await slow.getByRole("button", { name: "Refresh" }).click();
      await expect(slow).toHaveCount(0);
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
