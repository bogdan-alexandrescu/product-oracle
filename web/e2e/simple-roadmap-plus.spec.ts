import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple roadmap-plus (#723): the waterfall's drag (the whole item moves through the change
 * engine; estimated phases are worked out again, dated gates stay), a roadmap's key dates
 * (the header's editor, markers on the timeline, Gantt and waterfall, the card's "Near"
 * line) and the line on priorities (This quarter · a key date · a dated milestone · Pick a
 * date; hollow marks and a divider row; the URL and the person's preference), driven
 * through the UI against the mock (web/lib/api/mock/simple-roadmap.ts, simple-changes.ts,
 * simple-priorities.ts) on desktop (1366x820) and phone (390x844), light and dark, as an
 * owner, a commenter and a viewer. The mock's day is Oct 22, 2026: this quarter starts Oct
 * 1; "Alert rules engine" runs Oct 1 - Nov 10 with dated discover (Oct 7) and build (Oct 29)
 * gates; the Alerts roadmap's key date "Customer conference" is Nov 14, the Onboarding
 * roadmap's "Board meeting" Dec 15. Each test's card is in its comment.
 */

const ROADMAP = "/simple/roadmap";
const PRIORITIES = "/simple/priorities";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const body = (page: Page, key: string): Locator => bar(page, key).locator("rect[data-body]");
const phase = (page: Page, key: string, p: string): Locator => bar(page, key).locator(`[data-testid="phase"][data-phase="${p}"]`);
const marker = (page: Page, name: string): Locator => page.locator(`g[data-testid="key-date-marker"][data-name="${name}"]`);
const editor = (page: Page): Locator => page.getByTestId("key-dates-editor");

async function openRoadmap(page: Page, format: "timeline" | "gantt" | "waterfall", email?: string) {
  await login(page, email);
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", format);
}

/** A mouse drag of a bar by `dx` pixels from its middle. */
async function mouseDrag(page: Page, key: string, dx: number) {
  await body(page, key).scrollIntoViewIfNeeded();
  const box = (await body(page, key).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

/** A phone's long press on a bar, then a drag by `dx` (a touch pointer's events). */
async function longPressDrag(page: Page, key: string, dx: number) {
  await body(page, key).scrollIntoViewIfNeeded();
  const box = (await body(page, key).boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  const ev = { pointerId: 9, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1, clientY: y };
  await bar(page, key).dispatchEvent("pointerdown", { ...ev, clientX: x });
  await expect(bar(page, key)).toHaveAttribute("data-picked", "true");
  const svg = page.getByTestId("chart-svg");
  for (let n = 1; n <= 8; n++) await svg.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 8 });
  await svg.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + dx });
}

const days = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      /**
       * Card roadmap-plus-waterfall-drag: protects = on the waterfall an owner drags a phased
       * bar (the mouse on a desktop, a long press on a phone) and the whole item moves: one
       * move_dates change into the working draft with Undo, both ends shifted by the same
       * days, the estimated phases worked out again over the new span while the phases a
       * dated gate ends stay on the gate's day; the legend says so; Undo puts it back;
       * fails_when = the waterfall is read-only, a drag stretches one end, a dated gate
       * moves with the bar, the change skips the engine or Undo leaves the dates; no_claim =
       * the phase split's arithmetic (api/tests/test_simple_key_dates_api.py and
       * test_simple_dates.py).
       */
      test("an owner drags a phased bar on the waterfall, with Undo", async ({ page }) => {
        await openRoadmap(page, "waterfall");
        await expect(page.getByTestId("legend")).toContainText("a dated gate stays on its day");
        await expect(page.getByTestId("legend")).toContainText(where === "phone" ? "press and hold first" : "drag a bar");
        const start = (await bar(page, "alert-rules").getAttribute("data-start"))!;
        const end = (await bar(page, "alert-rules").getAttribute("data-end"))!;
        const discover = await phase(page, "alert-rules", "discover").getAttribute("data-end");
        const build = await phase(page, "alert-rules", "build").getAttribute("data-end");
        const launch = await phase(page, "alert-rules", "launch").getAttribute("data-end");
        if (where === "phone") await longPressDrag(page, "alert-rules", 40);
        else await mouseDrag(page, "alert-rules", 120);
        await expect(page.getByText(/Moved 'Alert rules engine' to .* in your working draft/)).toBeVisible();
        await expect(bar(page, "alert-rules")).not.toHaveAttribute("data-start", start);
        const start2 = (await bar(page, "alert-rules").getAttribute("data-start"))!;
        const end2 = (await bar(page, "alert-rules").getAttribute("data-end"))!;
        expect(days(start, start2)).toBeGreaterThan(0);
        expect(days(end, end2)).toBe(days(start, start2));
        // Dated gates stay; the estimated launch phase is worked out again (it ends with the bar).
        await expect(phase(page, "alert-rules", "discover")).toHaveAttribute("data-end", discover!);
        await expect(phase(page, "alert-rules", "build")).toHaveAttribute("data-end", build!);
        await expect(phase(page, "alert-rules", "launch")).toHaveAttribute("data-end", end2);
        expect(end2).not.toBe(launch);
        await page.getByRole("button", { name: "Undo" }).first().click();
        await expect(bar(page, "alert-rules")).toHaveAttribute("data-start", start);
        await expect(bar(page, "alert-rules")).toHaveAttribute("data-end", end);
      });

      /**
       * Card roadmap-plus-waterfall-keyboard: protects = the waterfall's keyboard drag: an
       * arrow on a focused bar moves the whole item a week (Shift+arrow too: no end-only
       * stretch here), one change per key press; a commenter's move is a proposal and the
       * bar stays; fails_when = the keyboard cannot move a phased bar, Shift stretches it,
       * or a commenter's move applies; no_claim = the Gantt's day step.
       */
      test("the keyboard moves the whole item; a commenter proposes", async ({ page }) => {
        await openRoadmap(page, "waterfall");
        const start = (await bar(page, "alert-rules").getAttribute("data-start"))!;
        const end = (await bar(page, "alert-rules").getAttribute("data-end"))!;
        await bar(page, "alert-rules").focus();
        await page.keyboard.press("Shift+ArrowRight");
        await expect(page.getByText(/Moved 'Alert rules engine'.* in your working draft/)).toBeVisible();
        await expect(bar(page, "alert-rules")).toHaveAttribute("data-start", new Date(Date.parse(start) + 7 * 86_400_000).toISOString().slice(0, 10));
        await expect(bar(page, "alert-rules")).toHaveAttribute("data-end", new Date(Date.parse(end) + 7 * 86_400_000).toISOString().slice(0, 10));
        await page.goto("/home");
        await openRoadmap(page, "waterfall", COMMENTER);
        const c0 = (await bar(page, "alert-export").getAttribute("data-start"))!;
        await bar(page, "alert-export").focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.getByText(/proposed: it waits for the decider/)).toBeVisible();
        await expect(bar(page, "alert-export")).toHaveAttribute("data-start", c0);
      });

      /**
       * Card roadmap-plus-key-dates-markers: protects = a roadmap's key dates show as
       * labelled markers (a diamond and a thin line) on the timeline, the Gantt and the
       * waterfall, and an item's card says "Near" a key date when it ends within 2 weeks of
       * it (Alert rules engine ends 4 days before the Customer conference) and not otherwise;
       * fails_when = a format lacks the markers, the label is missing, or the near line is
       * wrong or shown for a far item; no_claim = the markers' pixels.
       */
      test("key dates draw on every dated format and in the card's near line", async ({ page }) => {
        await openRoadmap(page, "timeline", VIEWER);
        for (const f of ["timeline", "gantt", "waterfall"] as const) {
          await page.getByTestId(`format-${f}`).click();
          await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
          await expect(marker(page, "Customer conference")).toHaveAttribute("data-date", "2026-11-14");
          await expect(marker(page, "Board meeting")).toHaveAttribute("data-date", "2026-12-15");
          await expect(marker(page, "Customer conference").getByTestId("key-date-label")).toHaveText("Customer conference");
          await expect(marker(page, "Customer conference").locator("line")).toHaveCount(1);
        }
        await expect(page.getByTestId("legend")).toContainText("a key date");
        await page.getByTestId("format-timeline").click();
        await body(page, "alert-rules").click();
        await expect(page.getByTestId("card-near")).toHaveText("Customer conference (Nov 14): ends 4 days before");
        await page.getByTestId("floating-card").getByRole("button", { name: "Close" }).click();
        await body(page, "alert-sso").click();
        await expect(page.getByTestId("floating-card")).toBeVisible();
        await expect(page.getByTestId("card-near")).toHaveCount(0);
      });

      /**
       * Card roadmap-plus-key-dates-owner: protects = an owner opens the header's Key dates
       * editor and adds, edits and removes key dates: each an applied change into the working
       * draft (toast with Undo; the marker shows "in the draft"), and Undo reverses one step;
       * fails_when = the editor writes without the engine, a change does not reach the chart,
       * or Undo does not put the key date back; no_claim = publishing on approval (API tests).
       */
      test("an owner adds, edits and removes key dates, with Undo", async ({ page }) => {
        await openRoadmap(page, "timeline");
        await page.getByTestId("key-dates-open").click();
        await expect(editor(page)).toHaveAttribute("data-sheet", where === "phone" ? "bottom" : "float");
        await expect(page.getByTestId("key-dates-hint")).toContainText("working draft");
        await editor(page).getByLabel("Roadmap").selectOption({ label: "Alerts roadmap" });
        await editor(page).getByLabel("New key date's name").fill("Partner summit");
        await editor(page).getByLabel("New key date's day").fill("2026-12-02");
        await editor(page).getByLabel("New key date's note").fill("Booth for alerts");
        await editor(page).getByRole("button", { name: "Add" }).click();
        await expect(page.getByText("Added the key date 'Partner summit' in your working draft")).toBeVisible();
        await expect(marker(page, "Partner summit")).toHaveAttribute("data-draft", "true");
        await expect(editor(page).locator('[data-testid="key-date-row"][data-name="Partner summit"]').getByTestId("key-date-in-draft")).toBeVisible();
        await editor(page).getByRole("button", { name: "Edit Customer conference" }).click();
        await editor(page).getByLabel("Date", { exact: true }).fill("2026-11-18");
        await editor(page).getByRole("button", { name: "Save" }).click();
        await expect(page.getByText(/Changed the key date 'Customer conference' in your working draft/)).toBeVisible();
        await expect(marker(page, "Customer conference")).toHaveAttribute("data-date", "2026-11-18");
        await editor(page).getByRole("button", { name: "Remove Partner summit" }).click();
        await expect(page.getByText(/Removed the key date 'Partner summit'/)).toBeVisible();
        await expect(marker(page, "Partner summit")).toHaveCount(0);
        await page.getByRole("button", { name: "Undo" }).first().click();
        await expect(marker(page, "Partner summit")).toHaveCount(1);
        await expect(page.getByTestId("key-dates-open")).toContainText("3");
      });

      /**
       * Card roadmap-plus-key-dates-roles: protects = a commenter's key-date change is a
       * proposal (nothing moves on the chart; the editor says the decider decides), the
       * owner accepts it from "Needs a decision" and the marker appears; a viewer's editor
       * only reads (no Add, Edit or Remove); fails_when = a commenter's change applies, a
       * viewer can edit, or an accepted proposal does not reach the chart; no_claim = the
       * routing to a named decider (API tests).
       */
      test("a commenter proposes a key date, the owner accepts; a viewer reads", async ({ page }) => {
        await openRoadmap(page, "gantt", COMMENTER);
        await page.getByTestId("key-dates-open").click();
        await expect(page.getByTestId("key-dates-hint")).toContainText("proposals");
        await editor(page).getByLabel("Roadmap").selectOption({ label: "Onboarding roadmap" });
        await editor(page).getByLabel("New key date's name").fill("Product launch");
        await editor(page).getByLabel("New key date's day").fill("2026-12-08");
        await editor(page).getByRole("button", { name: "Propose" }).click();
        await expect(page.getByText(/Added the key date 'Product launch' proposed: it waits for the decider/)).toBeVisible();
        await expect(marker(page, "Product launch")).toHaveCount(0);
        await page.goto("/home");
        await openRoadmap(page, "gantt");
        await page.getByTestId("needs-decision").click();
        const row = page.getByTestId("tray-proposal").filter({ hasText: "Key date 'Product launch'" });
        await row.getByRole("button", { name: "Accept" }).click();
        await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
        await expect(marker(page, "Product launch")).toHaveAttribute("data-date", "2026-12-08");
        await page.goto("/home");
        await openRoadmap(page, "waterfall", VIEWER);
        await page.getByTestId("key-dates-open").click();
        await expect(page.getByTestId("key-dates-hint")).toContainText("you read them");
        await expect(editor(page).getByTestId("key-date-add")).toHaveCount(0);
        await expect(editor(page).getByRole("button", { name: /^(Edit|Remove) / })).toHaveCount(0);
        await expect(editor(page).getByTestId("key-date-row").first()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(editor(page)).toHaveCount(0);
      });

      /**
       * Card roadmap-plus-priorities-line: protects = on Priorities the line is this
       * quarter's plan by default (a divider row names who falls below, hollow marks);
       * the Line picker offers each key date and each dated milestone and Pick a date; a
       * pick redraws the line (above = planned to finish by that day, by each row's end),
       * shows in the URL and is remembered for the person (opening Priorities again brings
       * it back); the 2x2 draws below-the-line marks hollow; fails_when = the default is not
       * Now, a pick does not redraw, the URL or the preference loses it, or a row's mark
       * disagrees with its end; no_claim = the ranking itself (API tests).
       */
      test("the line picker on the ranked list and the 2x2", async ({ page }) => {
        await login(page, VIEWER);
        await page.goto(PRIORITIES);
        await expect(page.getByTestId("simple-priorities")).toBeVisible();
        const select = page.getByTestId("line-picker").getByLabel("Line");
        await expect(select).toHaveValue("now");
        await expect(page.getByTestId("line-divider").first()).toContainText("The line: This quarter (Now)");
        const options = await select.locator("option").allTextContents();
        expect(options).toEqual(expect.arrayContaining([expect.stringMatching(/^Key date: Customer conference · Nov 14, 2026$/), expect.stringMatching(/^Milestone: Beta · /), "Pick a date…"]));
        const kd = (await select.locator("option", { hasText: "Customer conference" }).getAttribute("value"))!;
        await select.selectOption(kd);
        await expect(page).toHaveURL(new RegExp(`line=${encodeURIComponent(kd).replace(/%3A/i, "(:|%3A)")}`));
        await expect(page.getByTestId("line-divider").first()).toContainText("Customer conference · Nov 14, 2026");
        const rows = page.locator('[data-testid="prio-row"]');
        await expect(rows.first()).toBeVisible();
        for (const r of await rows.all()) {
          const end = await r.getAttribute("data-end");
          const above = await r.getAttribute("data-above");
          expect(above, `${await r.getAttribute("data-code")} ends ${end}`).toBe(end && end <= "2026-11-14" ? "true" : "false");
        }
        // Remembered: Priorities opened again without the URL's line brings it back.
        await page.goto("/home");
        await page.goto(PRIORITIES);
        await expect(page).toHaveURL(/line=key_date/);
        await expect(select).toHaveValue(kd);
        await select.selectOption("pick");
        await page.getByLabel("The line's date").fill("2026-12-31");
        await expect(page).toHaveURL(/line=date(:|%3A)2026-12-31/);
        await expect(page.getByTestId("line-divider").first()).toContainText("By Dec 31, 2026");
        await page.getByRole("tab", { name: "Value / effort" }).click();
        const points = page.getByTestId("vxe-point");
        await expect(points.first()).toBeVisible();
        expect(await page.locator('[data-testid="vxe-point"][data-above="false"]').count()).toBeGreaterThan(0);
        await expect(page.getByLabel("Legend")).toContainText("not planned to finish by Dec 31, 2026");
        await expect(page.getByTestId("line-divider")).toHaveCount(1);
        await select.selectOption("now");
        await expect(page).not.toHaveURL(/line=/);
      });
    });
  }
}
