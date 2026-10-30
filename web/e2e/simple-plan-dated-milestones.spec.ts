import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The plan-model lane: a PRD's plan is data (milestones with start and end dates, each
 * feature's slices), driven through the UI on a desktop (1366x820) and a phone (390x844),
 * light and dark, against the mock's "simple-plan" scenario (invented data: Guided setup's
 * plan, M1 Prove it 2 Nov - 27 Nov, M2 Scale volume 30 Nov - 25 Dec, M3 Open to all
 * 28 Dec - 12 Feb with a year-end break).
 *
 * Card plan-dated-home: protects = Home's "The plan this quarter" names the plan's span
 * ("2 Nov - 12 Feb") and draws one row per dated milestone ("M1 · Prove it", "M2 · Scale
 * volume", "M3 · Open to all"), each bar spanning its milestone's start to its end date
 * whatever its slices' own dates, with its end date written; fails_when = the span is
 * missing, a sliced feature is drawn as one item in no milestone, or a row starts at its
 * earliest slice instead of the milestone's start (M3 then starts 4 Jan, after the break);
 * no_claim = how the API reads the plan from the PRD (api pytest), the plan endpoints' other
 * fields (no UI shows them yet).
 *
 * Card plan-dated-one-pager: protects = the PRD's one-pager, reached from Simple's
 * One-pagers, leads with the plan's timeline whose milestone chips carry the same dated M1-M3
 * (prd-timeline replaced the strip there); fails_when = a milestone or its dates are lost;
 * no_claim = the timeline's lanes (simple-prd-timeline.spec), the PDF's drawing.
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;

// The strip's span for this plan: 1 Nov 2026 to 28 Feb 2027 (120 days).
const FROM = Date.parse("2026-11-01T00:00:00Z");
const SPAN = 120 * 86_400_000;
const pct = (day: string) => ((Date.parse(`${day}T00:00:00Z`) - FROM) / SPAN) * 100;
const ROWS = [
  { name: "M1 · Prove it", start: "2026-11-02", end: "2026-11-27", when: /Nov 27|27 Nov/ },
  { name: "M2 · Scale volume", start: "2026-11-30", end: "2026-12-25", when: /Dec 25|25 Dec/ },
  { name: "M3 · Open to all", start: "2026-12-28", end: "2027-02-12", when: /Feb 12|12 Feb/ },
];

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

/** Each dated row: its label, its end date written, its bar from the milestone's start to its end. */
async function expectDatedRows(strip: Locator, testId: string) {
  await expect(strip.getByTestId(`${testId}-month`)).toHaveText(["Nov", "Dec", "Jan", "Feb"]);
  const labels = strip.getByTestId(`${testId}-label`);
  for (const [k, r] of ROWS.entries()) {
    // fix4 (qa-simple-home-17): Home's row names its document first; the one-pager's does not.
    await expect(labels.nth(k)).toHaveText(new RegExp(`^(Guided setup · )?${r.name} · \\d+ items?$`));
    const row = strip.getByTestId(`${testId}-row`).nth(k);
    await expect(row).toContainText(r.when);
    const bar = row.locator("span.top-2");
    await expect(bar).toBeVisible();
    // A person sees the bar begin at the milestone's start and end on its date.
    const track = (await bar.locator("xpath=..").boundingBox())!;
    const box = (await bar.boundingBox())!;
    const left = ((box.x - track.x) / track.width) * 100;
    const right = ((box.x + box.width - track.x) / track.width) * 100;
    expect(Math.abs(left - pct(r.start)), `${r.name} starts on ${r.start}`).toBeLessThan(1);
    expect(Math.abs(right - pct(r.end)), `${r.name} ends on ${r.end}`).toBeLessThan(1);
    await expect(bar).not.toHaveAttribute("data-estimated", "true");
  }
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
          await expect(card.getByTestId("home-plan-span")).toHaveText("2 Nov - 12 Feb");
          await expectDatedRows(card, "home-strip");
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
            for (const f of ["M1 ends 27 Nov", "M2 ends 25 Dec", "M3 ends 12 Feb"]) await expect(timeline.getByRole("button", { name: f })).toBeVisible();
          } else {
            await expect(timeline.getByTestId("timeline-step")).toHaveText([/^2 Nov.*M1 Prove it/, /^30 Nov.*M2 Scale volume/, /^28 Dec.*M3 Open to all/]);
          }
          await expect(page.getByLabel("Timeline strip")).toHaveCount(0);
        });
      }
    });
  }
}
