import { AREA_PRDS, OLD_PRD } from "../lib/api/mock/one-roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * simple-replaced-prds (the owner, Nov 4): a PRD marked replaced is history, read in Detailed
 * only; Simple shows only the PRDs that replaced it. Against the mock's "one-roadmap" scenario
 * (web/lib/api/mock/one-roadmap.ts, invented data): Trust plan, replaced by User Safety and
 * Scale, is on no Simple list, picker or filter, and Home's one-pagers card does not count it;
 * its document page in Detailed still names the PRDs that replaced it.
 */

const AREAS = AREA_PRDS.map(([, title]) => title);
const OLD = OLD_PRD[1];

async function open(page: Page, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "one-roadmap"] as const);
  await login(page, email);
}

const optionTexts = async (select: Locator) => (await select.locator("option").allTextContents()).map((t) => t.trim());

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test.describe(`replaced PRDs in Simple (${name})`, () => {
    test.use({ viewport });

    /**
     * protects = One-pagers lists the two area PRDs and not the replaced one, and Home's
     * "One-pagers to read" shows and counts the same PRDs; fails_when = Trust plan is listed
     * or counted; no_claim = the order of the rows.
     */
    test("One-pagers and Home leave out the replaced PRD", async ({ page }) => {
      await open(page, "viewer@example.com");
      await page.goto("/simple/one-pagers");
      const list = page.getByTestId("simple-one-pagers");
      for (const title of AREAS) await expect(list.getByRole("link", { name: title, exact: true })).toBeVisible();
      await expect(list.getByRole("link", { name: OLD, exact: true })).toHaveCount(0);
      const total = await list.getByTestId("one-pager-row").count();

      await page.goto("/simple");
      const card = page.getByTestId("home-read");
      await expect(card.getByRole("link").first()).toBeVisible();
      await expect(card.getByRole("link", { name: OLD, exact: true })).toHaveCount(0);
      const shown = await card.locator("li").count();
      const more = card.getByTestId("home-more");
      const left = (await more.count()) ? Number((await more.innerText()).match(/\d+/)![0]) : 0;
      expect(shown + left).toBe(total);
    });

    /**
     * protects = the review start sheet's PRD picker and the Decisions page's PRD filter offer
     * the two area PRDs and never the replaced one, while Detailed still reads it with
     * "Replaced by"; fails_when = Trust plan is an option; no_claim = who may start a review.
     */
    test("the start sheet and the Decisions filter offer only the area PRDs", async ({ page }) => {
      await open(page);
      await page.goto("/simple/meetings");
      const start = page.getByRole("button", { name: "Start review" }).first();
      await start.scrollIntoViewIfNeeded();
      await start.click();
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      const picker = sheet.getByLabel("PRD");
      await expect(picker.locator("option", { hasText: AREAS[0] })).toHaveCount(1);
      const offered = await optionTexts(picker);
      for (const title of AREAS) expect(offered).toContain(title);
      expect(offered).not.toContain(OLD);
      await page.keyboard.press("Escape");

      await page.goto("/simple/decisions");
      const filter = page.getByRole("group", { name: "Filters" }).locator("label", { hasText: /^PRD/ }).locator("select");
      await expect(filter.locator("option", { hasText: AREAS[0] })).toHaveCount(1);
      const filters = await optionTexts(filter);
      for (const title of AREAS) expect(filters).toContain(title);
      expect(filters).not.toContain(OLD);

      // Detailed keeps it as history.
      await page.goto(`/documents/${OLD_PRD[0]}`);
      await expect(page.getByText(/Replaced by/).first()).toBeVisible();
    });
  });
}
