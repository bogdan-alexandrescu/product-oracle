import { readFileSync } from "node:fs";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * prd-timeline (the owner's picks D "Timeline first" and B "Goal lanes", 2026-10-28): the
 * Simple one-pager of a PRD leads with a dated timeline built from its plan, one lane per
 * goal plus a PM-owned lane, the milestone chips above it and the picked milestone's part
 * below it. Driven through the UI on a desktop (1366x820) and a phone (390x844), light and
 * dark, against the mock's "simple-plan" scenario (invented data: Guided setup, M1 Prove it
 * 2 Nov - 27 Nov, M2 Scale volume 30 Nov - 25 Dec, M3 Open to all 28 Dec - 12 Feb with a
 * year-end break; F-05, F-11 and F-12 have a slice in two milestones).
 *
 * Card timeline-lanes: protects = the timeline's axis (months, a Today pill, the year-end
 * break hatched), one lane per goal and a "PM-owned · no engineering" lane, each piece a bar
 * labelled with its codes in its milestone's colour, a lane whose pieces run back to back
 * (Growth: F-05a in M1, F-05b in M2) stacked in two rows, the milestone flags ("M1 ends
 * 27 Nov"); on a phone the same plan down the page, each milestone with each goal's chips;
 * fails_when = a lane or a flag is missing, a piece lands in the wrong lane, the stacked
 * pieces share one row, or the page scrolls sideways; no_claim = the exact colours (the
 * tokens), the API's reading of the plan (api pytest).
 *
 * Card timeline-goals: protects = each lane's label names its goal, its targets per
 * milestone with the unit once ("M1 100 → M2 250 → M3 600 weekly active teams") and what is
 * measured now ("Not counted yet"; "Now 40 weekly active teams · behind"); fails_when = a
 * target or the measure is dropped or worded with ids; no_claim = how a goal is measured.
 *
 * Card timeline-pick: protects = the current milestone's part shows by default (M1, the next
 * to start on the mock's day), picking the M2 chip shows M2's part (its dates, Done when,
 * targets per goal, what it builds grouped by kind with each feature's one line and flow
 * thumbnail, its open decisions and risks), and a bar or a flag picks its milestone too;
 * fails_when = the part does not follow the pick or shows another milestone's work;
 * no_claim = the flow viewer (the flows lane).
 *
 * Card timeline-edit-hover: protects = a line's "Edit" shows only when the line is pointed at
 * (desktop) or tapped (phone), with no "Edit line N" written on every line, and the header
 * names the PRD's owner and the plan's span; fails_when = Edit shows on every line at rest
 * or "Edit line" is written; no_claim = the edit itself (simple-one-pager.spec).
 *
 * Card timeline-no-dates: protects = a PRD whose milestones have no dates says so plainly,
 * with "Read the plan again" for an owner only; fails_when = an empty timeline is drawn or a
 * viewer is offered the button; no_claim = the read job (api pytest).
 *
 * Card timeline-pdf: protects = Export PDF saves the timeline page, then one page per
 * milestone; fails_when = a milestone's page is missing or out of order; no_claim = the
 * API's PDF drawing (the mock's PDF lists its pages).
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

      test(`the timeline leads the page with goal lanes and goals tracked (${where})`, async ({ page }) => {
        await open(page, scheme);
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl).toBeVisible();
        // It leads: above the page's first section.
        const tlBox = (await tl.boundingBox())!;
        const first = (await page.getByRole("region", { name: "Problem and who has it" }).boundingBox())!;
        expect(tlBox.y).toBeLessThan(first.y);
        await expect(tl.getByRole("button", { name: /^M1 Prove it/ })).toBeVisible();
        await expect(tl.getByRole("button", { name: /^M2 Scale volume/ })).toBeVisible();
        await expect(tl.getByRole("button", { name: /^M3 Open to all/ })).toBeVisible();

        const goals = tl.getByTestId("timeline-goal");
        await expect(goals).toHaveCount(4);
        const growth = goals.filter({ hasText: "Growth" });
        await expect(growth).toContainText("M1 100 → M2 250 → M3 600 weekly active teams");
        await expect(growth).toContainText("Now 40 weekly active teams · behind");
        await expect(goals.filter({ hasText: "Reliability" })).toContainText("Now 99.6% setup success · on track");
        await expect(goals.filter({ hasText: "Activation" })).toContainText("Not counted yet");
        await expect(goals.filter({ hasText: "Revenue" })).toContainText("Not counted yet");

        if (!phone) {
          const axis = tl.getByTestId("timeline-axis");
          await expect(axis.getByTestId("timeline-month")).toHaveText(["Oct", "Nov", "Dec", "Jan", "Feb"]);
          await expect(axis.getByText("Today", { exact: true })).toBeVisible();
          await expect(tl.getByTestId("timeline-no-work")).toHaveCount(1);
          await expect(tl.getByTestId("timeline-lane")).toHaveCount(5);
          await expect(tl.getByTestId("timeline-lane").last()).toContainText("PM-owned · no engineering");
          for (const f of ["M1 ends 27 Nov", "M2 ends 25 Dec", "M3 ends 12 Feb"]) await expect(tl.getByRole("button", { name: f })).toBeVisible();
          // Growth: F-05a (M1) and F-05b's M2 run back to back, so they stack in two rows.
          const lane = tl.getByTestId("timeline-lane").filter({ hasText: "Growth" });
          const m1 = lane.locator('[data-testid="timeline-bar"][data-milestone="M1"]');
          const m2 = lane.locator('[data-testid="timeline-bar"][data-milestone="M2"]');
          await expect(m1).toHaveCount(1);
          await expect(m1).toHaveText("F-05a");
          await expect(m2).toHaveCount(1);
          const [a, b] = [(await m1.boundingBox())!, (await m2.boundingBox())!];
          expect(Math.abs(a.y - b.y)).toBeGreaterThan(a.height / 2);
          expect(a.x + a.width).toBeLessThan(b.x + 4);
          // Each bar names what it builds; a bar too narrow for its codes ends with "+N".
          await expect(m2).toHaveAttribute("aria-label", /F-05b Team invites, part 2 of 2|F-05b Team invites/);
          await expect(m2).toHaveText(/^F-05b( · F-08)*( · F-12a)?( \+\d)?$/);
          const pm = tl.getByTestId("timeline-lane").last().locator('[data-testid="timeline-bar"]');
          await expect(pm).toHaveCount(3);
          await expect(pm.first()).toHaveAttribute("data-pm", "true");
        } else {
          const down = tl.getByTestId("timeline-vertical");
          await expect(down.getByTestId("timeline-step")).toHaveCount(3);
          const m1 = down.getByTestId("timeline-step").first();
          await expect(m1).toContainText("M1 Prove it");
          await expect(m1).toContainText("ends 27 Nov");
          await expect(m1.getByRole("button", { name: /F-05a/ })).toBeVisible();
          await expect(m1.getByTestId("timeline-step-goal").filter({ hasText: "PM-owned · no engineering" })).toContainText("F-04");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 390 : 1366);
      });

      test(`picking M2 shows M2's part below the timeline (${where})`, async ({ page }) => {
        await open(page, scheme, "viewer");
        const tl = page.getByRole("region", { name: "Timeline" });
        const part = page.getByTestId("milestone-part");
        // The current milestone by default: M1 is the next to start on the mock's day.
        await expect(part.getByRole("heading", { level: 2 })).toHaveText("M1 Prove it");
        await expect(tl.getByRole("button", { name: /^M1 Prove it/ })).toHaveAttribute("aria-pressed", "true");

        await tl.getByRole("button", { name: /^M2 Scale volume/ }).click();
        await expect(tl.getByRole("button", { name: /^M2 Scale volume/ })).toHaveAttribute("aria-pressed", "true");
        await expect(part.getByRole("heading", { level: 2 })).toHaveText("M2 Scale volume");
        await expect(part).toContainText("30 Nov – 25 Dec");
        await expect(part.getByTestId("part-done-when").getByRole("listitem")).toHaveText(["Bulk import handles 10,000 rows", "Invites come back from 40% of new admins"]);
        await expect(part.getByTestId("part-targets")).toContainText("Growth: 250 weekly active teams");
        await expect(part.getByTestId("part-targets")).toContainText("Revenue: $5,000 monthly recurring revenue");
        const builds = part.getByTestId("part-builds");
        await expect(builds.getByRole("heading", { level: 3 })).toHaveText(["New for people", "Behind the scenes", "PM-owned"]);
        const bulk = builds.getByRole("listitem").filter({ hasText: "F-07 Bulk import" });
        await expect(bulk).toContainText("Imports people and projects from a spreadsheet");
        await expect(bulk.getByTestId("part-flow")).toBeVisible();
        await expect(builds).toContainText("F-05b Team invites");
        await expect(builds).not.toContainText("F-01 Setup checklist");
        await expect(part.getByTestId("part-decisions")).toContainText("Q7 Legal input on invite emails");
        await expect(part.getByTestId("part-risks")).toContainText("Large imports could slow setup for everyone");

        if (!phone) {
          // A flag picks its milestone; so does a bar.
          await tl.getByRole("button", { name: "M3 ends 12 Feb" }).click();
          await expect(part.getByRole("heading", { level: 2 })).toHaveText("M3 Open to all");
          await tl.locator('[data-testid="timeline-bar"][data-milestone="M1"]').first().click();
          await expect(part.getByRole("heading", { level: 2 })).toHaveText("M1 Prove it");
        } else {
          await tl.getByTestId("timeline-step").nth(2).getByRole("button", { name: /F-13/ }).click();
          await expect(part.getByRole("heading", { level: 2 })).toHaveText("M3 Open to all");
        }
      });

      test(`a line's Edit shows when it is pointed at or tapped (${where})`, async ({ page }) => {
        await open(page, scheme);
        const meta = page.getByTestId("one-pager-meta");
        await expect(meta).toContainText(/Owner \S+/);
        await expect(meta).toContainText("2 Nov - 12 Feb");
        const article = page.getByRole("article", { name: "One-pager" });
        // What a person reads on each line is "Edit" (its number is for screen readers only).
        await expect(article.getByTestId("line-edit-word").first()).toHaveText("Edit");
        for (const word of await article.getByTestId("line-edit-word").allTextContents()) expect(word).toBe("Edit");
        const line = article.locator("li[data-line]").first();
        const edit = line.getByRole("button", { name: /^Edit line/ });
        await expect(edit).toHaveCSS("opacity", "0");
        if (!phone) await line.hover();
        else await line.getByTestId("one-pager-line-text").tap();
        await expect(edit).toHaveCSS("opacity", "1");
        await edit.click();
        await expect(article.getByRole("textbox")).toBeVisible();
      });

      test(`a PRD whose milestones have no dates says so (${where})`, async ({ page }) => {
        await open(page, scheme, "owner", "simple-plan-undated");
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl).toContainText("The milestones have no dates yet");
        await expect(tl.getByTestId("timeline-lane")).toHaveCount(0);
        await tl.getByRole("button", { name: "Read the plan again" }).click();
        await expect(tl.getByRole("status")).toContainText("Read again");
        await expect(tl).toContainText("The milestones have no dates yet");
      });

      test(`a viewer is not offered to read an undated plan again (${where})`, async ({ page }) => {
        await open(page, scheme, "viewer", "simple-plan-undated");
        const tl = page.getByRole("region", { name: "Timeline" });
        await expect(tl).toContainText("The milestones have no dates yet");
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
