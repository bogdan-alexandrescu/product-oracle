import { readFileSync } from "node:fs";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * prd-timeline, matched to the owner's picks (2026-10-28, "keep the mockup design very
 * strictly"): D "Timeline first" (prd-shape D1 desktop, D2 phone, D3 no dates) and B "Goal
 * lanes" (timeline-overlap B1, the When strip). The PRD's header leads, then the timeline is
 * its own card (the PRD's summary lines, the When strip: one slim lane per goal with its
 * targets and measure, milestone-end flags, Today, the holidays, the decisions with a date,
 * the legend, then "Milestones: done when"), and the picked milestone's part is a separate
 * card under it (Why now, Done when, Targets, What we build by kind, the flows in full, the
 * decisions it needs with the PRD's recommendation and due, the risks with "What we do").
 * A phone reads the timeline down the page (D2). Driven through the UI on a desktop
 * (1366x820) and a phone (390x844), light and dark, against the mock's "simple-plan" scenario
 * (invented data: Guided setup, M1 Prove it 2 Nov - 27 Nov, M2 Scale volume 30 Nov - 25 Dec,
 * M3 Open to all 28 Dec - 12 Feb with a year-end break; Q3 due 20 Oct, Q8 27 Nov, Q7 30 Nov,
 * Q9 with no day; the mock's today is 22 Oct).
 *
 * Card timeline-lanes: protects = the strip's axis (months, a Today pill, the year-end break
 * hatched), one lane per goal and a "PM-owned" lane, each piece a bar labelled with its codes
 * in its milestone's colour (PM-owned work dashed), a lane whose pieces run back to back, less
 * than a week apart (Growth: F-05a in M1, F-05b in M2), stacked in two rows while two pieces
 * more than a week apart (Revenue: F-11a in M2, F-11b in M3 past the break) share one, the
 * milestone flags ("M1 ends 27 Nov"); fails_when = a lane or a flag is missing, a piece lands
 * in the wrong lane, the close pieces share one row, the far ones stack, or the page scrolls
 * sideways; no_claim = the exact colours (the tokens), the API's reading of the plan.
 *
 * Card timeline-goals: protects = each lane's label names its goal, its targets per milestone
 * with the unit once ("M1 100 → M2 250 → M3 600 weekly active teams") and what is measured now
 * ("Not counted yet"; "Now 40 · behind"); fails_when = a target or the measure is dropped or
 * worded with ids; no_claim = how a goal is measured.
 *
 * Card timeline-card (B1 + D1): protects = the timeline card carries the PRD's summary lines,
 * "When", the decisions with a date as diamonds with their words ("was due Oct 20", "M2 decision, taken at the M1
 * review, Nov 27", "before M2 starts, Nov 30"), the legend, the count of decisions with no day
 * and "Milestones: done when"; it is slim (a one-row lane is at most 34 px; a goal's lane at
 * most 64); the milestone's part is a separate card under it; fails_when = a part is missing,
 * a lane grows back to the old height or the milestone's part shares the timeline's card.
 *
 * Card timeline-pick: protects = the current milestone's part shows by default (M1, the next to
 * start on the mock's day), picking M2 in "Milestones: done when" shows M2's card (its dates,
 * Done when, target tiles, what it builds grouped by kind with each feature's one line, its
 * flows in full, the decisions it needs with the PRD's recommendation and due, its risks with
 * what we do), and a bar or a flag picks its milestone too; on a phone the milestone's card in
 * the vertical timeline opens; fails_when = the part does not follow the pick or shows another
 * milestone's work; no_claim = the flow drawing (the Flow components).
 *
 * Card timeline-now: protects = on a day inside M1 its card's chip reads "Now · week 2 of 4"
 * and the next milestone's "Next · starts Nov 30"; fails_when = the week or the state is
 * wrong; no_claim = the company's time zone (its own spec).
 *
 * Card timeline-header (D1, D2): protects = the PRD's header sits above the timeline: the way
 * back to One-pagers (desktop), Present, Export PDF, Start review, Open the detailed view, the
 * title, Approved, the version and its day, the owner, the plan's dates and engineer-weeks; the
 * old one-pager no longer renders under the plan; a phone keeps a bar with the title once the
 * header scrolls away; fails_when = the title shows below the timeline, an action or a fact is
 * missing, or the one-pager's lines render twice; no_claim = Present and Start review
 * themselves (simple-one-pager.spec, the meetings specs).
 *
 * Card timeline-edit-hover: protects = with no plan, a one-pager line's "Edit" shows only when
 * the line is pointed at (desktop) or tapped (phone: the first tap shows Edit without opening
 * the line, a second tap on its words opens it), with no "Edit line N" written on every line;
 * fails_when = Edit shows on every line at rest or "Edit line" is written; no_claim = the edit
 * itself (simple-one-pager.spec).
 *
 * Card timeline-no-dates (D3): protects = milestones with no dates are named in "No dates yet:"
 * under the strip of the dated ones, with "Read the plan again" for an owner only; a plan with
 * no dates at all draws no lanes; fails_when = an empty timeline is drawn or a viewer is
 * offered the button; no_claim = the read job (api pytest).
 *
 * Card timeline-pdf: protects = Export PDF saves the timeline page, then one page per
 * milestone; fails_when = a milestone's page is missing or out of order; no_claim = the API's
 * PDF drawing (the mock's PDF lists its pages).
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;

async function open(page: Page, scheme: "light" | "dark", role: keyof typeof EMAILS = "owner", scenario = "simple-plan") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, EMAILS[role]);
  await page.goto("/simple");
  await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Guided setup" }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup$/);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme, hasTouch: phone });

      test(`the PRD's header leads, then the timeline, then the milestone's card (${where})`, async ({ page }) => {
        await open(page, scheme);
        const title = page.getByRole("heading", { level: 1, name: "Guided setup" });
        await expect(title).toBeVisible();
        const meta = page.getByTestId("one-pager-meta");
        await expect(meta).toContainText("Approved");
        await expect(meta).toContainText(phone ? "v3 · Oct 20, 2026" : "Version 3 · Oct 20, 2026");
        await expect(meta).toContainText("Owner Avery Stone");
        await expect(meta).toContainText("Nov 2, 2026 → Feb 12, 2027");
        await expect(meta).toContainText("56 engineer-weeks");
        for (const name of ["Present", "Export PDF", "Start review"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "Open in Detailed" })).toBeVisible();
        const tl = page.getByRole("region", { name: "Timeline" });
        const part = page.getByTestId("milestone-part");
        // In that order down the page; the milestone's part is its own card, not the timeline's.
        const [h, t, p] = [(await title.boundingBox())!, (await tl.boundingBox())!, (await part.boundingBox())!];
        expect(h.y).toBeLessThan(t.y);
        expect(t.y + t.height).toBeLessThanOrEqual(p.y);
        await expect(tl.getByTestId("milestone-part")).toHaveCount(0);
        // The old one-pager no longer renders under the plan.
        await expect(page.getByRole("article", { name: "One-pager" })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Problem and who has it" })).toHaveCount(0);
        if (!phone) {
          await page.getByRole("link", { name: "One-pagers", exact: true }).filter({ visible: true }).last().click();
          await expect(page).toHaveURL(/\/simple\/one-pagers$/);
        } else {
          // Past the header a bar keeps the PRD's title (D2).
          await expect(page.getByTestId("timeline-stick")).toHaveCount(0);
          await tl.getByTestId("timeline-step").first().scrollIntoViewIfNeeded();
          await page.evaluate(() => window.scrollBy(0, 200));
          const stick = page.getByTestId("timeline-stick");
          await expect(stick).toBeVisible();
          await expect(stick).toContainText("Guided setup");
          await expect(stick).toContainText(/Timeline|M1 · Prove it/);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1366);
      });

      test(`the timeline's lanes, flags and goals (${where})`, async ({ page }) => {
        await open(page, scheme);
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl).toBeVisible();
        await expect(tl.getByRole("button", { name: /^M1 Prove it/ })).toBeVisible();
        await expect(tl.getByRole("button", { name: /^M2 Scale volume/ })).toBeVisible();
        await expect(tl.getByRole("button", { name: /^M3 Open to all/ })).toBeVisible();

        if (!phone) {
          const goals = tl.getByTestId("timeline-goal");
          await expect(goals).toHaveCount(4);
          const growth = goals.filter({ hasText: "Growth" });
          await expect(growth).toContainText("M1 100 → M2 250 → M3 600 weekly active teams");
          await expect(growth).toContainText("Now 40 · behind");
          await expect(goals.filter({ hasText: "Reliability" })).toContainText("Now 99.6% · on track");
          await expect(goals.filter({ hasText: "Activation" })).toContainText("Not counted yet");
          await expect(goals.filter({ hasText: "Revenue" })).toContainText("M1 $0 → M2 $5,000 → M3 $20,000 monthly recurring revenue");

          const axis = tl.getByTestId("timeline-axis");
          // Oct gives way to the Today pill when there is no room for both (B1 draws it when there is).
          await expect(axis.getByTestId("timeline-month").last()).toHaveText("Feb");
          expect((await axis.getByTestId("timeline-month").allTextContents()).slice(-4)).toEqual(["Nov", "Dec", "Jan", "Feb"]);
          await expect(axis.getByText("Today", { exact: true })).toBeVisible();
          await expect(tl.getByTestId("timeline-no-work")).toHaveCount(1);
          await expect(tl.getByTestId("timeline-lane")).toHaveCount(5);
          await expect(tl.getByTestId("timeline-lane").last()).toContainText("Product manager's work");
          for (const f of ["M1 ends Nov 27", "M2 ends Dec 25", "M3 ends Feb 12"]) await expect(tl.getByRole("button", { name: f })).toBeVisible();
          // Growth: F-05a (M1) and F-05b's M2 run back to back, so they stack in two rows.
          const lane = tl.getByTestId("timeline-lane").filter({ hasText: "Growth" });
          const m1 = lane.locator('[data-testid="timeline-bar"][data-milestone="M1"]');
          const m2 = lane.locator('[data-testid="timeline-bar"][data-milestone="M2"]');
          await expect(m1).toHaveCount(1);
          // A bar names its work, not only its code.
          await expect(m1).toHaveText(/^(F-05a Team invites, part 1 of 2|Team invites, part 1 of 2|F-05a)$/);
          await expect(m2).toHaveCount(1);
          const [a, b] = [(await m1.boundingBox())!, (await m2.boundingBox())!];
          expect(Math.abs(a.y - b.y)).toBeGreaterThan(a.height / 2);
          expect(a.x + a.width).toBeLessThan(b.x + 4);
          // Each bar names what it builds; a bar too narrow for its codes ends with "+N".
          await expect(m2).toHaveAttribute("aria-label", /F-05b Team invites, part 2 of 2/);
          await expect(m2).toHaveText(/^(F-05b Team invites|Team invites, part 2 of 2 \+\d|F-05b \+\d|\d features)/);
          // The owner's rule: two pieces in one lane stack only when they overlap or are less
          // than a week apart. F-11a ends 25 Dec and F-11b starts 4 Jan, past the year-end
          // break (10 days): one row.
          const revenue = tl.getByTestId("timeline-lane").filter({ hasText: "Revenue" });
          const f11a = revenue.locator('[data-testid="timeline-bar"][aria-label*="F-11a "]');
          const f11b = revenue.locator('[data-testid="timeline-bar"][aria-label*="F-11b "]');
          await expect(f11a).toHaveAttribute("data-milestone", "M2");
          await expect(f11b).toHaveAttribute("data-milestone", "M3");
          await expect(f11b).toHaveAttribute("data-row", (await f11a.getAttribute("data-row"))!);
          const [x, y] = [(await f11a.boundingBox())!, (await f11b.boundingBox())!];
          expect(Math.abs(x.y - y.y)).toBeLessThan(1);
          expect(x.x + x.width).toBeLessThan(y.x);
          await expect(m1).toHaveAttribute("data-row", "0");
          await expect(m2).toHaveAttribute("data-row", "1");
          // No bar's label spills past the bar: it is fitted, never wider than the bar.
          for (const bar of await tl.getByTestId("timeline-bar").all()) {
            const [inner, outer] = await bar.evaluate((el) => [el.scrollWidth, el.clientWidth]);
            expect(inner).toBeLessThanOrEqual(outer + 1);
          }
          const pm = tl.getByTestId("timeline-lane").last().locator('[data-testid="timeline-bar"]');
          await expect(pm).toHaveCount(3);
          await expect(pm.first()).toHaveAttribute("data-pm", "true");
          // B1's slim strip: the bars are 22 px; a one-row lane at most 34 px, a goal's at most 64.
          expect((await pm.first().boundingBox())!.height).toBeLessThanOrEqual(23);
          const pmLane = (await tl.getByText("Product manager's work", { exact: true }).boundingBox())!;
          expect(pmLane.height).toBeLessThanOrEqual(34);
          for (const g of await goals.all()) expect((await g.boundingBox())!.height).toBeLessThanOrEqual(64);
        } else {
          // D2: the timeline turns vertical: milestones, decisions with a day and Today, by date.
          const down = tl;
          await expect(tl).toHaveAttribute("data-testid", "timeline-vertical");
          await expect(down.getByTestId("timeline-step")).toHaveCount(3);
          const m1 = down.getByTestId("timeline-step").first();
          await expect(m1).toContainText("M1 Prove it");
          await expect(m1).toContainText("to Nov 27 · 4 weeks · 16 engineer-weeks");
          // A compact summary: the milestone's part (Done when, targets) follows the timeline once.
          await expect(m1.getByTestId("part-done-when")).toHaveCount(0);
          await expect(m1.getByRole("link", { name: "6 features, 2 flows · 1 decision ›" })).toBeVisible();
          await expect(down.getByTestId("timeline-decision")).toHaveText([/Q3 Which sample data to ship\s*was due Oct 20/, /Q8 The bulk import row limit\s*M2 decision, taken at the M1 review/, /Q7 Legal input on invite emails\s*before M2 starts/]);
          const order = await down.locator(':scope > [data-testid], :scope > div').allTextContents();
          const at = (words: string) => order.findIndex((t) => t.includes(words));
          expect(at("Q3 Which")).toBeLessThan(at("Today"));
          expect(at("Today")).toBeLessThan(at("Prove it"));
          expect(at("Q7 Legal")).toBeLessThan(at("Scale volume"));
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1366);
      });

      if (!phone) {
        test(`the timeline card: summary, decisions with a date, legend, done when (${where})`, async ({ page }) => {
          await open(page, scheme, "viewer");
          const tl = page.getByRole("region", { name: "Timeline" });
          const summary = tl.getByTestId("timeline-summary").getByRole("listitem");
          await expect(summary).toHaveCount(2);
          await expect(summary.first()).toContainText("Goal: setup in a day. This quarter builds");
          await expect(summary.first().locator("b")).toHaveText("Goal: setup in a day.");
          await expect(tl.getByRole("heading", { name: "When", exact: true })).toBeVisible();
          const decisions = tl.getByTestId("timeline-decision");
          await expect(decisions).toHaveText([/Q3 Which sample data to ship\s*was due Oct 20/, /Q8 The bulk import row limit\s*M2 decision, taken at the M1 review, Nov 27/, /Q7 Legal input on invite emails\s*before M2 starts, Nov 30/]);
          await expect(tl).toContainText("1 more decision has no date yet; it is listed under its milestone.");
          const legend = tl.getByTestId("timeline-legend");
          for (const w of ["M1", "M2", "M3", "Product manager's work, no engineering", "Today Oct 22", "Holidays Dec 28 – Jan 1", "milestone end"]) await expect(legend).toContainText(w);
          await expect(tl.getByRole("heading", { name: "Milestones: done when" })).toBeVisible();
          await expect(tl.getByRole("group", { name: "Milestones" }).getByRole("button")).toHaveText(["M1 Prove it", "M2 Scale volume", "M3 Open to all"]);
          // The decisions' row sits under the lanes, inside the strip.
          const lanesBottom = (await tl.getByTestId("timeline-lane").last().locator(":scope > div").last().boundingBox())!;
          expect((await decisions.first().boundingBox())!.y).toBeGreaterThanOrEqual(lanesBottom.y + lanesBottom.height - 1);
        });
      }

      test(`picking M2 shows M2's card below the timeline (${where})`, async ({ page }) => {
        await open(page, scheme, "viewer");
        const tl = page.getByRole("region", { name: "Timeline" });
        const part = page.getByTestId("milestone-part");
        // The current milestone by default: M1 is the next to start on the mock's day.
        await expect(part.getByRole("heading", { level: 2 })).toHaveText("M1 Prove it");
        await expect(part).toContainText("Next · starts Nov 2");
        await expect(part.getByTestId("part-why")).toContainText("Why now");
        const m1 = tl.getByRole("button", { name: /^M1 Prove it/ });
        await expect(m1).toHaveAttribute(phone ? "aria-expanded" : "aria-pressed", "true");
        // M1's flows in full: each a box with its steps.
        await expect(part.getByRole("heading", { name: "Flows in M1" })).toBeVisible();
        await expect(part.getByTestId("part-flow")).toHaveCount(2);
        await expect(part.getByTestId("part-flow").first()).toContainText("Flow · F-01 Setup checklist");
        await expect(part.getByTestId("part-flow").first().getByRole("img", { name: /User flow: 1 Open setup/ })).toBeVisible();

        await tl.getByRole("button", { name: /^M2 Scale volume/ }).click();
        await expect(tl.getByRole("button", { name: /^M2 Scale volume/ })).toHaveAttribute(phone ? "aria-expanded" : "aria-pressed", "true");
        await expect(part.getByRole("heading", { level: 2 })).toHaveText("M2 Scale volume");
        await expect(part.getByTestId("part-dates")).toHaveText("Nov 30 → Dec 25, 2026 · 4 weeks · 16 engineer-weeks, 1 of it buffer");
        await expect(part).toContainText("Later · starts Nov 30");
        await expect(part.getByTestId("part-why")).toContainText("Now bring in whole teams at once");
        await expect(part.getByTestId("part-done-when").getByRole("listitem")).toHaveText(["Bulk import handles 10,000 rows", "Invites come back from 40% of new admins"]);
        const tiles = part.getByTestId("part-targets");
        await expect(tiles).toContainText("250weekly active teams");
        await expect(tiles).toContainText("$5,000monthly recurring revenue");
        const builds = part.getByTestId("part-builds");
        await expect(builds).toContainText("What we build · 7 features, by kind");
        await expect(builds.getByRole("heading", { level: 4 })).toHaveText([/^New for people · \d$/, /^Behind the scenes · \d$/, /^Product manager's work, no new engineering · 1$/]);
        const bulk = builds.getByRole("listitem").filter({ hasText: "F-07" });
        await expect(bulk).toContainText("Bulk import · flow below");
        await expect(bulk).toContainText("Imports people and projects from a spreadsheet");
        await expect(part.getByTestId("part-flow").filter({ hasText: "F-07 Bulk import" })).toBeVisible();
        await expect(builds).toContainText("Team invites, part 2 of 2");
        await expect(builds).not.toContainText("Setup checklist");
        const decisions = part.getByTestId("part-decisions");
        await expect(decisions.getByRole("heading")).toHaveText("Decisions it needs · 2");
        const q7 = decisions.getByRole("listitem").filter({ hasText: "Legal input on invite emails" });
        await expect(q7).toContainText("Q7");
        await expect(q7).toContainText("Recommended: Legal reads the invite email once, before it goes out.");
        await expect(q7).toContainText("before M2 starts, Nov 30");
        await expect(decisions.getByRole("listitem").filter({ hasText: "The bulk import row limit" })).toContainText("at the M1 review, Nov 27");
        const risks = part.getByTestId("part-risks");
        const r2 = risks.getByRole("listitem").filter({ hasText: "Large imports could slow setup for everyone" });
        await expect(r2).toContainText("R-2");
        await expect(r2).toContainText("What we do: F-09 moves big imports to a queue.");
        await expect(r2).toContainText("Likelihood: Medium · Impact: Medium");

        if (!phone) {
          // A flag picks its milestone; so does a bar.
          await tl.getByRole("button", { name: "M3 ends Feb 12" }).click();
          await expect(part.getByRole("heading", { level: 2 })).toHaveText("M3 Open to all");
          // M3's decision has no day: its milestone stands for when.
          await expect(part.getByTestId("part-decisions").getByRole("listitem")).toContainText("M3");
          await tl.locator('[data-testid="timeline-bar"][data-milestone="M1"]').first().click();
          await expect(part.getByRole("heading", { level: 2 })).toHaveText("M1 Prove it");
        } else {
          await tl.getByRole("button", { name: /^M3 Open to all/ }).click();
          await expect(part.getByRole("heading", { level: 2 })).toHaveText("M3 Open to all");
          await tl.getByTestId("timeline-step").nth(2).getByRole("link", { name: /features/ }).click();
          await expect(part).toBeInViewport();
        }
      });

      test(`on a day inside M1 its card reads "Now · week 2 of 4" (${where})`, async ({ page }) => {
        await page.clock.setSystemTime(new Date("2026-11-10T20:00:00Z"));
        await open(page, scheme, "viewer");
        const part = page.getByTestId("milestone-part");
        await expect(part.getByRole("heading", { level: 2 })).toHaveText("M1 Prove it");
        await expect(part).toContainText("Now · week 2 of 4");
        await expect(part.getByTestId("part-decisions").getByRole("listitem")).toContainText("was due Oct 20");
        const tl = page.getByRole("region", { name: "Timeline" });
        if (phone) await expect(tl.getByTestId("timeline-step").first()).toContainText("week 2 of 4");
        await tl.getByRole("button", { name: /^M2 Scale volume/ }).click();
        await expect(part).toContainText("Next · starts Nov 30");
      });

      /**
       * Card prd-plan-lines-to-review (BGD 2026-10-28, the train Z review): protects = a PRD with a
       * plan shows only its header, timeline and milestone card until there is something to
       * review; once a working draft exists (here: a line changed in a review meeting) the
       * one-pager's lines, the margin and the Working draft bar show under the milestone card
       * outside the meeting too, so whoever Remind sends there can read and decide them;
       * fails_when = the lines stay hidden while the bar says there are changes, or show with
       * nothing to review; no_claim = Remind itself (simple-one-pager-remind.spec).
       */
      test(`with a plan, the lines come back while there is something to review (${where})`, async ({ page }) => {
        await open(page, scheme);
        await page.goto("/simple/prds/guided-setup");
        await expect(page.getByTestId("milestone-part")).toBeVisible();
        await expect(page.getByRole("article", { name: "One-pager" })).toHaveCount(0);
        await page.getByRole("button", { name: "Start review", exact: true }).click();
        await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
        await page.getByLabel("New wording for").fill("A setup checklist with the next two steps");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
        await page.goto("/simple/prds/guided-setup");
        await expect(page.getByTestId("milestone-part")).toBeVisible();
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
        const article = page.getByRole("article", { name: "One-pager" });
        await expect(article).toBeVisible();
        await expect(article).toContainText("A setup checklist with the next two steps");
        await expect(article.getByRole("button", { name: "Edit “A setup checklist with the" })).toHaveCount(1);
        // Below the milestone's card, never above it.
        const [p, a] = [(await page.getByTestId("milestone-part").boundingBox())!, (await article.boundingBox())!];
        expect(p.y + p.height).toBeLessThanOrEqual(a.y);
      });

      test(`a line's Edit shows when it is pointed at or tapped, with no plan (${where})`, async ({ page }) => {
        // The mock's default company: Guided setup has no plan, so its one-pager's lines show.
        await page.emulateMedia({ colorScheme: scheme });
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await expect(page.getByTestId("milestone-part")).toHaveCount(0);
        const meta = page.getByTestId("one-pager-meta");
        await expect(meta).toContainText(/Owner \S+/);
        const article = page.getByRole("article", { name: "One-pager" });
        // What a person reads on each line is "Edit" (its number is for screen readers only).
        await expect(article.getByTestId("line-edit-word").first()).toHaveText("Edit");
        for (const word of await article.getByTestId("line-edit-word").allTextContents()) expect(word).toBe("Edit");
        const line = article.locator("li[data-line]").first();
        const edit = line.getByRole("button", { name: /^Edit “/ });
        await expect(edit).toHaveCSS("opacity", "0");
        if (!phone) await line.hover();
        else {
          // A tap on the line shows Edit and does not open the line (a phone snaps a tap near
          // the words onto them; a second tap on the words opens it, below). The touchscreen
          // taps where the viewport is, so the line is brought into view first.
          await line.scrollIntoViewIfNeeded();
          const box = (await line.boundingBox())!;
          const words = (await line.getByTestId("one-pager-line-text").boundingBox())!;
          await page.touchscreen.tap(words.x + words.width + 2 < box.x + box.width ? words.x + words.width + 2 : box.x + 2, box.y + box.height - 2);
          await expect(line.getByTestId("one-pager-line-text")).toHaveAttribute("aria-expanded", "false");
          await expect(edit).toHaveCSS("opacity", "1");
          await line.getByTestId("one-pager-line-text").tap();
          await expect(line.getByTestId("one-pager-line-text")).toHaveAttribute("aria-expanded", "true");
          await line.getByTestId("one-pager-line-text").tap();
        }
        await expect(edit).toHaveCSS("opacity", "1");
        await edit.click();
        await expect(article.getByRole("textbox")).toBeVisible();
      });

      test(`work with no goal named adds no lane of its own (${where})`, async ({ page }) => {
        // Card timeline-no-goal-lane: protects = slices whose feature names no goal add no
        // "No goal named" lane (one lane per goal, then the PM-owned lane); fails_when = that
        // lane is drawn; no_claim = the milestone part, which still lists the work.
        await open(page, scheme, "owner", "simple-plan-goalless");
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl).toBeVisible();
        await expect(tl).not.toContainText("No goal named");
        if (!phone) await expect(tl.getByTestId("timeline-lane")).toHaveCount(5);
        await tl.getByRole("button", { name: /^M2 / }).first().click();
        await expect(page.getByTestId("milestone-part")).toContainText("Docs refresh");
      });

      test(`milestones with no dates are named under the strip (D3) (${where})`, async ({ page }) => {
        await open(page, scheme, "owner", "simple-plan-partly-dated");
        const tl = page.getByRole("region", { name: "Timeline" });
        const note = tl.getByTestId("timeline-no-dates");
        await expect(note).toContainText("No dates yet:");
        await expect(note).toContainText("M2 · Scale volume");
        await expect(note).toContainText("M3 · Open to all");
        await expect(note).not.toContainText("M1 · Prove it");
        await expect(note.getByRole("button", { name: "Read the plan again" })).toBeVisible();
        if (!phone) {
          await expect(tl.getByTestId("timeline-lane")).toHaveCount(5);
          const bars = tl.getByTestId("timeline-bar");
          expect(new Set(await bars.evaluateAll((els) => els.map((e) => e.getAttribute("data-milestone"))))).toEqual(new Set(["M1"]));
          await expect(tl.getByRole("button", { name: "M1 ends Nov 27" })).toBeVisible();
          await expect(tl.getByRole("button", { name: /^M2 ends/ })).toHaveCount(0);
        }
        await tl.getByRole("button", { name: /^M2 Scale volume/ }).click();
        await expect(page.getByTestId("milestone-part")).toContainText("No dates yet");
      });

      test(`a PRD whose milestones have no dates says so (${where})`, async ({ page }) => {
        await open(page, scheme, "owner", "simple-plan-undated");
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl.getByTestId("timeline-no-dates")).toContainText("No dates yet:");
        await expect(tl.getByTestId("timeline-lane")).toHaveCount(0);
        await tl.getByRole("button", { name: "Read the plan again" }).click();
        await expect(tl.getByRole("status")).toContainText("Read again");
        await expect(tl.getByTestId("timeline-no-dates")).toContainText("No dates yet:");
      });

      test(`a viewer is not offered to read an undated plan again (${where})`, async ({ page }) => {
        await open(page, scheme, "viewer", "simple-plan-undated");
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl.getByTestId("timeline-no-dates")).toContainText("No dates yet:");
        await expect(tl.getByRole("button", { name: "Read the plan again" })).toHaveCount(0);
      });

      test(`Export PDF saves the timeline, then a page per milestone (${where})`, async ({ page }) => {
        await open(page, scheme, "viewer");
        await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export PDF" }).click()]);
        const text = readFileSync((await download.path())!, "utf8");
        expect([...text.matchAll(/% page \d+: (.+)/g)].map((m) => m[1])).toEqual(["The timeline", "M1 Prove it", "M2 Scale volume", "M3 Open to all"]);
      });
    });
  }
}
