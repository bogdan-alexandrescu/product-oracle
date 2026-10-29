import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The plan-model lane: Oracle's dates for an item whose PRD feature is built over two
 * milestones, confirmed from the roadmap tray's "Dates to confirm", driven through the UI on
 * a desktop (1366x820) and a phone (390x844), light and dark, against the mock's
 * "simple-plan" scenario (invented data: Guided setup's plan; Team invites, F-05, has no
 * dates of its own and a slice in each of M1 Prove it and M2 Scale volume: F-05a 9 Nov -
 * 27 Nov, F-05b 30 Nov - 11 Dec).
 *
 * Card plan-dates-to-confirm: protects = the tray's row for a two-milestone item shows ONE
 * suggestion spanning its open slices (the first slice's start to the last slice's end,
 * "Nov 9 – Dec 11"), and Accept saves exactly the dates the row showed: the item's card then
 * reads those dates as accepted, its bar draws dated, and no row is left for its other
 * slice; fails_when = the row shows only the first slice's dates ("Nov 9 – Nov 27") while
 * Accept saves the whole span, Accept saves other dates than the row showed, or the second
 * slice's suggestion stays open in the tray after the Accept; no_claim = how the API builds
 * the slices and their suggestions from the PRD (api pytest), Dismiss and Edit of a sliced
 * suggestion, the slice names ("…, part 1 of 2") which no roadmap screen shows.
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };
const ITEM = "plan-f-05";
const TITLE = "Team invites";
// The span of F-05's slices: F-05a's start (M1) to F-05b's end (M2).
const SPAN = { start: "2026-11-09", end: "2026-12-11", words: "Nov 9 – Dec 11" };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

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

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      test(`an owner accepts a two-milestone item's dates from the tray (${where}, ${scheme})`, async ({ page }) => {
        await setUp(page, scheme);
        await login(page);
        await page.goto("/simple/roadmap");
        await expect(page.getByTestId("simple-roadmap")).toBeVisible();
        // A phone reads the item's bar on the Gantt: its Timeline (timeline-overlap B3) draws thin lanes, no bars.
        if (where === "phone") await page.getByTestId("format-gantt").click();
        await expect(bar(page, ITEM)).toHaveAttribute("data-kind", "estimated");

        await page.getByTestId("needs-decision").click();
        const tray = page.getByTestId("decision-tray");
        await expect(tray).toBeVisible();
        const row = tray.getByTestId("tray-date").filter({ hasText: `${TITLE}:` });
        await expect(row).toHaveCount(1);
        const words = row.locator("span").first();
        // One suggestion for the item: the span of its two slices, not its first slice's dates.
        await expect(words).toHaveText(`${TITLE}: ${SPAN.words}`);
        const shown = (await words.textContent())!.slice(`${TITLE}: `.length).trim();

        await row.getByRole("button", { name: "Accept" }).click();
        await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
        // Every open slice was accepted with it: no row is left for the item.
        await expect(tray.getByTestId("tray-date").filter({ hasText: `${TITLE}:` })).toHaveCount(0);
        await tray.getByRole("button", { name: "Close" }).click();
        await expect(tray).toHaveCount(0);

        // The saved dates are the ones the row showed.
        await expect(bar(page, ITEM)).toHaveAttribute("data-kind", "dated");
        await expect(bar(page, ITEM)).toHaveAttribute("data-start", SPAN.start);
        await expect(bar(page, ITEM)).toHaveAttribute("data-end", SPAN.end);
        await bar(page, ITEM).click();
        const card = page.getByTestId("floating-card");
        await expect(card.getByRole("heading", { name: TITLE })).toBeVisible();
        await expect(card.getByTestId("card-dates")).toHaveText(`${shown} · accepted`);

        if (where === "phone") expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
      });
    });
  }
}
