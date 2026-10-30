import { MOCK_COMPANY_NAME } from "../lib/api/mock/branding";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple S4 (#723), lane 2: the roadmap's Now / Next / Later board and waterfall phases,
 * the phone layout (the format switch, the card and the tray as sheets, long-press drag on
 * the board) and the exports of every format with its filters, driven through the UI
 * against the mock (web/lib/api/mock/simple-roadmap.ts, simple-changes.ts), on desktop and
 * phone, light and dark. Each test's card is in its comment.
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const FORMATS = ["timeline", "gantt", "board", "waterfall"] as const;

const card = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const column = (page: Page, h: "now" | "next" | "later"): Locator => page.locator(`[data-horizon-column="${h}"]`);
const phase = (page: Page, key: string, p: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"] [data-testid="phase"][data-phase="${p}"]`);

async function open(page: Page, format: (typeof FORMATS)[number], email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

/** Drags a board card with the mouse onto a column's header. */
async function dragTo(page: Page, key: string, to: "now" | "next" | "later") {
  const from = (await card(page, key).boundingBox())!;
  const target = (await column(page, to).locator("header").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** A phone's long press on a card, then a drag onto a column's header (a touch pointer). */
async function longPressTo(page: Page, key: string, to: "now" | "next" | "later") {
  const from = (await card(page, key).boundingBox())!;
  await column(page, to).locator("header").scrollIntoViewIfNeeded();
  const target = (await column(page, to).locator("header").boundingBox())!;
  const x = from.x + from.width / 2;
  const y = (await card(page, key).boundingBox())!.y + from.height / 2;
  const ev = { pointerId: 11, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
  await card(page, key).dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
  await expect(card(page, key)).toHaveAttribute("data-picked", "true");
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height / 2;
  for (let n = 1; n <= 8; n++) await card(page, key).dispatchEvent("pointermove", { ...ev, clientX: x + ((tx - x) * n) / 8, clientY: y + ((ty - y) * n) / 8 });
  await card(page, key).dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: tx, clientY: ty });
}

async function noSidewaysScroll(page: Page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      /**
       * Card simple-board-draws: protects = the Now / Next / Later board shows the same
       * items as the timeline in three columns by their horizon (each with its window and
       * count, with its years when not this year's), grouped by goal inside a column, estimated dates hatched, the draft dashed,
       * a broken link red with its reason, the cut item below the line; on a phone the
       * columns stack and the page never scrolls sideways; fails_when = an item sits in the
       * wrong column, a column or group is missing, or a phone scrolls sideways; no_claim =
       * the look of the cards.
       */
      test("the Now / Next / Later board", async ({ page }) => {
        await open(page, "board");
        await expect(page.getByTestId("board-column")).toHaveCount(3);
        for (const k of ["alert-rules", "alert-digest", "setup-checklist"]) await expect(column(page, "now").locator(`[data-item="${k}"]`)).toBeVisible();
        for (const k of ["alert-export", "alert-sso", "setup-ideas"]) await expect(column(page, "next").locator(`[data-item="${k}"]`)).toBeVisible();
        await expect(column(page, "later").locator('[data-item="setup-video"]')).toBeVisible();
        await expect(column(page, "now").getByTestId("board-group").first()).toContainText(/Grow retention|Faster activation/);
        await expect(card(page, "alert-sso")).toHaveAttribute("data-kind", "estimated");
        await expect(card(page, "alert-sso").getByTestId("board-dates")).toContainText("estimated");
        await expect(card(page, "setup-ideas")).toHaveAttribute("data-kind", "draft");
        await expect(card(page, "alert-digest")).toHaveAttribute("data-broken", "true");
        await expect(card(page, "alert-digest").getByTestId("board-broken")).toContainText("which it depends on, ends");
        await expect(column(page, "later").getByTestId("board-below")).toContainText("In-app tour");
        // A window or span outside this year names its years.
        await expect(column(page, "later").locator("header")).toContainText(/, 20\d\d – .*, 20\d\d/);
        await expect(card(page, "setup-video").getByTestId("board-dates")).toContainText(/20\d\d/);
        await expect(page.getByTestId("legend")).toContainText("Drag a card to another column");
        if (where === "phone") {
          const now = (await column(page, "now").boundingBox())!;
          const next = (await column(page, "next").boundingBox())!;
          expect(next.y).toBeGreaterThanOrEqual(now.y + now.height - 1);
          await noSidewaysScroll(page);
        }
        await card(page, "alert-rules").click();
        const sheet = page.getByTestId("floating-card");
        await expect(sheet.getByRole("heading", { name: "Alert rules engine" })).toBeVisible();
        await expect(sheet).toHaveAttribute("data-sheet", where === "phone" ? "bottom" : "float");
      });

      /**
       * Card simple-waterfall-draws: protects = the waterfall draws each item as its four
       * phases (discover · build · beta · launch) from the API; a phase a milestone or
       * validation gate dates is solid, the others hatched (estimated), an undated item's
       * phases all hatched, with the phases' key; a click (no drag) opens the card and moves
       * nothing (the drag itself: simple-roadmap-plus.spec.ts); fails_when = a phase is
       * missing, a dated phase draws hatched or an estimated one solid, or a click writes a
       * change; no_claim = the split's arithmetic (api/tests for oracle.simple.dates.phases).
       */
      test("the waterfall phases", async ({ page }) => {
        await open(page, "waterfall");
        await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "waterfall");
        for (const p of ["discover", "build", "beta", "launch"]) await expect(phase(page, "alert-rules", p)).toBeAttached();
        await expect(phase(page, "alert-rules", "discover")).toHaveAttribute("data-estimated", "false");
        await expect(phase(page, "alert-rules", "build")).toHaveAttribute("data-estimated", "false");
        await expect(phase(page, "alert-rules", "beta")).toHaveAttribute("data-estimated", "true");
        await expect(phase(page, "alert-digest", "beta")).toHaveAttribute("data-estimated", "false");
        await expect(phase(page, "setup-checklist", "beta")).toHaveAttribute("data-estimated", "false");
        for (const p of ["discover", "build", "beta", "launch"]) await expect(phase(page, "alert-sso", p)).toHaveAttribute("data-estimated", "true");
        await expect(phase(page, "alert-sso", "build")).toHaveAttribute("fill", "url(#simple-hatch-build)");
        await expect(page.getByTestId("phase-key")).toHaveCount(4);
        const bar = page.locator('g[data-testid="bar"][data-item="alert-export"]');
        await expect(bar).toHaveAttribute("data-phased", "true");
        const before = await bar.getAttribute("data-start");
        await bar.locator("rect[data-body]").click();
        await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Alert history export" })).toBeVisible();
        await expect(bar).toHaveAttribute("data-start", before!);
        if (where === "phone") await noSidewaysScroll(page);
      });

      /**
       * Card simple-roadmap-export-formats: protects = D20: every format (timeline, Gantt,
       * board, waterfall) exports as a PNG and a one-page PDF of the view on screen, framed
       * with the company's branding and a line naming its filters (a goal filter reads in
       * it); fails_when = a format cannot export, the file is not a PNG / PDF, or the
       * header lacks the company or the filters; no_claim = the picture's pixels.
       */
      test("every format exports as PNG and PDF, branded, with its filters", async ({ page }) => {
        await open(page, "timeline");
        await page.getByLabel("Goal").selectOption("faster-activation");
        await expect(page.locator('g[data-testid="bar"][data-item="alert-rules"]')).toHaveCount(0);
        await page.evaluate(() => (window.__poExports = []));
        for (const f of FORMATS) {
          await page.getByTestId(`format-${f}`).click();
          await expect(page.getByTestId(f === "board" ? "board" : "simple-chart")).toBeVisible();
          const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export PNG" }).click()]);
          expect(png.suggestedFilename()).toBe(`roadmap-${f}.png`);
          expect(Buffer.concat(await (await png.createReadStream()).toArray()).subarray(1, 4).toString()).toBe("PNG");
          const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export PDF" }).click()]);
          expect(pdf.suggestedFilename()).toBe(`roadmap-${f}.pdf`);
          const bytes = Buffer.concat(await (await pdf.createReadStream()).toArray());
          expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
          expect(bytes.toString("latin1")).toContain("/Count 1");
        }
        const drawn = await page.evaluate(() => window.__poExports ?? []);
        expect(drawn.map((d) => `${d.kind}:${d.title}`)).toEqual([
          "png:Roadmap · Timeline",
          "pdf:Roadmap · Timeline",
          "png:Roadmap · Gantt (week)",
          "pdf:Roadmap · Gantt (week)",
          "png:Roadmap · Now / Next / Later",
          "pdf:Roadmap · Now / Next / Later",
          "png:Roadmap · Waterfall",
          "pdf:Roadmap · Waterfall",
        ]);
        for (const d of drawn) {
          expect(d.brand).toBe(MOCK_COMPANY_NAME);
          expect(d.filters).toBe("Grouped by goal · Goal: Faster activation");
        }
      });
    });
  }
}

/**
 * Card simple-board-drag-owner: protects = an owner drags a card from Next to Now: a
 * change_horizon change applies into the working draft (toast with Undo, the banner counts
 * it, the card moves column), and Undo puts it back; fails_when = the drop writes nothing,
 * skips the engine, or Undo leaves it in Now; no_claim = the API's engine
 * (api/tests/test_simple_changes_api.py).
 */
test("an owner drags a board card to another horizon, with Undo", async ({ page }) => {
  await open(page, "board");
  await dragTo(page, "alert-export", "now");
  await expect(page.getByText("Moved 'Alert history export' to Now in your working draft")).toBeVisible();
  await expect(column(page, "now").locator('[data-item="alert-export"]')).toBeVisible();
  await expect(page.getByTestId("draft-count")).toHaveText("1");
  await page.getByTestId("draft-banner").getByRole("button", { name: "See changes" }).click();
  await expect(page.getByTestId("draft-changes")).toContainText("horizon");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
});

/**
 * Card simple-board-drag-propose: protects = a commenter's drop on another column is a
 * proposal: the card stays where the published roadmap has it, saying where it was
 * proposed to go, and the owner accepts it from the tray's "Pulled in" list, after which
 * the card moves; fails_when = a commenter's drop applies, or the proposal is not in the
 * tray; no_claim = routing to a named decider (simple-deciders.spec).
 */
test("a commenter's board move is a proposal the owner accepts", async ({ page }) => {
  await page.context().addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
  await open(page, "board", "commenter@example.com");
  await dragTo(page, "alert-export", "now");
  await expect(page.getByText(/^Moved 'Alert history export' to Now proposed: it waits for .+ in Needs a decision$/)).toBeVisible();
  await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
  await expect(card(page, "alert-export").getByTestId("board-pending")).toContainText("Proposed by Commenter: move to Now");
  await page.goto("/home");
  await signOut(page);
  await open(page, "board");
  await page.getByTestId("needs-decision").click();
  const tray = page.getByTestId("decision-tray");
  await tray.getByTestId("tray-proposal").filter({ hasText: "Alert history export" }).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
  await tray.getByRole("button", { name: "Close" }).click();
  await expect(column(page, "now").locator('[data-item="alert-export"]')).toBeVisible();
});

/**
 * Card simple-board-viewer: protects = a viewer reads the board (a card opens the
 * floating card) but a drag moves nothing; fails_when = a viewer's drag sends a change;
 * no_claim = the API's 403 (its tests).
 */
test("a viewer reads the board and cannot move a card", async ({ page }) => {
  await open(page, "board", "viewer@example.com");
  await dragTo(page, "alert-export", "now");
  await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
  await card(page, "alert-export").click();
  await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Alert history export" })).toBeVisible();
});

/**
 * Card simple-board-keyboard: protects = a focused card moves to the next or previous
 * column with the arrow keys, through the change engine; fails_when = the keyboard cannot
 * change a horizon; no_claim = the API's engine.
 */
test("the keyboard moves a board card between horizons", async ({ page }) => {
  await open(page, "board");
  await card(page, "alert-export").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Moved 'Alert history export' to Later in your working draft")).toBeVisible();
  await expect(column(page, "later").locator('[data-item="alert-export"]')).toBeVisible();
});

/**
 * Card simple-board-keyboard-desktop (#723 review): protects = on a desktop only the left
 * and right arrows move a focused card (up and down still scroll the page), and the card
 * keeps the focus in its new column so the next arrow moves it again; fails_when = ArrowDown
 * moves a card on a desktop, or the focus is lost after a move; no_claim = the engine.
 */
test("on a desktop the up and down arrows do not move a card, and it keeps the focus", async ({ page }) => {
  await open(page, "board");
  await card(page, "alert-export").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(500);
  await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(column(page, "later").locator('[data-item="alert-export"]')).toBeVisible();
  await expect(card(page, "alert-export")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
});

/**
 * Card simple-waterfall-phase-inside (#723 review): protects = a phase a gate dates after
 * the item's end is drawn inside the bar's outline (its dates stay in its title); fails_when
 * = a phase's rectangle reaches past the bar; no_claim = the API's split.
 */
test("a phase dated after the bar's end stays inside the bar", async ({ page }) => {
  await open(page, "waterfall");
  await expect(phase(page, "setup-import", "beta")).toHaveAttribute("data-estimated", "false");
  const bar = page.locator('g[data-testid="bar"][data-item="setup-import"]');
  const body = (await bar.locator("rect[data-body]").boundingBox())!;
  for (const p of ["discover", "build", "beta", "launch"]) {
    const r = (await phase(page, "setup-import", p).boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(body.x - 1);
    expect(r.x + r.width).toBeLessThanOrEqual(body.x + body.width + 1);
  }
});

test.describe("phone", () => {
  test.use(PHONE);

  /**
   * Card simple-board-touch-cancel (#723 review): protects = a touch drag the system
   * cancels (pointercancel) moves nothing, even after the card was dragged over another
   * column; fails_when = a cancelled drag writes a change; no_claim = the browser's gestures.
   */
  test("a cancelled touch drag moves nothing", async ({ page }) => {
    await open(page, "board");
    const from = (await card(page, "alert-export").boundingBox())!;
    const target = (await column(page, "now").locator("header").boundingBox())!;
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    const ev = { pointerId: 12, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
    await card(page, "alert-export").dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
    await expect(card(page, "alert-export")).toHaveAttribute("data-picked", "true");
    for (let n = 1; n <= 6; n++) await card(page, "alert-export").dispatchEvent("pointermove", { ...ev, clientX: x, clientY: y + ((target.y + 10 - y) * n) / 6 });
    await expect(column(page, "now")).toHaveAttribute("data-drop-target", "true");
    await card(page, "alert-export").dispatchEvent("pointercancel", { ...ev, buttons: 0, clientX: x, clientY: target.y + 10 });
    await expect(column(page, "now")).not.toHaveAttribute("data-drop-target", "true");
    await page.waitForTimeout(300);
    await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
    await expect(page.getByTestId("draft-banner")).toHaveCount(0);
  });

  /**
   * Card simple-board-phone-reach (#723 review): protects = on a phone a picked-up card
   * held at the screen's edge scrolls the page, so a column off the screen can be reached,
   * and the floating card moves an item to another horizon without dragging; fails_when =
   * the page stays put under a held card, or the card has no horizon control; no_claim =
   * the scrolling speed.
   */
  test("a held card scrolls the page, and the card moves a horizon", async ({ page }) => {
    await open(page, "board");
    await card(page, "setup-video").scrollIntoViewIfNeeded();
    await expect(column(page, "now").locator("header")).not.toBeInViewport();
    const from = (await card(page, "setup-video").boundingBox())!;
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    const ev = { pointerId: 13, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
    await card(page, "setup-video").dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
    await expect(card(page, "setup-video")).toHaveAttribute("data-picked", "true");
    for (let n = 1; n <= 6; n++) await card(page, "setup-video").dispatchEvent("pointermove", { ...ev, clientX: x, clientY: y + ((8 - y) * n) / 6 });
    await expect(column(page, "now").locator("header")).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const target = (await column(page, "now").locator("header").boundingBox())!;
    await card(page, "setup-video").dispatchEvent("pointermove", { ...ev, clientX: x, clientY: target.y + target.height / 2 });
    await card(page, "setup-video").dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x, clientY: target.y + target.height / 2 });
    await expect(page.getByText("Moved 'Welcome video' to Now in your working draft")).toBeVisible();
    await expect(column(page, "now").locator('[data-item="setup-video"]')).toBeVisible();

    await card(page, "alert-export").tap();
    const sheet = page.getByTestId("floating-card");
    await expect(sheet.getByTestId("card-horizon")).toBeVisible();
    await sheet.getByTestId("card-horizon").getByRole("button", { name: "Later" }).tap();
    await expect(page.getByText("Moved 'Alert history export' to Later in your working draft")).toBeVisible();
    await expect(column(page, "later").locator('[data-item="alert-export"]')).toBeVisible();
    await noSidewaysScroll(page);
  });

  /**
   * Card simple-roadmap-narrow-switch (#723 review): protects = on a 320 px phone the
   * format switch shows all four formats without scrolling sideways; fails_when = a format
   * is cut off or the switch scrolls; no_claim = its look.
   */
  test("the format switch fits a 320 px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, "timeline");
    const group = page.getByTestId("format-switch").getByRole("group");
    const { sw, cw } = await group.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw);
    for (const f of FORMATS) {
      const b = (await page.getByTestId(`format-${f}`).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(320);
    }
    await noSidewaysScroll(page);
  });

  /**
   * Card simple-board-long-press: protects = on a phone a long press picks a board card
   * up (its cue) and dragging it onto another (stacked) column changes its horizon
   * through the change engine; fails_when = a touch drag does nothing; no_claim = native
   * scrolling during the press.
   */
  test("a long press drags a board card on a phone", async ({ page }) => {
    await open(page, "board");
    await longPressTo(page, "alert-export", "now");
    await expect(page.getByText("Moved 'Alert history export' to Now in your working draft")).toBeVisible();
    await expect(column(page, "now").locator('[data-item="alert-export"]')).toBeVisible();
    await noSidewaysScroll(page);
  });

  /**
   * Card simple-roadmap-phone-sheets: protects = on a phone the format switch is a
   * segmented control on its own row, inside the screen, whose four formats all switch
   * the view; the decision tray opens as a bottom sheet; fails_when = the switch spills
   * off the screen, a format cannot be picked, or the tray covers the screen as a page;
   * no_claim = the sheets' animation.
   */
  test("the format switch and the tray as a sheet", async ({ page }) => {
    await open(page, "timeline");
    const sw = (await page.getByTestId("format-switch").boundingBox())!;
    expect(sw.x).toBeGreaterThanOrEqual(0);
    expect(sw.x + sw.width).toBeLessThanOrEqual(391);
    for (const f of FORMATS) {
      await page.getByTestId(`format-${f}`).click();
      await expect(page.getByTestId(`format-${f}`)).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByTestId("needs-decision").click();
    const tray = page.getByTestId("decision-tray");
    await expect(tray).toHaveAttribute("data-sheet", "bottom");
    const t = (await tray.boundingBox())!;
    expect(Math.round(t.y + t.height)).toBeGreaterThanOrEqual(843);
    expect(t.y).toBeGreaterThan(0);
    await noSidewaysScroll(page);
  });
});
