import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * qa-shell-8 (desktop and phone, mock-backed, through the UI only): a new company's first run.
 * The owner signs in, switches to Simple and opens Priorities and Roadmap: each says in one line
 * what will show there and the next step (confirm the goals in Detailed › Baseline, a working
 * link), with no line picker or comparison over nothing on Priorities and no empty chart, filters,
 * review or export on Roadmap.
 * no_claim: what the Baseline page then does (onboarding specs cover it).
 */

/** The 'empty' scenario, with the mock's company store reset once at the start. */
async function newCompany(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-empty")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-empty", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "empty"] as const,
  );
}

const NO_GOALS = /^No features yet: confirm your company’s goals in Detailed › Baseline and /;

for (const [where, use] of [
  ["desktop", { viewport: { width: 1440, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test(`qa-shell-8: a new company's Priorities and Roadmap say what shows there and the next step (${where})`, async ({ page }) => {
      await newCompany(page);
      await login(page);
      // Switch to Simple from Detailed's Mode switch (the rail on a desktop, the menu on a phone).
      if (where === "desktop") {
        await page.getByRole("navigation", { name: "Oracle" }).getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Simple" }).click();
      } else {
        await page.goto("/simple");
      }
      await expect(page).toHaveURL(/\/simple$/);

      // Priorities: one line and the next step, no "0 of 0 miss" and nothing to pick over.
      if (where === "desktop") await page.getByTestId("simple-nav-priorities").click();
      else {
        await page.getByTestId("simple-tab-more").click();
        await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Priorities", exact: true }).click();
      }
      await expect(page).toHaveURL(/\/simple\/priorities/);
      const prio = page.getByTestId("simple-priorities");
      await expect(prio.getByTestId("priorities-empty")).toHaveText(NO_GOALS);
      await expect(prio.getByTestId("line-caption")).toHaveCount(0);
      await expect(prio.getByRole("switch", { name: "Compare with Oracle" })).toHaveCount(0);
      await prio.getByRole("tab", { name: "Value / effort" }).click();
      await expect(prio.getByTestId("priorities-empty")).toBeVisible();

      // Roadmap: one line and the next step; no empty chart, filters, review or export.
      if (where === "desktop") await page.getByTestId("simple-nav-roadmap").click();
      else await page.getByTestId("simple-tab-roadmap").click();
      await expect(page).toHaveURL(/\/simple\/roadmap/);
      const roadmap = page.getByTestId("simple-roadmap");
      const empty = roadmap.getByTestId("roadmap-empty");
      await expect(empty).toHaveText(NO_GOALS);
      await expect(roadmap.getByTestId("simple-chart")).toBeHidden();
      await expect(roadmap.getByTestId("today-line")).toBeHidden();
      await expect(roadmap.getByTestId("filters")).toHaveCount(0);
      for (const name of ["Export PNG", "Export PDF", "Start review"]) await expect(roadmap.getByRole("button", { name })).toHaveCount(0);
      await expect(roadmap.getByTestId("quick-add")).toHaveCount(0);

      // The link works: it opens Detailed's Baseline.
      await empty.getByRole("link", { name: "Detailed › Baseline" }).click();
      await expect(page).toHaveURL(/\/baseline$/);
      await expect(page.getByRole("heading", { name: "Baseline" }).first()).toBeVisible();
    });
  }
}
