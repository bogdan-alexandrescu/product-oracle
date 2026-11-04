import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * one-roadmap-many-prds (the owner, Nov 4: the company has ONE roadmap, never one per PRD): Simple
 * › Roadmap shows the items of two area PRDs (User Safety, Scale) on the one Product roadmap, and
 * its PRD filter narrows it to one PRD's items; the older PRD Trust plan, replaced by both, names
 * them in a line at its top and offers no Build roadmap. Driven through the UI against the mock's
 * "one-roadmap" scenario (web/lib/api/mock/one-roadmap.ts, invented data).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const SAFETY = ["Report button on every post", "Block list"];
const SCALE = ["Read replicas in two regions", "Queue backpressure"];

const filter = (page: Page, label: string): Locator => page.getByTestId("filters").locator("label", { hasText: new RegExp(`^${label}`) }).locator("select");
const shown = (page: Page, title: string): Locator => page.getByTestId("simple-roadmap").getByText(title, { exact: true }).filter({ visible: true }).first();

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "one-roadmap"] as const);
  await login(page);
}

for (const [name, device] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`one company roadmap (${name})`, () => {
    test.use(device);

    /**
     * protects = Simple › Roadmap shows two PRDs' items on one roadmap (Product roadmap) and the
     * PRD filter narrows it to one PRD's items and back; fails_when = a PRD's items are missing,
     * the roadmap is one per PRD, or the PRD filter leaves the other PRD's items on; no_claim =
     * how a run writes the roadmap (the API's tests).
     */
    test("Simple Roadmap shows items of two PRDs on one roadmap, with a PRD filter", async ({ page }) => {
      await open(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      for (const title of [...SAFETY, ...SCALE]) await expect(shown(page, title)).toBeVisible();

      const prd = filter(page, "PRD");
      await expect(prd.locator("option")).toHaveText(["All", "Scale", "User Safety"]);
      await prd.selectOption({ label: "Scale" });
      for (const title of SCALE) await expect(shown(page, title)).toBeVisible();
      for (const title of SAFETY) await expect(shown(page, title)).toHaveCount(0);

      await prd.selectOption({ label: "User Safety" });
      for (const title of SAFETY) await expect(shown(page, title)).toBeVisible();
      for (const title of SCALE) await expect(shown(page, title)).toHaveCount(0);

      await prd.selectOption({ label: "All" });
      for (const title of [...SAFETY, ...SCALE]) await expect(shown(page, title)).toBeVisible();
    });

    /**
     * protects = a PRD replaced by area PRDs names them in a line at its top, each a link, and
     * offers no Build roadmap (read-only); fails_when = the line is missing, names no PRD, or the
     * Build roadmap button still shows; no_claim = the carried schedule bases (the API's tests).
     */
    test("a replaced PRD shows its Replaced by line", async ({ page }) => {
      await open(page);
      await page.goto("/documents/trust-plan");
      const line = page.getByTestId("replaced-by");
      await expect(line).toHaveText("Replaced by User Safety and Scale. Read-only: its items no longer feed the roadmap.");
      await expect(page.getByRole("button", { name: /Build roadmap/ })).toHaveCount(0);
      await line.getByRole("link", { name: "Scale" }).click();
      await expect(page).toHaveURL(/\/documents\/scale$/);
      await expect(page.getByTestId("replaced-by")).toHaveCount(0);
    });
  });
}
