import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * The owner's production walk of Simple mode, round 3 (2026-10-28): findings H2 and M1, driven
 * through the UI on the mock layer (lib/api/mock/simple-changes.ts, simple-change-words.ts,
 * simple-meetings.ts, rituals.ts), on desktop and on a phone, in light and dark. Made-up people
 * and items only.
 *
 * Card walk3-since-words (H2): protects = Home's "Since your last visit" names a change in plain
 * words, who and what with the item's code and name, and "· undone" once it is undone, in one
 * row (the undo is said on the change, not as a second row); fails_when = a row shows an op's
 * internal name (anything with "_"), the old label ("Dependents moved after"), misses
 * "· undone", or the undo shows as a row of its own; no_claim = every op's sentence (the API
 * test test_simple_walk_fixes3_cp_api covers each op).
 *
 * Card walk3-since-undo (review minor): protects = an undo made after the last visit (a visit
 * to the Inbox) of a change made before it shows as its own row ("<who> undid: ..."); fails_when
 * = it is hidden because the change it undid falls before the last visit; no_claim = which
 * visit counts as the last one.
 *
 * Card walk3-pre-read (M1): protects = Home's "Open pre-read" stays in Simple (Meetings, the
 * review's pre-read) and the pre-read lists the open product decisions as Simple's Decisions
 * page reads them, each opening there; fails_when = the link goes to Detailed's ritual page, the
 * pre-read lists a run's approval ("Run stop") or misses the open decision, or the decision
 * opens outside Simple; no_claim = Detailed's ritual pre-read, the API's exclusion of run
 * approvals (test_simple_walk_fixes3_cp_api).
 */

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

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 820 };

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? PHONE : DESKTOP, colorScheme: scheme });

      test(`Home's since-your-last-visit says my change as mine and drops it once undone (${where})`, async ({ page }) => {
        await setUp(page, "simple-home", scheme);
        await login(page);
        await page.goto("/simple");
        await expect(page.getByTestId("home-greeting")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        const broken = page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "which it depends on" });
        await broken.getByRole("button", { name: "Move dependents" }).click();
        await expect(page.getByText("Dependents moved in your working draft")).toBeVisible();
        const since = page.getByTestId("home-since");
        const rows = since.getByTestId("home-since-row").filter({ hasText: "Weekly alert digest" });
        await expect(rows).toHaveCount(1);
        // qa-simple-home-15: my own change says "You".
        await expect(rows).toContainText(/^You moved (F-\d+ )?Weekly alert digest and its dependents after what it depends on/);
        await expect(rows).not.toContainText("undone");
        await page.getByRole("button", { name: "Undo" }).click();
        await expect(page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "which it depends on" })).toBeVisible();
        // qa-simple-home-15: an undone change and its undo are no rows.
        await expect(rows).toHaveCount(0);
        for (const text of await since.getByTestId("home-since-row").allInnerTexts()) {
          expect(text).not.toContain("_");
          expect(text).not.toContain("Dependents moved after");
        }
        if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
      });

      test(`Home's since-your-last-visit lists no undo of a change made before the last visit (${where})`, async ({ page }) => {
        await setUp(page, "simple-home", scheme);
        await login(page);
        await page.goto("/simple");
        const broken = page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "which it depends on" });
        await broken.getByRole("button", { name: "Move dependents" }).click();
        await expect(page.getByText("Dependents moved in your working draft")).toBeVisible();
        // A visit to the Inbox: the change is now from before the last visit.
        await expect(async () => {
          await page.goto("/inbox");
          await expect(page).toHaveURL(/\/inbox$/);
          await page.waitForLoadState("networkidle");
          await page.goto("/simple");
          const since = page.getByTestId("home-since");
          await expect(since.getByTestId("home-since-row").or(since.getByTestId("home-since-empty")).first()).toBeVisible({ timeout: 2_000 });
          await expect(since.getByTestId("home-since-row").filter({ hasText: "Weekly alert digest" })).toHaveCount(0, { timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        // The person undoes it from the roadmap's working draft, after that visit.
        await page.goto("/simple/roadmap");
        await page.getByTestId("draft-banner").getByRole("button", { name: "Undo" }).click();
        await expect(page.getByText("Undone", { exact: true })).toBeVisible();
        await page.goto("/simple");
        const rows = page.getByTestId("home-since").getByTestId("home-since-row").filter({ hasText: "Weekly alert digest" });
        // qa-simple-home-15: an undo (and the change it undid) is no row of what changed.
        await expect(page.getByTestId("home-since").getByTestId("home-since-row").or(page.getByTestId("home-since-empty")).first()).toBeVisible();
        await expect(rows).toHaveCount(0);
        if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
      });

      test(`Home's Open pre-read stays in Simple and lists the open product decisions (${where})`, async ({ page }) => {
        await setUp(page, null, scheme);
        await login(page);
        // An owner prepares the next weekly goals check-in in Detailed (the ritual's pre-read is ready).
        await page.setViewportSize(DESKTOP);
        await page.goto("/company/rituals");
        await page.getByTestId("ritual-row").filter({ hasText: "Weekly goals check-in" }).click();
        await page.getByTestId("ritual-inspector").filter({ visible: true }).getByRole("button", { name: "Prepare now" }).click();
        await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
        if (phone) await page.setViewportSize(PHONE);

        await page.goto("/simple");
        const next = page.getByTestId("home-meeting-next");
        await expect(next).toContainText("Weekly goals check-in");
        const open = next.getByRole("link", { name: "Open pre-read" });
        await expect(open).toHaveAttribute("href", /^\/simple\/meetings\?pre_read=[0-9a-f-]{36}$/);
        await open.click();
        await expect(page).toHaveURL(/\/simple\/meetings\?pre_read=[0-9a-f-]{36}$/);
        const pre = page.getByTestId("meetings-pre-read");
        await expect(pre).toBeVisible();
        await expect(pre).toContainText("Weekly goals check-in");
        const decision = pre.getByTestId("pre-read-decision").filter({ hasText: "Should muted teams still get the weekly digest?" });
        await expect(decision).toContainText("D-3");
        await expect(pre).not.toContainText("Run stop");
        await expect(pre).not.toContainText("_");
        if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
        // The decision opens on Simple's Decisions page, at its row.
        await decision.getByRole("link", { name: "D-3" }).click();
        await expect(page).toHaveURL(/\/simple\/decisions#d-3$/);
        await expect(page.locator("#d-3")).toContainText("Should muted teams still get the weekly digest?");
      });
    });
  }
}
