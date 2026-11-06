import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The plan-model lane: a PRD's plan is data (milestones with start and end dates, each
 * feature's slices), driven through the UI on a desktop (1366x820) and a phone (390x844),
 * light and dark, against the mock's "simple-plan" scenario (invented data: Guided setup's
 * plan, M1 Prove it 2 Nov - 27 Nov, M2 Scale volume 30 Nov - 25 Dec, M3 Open to all
 * 28 Dec - 12 Feb with a year-end break).
 *
 * Card plan-dated-home: protects = Home's "The plan this quarter" names the plan's span
 * ("Nov 2 - Feb 12") and, since home-waiting-one-list (PR 1235), draws the company roadmap's
 * plan: rows by the roadmap's own milestones, each opening the whole roadmap, never one PRD's
 * plan milestones ("M1 · Prove it"); fails_when = the span is missing, or Home draws Guided
 * setup's plan milestones in place of the company roadmap's; no_claim = how the API reads the
 * plan from the PRD (api pytest), the plan endpoints' other fields (no UI shows them yet).
 *
 * Card plan-dated-one-pager: protects = the PRD's one-pager, reached from Simple's
 * One-pagers, leads with the plan's timeline whose milestone chips carry the same dated M1-M3
 * (prd-timeline replaced the strip there); fails_when = a milestone or its dates are lost;
 * no_claim = the timeline's lanes (simple-prd-timeline.spec), the PDF's drawing.
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;

// Guided setup's plan milestones, as its one-pager's timeline names them.
const ROWS = ["M1 · Prove it", "M2 · Scale volume", "M3 · Open to all"];

async function setUp(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "simple-plan", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      for (const role of ["owner", "viewer"] as const) {
        test(`Home's plan and the one-pager draw the dated milestones, as ${role} (${where})`, async ({ page }) => {
          await setUp(page, scheme);
          await login(page, EMAILS[role]);
          await page.goto("/simple");
          const card = page.getByTestId("home-plan");
          await expect(page.getByRole("heading", { name: "The plan this quarter" })).toBeVisible();
          await expect(card.getByTestId("home-plan-span")).toHaveText("Nov 2 - Feb 12");
          // The company roadmap's plan (PR 1235): its own milestones, each row opening the whole roadmap.
          const rows = card.getByTestId("home-strip-row");
          await expect(rows.first()).toBeVisible();
          for (const href of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) expect(href).toBe("/simple/roadmap");
          for (const label of await card.getByTestId("home-strip-label").allTextContents()) {
            expect(label).toMatch(/ · \d+ items?$/);
            for (const name of ROWS) expect(label).not.toContain(name);
          }
          if (!phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
          else expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

          // The PRD's one-pager, through Simple's One-pagers.
          await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
          await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Guided setup" }).click();
          await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup$/);
          // prd-timeline (fidelity, picks D and B): the one-pager leads with the plan's timeline in
          // place of the strip: each milestone's end is a flag on a desktop and "Milestones: done
          // when" names them; down a phone each milestone starts on its day.
          const timeline = page.getByRole("region", { name: "Timeline" });
          if (!phone) {
            await expect(timeline.getByRole("group", { name: "Milestones" }).getByRole("button")).toHaveText(["M1 Prove it", "M2 Scale volume", "M3 Open to all"]);
            for (const f of ["M1 ends Nov 27", "M2 ends Dec 25", "M3 ends Feb 12"]) await expect(timeline.getByRole("button", { name: f })).toBeVisible();
          } else {
            await expect(timeline.getByTestId("timeline-step")).toHaveText([/^Nov 2.*M1 Prove it/, /^Nov 30.*M2 Scale volume/, /^Dec 28.*M3 Open to all/]);
          }
          await expect(page.getByLabel("Timeline strip")).toHaveCount(0);
        });
      }
    });
  }
}
