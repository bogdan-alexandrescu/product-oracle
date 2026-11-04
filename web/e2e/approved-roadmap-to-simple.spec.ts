import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * approved-roadmap-to-simple (the owner, Nov 3: one roadmap, one set of dates): approving a
 * roadmap version applies its plan to the roadmap's items, so Simple › Roadmap shows the
 * approved version's dates with where they come from, drops the shipped item, adds the new
 * one, moves the next-PRD item out, draws the version's milestones, recomputes the broken
 * dependency mark and says which version it matches. Driven through the UI against the mock's
 * "approved-roadmap" scenario (invented data: the roadmap Example trails, version 2 approved
 * on old engineering estimates, version 3 in review with the re-planned dates).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };
const SIMPLE = "/simple/roadmap?roadmap=example-trails";

const bar = (page: Page, key: string) => page.locator(`[data-testid="bar"][data-item="${key}"]`).filter({ visible: true });

async function view(page: Page, format: "timeline" | "gantt") {
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", format);
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use(phone ? PHONE : DESKTOP);

    /**
     * protects = approving roadmap version 3 in Detailed puts its plan on Simple › Roadmap:
     * the version's dates with their source words ("Founder commitment"), the shipped Offline
     * sync and the next-PRD Trail chat off the plan, the new "Keep improving trail maps" on it,
     * the version's milestones on the Timeline and the Gantt, Trip reports no longer broken,
     * and the line "Matches roadmap version 3, approved ..." linking the version;
     * fails_when = Simple still shows version 2's estimates, the shipped item, no milestone
     * marks, the broken mark, or no line; no_claim = a person's own dates (the API's tests).
     */
    test(`approving roadmap version 3 puts its plan on Simple (${where})`, async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "approved-roadmap"] as const);
      await login(page);

      // Before: version 2's engineering estimates; Trip reports starts before Route search ends.
      await page.goto(SIMPLE);
      await view(page, "gantt");
      await expect(bar(page, "route-search")).toHaveAttribute("data-end", "2027-01-20");
      await expect(bar(page, "trip-reports")).toHaveAttribute("data-broken", "true");
      await expect(bar(page, "offline-sync")).toHaveCount(1);
      await expect(bar(page, "keep-improving")).toHaveCount(0);
      await expect(page.getByTestId("applied-version")).toHaveCount(0);

      // Approve version 3 in Detailed.
      await page.goto("/documents/example-trails/v/3");
      await page.getByTestId("approve-version").filter({ visible: true }).click();
      await page.getByRole("group", { name: "Confirm approval" }).filter({ visible: true }).getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByRole("alert").filter({ visible: true }).filter({ hasText: /./ })).toHaveCount(0);
      await expect(page.getByText(/✓ Approved Oct 22, 2026/).filter({ visible: true }).first()).toBeVisible();

      // After: Simple reads version 3.
      await page.goto(SIMPLE);
      const line = page.getByTestId("applied-version");
      // The mock clock starts at Oct 22, 2026 (MOCK_NOW).
      await expect(line).toContainText("Matches roadmap version 3, approved Oct 22, 2026");
      await expect(line.getByTestId("applied-off-plan")).toHaveText("Shipped, off the plan: Offline sync. Moved to the next PRD: Trail chat.");
      await expect(line.getByRole("link", { name: "roadmap version 3" })).toHaveAttribute("href", "/documents/example-trails/v/3");

      // The Gantt: the version's dates with their source words, its milestones, no broken mark.
      await view(page, "gantt");
      await expect(bar(page, "route-search")).toHaveAttribute("data-start", "2026-12-01");
      await expect(bar(page, "route-search")).toHaveAttribute("data-end", "2027-01-08");
      await expect(bar(page, "route-search")).toHaveAttribute("aria-label", /Founder commitment/);
      await expect(bar(page, "photo-pins")).toHaveAttribute("aria-label", /Set by Pat Example/);
      await expect(bar(page, "keep-improving")).toHaveAttribute("data-end", "2027-03-31");
      await expect(bar(page, "offline-sync")).toHaveCount(0);
      await expect(bar(page, "trail-chat")).toHaveCount(0);
      await expect(bar(page, "trip-reports")).toHaveAttribute("data-broken", "false");
      const marks = page.getByTestId("track-milestone").filter({ visible: true });
      await expect(marks.filter({ hasText: "Trail beta" })).toHaveCount(1);
      await expect(marks.filter({ hasText: "Trail launch" })).toHaveCount(1);

      // The Timeline: the same dates, the shipped and moved items gone, the new one there.
      await view(page, "timeline");
      const row = (key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`).filter({ visible: true });
      await expect(row("route-search")).toContainText("Jan 8");
      await expect(row("keep-improving")).toHaveCount(1);
      await expect(row("offline-sync")).toHaveCount(0);
      await expect(row("trail-chat")).toHaveCount(0);
      await expect(row("trip-reports").getByLabel("Broken link")).toHaveCount(0);
      const flags = page.getByTestId("timeline-milestone").filter({ visible: true });
      await expect(flags.filter({ hasText: "Trail beta · Jan 15" })).toHaveCount(1);
      await expect(flags.filter({ hasText: "Trail launch · Jan 29" })).toHaveCount(1);

      // The card says where the dates come from.
      await view(page, "gantt");
      await bar(page, "route-search").click();
      await expect(page.getByTestId("card-dates").filter({ visible: true })).toContainText("Founder commitment");

      // The line's link opens the version.
      await page.keyboard.press("Escape");
      await line.getByRole("link", { name: "roadmap version 3" }).click();
      await expect(page).toHaveURL(/\/documents\/example-trails\/v\/3/);
    });
  });
}
