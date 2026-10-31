import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * A dialog's or sheet's dimmed backdrop where a page scrollbar takes space. Windows and Linux
 * draw one of about 15 px; a Mac's floats over the page, and Playwright hides scrollbars. This
 * file shows them and styles one, so it takes its space here too (as
 * priorities-scrollbar-room.spec.ts does). From 640 px the page keeps the scrollbar's room
 * (html { scrollbar-gutter: stable }), so opening a dialog does not shift the page sideways.
 *
 * protects = the backdrop's box is the whole window and it is on top at the window's right
 * edge (no undimmed strip where the scrollbar was), desktop and phone, for the shared Dialog,
 * the shared Sheet, the meeting's start sheet and the opened flow; the page behind does not
 * move sideways when one opens. fails_when = the backdrop ends 15 px short of the right edge.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SCROLLBAR = "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #999; }";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

async function showScrollbar(page: Page, desktop: boolean) {
  await page.addStyleTag({ content: SCROLLBAR });
  // On a desktop the scrollbar's room is kept; a phone's takes none (no gutter under 640 px).
  // (The page's own box, not its clientWidth: a page too short to scroll still reports the whole window there.)
  if (desktop) await expect.poll(() => page.evaluate(() => window.innerWidth - document.documentElement.getBoundingClientRect().width)).toBeGreaterThanOrEqual(15);
}

/** The backdrop's box is the window, and at every corner and the right edge a person sees it (or the dialog over it). */
async function expectCoversWindow(backdrop: Locator) {
  await expect(backdrop).toBeVisible();
  const look = await backdrop.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const points = [[2, 2], [w - 2, 2], [w - 2, h / 2], [w - 2, h - 2], [2, h - 2]];
    return {
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
      win: { x: 0, y: 0, w, h },
      uncovered: points
        .filter(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== el && !hit?.closest('[role="dialog"]');
        })
        .map(([x, y]) => `${x},${y}`),
    };
  });
  expect(look.box, "the backdrop's box is the window").toEqual(look.win);
  expect(look.uncovered, "points outside the dialog the backdrop does not cover").toEqual([]);
}

/** The x of an element of the page behind, to show it does not move when a dialog opens. */
const left = async (l: Locator) => (await l.boundingBox())!.x;

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  const desktop = name === "desktop";

  test.describe(`${name}: backdrops cover the whole window where scrollbars take space`, () => {
    test.use({ viewport });

    test("the shared Dialog (New request)", async ({ page }) => {
      await login(page);
      await page.goto("/requests");
      const heading = page.getByRole("heading", { name: "Requests", level: 1 });
      await expect(heading).toBeAttached();
      await showScrollbar(page, desktop);
      const before = desktop ? await left(heading) : 0;
      await page.getByRole("button", { name: "New request" }).first().click();
      await expect(page.getByRole("dialog", { name: "New request" })).toBeVisible();
      await expectCoversWindow(page.getByTestId("dialog-backdrop"));
      if (desktop) expect(await left(heading), "the page does not jump").toBe(before);
    });

    test("the shared Sheet (New webhook)", async ({ page }) => {
      await login(page);
      await page.goto("/settings/webhooks");
      const button = page.getByRole("button", { name: "New webhook" });
      await expect(button).toBeVisible();
      await showScrollbar(page, desktop);
      const heading = page.getByRole("heading", { level: 1 });
      const before = await left(heading);
      await button.click();
      await expect(page.getByRole("dialog", { name: "New webhook" })).toBeVisible();
      await expectCoversWindow(page.getByTestId("new-webhook-sheet").getByTestId("sheet-scrim"));
      expect(await left(heading), "the page does not jump").toBe(before);
    });

    test("the meeting's start sheet and the opened flow on a one-pager", async ({ page }) => {
      await page.context().addInitScript((key) => localStorage.removeItem(key), MOCK_SCENARIO_KEY);
      await login(page);
      await page.goto("/simple/prds/guided-setup");
      await expect(page.getByTestId("one-pager")).toBeVisible();
      await showScrollbar(page, desktop);
      await page.getByRole("button", { name: "Start review" }).click();
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      await expect(sheet).toBeVisible();
      await expectCoversWindow(page.getByTestId("start-backdrop"));
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toHaveCount(0);

      await page.getByRole("group", { name: "User flow of “A setup checklist that shows" }).getByTestId("flow-row").getByRole("button", { name: "Open the storyboard", exact: true }).click();
      await expect(page.getByTestId("flow-storyboard")).toBeVisible();
      await expectCoversWindow(page.getByTestId("flow-backdrop"));
    });
  });
}
