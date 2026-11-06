import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The Goal ladder (the owner's picks of Nov 6: "Free canvas", "Arrows for the picked card",
 * "Edit ladder toggle"), driven through the UI against the mock ("goal-ladder", invented data:
 * four goals, twelve milestones, 63 features, about 40 dependencies). Owner, commenter and
 * viewer; 1440, 1512 and 390; light and dark.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const SHOTS = process.env.LADDER_SHOTS;
const SIZES = { 1440: { width: 1440, height: 900 }, 1512: { width: 1512, height: 945 } } as const;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scheme: "light" | "dark", role?: "commenter" | "viewer") {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple");
  if (page.viewportSize()!.width <= 600) {
    await page.getByTestId("simple-tab-more").click();
    await page.getByTestId("simple-more-sheet").getByRole("link", { name: "Goal map" }).click();
  } else await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-page")).toBeVisible();
  if (page.viewportSize()!.width > 600) await expect(card(page, "F-03")).toBeVisible();
}

const card = (page: Page, code: string) => page.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: new RegExp(`^${code}$`) }) });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
/** Drags with the mouse in steps, as a person does. */
async function dragBy(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();
}
/** Scrolls the page until the whole canvas is on screen. */
const inView = (page: Page) => page.getByTestId("ld-canvas").evaluate((el) => el.scrollIntoView({ block: "nearest" }));
/** The part of the canvas on screen, above where toasts show. */
async function area(page: Page) {
  const c = (await page.getByTestId("ld-canvas").boundingBox())!;
  const top = Math.max(c.y, 0);
  return { x: c.x, y: top, width: c.width, height: Math.min(c.y + c.height, page.viewportSize()!.height - 100) - top };
}
/** Scrolls the canvas (the wheel or a trackpad over it) so its cards move dy down. */
async function pan(page: Page, dy: number) {
  const canvas = await area(page);
  await page.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, -dy);
  await page.waitForTimeout(50);
}
/** Pans the canvas until the card is in view, as a person does. */
async function reveal(page: Page, loc: ReturnType<Page["locator"]>) {
  await inView(page);
  const canvas = await area(page);
  for (let i = 0; i < 12; i++) {
    const b = (await loc.boundingBox())!;
    const dy = b.y + b.height / 2 - (canvas.y + canvas.height / 2);
    if (b.y >= canvas.y && b.y + b.height <= canvas.y + canvas.height) return;
    await pan(page, -dy);
  }
}
/** Zooms out until both cards fit in the canvas, then pans them into view. */
async function showBoth(page: Page, a: ReturnType<Page["locator"]>, b: ReturnType<Page["locator"]>) {
  await inView(page);
  const canvas = await area(page);
  for (let i = 0; i < 12; i++) {
    const [A, B] = [(await a.boundingBox())!, (await b.boundingBox())!];
    const top = Math.min(A.y, B.y);
    const bottom = Math.max(A.y + A.height, B.y + B.height);
    if (top >= canvas.y && bottom <= canvas.y + canvas.height) return;
    if (bottom - top > canvas.height - 40) {
      await page.getByRole("button", { name: "Zoom out" }).click();
      continue;
    }
    await pan(page, canvas.y + canvas.height / 2 - (top + bottom) / 2);
  }
}
/** The middle of an element already in view. */
async function mid(loc: ReturnType<Page["locator"]>) {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function centre(page: Page, loc: ReturnType<Page["locator"]>) {
  if (page.viewportSize()!.width > 600) await reveal(page, loc);
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1440, 1512] as const) {
    test.describe(`${width} ${scheme}`, () => {
      test.use({ viewport: SIZES[width] });

      test("at rest: the week strip, the guardrail, goals as columns with their milestones and work, counts but no arrows", async ({ page }) => {
        // protects=the picked layout (ld1-d-rest, ld2-a-rest, ld3-b-rest): We are here and each
        // milestone's week, goals in priority order, ←/→ counts, no arrows and no handles at rest;
        // fails_when=the grid by area comes back, arrows show at rest or the counts are wrong;
        // no_claim=pixel match (the compare page).
        await open(page, scheme);
        await expect(page.getByTestId("ld-here")).toHaveText("We are here");
        await expect(page.getByTestId("ld-week-mark").first()).toContainText("M1");
        await expect(page.getByTestId("gm-guardrail")).toContainText("Pages load in under 2 seconds");
        await expect(page.getByTestId("ld-goal")).toHaveText([/Goal 1Teams stay past their first year/, /Goal 2New teams set up in one day/, /Goal 3Larger teams add paid seats/, /Goal 4Half the support tickets per team/]);
        await expect(page.getByTestId("ld-milestone")).toHaveCount(12);
        await expect(page.getByTestId("ld-milestone").first()).toContainText("M1Weekly active teams baseline set");
        // F-03 waits on F-02, and three features wait on it.
        await expect(card(page, "F-03").getByTestId("ld-counts")).toHaveText("←13→");
        await expect(page.getByTestId("ld-arrow")).toHaveCount(0);
        await expect(page.getByTestId("ld-more")).toHaveCount(0);
        await expect(page.getByTestId("gm-ladder")).toHaveCount(0);
        await expect(page.getByTestId("ld-zoom-level")).toHaveText("72%");
        await expect(page.getByTestId("ld-edit")).toHaveText("Edit ladder");
        await shot(page, `ld1-d-rest-${width}-${scheme}`);
      });

      test("pick a card: its arrows light both ways, the rest dims; pick an arrow and remove it", async ({ page }) => {
        // protects=ld2-a-select, ld2-a-arrow, ld2-a-unlinked: picking F-03 draws F-02→F-03 and
        // F-03→F-04/F-05; picking an arrow says which waits on which with Remove, which unlinks
        // (set_depends) with Undo; fails_when=no arrows, or Remove leaves the link;
        // no_claim=the arrows' exact curves.
        await open(page, scheme);
        await reveal(page, card(page, "F-03"));
        await card(page, "F-03").click();
        await expect(page.getByTestId("ld-arrow")).toHaveCount(4);
        await expect(card(page, "F-01")).toHaveCSS("opacity", "1");
        await shot(page, `ld2-a-select-${width}-${scheme}`);
        const hit = page.locator('[data-testid="ld-arrow-hit"]').first();
        await hit.dispatchEvent("click");
        const pop = page.getByTestId("ld-arrow-pop");
        await expect(pop).toContainText("F-03 Renewal health score shown to account owners each Monday waits on F-02 Activity events pipeline");
        await shot(page, `ld2-a-arrow-${width}-${scheme}`);
        await pop.getByRole("button", { name: "Remove" }).click();
        await expect(page.getByRole("status").filter({ hasText: "no longer waits on" })).toContainText("F-03 Renewal health score shown to account owners each Monday no longer waits on F-02");
        await expect(card(page, "F-03").getByTestId("ld-counts")).toHaveText("3→");
        await shot(page, `ld2-a-unlinked-${width}-${scheme}`);
        await page.getByTestId("toasts").getByRole("button", { name: "Undo" }).click();
        await expect(card(page, "F-03").getByTestId("ld-counts")).toHaveText("←13→");
      });

      test("place a card by hand, reload, Fit, Tidy up", async ({ page }) => {
        // protects=ld1-d-placed: a card dragged outside Edit mode stays where this person put it
        // (place_card) after a reload, marked Placed by hand, its milestone unchanged; Fit and
        // zoom change the view; Tidy up puts it back; fails_when=the place is lost on reload,
        // or a drag changes the feature's milestone; no_claim=another person's view.
        await open(page, scheme);
        const c = card(page, "F-15");
        const before = (await c.boundingBox())!;
        const from = await centre(page, c);
        await dragBy(page, from, { x: from.x + 520, y: from.y - 260 });
        await expect(c.getByTestId("ld-placed")).toContainText("Placed by hand · serves M4 Setup time under two days");
        await expect(page.getByRole("status").filter({ hasText: "by hand" })).toContainText("Moved F-15");
        await shot(page, `ld1-d-placed-${width}-${scheme}`);
        await page.reload();
        await expect(card(page, "F-15").getByTestId("ld-placed")).toBeVisible();
        const after = (await card(page, "F-15").boundingBox())!;
        expect(after.x - before.x).toBeGreaterThan(300);
        await expect(page.locator('[data-ld-group] [data-ld-card]').filter({ hasText: "F-15" })).toHaveCount(1);
        await page.getByRole("button", { name: "Zoom in" }).click();
        await expect(page.getByTestId("ld-zoom-level")).toHaveText("82%");
        await page.getByTestId("ld-fit").click();
        await expect(page.getByTestId("ld-zoom-level")).not.toHaveText("82%");
        await page.getByTestId("ld-tidy").click();
        await expect(card(page, "F-15").getByTestId("ld-placed")).toHaveCount(0);
        await page.reload();
        await expect(card(page, "F-15")).toBeVisible();
        await expect(card(page, "F-15").getByTestId("ld-placed")).toHaveCount(0);
      });

      test("Edit ladder: handles show; draw a link from the dot; a loop is refused naming both", async ({ page }) => {
        // protects=ld3-b-edit, ld2-a-draw, ld2-a-linked, ld2-a-loop: Edit ladder shows menus,
        // + Add and reads Done; dragging from F-34's dot onto F-24 makes F-24 wait on F-34
        // (set_depends), with Undo; drawing F-04 onto F-02 is refused with the engine's reason
        // naming both by code and name; fails_when=no dot, the link is not made, or the loop is
        // made or refused without saying why; no_claim=links across PRDs.
        await open(page, scheme);
        await page.getByTestId("ld-edit").click();
        await expect(page.getByTestId("ld-edit")).toHaveText("Done");
        await expect(page.getByTestId("ld-add-milestone")).toHaveCount(4);
        await expect(page.getByTestId("ld-add-feature")).toHaveCount(12);
        await shot(page, `ld3-b-edit-${width}-${scheme}`);
        await reveal(page, card(page, "F-34"));
        await card(page, "F-34").click();
        const dot = card(page, "F-34").getByTestId("ld-dot");
        await showBoth(page, card(page, "F-34"), card(page, "F-24"));
        await dragBy(page, await mid(dot), await mid(card(page, "F-24")));
        await expect(page.getByRole("status").filter({ hasText: "now waits on" })).toContainText("F-24");
        await expect(page.getByRole("status").filter({ hasText: "now waits on" })).toContainText("now waits on F-34");
        await shot(page, `ld2-a-linked-${width}-${scheme}`);
        // F-04 waits on F-02: F-02 waiting on F-04 would be a loop.
        await reveal(page, card(page, "F-04"));
        await card(page, "F-04").click();
        await showBoth(page, card(page, "F-04"), card(page, "F-02"));
        await dragBy(page, await mid(card(page, "F-04").getByTestId("ld-dot")), await mid(card(page, "F-02")));
        await expect(page.getByRole("status").filter({ hasText: "loop" })).toContainText(/F-04 Saved views that follow a person across projects and devices already waits on F-02 Activity events pipeline/);
        await expect(page.getByTestId("ld-refused")).toHaveCount(1);
        await shot(page, `ld2-a-loop-${width}-${scheme}`);
      });

      test("Edit ladder: drag a feature to another milestone; menu Delete to Trash and Restore; + Add a feature", async ({ page }) => {
        // protects=ld3-b-drag, ld3-b-moved, ld3-b-menu, ld3-b-deleted, ld3-b-add, ld3-b-added:
        // dropped on M6's work, F-21 (last under M5) serves M6 (links/move) with Undo; Delete (to Trash) takes it
        // off the ladder and Settings › Trash restores it; + Add feature names one under M5;
        // fails_when=the drop only places the card, Delete removes it for good, or the new
        // feature is not under M5; no_claim=reorder within a list.
        await open(page, scheme);
        await page.getByTestId("ld-edit").click();
        const m6 = page.locator('[data-ld-group]').filter({ hasText: "M6 Setup time one day for new teams" }).first();
        await showBoth(page, card(page, "F-21"), m6.locator("span").first());
        await dragBy(page, await mid(card(page, "F-21")), await mid(m6.locator("span").first()));
        await expect(page.getByRole("status").filter({ hasText: "Moved F-21" })).toContainText("to M6 Setup time one day for new teams");
        await expect(m6.getByTestId("ld-feature").filter({ hasText: "F-21" })).toHaveCount(1);
        await shot(page, `ld3-b-moved-${width}-${scheme}`);
        await card(page, "F-21").getByTestId("ld-more").click();
        await expect(page.getByTestId("ld-feature-menu").getByRole("menuitem")).toHaveText(["Open", "Move to…", "Move up", "Move down", "Waits on…", "Delete (to Trash)"]);
        await shot(page, `ld3-b-menu-${width}-${scheme}`);
        await page.getByRole("menuitem", { name: "Delete (to Trash)" }).click();
        await expect(page.getByRole("status").filter({ hasText: "to Trash" })).toContainText("Moved F-21");
        await expect(card(page, "F-21")).toHaveCount(0);
        await shot(page, `ld3-b-deleted-${width}-${scheme}`);
        const m5 = page.locator('[data-ld-group]').filter({ hasText: "M5 Imports finish without help" }).first();
        await m5.getByTestId("ld-add-feature").click();
        await m5.getByRole("textbox").fill("Import from calendar tools with every date kept");
        await shot(page, `ld3-b-add-${width}-${scheme}`);
        await m5.getByRole("button", { name: "Add", exact: true }).click();
        await expect(m5.getByTestId("ld-feature").filter({ hasText: "Import from calendar tools with every date kept" })).toHaveCount(1);
        await shot(page, `ld3-b-added-${width}-${scheme}`);
        await page.goto("/settings/trash");
        const row = page.getByRole("listitem").filter({ hasText: "Undo a whole import" }).or(page.getByRole("row").filter({ hasText: "Undo a whole import" })).first();
        await row.getByRole("button", { name: /Restore/ }).click();
        await expect(page.getByRole("status").filter({ hasText: "Restored" })).toContainText("Undo a whole import");
        await page.goto("/simple/goals");
        await expect(card(page, "F-21")).toBeVisible();
      });

      test("a commenter suggests; a viewer reads", async ({ page, browser }) => {
        // protects=ld2-a-commenter, ld3-b-commenter, ld1-d-viewer, ld3-b-viewer: a commenter's
        // toggle reads Suggest changes, gets no + Add milestone, and a drawn link is a suggestion
        // sent to an approver; a viewer has Read only, no toggle and no Tidy up;
        // fails_when=a commenter changes the ladder directly or a viewer gets a handle;
        // no_claim=who approves.
        await open(page, scheme, "commenter");
        await expect(page.getByTestId("ld-edit")).toHaveText("Suggest changes");
        await page.getByTestId("ld-edit").click();
        await expect(page.getByTestId("ld-edit")).toHaveText("Done suggesting");
        await expect(page.getByTestId("ld-add-milestone")).toHaveCount(0);
        await reveal(page, card(page, "F-34"));
        await card(page, "F-34").click();
        await showBoth(page, card(page, "F-34"), card(page, "F-24"));
        await dragBy(page, await mid(card(page, "F-34").getByTestId("ld-dot")), await mid(card(page, "F-24")));
        await expect(page.getByRole("status").filter({ hasText: "Suggested" })).toContainText("Suggested: F-24");
        await expect(card(page, "F-24").getByTestId("ld-counts")).not.toContainText("←2");
        await shot(page, `ld2-a-commenter-${width}-${scheme}`);
        const ctx = await browser.newContext({ viewport: SIZES[width] });
        const viewer = await ctx.newPage();
        await open(viewer, scheme, "viewer");
        await expect(viewer.getByTestId("ld-read-only")).toHaveText("Read only");
        await expect(viewer.getByTestId("ld-edit")).toHaveCount(0);
        await expect(viewer.getByTestId("ld-tidy")).toHaveCount(0);
        await shot(viewer, `ld1-d-viewer-${width}-${scheme}`);
        await ctx.close();
      });
    });
  }

  test.describe(`phone ${scheme}`, () => {
    test.use(PHONE);

    test("Goal 3's measure row is whole on a phone", async ({ page }) => {
      // protects=ld1-a-phone's goal card; fails_when=the numbers or the pill wrap; no_claim=layout beside them.
      await open(page, scheme);
      await page.getByRole("tab", { name: "Goal 3" }).click();
      await expectMeasureRowWhole(page.getByTestId("ld-goal"));
    });

    test("one goal at a time; Edit ladder's Move to… opens a sheet", async ({ page }) => {
      // protects=ld1-a-phone, ld3-b-phone: no canvas on a phone, the goal picked from Goal 1 to
      // Goal 4 with its milestones and their features; while editing, no grips, and Move to…
      // moves F-15 to M6 from a sheet; fails_when=the canvas shows on a phone or Move to… does
      // nothing; no_claim=drag on a phone.
      await open(page, scheme);
      await expect(page.getByTestId("ld-phone")).toBeVisible();
      await expect(page.getByTestId("ld-canvas")).toHaveCount(0);
      await expect(page.getByTestId("ld-phone")).toContainText("We are here: week of Nov 2");
      await page.getByRole("tab", { name: "Goal 2" }).click();
      await expect(page.getByTestId("ld-goal")).toContainText("New teams set up in one day");
      await expect(page.getByTestId("ld-phone")).toContainText("next: M4 Setup time under two days, Nov 13");
      await shot(page, `ld1-a-phone-${scheme}`);
      await page.getByTestId("ld-edit").click();
      await card(page, "F-15").getByTestId("ld-more").click();
      await page.getByRole("menuitem", { name: "Move to…" }).click();
      const sheet = page.getByTestId("ld-move-sheet");
      await sheet.getByText("Setup time one day for new teams").click();
      await shot(page, `ld3-b-phone-${scheme}`);
      await sheet.getByTestId("ld-move-go").click();
      await expect(page.getByRole("status").filter({ hasText: "Moved F-15" })).toContainText("to M6");
      const m6 = page.locator("[data-ld-group]").filter({ hasText: "Setup time one day for new teams" });
      await expect(m6.getByTestId("ld-feature").filter({ hasText: "F-15" })).toHaveCount(1);
    });
  });
}

/** The goal card's measure row: its numbers and its status pill are each one line tall. */
async function expectMeasureRowWhole(goal: ReturnType<Page["locator"]>) {
  const row = goal.getByTestId("ld-goal-measure");
  const numbers = row.getByTestId("ld-goal-numbers");
  const pill = row.getByTestId("ld-goal-status");
  await expect(pill).toHaveText("Too early");
  const line = await numbers.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect((await numbers.boundingBox())!.height).toBeLessThanOrEqual(line + 1);
  expect((await pill.boundingBox())!.height).toBeLessThanOrEqual(line + 1);
  const card = (await goal.boundingBox())!;
  const right = (await pill.boundingBox())!;
  expect(right.x + right.width).toBeLessThanOrEqual(card.x + card.width);
}

/** The opacity a person sees on an element: its own times every ancestor's. */
const seenOpacity = (loc: ReturnType<Page["locator"]>) =>
  loc.evaluate((el) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  });

test.describe("visual QA fixes (L-1 to L-8), 1440 light", () => {
  test.use({ viewport: SIZES[1440] });

  test("L-1: a feature's menu is solid while another card is picked", async ({ page }) => {
    // protects=ld3-b-menu: the ⋯ menu of a card the pick dims is drawn solid and its card is not
    // dimmed; fails_when=the menu fades with its dimmed card; no_claim=menu position.
    await open(page, "light");
    await page.getByTestId("ld-edit").click();
    await reveal(page, card(page, "F-03"));
    await card(page, "F-03").click();
    await reveal(page, card(page, "F-01"));
    await card(page, "F-01").getByTestId("ld-more").click();
    const menu = page.getByTestId("ld-feature-menu");
    await expect(menu).toBeVisible();
    expect(await seenOpacity(menu)).toBe(1);
    expect(await seenOpacity(card(page, "F-01").locator(".simple-code"))).toBe(1);
  });

  test("L-2: the feature panel names the goal and milestone the ladder places it under", async ({ page }) => {
    // protects=ld1-d-rest + one feature panel: F-03 under M1 of Goal 1 opens with that goal and
    // milestone; fails_when=the panel says No goal yet; no_claim=changing the goal from there.
    await open(page, "light");
    await reveal(page, card(page, "F-03"));
    await card(page, "F-03").click();
    await card(page, "F-03").getByTestId("ld-open").click();
    const panel = page.getByTestId("gm-feature-panel");
    await expect(panel.getByTestId("card-goal")).toContainText("Teams stay past their first year");
    await expect(panel).toContainText("M1 Weekly active teams baseline set");
  });

  test("L-3: a commenter's suggested link shows on the card, and Undo takes it back", async ({ page }) => {
    // protects=ld2-a-commenter: the amber "Suggested: wait on F-34 …" line under F-24's dates
    // and Undo in the toast; fails_when=no mark on the card or no Undo; no_claim=the approver's side.
    await open(page, "light", "commenter");
    await page.getByTestId("ld-edit").click();
    await reveal(page, card(page, "F-34"));
    await card(page, "F-34").click();
    await showBoth(page, card(page, "F-34"), card(page, "F-24"));
    await dragBy(page, await mid(card(page, "F-34").getByTestId("ld-dot")), await mid(card(page, "F-24")));
    await expect(page.getByRole("status").filter({ hasText: "Suggested" })).toContainText("Suggested: F-24");
    await expect(card(page, "F-24").getByTestId("ld-suggested")).toHaveText("Suggested: wait on F-34 Cross-team reports for leaders of many departments");
    await page.getByTestId("toasts").getByRole("button", { name: "Undo" }).click();
    await expect(card(page, "F-24").getByTestId("ld-suggested")).toHaveCount(0);
  });

  test("L-4: the guardrail strip and goal cards carry only the frame's words", async ({ page }) => {
    // protects=ld1-d-rest, ld1-d-viewer: "Guardrail: … · Held N of 7 days" and goal cards without
    // the reading's source line; fails_when=the extra prose comes back; no_claim=the reading itself.
    await open(page, "light", "viewer");
    await expect(page.getByTestId("gm-guardrail")).toHaveText("Guardrail: Pages load in under 2 seconds for 95% of viewsHeld 7 of 7 days");
    // The reading's source sits behind the goal's (i), not in a line of its own.
    await expect(page.getByTestId("gm-goal-source").first()).toBeHidden();
  });

  test("compare page: flags beside the toggle, milestone status on its own line, undated work says No dates yet", async ({ page }) => {
    // protects=ld1-d-rest, ld3-b-rest: no flag row under Updated, "2.6 of 2 · by Nov 13 · Onboarding"
    // then the status, and "No dates yet" for work no one dated; fails_when=the extra row or the
    // window's estimate comes back; no_claim=status words the API does not have (Backlog).
    await open(page, "light");
    await expect(page.getByTestId("ld-actions").getByTestId("gm-flag-unplaced")).toBeVisible();
    const m4 = page.getByTestId("ld-milestone").filter({ hasText: "Setup time under two days" });
    await expect(m4).toContainText("2.6 of 2 · by Nov 13 · Onboarding");
    await expect(m4.getByTestId("ld-ms-status")).toHaveText("At risk");
    await expect(card(page, "F-21")).toContainText("No dates yet");
  });

  test("L-5: a refused loop names both cards as the frame does", async ({ page }) => {
    // protects=ld2-a-loop; fails_when=the engine's words show instead; no_claim=the Roadmap's words.
    await open(page, "light");
    await page.getByTestId("ld-edit").click();
    await reveal(page, card(page, "F-04"));
    await card(page, "F-04").click();
    await showBoth(page, card(page, "F-04"), card(page, "F-02"));
    await dragBy(page, await mid(card(page, "F-04").getByTestId("ld-dot")), await mid(card(page, "F-02")));
    await expect(page.getByRole("status").filter({ hasText: "loop" })).toHaveText(
      "Not added, it would make a loop: F-04 Saved views that follow a person across projects and devices already waits on F-02 Activity events pipeline with daily rollups for every workspace",
    );
    await expect(page.getByTestId("ld-refused")).toHaveCount(1);
  });

  test("L-7: Escape lets go of the menu, then the arrow, then the card", async ({ page }) => {
    // protects=ld2-a-arrow, ld3-b-menu; fails_when=Escape does nothing or drops all at once.
    await open(page, "light");
    await page.getByTestId("ld-edit").click();
    await reveal(page, card(page, "F-03"));
    await card(page, "F-03").click();
    await page.locator('[data-testid="ld-arrow-hit"]').first().dispatchEvent("click");
    await expect(page.getByTestId("ld-arrow-pop")).toBeVisible();
    await card(page, "F-03").getByTestId("ld-more").click();
    await expect(page.getByTestId("ld-feature-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ld-feature-menu")).toHaveCount(0);
    await expect(page.getByTestId("ld-arrow-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ld-arrow-pop")).toHaveCount(0);
    await expect(page.getByTestId("ld-arrow")).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ld-arrow")).toHaveCount(0);
  });

  test("L-8: picked arrows are 3 px on screen at any zoom; Fit stays at 85% or more", async ({ page }) => {
    // protects=ld2-a-select; fails_when=arrows thin out with the zoom or Fit goes below 85%.
    await open(page, "light");
    await reveal(page, card(page, "F-03"));
    await card(page, "F-03").click();
    const width = async () => Number(await page.getByTestId("ld-arrow").first().getAttribute("stroke-width"));
    const zoom = async () => Number((await page.getByTestId("ld-zoom-level").textContent())!.replace("%", "")) / 100;
    expect((await width()) * (await zoom())).toBeCloseTo(3, 1);
    await page.getByTestId("ld-fit").click();
    expect(await zoom()).toBeGreaterThanOrEqual(0.85);
    expect((await width()) * (await zoom())).toBeCloseTo(3, 1);
  });
});

test.describe("visual QA fixes, phone light", () => {
  test.use(PHONE);

  test("L-6: the guardrail is one line under the goal picker and the goal card starts high", async ({ page }) => {
    // protects=ld1-a-phone; fails_when=the strip wraps above the picker and pushes the ladder
    // down; no_claim=the exact line break.
    await open(page, "light");
    const line = page.getByTestId("ld-phone-guardrail");
    await expect(line).toContainText("Guardrail: Pages load in under 2 seconds");
    const tabs = (await page.getByRole("tablist").boundingBox())!;
    const g = (await line.boundingBox())!;
    expect(g.y).toBeGreaterThan(tabs.y);
    expect(g.height).toBeLessThan(30);
    expect((await page.getByTestId("ld-goal").boundingBox())!.y).toBeLessThan(360);
  });
});

test.describe("Goal ladder findings: numbers, first view, week captions, 1440", () => {
  test.use({ viewport: SIZES[1440] });

  test("numbers on the goal and milestone cards carry a thousands separator", async ({ page }) => {
    // protects=the rest of the app's "$11,200 of $20,000"; fails_when=a card prints "$11200 of
    // $20000" or "$10000"; no_claim=the guardrail's tooltip reading.
    await open(page, "light");
    await expect(page.getByTestId("ld-goal").filter({ hasText: "Larger teams add paid seats" })).toContainText("$11,200 of $20,000");
    const m7 = page.getByTestId("ld-milestone").filter({ hasText: "M7" });
    await expect(m7).toContainText("$10,000 of $10,000");
    await expect(page.getByTestId("ld-milestone").filter({ hasText: "M9" })).toContainText("— of $20,000");
    await expect(page.getByTestId("ld-goal").first()).toContainText("81% of 88%");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`Goal 3's measure row keeps its numbers on one line and its pill whole, ${scheme}`, async ({ page }) => {
      // protects=ld1-d-rest: "$11,200 of $20,000" and the status pill read whole on the 184 px
      // goal card; fails_when=the numbers wrap onto two lines or "Too early" breaks into two;
      // no_claim=whether the pill sits beside the numbers or under them.
      await open(page, scheme);
      await expectMeasureRowWhole(page.getByTestId("ld-goal").filter({ hasText: "Larger teams add paid seats" }));
    });
  }

  test("a short screen opens with the whole ladder in view, the strip above it still showing", async ({ page }) => {
    // protects=ld1-d-rest at 1440: the canvas is on screen when the page opens, not below the
    // fold where its own wheel-pan holds the page still; fails_when=the canvas ends below the
    // viewport (this run uses 1440 x 800, where the owner's fonts at 1440 x 900 also overflow);
    // no_claim=the exact scroll.
    await page.setViewportSize({ width: 1440, height: 800 });
    await open(page, "light");
    await expect(page.getByTestId("ld-zoom")).toBeVisible();
    const canvas = (await page.getByTestId("ld-canvas").boundingBox())!;
    expect(canvas.y).toBeGreaterThanOrEqual(0);
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(800);
    expect((await page.getByTestId("ld-periods").boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("ld-zoom")).toBeInViewport();
  });

  test("picking a card half out of the canvas brings it fully into view", async ({ page }) => {
    // protects=ld2-a-select: the picked card and its arrows are what the person looks at;
    // fails_when=the pick leaves the card under the canvas edge; no_claim=how far it moves.
    await open(page, "light");
    await reveal(page, card(page, "F-03"));
    const canvas = await area(page);
    const b = (await card(page, "F-03").boundingBox())!;
    // Pan until the card's top half sits under the canvas' bottom edge.
    await pan(page, canvas.y + canvas.height - 24 - b.y);
    const half = (await card(page, "F-03").boundingBox())!;
    expect(half.y + half.height).toBeGreaterThan(canvas.y + canvas.height);
    await page.mouse.click(half.x + half.width / 2, half.y + 8);
    await expect(page.getByTestId("ld-arrow").first()).toBeVisible();
    const after = (await card(page, "F-03").boundingBox())!;
    const box = (await page.getByTestId("ld-canvas").boundingBox())!;
    expect(after.y).toBeGreaterThanOrEqual(box.y);
    expect(after.y + after.height).toBeLessThanOrEqual(box.y + box.height);
  });

  test("V-6: the week strip's captions name the whole milestone and never end on a small word", async ({ page }) => {
    // protects=ld1-d-rest's strip: "M9 Seat revenue of $20,000" with the full name as its title;
    // fails_when=a caption is cut ("M9 Seat revenue of $20,000 per") with no way to read the rest;
    // no_claim=where the captions sit.
    await open(page, "light");
    const m2 = page.getByTestId("ld-week-mark").filter({ hasText: "M2 Renewal" });
    await expect(m2).toHaveAttribute("title", /M2 Renewal rate at 85% for spring renewals/);
    const m9 = page.getByTestId("ld-week-mark").filter({ hasText: "M9 Seat" });
    await expect(m9).toHaveText("M9 Seat revenue of $20,000");
    await expect(m9).toHaveAttribute("title", /M9 Seat revenue of \$20,000 per month/);
    // Wrapped, not clipped: no caption is wider than its box.
    for (const mark of await page.getByTestId("ld-week-mark").all()) {
      expect(await mark.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  });
});
