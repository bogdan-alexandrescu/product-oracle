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
  // A Mac draws the styled scrollbar only on a page that scrolls (a short one, like Webhooks, keeps
  // its overlay scrollbar and no room), so the page is made a little taller than the window.
  if (desktop) await page.addStyleTag({ content: "html { min-height: calc(100vh + 200px); }" });
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

      await page.getByRole("group", { name: "User flow of “A setup checklist that shows" }).getByTestId("flow-row").getByRole("button", { name: desktop ? "Open the storyboard" : "Open the flow", exact: true }).click();
      // A desktop dims the page behind the storyboard; a phone opens the flow as a full-window sheet.
      if (desktop) {
        await expect(page.getByTestId("flow-storyboard")).toBeVisible();
        await expectCoversWindow(page.getByTestId("flow-backdrop"));
      } else await expectCoversWindow(page.getByTestId("flow-detail"));
    });
  });
}

/*
 * The backdrop-gutter review's findings. protects = a margin note's flow dialog dims the whole
 * window; the scrollbar's room is right when the Ask panel's backdrop is in the page but not
 * shown, and when a page opens with a backdrop already up; a toast over a dialog keeps to the
 * page's width. fails_when = an undimmed strip at the right, or the page moves when the Ask
 * panel closes, or the toasts reach under where the scrollbar was.
 */
test.describe("desktop: the review's cases", () => {
  test.use({ viewport: DESKTOP });

  const ask = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });
  const pageWidth = async (page: Page) => (await page.locator("main#main").boundingBox())!.width;

  test("a margin note's flow dialog covers the whole window", async ({ page }) => {
    await page.context().addInitScript((key) => localStorage.removeItem(key), MOCK_SCENARIO_KEY);
    await login(page);
    await page.goto("/simple/one-pagers/guided-setup");
    await expect(page.getByTestId("one-pager")).toBeVisible();
    await showScrollbar(page, true);
    const bet = page.locator('[data-line="bets-1"]');
    await bet.hover();
    await bet.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
    await page.getByLabel("New wording for").fill("A setup checklist that shows the next two steps");
    await page.getByRole("button", { name: "Save" }).click();
    const note = page.getByRole("complementary", { name: "Changes and proposals" }).getByRole("note").first();
    await note.getByRole("button", { name: /^Flow for/ }).click();
    await expect(page.getByRole("dialog", { name: "User flow" })).toBeVisible();
    await expectCoversWindow(page.getByTestId("note-flow-backdrop").filter({ visible: true }));
  });

  test("the scrollbar's room follows a change while the Ask panel is docked", async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 900 });
    await login(page);
    await page.goto("/requests");
    await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
    await page.getByTestId("hop-strip").click();
    await expect(ask(page)).toBeVisible();
    // The scrollbar widens (as with a zoom) while the panel sits beside the page.
    await page.addStyleTag({ content: SCROLLBAR.replace(/15px/g, "24px") });
    await expect.poll(() => page.evaluate(() => window.innerWidth - document.documentElement.getBoundingClientRect().width)).toBe(24);
    // Narrower, the panel dims the page (it sits over the page's right); closing it, the page does not move.
    await page.setViewportSize({ width: 1500, height: 900 });
    await expect(page.getByTestId("hop-backdrop")).toBeVisible();
    const open = await pageWidth(page);
    await page.keyboard.press("Escape");
    await expect(ask(page)).toHaveCount(0);
    expect(await pageWidth(page), "the page does not jump").toBe(open);
  });

  test("a page that opens with a dialog up keeps the scrollbar's room", async ({ page }) => {
    // The scrollbar is styled from the first paint, so it is there before the page is.
    await page.context().addInitScript((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.documentElement.appendChild(style);
    }, SCROLLBAR);
    await login(page);
    await page.goto("/company/decisions?propose=1");
    const dialog = page.getByRole("dialog", { name: "Propose decision" });
    await expect(dialog).toBeVisible();
    const open = await pageWidth(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await pageWidth(page), "the page does not jump").toBe(open);
  });

  test("the toasts keep to the page's width over a dialog", async ({ page }) => {
    await login(page);
    await page.goto("/requests");
    await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
    await showScrollbar(page, true);
    // Where a toast shows: the strip it centres in.
    const strip = () => page.getByTestId("toasts").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, w: r.width }; });
    const before = await strip();
    await page.getByRole("button", { name: "New request" }).first().click();
    await expect(page.getByRole("dialog", { name: "New request" })).toBeVisible();
    await expect.poll(strip).toEqual(before);
  });
});
