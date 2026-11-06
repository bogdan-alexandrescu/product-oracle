import { stableUuid } from "../lib/api/mock/ids";
import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * Simple's roadmap reads ?item=<id> (train AN 1b8d555db and 775ac69ed, ported): a link to one
 * item, as the Detailed Plan's "Open it on the roadmap" sends for an item the Plan does not show
 * (PR 1309: /simple/roadmap?item=<Simple's item id>), lands on the Roadmap with that item's one
 * feature panel open, whichever format the Roadmap is in. protects = the link opens that item's
 * panel, an item only a working draft holds included, once (closing it leaves it closed);
 * fails_when = the Roadmap opens with no panel, or another item's; no_claim = the Plan's own line
 * (web/app/plan, PR 1309's specs). The mock's default company (invented data).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

/** Simple's item id, as the Plan's line puts it in the link (the mock's ids are stable). */
const itemId = (key: string) => stableUuid(`simple-item/${key}`);

async function follow(page: Page, key: string) {
  await login(page);
  await page.goto(`/simple/roadmap?item=${encodeURIComponent(itemId(key))}`);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

for (const [where, device] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(device);

    test("a link to an item only a draft holds opens its feature panel", async ({ page }) => {
      await follow(page, "setup-ideas");
      const panel = page.getByTestId("floating-card");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("aria-label", "Team invite nudges");
      await expect(panel).toBeInViewport();
    });

    test("a link to a planned item opens its panel once: closed, it stays closed", async ({ page }) => {
      await follow(page, "alert-digest");
      const panel = page.getByTestId("floating-card");
      await expect(panel).toHaveAttribute("aria-label", "Weekly alert digest");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await page.getByTestId("format-board").click();
      await expect(page.getByTestId("format-board")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("floating-card")).toHaveCount(0);
    });
  });
}
