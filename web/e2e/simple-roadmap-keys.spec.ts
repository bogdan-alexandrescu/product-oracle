import { MOCK_SLOW_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple S4 (#723) re-review, train T: keyboard moves send ONE change per burst. Arrow
 * presses on a focused bar or board card move it locally and coalesce into one change sent
 * when the person pauses (about 600 ms) or the bar loses focus, with `before` = the stored
 * dates at the burst's first press; Escape before the send cancels it. Driven through the
 * UI against the mock, on desktop and phone (its keyboard), light and dark. Run with
 * --repeat-each=5 to show they are not flaky. Each test's card is in its comment.
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const card = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const column = (page: Page, h: "now" | "next" | "later"): Locator => page.locator(`[data-horizon-column="${h}"]`);
const plus = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Opens the roadmap; on a phone, its Gantt: the phone's Timeline (timeline-overlap B3) draws thin lanes with no bars to focus. */
async function open(page: Page, email?: string, phone = false) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  if (phone) await page.getByTestId("format-gantt").click();
  await expect(bar(page, "alert-export")).toBeVisible();
}

async function board(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
}

/** The change engine's answers come late (MOCK_SLOW_MS): a change is on its way while the person goes on. */
const slowChanges = (page: Page) => page.evaluate((k) => localStorage.setItem(k, "POST /v1/simple/changes"), MOCK_SLOW_KEY);

/**
 * Counts each bar's renders by its item's key (window.__poBarRenders): a React DevTools
 * hook sees every commit, and a bar rendered again holds a new props object.
 */
function countBarRenders(page: Page) {
  return page.addInitScript(() => {
    type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedProps: unknown };
    const w = window as unknown as { __poBarRenders: Record<string, number>; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    const renders: Record<string, number> = (w.__poBarRenders = {});
    const seen = new Map<string, unknown>();
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        const stack: Fiber[] = [root.current];
        while (stack.length) {
          const f = stack.pop()!;
          const p = f.memoizedProps as { item?: { key: string }; onKeyCancel?: unknown; phased?: unknown; unit?: unknown } | null;
          // A chart's bar (memo(Bar): it has `phased`) or a lane's pill (timeline-overlap B2, memo(Pill): it has `unit`).
          if (p && typeof p === "object" && p.item && "onKeyCancel" in p && ("phased" in p || "unit" in p) && seen.get(p.item.key) !== p) {
            seen.set(p.item.key, p);
            renders[p.item.key] = (renders[p.item.key] ?? 0) + 1;
          }
          if (f.sibling) stack.push(f.sibling);
          if (f.child) stack.push(f.child);
        }
      },
    };
  });
}

/** The 409's words: a burst never meets its own earlier move. */
const conflict = (page: Page) => page.getByText(/Changed since you saw it/);

/** The proposals listed on an item's floating card (opened from the keyboard, closed after). */
async function proposalsOn(page: Page, b: Locator): Promise<number> {
  await b.focus();
  await page.keyboard.press("Enter");
  const fc = page.getByTestId("floating-card");
  await expect(fc).toBeVisible();
  const n = await fc.getByTestId("card-proposals").locator("li").count();
  await fc.getByRole("button", { name: "Close" }).first().click();
  await expect(fc).toHaveCount(0);
  return n;
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      /**
       * Card simple-keys-burst: protects = a decider's two quick arrow presses on a bar move
       * it two weeks at once, the screen reader hears the pending dates, and ONE move_dates
       * change is sent when they pause (the draft counts 1); it never 409s and the bar does
       * not snap back; a second burst after that change returns builds on its result (2
       * changes, no 409); fails_when = each press sends its own change (the second 409s with
       * "Changed since you saw it" and the bar returns), or the burst sends with a stale
       * `before`; no_claim = the API's engine (api/tests/test_simple_changes_api.py).
       */
      test("two quick presses are one change, no 409, no snap back", async ({ page }) => {
        await open(page, undefined, where === "phone");
        const b = bar(page, "alert-export");
        const start = (await b.getAttribute("data-start"))!;
        const end = (await b.getAttribute("data-end"))!;
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(1200);
        await expect(conflict(page)).toHaveCount(0);
        await expect(b).toHaveAttribute("data-start", plus(start, 14));
        await expect(b).toHaveAttribute("data-end", plus(end, 14));
        await expect(page.getByText(/Moved 'Alert history export'.*in your working draft/)).toBeVisible();
        await expect(page.getByTestId("draft-count")).toHaveText("1");
        // A second burst builds on the first one's result.
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByTestId("draft-count")).toHaveText("2");
        await page.waitForTimeout(800);
        await expect(conflict(page)).toHaveCount(0);
        await expect(b).toHaveAttribute("data-start", plus(start, 21));
      });

      /**
       * Card simple-keys-pending-words: protects = while a burst waits, the screen reader
       * hears the bar's pending dates and that they are not sent yet; fails_when = the
       * presses are silent until the change returns; no_claim = the toast's words.
       */
      test("the screen reader hears the pending dates", async ({ page }) => {
        await open(page, undefined, where === "phone");
        const b = bar(page, "alert-export");
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByTestId("key-pending")).toContainText("Alert history export");
        await expect(page.getByTestId("key-pending")).toContainText("not sent yet");
      });

      /**
       * Card simple-keys-commenter: protects = a commenter holding an arrow key files ONE
       * proposal for the whole burst (the bar keeps its published dates once it is sent);
       * fails_when = every press (or key repeat) files its own proposal; no_claim = who
       * decides it (simple-roadmap.spec's tray test).
       */
      test("a commenter's held key is one proposal", async ({ page }) => {
        await open(page, "commenter@example.com", where === "phone");
        const b = bar(page, "alert-export");
        const start = (await b.getAttribute("data-start"))!;
        const had = await proposalsOn(page, b);
        await b.focus();
        await page.keyboard.down("ArrowRight");
        for (let n = 0; n < 5; n++) await page.keyboard.down("ArrowRight");
        await page.keyboard.up("ArrowRight");
        await expect(page.getByText(/proposed: it waits for the decider/)).toBeVisible();
        await page.waitForTimeout(800);
        await expect(b).toHaveAttribute("data-start", start);
        expect(await proposalsOn(page, b)).toBe(had + 1);
      });

      /**
       * Card simple-keys-escape: protects = Escape before the pause cancels the burst: the
       * bar returns to its stored dates and nothing is sent; fails_when = the presses were
       * sent already or the bar stays moved; no_claim = Undo after a send (simple-roadmap.spec).
       */
      test("Escape cancels the burst", async ({ page }) => {
        await open(page, undefined, where === "phone");
        const b = bar(page, "alert-export");
        const start = (await b.getAttribute("data-start"))!;
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect(b).toHaveAttribute("data-start", plus(start, 14));
        await page.keyboard.press("Escape");
        await expect(b).toHaveAttribute("data-start", start);
        await expect(page.getByTestId("key-pending")).toContainText("cancelled");
        await page.waitForTimeout(1200);
        await expect(page.getByTestId("draft-banner")).toHaveCount(0);
        await expect(page.getByText(/Moved 'Alert history export'/)).toHaveCount(0);
        await expect(b).toHaveAttribute("data-start", start);
      });

      /**
       * Card simple-keys-resize: protects = Shift+arrow presses (the resize keys) coalesce
       * the same way: two presses move the end two weeks in one change; fails_when = each
       * press sends (a 409 or two changes); no_claim = the drag's resize handles.
       */
      test("resize keys are one change too", async ({ page }) => {
        await open(page, undefined, where === "phone");
        const b = bar(page, "alert-export");
        const start = (await b.getAttribute("data-start"))!;
        const end = (await b.getAttribute("data-end"))!;
        await b.focus();
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        await expect(page.getByText(/Moved 'Alert history export'.*in your working draft/)).toBeVisible();
        await expect(page.getByTestId("draft-count")).toHaveText("1");
        await page.waitForTimeout(800);
        await expect(conflict(page)).toHaveCount(0);
        await expect(b).toHaveAttribute("data-end", plus(end, 14));
        await expect(b).toHaveAttribute("data-start", start);
      });

      /**
       * Card simple-keys-blur: protects = moving the focus away ends the burst at once (the
       * change is sent without waiting for the pause: a press right after coming back,
       * well inside the pause, is a second change, not part of the first burst);
       * fails_when = a blurred burst waits for the pause, is lost or never sent, or each
       * press sends at once; no_claim = the pause's exact length.
       */
      test("leaving the bar sends the burst", async ({ page }) => {
        await open(page, undefined, where === "phone");
        const b = bar(page, "alert-export");
        const start = (await b.getAttribute("data-start"))!;
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByTestId("key-pending")).toContainText("not sent yet");
        await expect(page.getByTestId("draft-banner")).toHaveCount(0);
        await page.getByTestId("format-switch").getByTestId("format-timeline").focus();
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByTestId("draft-count")).toHaveText("2");
        await expect(conflict(page)).toHaveCount(0);
        await expect(b).toHaveAttribute("data-start", plus(start, 14));
      });

      /**
       * Card simple-keys-overlap: protects = on a slow network, a burst sent while the
       * previous one's change is still on its way keeps the bar at its own pending dates when
       * that earlier change returns (no transient snap back to the earlier burst's dates),
       * then lands as the second change; fails_when = the earlier change's return clears the
       * pending dates and the bar falls back until the later one returns; no_claim = how
       * late the network is.
       */
      test("a burst sent while the last is on its way does not snap back", async ({ page }) => {
        await open(page, undefined, where === "phone");
        await slowChanges(page);
        const b = bar(page, "alert-export");
        const start = (await b.getAttribute("data-start"))!;
        const away = page.getByTestId("format-switch").getByTestId("format-timeline");
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await away.focus();
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await away.focus();
        await expect(b).toHaveAttribute("data-start", plus(start, 14));
        // The first burst's change returns (its toast); the second is still on its way.
        await expect(page.getByText(/Moved 'Alert history export'/).first()).toBeVisible({ timeout: 4000 });
        for (let n = 0; n < 6; n++) {
          expect(await b.getAttribute("data-start")).toBe(plus(start, 14));
          await page.waitForTimeout(100);
        }
        await expect(page.getByTestId("draft-count")).toHaveText("2", { timeout: 5000 });
        await expect(conflict(page)).toHaveCount(0);
        await expect(b).toHaveAttribute("data-start", plus(start, 14));
      });

      /**
       * Card simple-keys-failed-chain: protects = when the change on its way fails (here: the
       * bar was moved in another tab, so it meets a 409), a burst begun meanwhile takes its
       * `before` from the reload that followed, not from what was stored at its press, and
       * lands; fails_when = the second burst sends the dates from before the reload and 409s
       * too (the bar ends at the other tab's dates); no_claim = the first change's 409.
       */
      test("a burst after a failed change starts from the reload", async ({ page, context }) => {
        await open(page, undefined, where === "phone");
        const other = await context.newPage();
        await other.goto(URL);
        if (where === "phone") await other.getByTestId("format-gantt").click();
        await expect(bar(other, "alert-export")).toBeVisible();
        const start = (await bar(page, "alert-export").getAttribute("data-start"))!;
        // The other tab moves the bar a week earlier; this tab has not reloaded.
        await bar(other, "alert-export").focus();
        await other.keyboard.press("ArrowLeft");
        await other.getByTestId("format-switch").getByTestId("format-timeline").focus();
        await expect(other.getByText(/Moved 'Alert history export'/)).toBeVisible();
        await other.close();
        await slowChanges(page);
        const b = bar(page, "alert-export");
        const away = page.getByTestId("format-switch").getByTestId("format-timeline");
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await away.focus();
        await b.focus();
        await page.keyboard.press("ArrowRight");
        await away.focus();
        await expect(conflict(page)).toBeVisible({ timeout: 4000 });
        await expect(page.getByText(/Moved 'Alert history export'.*in your working draft/)).toBeVisible({ timeout: 5000 });
        await expect(b).toHaveAttribute("data-start", plus(start, 14));
      });

      /**
       * Card simple-keys-renders: protects = an arrow press redraws only the pressed bar (the
       * other bars' handlers stay the same, so memo(Bar) keeps them); fails_when = every bar
       * renders again on each press (inline handlers); no_claim = the drag's frames
       * (simple-roadmap-perf).
       */
      test("a press redraws only the pressed bar", async ({ page }) => {
        await countBarRenders(page);
        await open(page, undefined, where === "phone");
        await page.waitForTimeout(300);
        const before = await page.evaluate(() => ({ ...(window as unknown as { __poBarRenders: Record<string, number> }).__poBarRenders }));
        expect(Object.keys(before).length).toBeGreaterThan(1);
        await bar(page, "alert-export").focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByTestId("key-pending")).toContainText("not sent yet");
        const after = await page.evaluate(() => ({ ...(window as unknown as { __poBarRenders: Record<string, number> }).__poBarRenders }));
        expect(after["alert-export"]).toBeGreaterThan(before["alert-export"]);
        expect(Object.keys(after).filter((k) => k !== "alert-export" && after[k] !== before[k])).toEqual([]);
      });

      /**
       * Card simple-keys-board: protects = on the Now / Next / Later board a card's arrow
       * presses move it locally (keeping the focus) and send ONE change_horizon for the
       * burst: Now→Next→Later is one change; Right then Left sends nothing; fails_when = each
       * press sends its own change (a stale `before` or two changes), or a round trip writes;
       * no_claim = the board's drag (simple-roadmap-formats.spec).
       */
      test("board: a burst of arrows is one horizon change", async ({ page }) => {
        await board(page);
        const c = card(page, "alert-rules");
        await c.focus();
        const right = where === "phone" ? "ArrowDown" : "ArrowRight";
        const left = where === "phone" ? "ArrowUp" : "ArrowLeft";
        await page.keyboard.press(right);
        await page.keyboard.press(right);
        await expect(column(page, "later").locator('[data-item="alert-rules"]')).toBeVisible();
        await expect(card(page, "alert-rules")).toBeFocused();
        await expect(page.getByText("Moved 'Alert rules engine' to Later in your working draft")).toBeVisible();
        await expect(page.getByTestId("draft-count")).toHaveText("1");
        await page.waitForTimeout(800);
        await expect(conflict(page)).toHaveCount(0);
        await expect(column(page, "later").locator('[data-item="alert-rules"]')).toBeVisible();
        // There and back in one burst: nothing to send.
        const e = card(page, "alert-export");
        await e.focus();
        await page.keyboard.press(right);
        await page.keyboard.press(left);
        await page.waitForTimeout(1200);
        await expect(page.getByTestId("draft-count")).toHaveText("1");
        await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
      });

      /**
       * Card simple-keys-board-commenter: protects = a commenter's burst on a board card is
       * one proposal (the card shows it pending once); fails_when = each press proposes;
       * no_claim = the decider's tray.
       */
      test("board: a commenter's burst is one proposal", async ({ page }) => {
        await board(page, "commenter@example.com");
        const c = card(page, "alert-rules");
        await c.focus();
        const right = where === "phone" ? "ArrowDown" : "ArrowRight";
        await page.keyboard.press(right);
        await page.keyboard.press(right);
        await expect(page.getByText(/proposed: it waits for the decider/)).toBeVisible();
        await page.waitForTimeout(800);
        await expect(column(page, "now").locator('[data-item="alert-rules"]')).toBeVisible();
        await expect(card(page, "alert-rules").getByTestId("board-pending")).toHaveText(/Proposed: move to Later/);
        // A phone reads the proposal on the Gantt's bar (its Timeline, timeline-overlap B3, has none).
        await page.getByTestId(where === "phone" ? "format-gantt" : "format-timeline").click();
        expect(await proposalsOn(page, bar(page, "alert-rules"))).toBe(1);
      });
    });
  }
}

test.describe("phone, long-press", () => {
  test.use(PHONE);

  /**
   * Card simple-keys-long-press: protects = the phone's long-press drag is still exactly
   * one change (the draft counts 1, no 409) next to the keyboard's bursts; fails_when = the
   * drag sends per move or meets a pending burst's stale dates; no_claim = native scrolling.
   */
  test("a long-press drag is one change", async ({ page }) => {
    await open(page, undefined, true);
    const body = bar(page, "alert-export").locator("rect[data-body]");
    const box = (await body.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const ev = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1, clientY: y };
    const before = await bar(page, "alert-export").getAttribute("data-start");
    await bar(page, "alert-export").dispatchEvent("pointerdown", { ...ev, clientX: x });
    await page.waitForTimeout(650);
    const svg = page.getByTestId("chart-svg");
    for (let n = 1; n <= 8; n++) await svg.dispatchEvent("pointermove", { ...ev, clientX: x + (60 * n) / 8 });
    await svg.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + 60 });
    await expect(page.getByText(/Moved 'Alert history export'/)).toBeVisible();
    await expect(page.getByTestId("draft-count")).toHaveText("1");
    await page.waitForTimeout(800);
    await expect(conflict(page)).toHaveCount(0);
    await expect(bar(page, "alert-export")).not.toHaveAttribute("data-start", before!);
  });
});
