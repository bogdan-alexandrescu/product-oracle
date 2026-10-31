import { expect, test, type Page } from "./test";

import { LONG_GOAL_NAME, LONG_GOAL_SCENARIO } from "../lib/api/mock/baseline";
import { REPORT_OFF_TRACK_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * qa5-plan-at-risk, driven through the UI on the mock API as a person would, on a desktop
 * (1440x900) and a phone (390x844). Test cards (protects / fails_when / no_claim):
 * - "milestone at risk": protects=a report's next milestone reads "at risk" only when an item of
 *   it slips past its date; fails_when=a track off track for a critical blocker, nothing
 *   slipping, reads its milestone at risk; no_claim=the track's health chip (off track).
 *   "report-off-track" is "alignment-report" with the digest's slip accepted at First
 *   release's Nov 30 and an open critical blocker on Alerts in the team chat (Now).
 * - "long goal": protects=a long goal name in Priorities' Goal column is shown whole, inside
 *   its cell, wrapped between words; fails_when=the name is cut (clamped), a word breaks across
 *   lines, or the chip runs past its cell; no_claim=a single word wider than the column.
 *   "long-goal" names G2 (paid conversion) "Grow paid conversion for small teams on the yearly plan".
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function start(page: Page, scenario: string, email?: string) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("milestone at risk: off track for a blocker, nothing slipping, the milestone keeps its basis", async ({ page }) => {
      await start(page, REPORT_OFF_TRACK_SCENARIO);
      await page.goto("/plan/reports");
      await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
      const usage = visible(page, "report-track").filter({ hasText: "Usage alerts PRD" });
      await expect(usage).toContainText("Off track");
      await expect(usage.getByTestId("needs-attention")).toContainText("Chat app review takes two weeks (open)");
      await expect(usage.getByTestId("needs-attention")).not.toContainText("after the milestone date");
      await expect(usage).toContainText("First release, Nov 30");
      await expect(usage.getByTestId("report-milestone-risk")).toHaveCount(0);
      await expect(usage).toContainText("· a verified basis supports it");
    });

    test("long goal: the Goal column shows a long goal name whole, inside its cell", async ({ page }) => {
      await start(page, LONG_GOAL_SCENARIO, "approver@example.com");
      await page.goto("/priorities");
      await expect(page.locator('tr[data-testid^="priority-row-"]')).toHaveCount(8);
      const row = page.getByTestId("priority-row-F-3");
      const chip = row.locator('[data-testid="row-goals"]').filter({ visible: true }).getByTestId("code-name");
      await expect(chip).toHaveText(LONG_GOAL_NAME);
      await chip.scrollIntoViewIfNeeded();
      const fit = await chip.evaluate((el) => {
        const cell = el.closest("td") ?? el.closest('[data-testid="row-goals"]')!;
        const node = el.firstChild!;
        const text = node.textContent ?? "";
        const broken: string[] = [];
        let lines = new Set<number>();
        for (const m of text.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(node, m.index ?? 0);
          r.setEnd(node, (m.index ?? 0) + m[0].length);
          const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
          if (tops.size > 1) broken.push(m[0]);
          lines = new Set([...lines, ...tops]);
        }
        const c = el.getBoundingClientRect();
        const box = cell.getBoundingClientRect();
        return {
          broken,
          lines: lines.size,
          clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
          inside: c.left >= box.left - 0.5 && c.right <= box.right + 0.5 && c.right <= window.innerWidth,
        };
      });
      expect(fit.broken, "goal words broken across lines").toEqual([]);
      expect(fit.clipped, "the goal name is cut").toBe(false);
      expect(fit.inside, "the goal chip runs past its cell").toBe(true);
      // Long enough to need more than one line somewhere, so the check guards the wrapping.
      if (viewport === DESKTOP) expect(fit.lines).toBeGreaterThan(2);
    });
  });
}
