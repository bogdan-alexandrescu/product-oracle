import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple polish from CLD's production walk (#723, 2026-10-27), driven through the UI on a
 * desktop (1366x820) and a phone (390x844), light and dark, against the mock (invented data).
 *
 * Card plan-strip-one-pager: protects = the one-pager's Timeline block is the PRD's span by
 * month (Oct-Jan) with one row per milestone ("M1 · 12 items" and its date), the items with
 * no milestone summed in one row, today's line and the commitment past the edge, and never a
 * bar per item; clicking a milestone opens the roadmap filtered to the PRD; fails_when = the
 * block lists each roadmap item, loses a milestone's count, or the row does not filter the
 * roadmap; no_claim = the PDF's drawing (api tests/test_simple_one_pager_polish.py).
 *
 * Card plan-strip-owner: protects = the meta names the PRD's owner, and a PRD with none reads
 * "No owner yet" (never "Owner someone"); fails_when = the meta names "someone" or drops the
 * missing owner; no_claim = how the API resolves the owner (its pytest).
 *
 * Card plan-strip-home: protects = Home's "The plan this quarter" draws the same strip for the
 * PRD in play (months, milestone rows with their item counts, today's line), no per-item bars,
 * at most 8 rows then "+N more on the roadmap" to /simple/roadmap, a row opening the roadmap
 * filtered to the PRD, and the goal band's money grouped by the locale ("$30,000 -> $50,000");
 * fails_when = Home lists every item, shows a 9th row, or prints "$50000"; no_claim = which
 * PRD the API ranks first (the mock's priorities).
 *
 * Card plan-strip-home-one-prd (#723 polish review): protects = with one PRD in play, Home's
 * strip draws as soon as the roadmap answers, without waiting on the ranking; fails_when =
 * Home shows its spinner until /v1/simple/priorities answers; no_claim = the ranking's order.
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;

async function setUp(page: Page, scenario: string | null, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario ?? "", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      for (const role of ["owner", "viewer"] as const) {
        test(`the one-pager's plan strip by month, as ${role} (${where})`, async ({ page }) => {
          await setUp(page, null, scheme);
          await login(page, EMAILS[role]);
          await page.goto("/simple/prds/guided-setup");
          await expect(page.getByTestId("one-pager-meta")).toContainText(/Owner \S/);
          await expect(page.getByTestId("one-pager-meta")).not.toContainText("someone");
          const strip = page.getByLabel("Timeline strip");
          await expect(strip.getByTestId("plan-strip-month")).toHaveText(["Oct", "Nov", "Dec", "Jan"]);
          await expect(strip.getByTestId("plan-strip-label")).toHaveText(["M1 · 12 items", "M2 · 5 items", "M3 · 3 items", "No milestone · 2 items"]);
          await expect(strip.getByTestId("plan-strip-row").first()).toContainText("Nov 20");
          await expect(strip.getByTestId("plan-strip-today")).toHaveCount(1);
          await expect(strip.getByTestId("plan-strip-edge")).toHaveText("1 commitment ends past Jan →");
          // One page: no bar per roadmap item.
          await expect(strip).not.toContainText("Setup step 1");
          await expect(strip.getByTestId("plan-strip-more")).toHaveCount(0);
          if (!phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
          else expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
          await strip.getByTestId("plan-strip-row").filter({ hasText: "M1 · 12 items" }).click();
          await expect(page).toHaveURL(/\/simple\/roadmap\?prd=guided-setup$/);
          await expect(page.getByLabel("PRD")).toHaveValue("guided-setup");
        });
      }

      test(`a PRD with no owner reads "No owner yet" (${where})`, async ({ page }) => {
        await setUp(page, "one-pager-no-owner", scheme);
        await login(page, EMAILS.viewer);
        await page.goto("/simple/prds/guided-setup");
        await expect(page.getByTestId("one-pager-meta")).toContainText("No owner yet");
        await expect(page.getByTestId("one-pager-meta")).not.toContainText("Owner ");
      });

      for (const role of ["owner", "viewer"] as const) {
        test(`Home's plan this quarter by month and the money band, as ${role} (${where})`, async ({ page }) => {
          await setUp(page, "simple-home", scheme);
          await login(page, EMAILS[role]);
          await page.goto("/simple");
          await expect(page.getByTestId("home-goal").filter({ hasText: "Faster activation" }).getByTestId("home-goal-path")).toHaveText("$30,000 -> $50,000");
          const plan = page.getByTestId("home-plan");
          await expect(plan.getByTestId("home-strip-month").first()).toBeVisible();
          await expect(plan.getByTestId("home-strip-today")).toHaveCount(1);
          const rows = plan.getByTestId("home-strip-row");
          await expect(rows.first()).toBeVisible();
          for (const label of await plan.getByTestId("home-strip-label").allTextContents()) expect(label).toMatch(/ · \d+ items?$/);
          await expect(plan.getByTestId("home-strip-bar")).toHaveCount(0);
          const prd = (await rows.first().getAttribute("href"))!;
          expect(prd).toMatch(/^\/simple\/roadmap\?prd=[a-z-]+$/);
          await rows.first().click();
          await expect(page).toHaveURL(new RegExp(`${prd.replace("?", "\\?")}$`));
          await expect(page.getByLabel("PRD")).toHaveValue(prd.split("=")[1]);
        });
      }

      test(`with one PRD in play, Home's strip does not wait on the ranking (${where})`, async ({ page }) => {
        await setUp(page, "simple-home-one-prd", scheme);
        // The ranking answers 6 s after it is asked.
        await page.context().addInitScript(
          ([slow, path, msKey, ms]) => {
            localStorage.setItem(slow, path);
            localStorage.setItem(msKey, ms);
          },
          [MOCK_SLOW_KEY, "/v1/simple/priorities", MOCK_SLOW_MS_KEY, "6000"] as const,
        );
        await login(page, EMAILS.viewer);
        // It is asked after the page commits: a strip within 5 s of the commit never waited on it.
        await page.goto("/simple", { waitUntil: "commit" });
        const row = page.getByTestId("home-plan").getByTestId("home-strip-row").first();
        await expect(row).toBeVisible({ timeout: 5000 });
        await expect(row).toHaveAttribute("href", "/simple/roadmap?prd=guided-setup");
      });

      test(`Home shows at most 8 milestone rows, then "+N more on the roadmap" (${where})`, async ({ page }) => {
        await setUp(page, "simple-home-milestones", scheme);
        await login(page, EMAILS.viewer);
        await page.goto("/simple");
        const plan = page.getByTestId("home-plan");
        await expect(plan.getByTestId("home-strip-row")).toHaveCount(8);
        const more = plan.getByTestId("home-strip-more");
        await expect(more).toHaveText(/^\+\d+ more on the roadmap$/);
        await more.click();
        await expect(page).toHaveURL(/\/simple\/roadmap$/);
      });
    });
  }
}
