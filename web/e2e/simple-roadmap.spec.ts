import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple S4 (#723), lane 1: the roadmap screen at /simple/roadmap (direction "A · Wall"):
 * the timeline and the Gantt, the floating card, the decision tray and drag, driven
 * through the UI against the mock (web/lib/api/mock/simple-roadmap.ts, simple-changes.ts),
 * on desktop and phone, light and dark. Each test's card is in its comment.
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const body = (page: Page, key: string): Locator => bar(page, key).locator("rect[data-body]");

/** Opens the roadmap's Timeline (`gantt`: its Gantt, whose bars a phone long-presses: the phone's Timeline, timeline-overlap B3, draws thin lanes with no bars). */
async function open(page: Page, email?: string, gantt = false) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  if (gantt) await page.getByTestId("format-gantt").click();
  if (gantt || page.viewportSize()!.width > 640) await expect(bar(page, "alert-rules")).toBeVisible();
  else await expect(page.getByTestId("phone-lane").first()).toBeVisible();
}

/** B3: a phone opens a lane, then a piece's row in its list (the card opens as a sheet). */
async function openFromLane(page: Page, laneTitle: string, key: string) {
  await page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: laneTitle }) }).click();
  await page.locator(`[data-testid="lane-row"][data-item="${key}"]`).click();
}

/** Drags a bar by `dx` pixels with the mouse, from its middle (a move, not a resize). */
async function drag(page: Page, key: string, dx: number, steps = 12) {
  // The bar in view first (the chart's header grows a row per crowded mark: roadmap-milestones).
  await body(page, key).scrollIntoViewIfNeeded();
  const box = (await body(page, key).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps });
  await page.mouse.up();
}

/** A phone's long press, then a drag by `dx` (pointer events of a touch pointer). */
async function longPressDrag(page: Page, key: string, dx: number) {
  const box = (await body(page, key).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const ev = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1, clientY: y };
  await bar(page, key).dispatchEvent("pointerdown", { ...ev, clientX: x });
  await page.waitForTimeout(650);
  const svg = page.getByTestId("chart-svg");
  for (let n = 1; n <= 8; n++) await svg.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 8 });
  await svg.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + dx });
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
       * Card simple-roadmap-draws: protects = the timeline (timeline-overlap B2: goal lanes)
       * draws every item as a pill in its goal's lane with the lane's count, dated solid,
       * estimated hatched, the draft dashed, Oracle's suggestion as a dotted outline, a broken
       * dependency red with its callout, an accepted risk amber, the milestone diamonds,
       * today's line, the cut item below the line with its place, the goal counters with
       * their metrics and the four format tabs; a phone (B3) draws a thin lane per goal and
       * lists the open lane's pieces; fails_when = any of them is missing or the page scrolls
       * sideways on a phone; no_claim = pixel-exact drawing.
       */
      test("the timeline draws the roadmap", async ({ page }) => {
        await open(page);
        if (where === "desktop") {
          await expect(bar(page, "alert-rules")).toHaveAttribute("data-kind", "dated");
          await expect(bar(page, "alert-sso")).toHaveAttribute("data-kind", "estimated");
          await expect(bar(page, "setup-ideas")).toHaveAttribute("data-kind", "draft");
          await expect(page.locator('[data-testid="suggestion-outline"][data-item="alert-sso"]')).toBeVisible();
          await expect(bar(page, "alert-digest")).toHaveAttribute("data-broken", "true");
          await expect(page.locator('[data-testid="dep-arrow"][data-from="alert-rules"][data-to="alert-digest"]')).toHaveAttribute("data-state", "red");
          await expect(page.locator('[data-testid="dep-arrow"][data-from="setup-checklist"][data-to="setup-import"]')).toHaveAttribute("data-state", "amber");
          await expect(page.locator('[data-testid="broken-callout"][data-item="alert-digest"]')).toContainText("which it depends on, ends");
          await expect(page.getByTestId("item-milestone").first()).toBeAttached();
          await expect(page.getByTestId("below-the-line")).toBeVisible();
          // fix4 qa-simple-roadmap-3: the return queue's place is on hover ("1st to come back"), not a "#1" on the bar.
          await expect(page.locator('[data-testid="bar"][data-place="1"] title').first()).toContainText("1st to come back");
          // B2: the lanes name their goal and count their items.
          await expect(page.getByTestId("chart-group").filter({ hasText: "Grow retention" }).getByTestId("lane-count")).toHaveText("4 items");
          expect(await bar(page, "alert-digest").getAttribute("data-lane")).toBe(await page.getByTestId("chart-group").filter({ hasText: "Grow retention" }).getAttribute("data-lane"));
        } else {
          // B3: a thin lane per goal (and below the line), the open lane's pieces listed under the chart.
          await expect(page.getByTestId("phone-lane").filter({ hasText: "Grow retention" }).getByTestId("lane-count")).toHaveText("4 items");
          await expect(page.getByTestId("phone-lane").filter({ hasText: "Below the line" })).toHaveCount(1);
          await expect(page.getByTestId("lane-list").getByTestId("lane-row").first()).toBeVisible();
        }
        await expect(page.getByTestId("track-milestone")).toHaveCount(1);
        await expect(page.getByTestId("today-line")).toBeAttached();
        await expect(page.getByTestId("goal-counter")).toHaveCount(2);
        await expect(page.getByTestId("goal-counters")).toContainText("Teams active after 90 days");
        for (const t of ["timeline", "gantt", "board", "waterfall"]) await expect(page.getByTestId(`format-${t}`)).toBeVisible();
        await expect(page.getByTestId("format-timeline")).toHaveAttribute("aria-pressed", "true");
        if (where === "phone") await noSidewaysScroll(page);
      });

      /**
       * Card simple-roadmap-card: protects = clicking a bar opens D8's floating card by the
       * bar (a bottom sheet on a phone) with the outcome, owner, dates and their source,
       * status, dependencies both ways, top reasons, open decisions, proposals and "Open
       * the detailed view"; fails_when = the card is docked, a field is missing or the
       * link reads otherwise; no_claim = the reasons' wording (the API's test).
       */
      test("a bar opens the floating card", async ({ page }) => {
        await open(page);
        // A phone's Timeline (B3) opens it from the lane's list.
        if (where === "phone") await openFromLane(page, "Grow retention", "alert-digest");
        else await bar(page, "alert-digest").click();
        const card = page.getByTestId("floating-card");
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute("data-sheet", where === "phone" ? "bottom" : "float");
        await expect(card.getByRole("heading", { name: "Weekly alert digest" })).toBeVisible();
        await expect(card.getByTestId("card-owner")).toHaveText("No owner yet");
        await expect(card.getByTestId("card-dates")).toContainText("accepted");
        await expect(card.getByTestId("card-depends")).toHaveText("Alert rules engine");
        await expect(card.getByTestId("card-reasons")).toContainText("Serves the goal Grow retention.");
        await expect(card.getByTestId("card-decisions")).toContainText("Send the digest weekly or daily?");
        await expect(card.getByTestId("card-flags")).toContainText("which it depends on, ends");
        await expect(card.getByRole("link", { name: "Open the detailed view" })).toHaveAttribute("href", /^\/plan\?item=alert-digest&prd=[0-9a-f-]{36}$/);
        // The owner's pick C: a desktop card's foot has Talk to Oracle; a phone's sheet has it as a tab.
        await expect(card.getByRole(where === "phone" ? "tab" : "button", { name: "Talk to Oracle" })).toBeVisible();
        if (where === "desktop") {
          const c = (await card.boundingBox())!;
          const b = (await body(page, "alert-digest").boundingBox())!;
          expect(Math.abs(c.y - (b.y + b.height))).toBeLessThan(24);
        }
        await card.getByRole("button", { name: "Close" }).click();
        await expect(card).toHaveCount(0);
      });
    });
  }
}

/**
 * Card simple-roadmap-drag-owner: protects = an owner drags a bar to new dates: a
 * move_dates change applies into the working draft (toast with Undo, the banner counts it,
 * the bar draws at its new dates, solid and typed), and Undo puts it back; fails_when = the
 * drag writes nothing, skips the engine, or Undo leaves the dates; no_claim = the API's
 * engine (api/tests/test_simple_changes_api.py).
 */
test("an owner drags a bar: applied, with Undo", async ({ page }) => {
  await open(page);
  const before = await bar(page, "alert-export").getAttribute("data-start");
  await drag(page, "alert-export", 90);
  await expect(page.getByText(/Moved 'Alert history export' to .* in your working draft/)).toBeVisible();
  await expect(page.getByTestId("draft-banner")).toContainText("Your working draft");
  await expect(page.getByTestId("draft-count")).toHaveText("1");
  await expect(bar(page, "alert-export")).not.toHaveAttribute("data-start", before!);
  await expect(bar(page, "alert-export")).toHaveAttribute("data-kind", "dated");
  await page.getByTestId("draft-banner").getByRole("button", { name: "See changes" }).click();
  await expect(page.getByTestId("draft-changes")).toContainText("Move the dates");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(bar(page, "alert-export")).toHaveAttribute("data-start", before!);
});

/**
 * Card simple-roadmap-drag-live: protects = while a bar is dragged its dates and the
 * constraint check show live (a move before its dependency ends reads broken); fails_when
 * = nothing shows during the drag; no_claim = the server's checker (it runs on drop).
 */
test("the drag shows dates and constraint flags live", async ({ page }) => {
  await open(page);
  // Mobile alert push depends on the rules engine: any span before the rules end is broken.
  const box = (await body(page, "alert-mobile").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 6 });
  await expect(page.getByTestId("drag-live")).toBeVisible();
  await expect(page.getByTestId("drag-live")).toHaveAttribute("data-state", "broken");
  await expect(bar(page, "alert-mobile")).toHaveAttribute("data-live", "broken");
  await page.mouse.up();
  await expect(page.getByText(/Moved 'Mobile alert push'/)).toBeVisible();
});

/**
 * Card simple-roadmap-drag-propose: protects = a commenter's drag is a proposal (it waits
 * for the decider; the bar stays at its published dates), and the owner accepts it from
 * the "Needs a decision" tray; fails_when = a commenter's drag applies, or the tray lacks
 * the proposal or its Accept; no_claim = routing to a named decider (simple-deciders.spec).
 */
test("a commenter's drag is a proposal the owner accepts in the tray", async ({ page }) => {
  await page.context().addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
  await open(page, "commenter@example.com");
  await expect(page.getByTestId("needs-decision")).toHaveCount(0);
  const before = await bar(page, "alert-export").getAttribute("data-start");
  await drag(page, "alert-export", 90);
  await expect(page.getByText(/proposed: it waits for .+ in Needs a decision/)).toBeVisible();
  await expect(bar(page, "alert-export")).toHaveAttribute("data-start", before!);
  await page.goto("/home");
  await signOut(page);
  await open(page);
  await page.getByTestId("needs-decision").click();
  const tray = page.getByTestId("decision-tray");
  await expect(tray.getByTestId("tray-counters")).toContainText("Proposals");
  await expect(tray.getByTestId("tray-broken").first()).toContainText("Weekly alert digest");
  await expect(tray.getByTestId("tray-date").first()).toBeVisible();
  const proposal = tray.getByTestId("tray-proposal").filter({ hasText: "Alert history export" });
  await proposal.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Accepted: it is in your working draft")).toBeVisible();
  await tray.getByRole("button", { name: "Close" }).click();
  await expect(bar(page, "alert-export")).not.toHaveAttribute("data-start", before!);
});

/**
 * Card simple-roadmap-fixes: protects = D14's one-click fixes on a broken dependency's
 * callout: "Move the dependents" clears the red link; "Accept as risk" with a note keeps
 * it amber with the note; fails_when = a fix writes nothing or the link stays red;
 * no_claim = the fixes' date arithmetic (the API's tests).
 */
test("a broken link's fixes: move the dependents, accept as risk", async ({ page }) => {
  await open(page);
  const arrow = page.locator('[data-testid="dep-arrow"][data-from="alert-rules"][data-to="alert-digest"]');
  await expect(arrow).toHaveAttribute("data-state", "red");
  await page.locator('[data-testid="broken-callout"][data-item="alert-digest"]').getByRole("button", { name: "Accept as risk" }).click();
  await page.getByLabel("Why it is an accepted risk").fill("The digest can ship on the old rules");
  await page.getByRole("button", { name: "Save the risk" }).click();
  await expect(arrow).toHaveAttribute("data-state", "amber");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(arrow).toHaveAttribute("data-state", "red");
  await page.locator('[data-testid="broken-callout"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect(page.getByText(/Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();
  await expect(arrow).toHaveAttribute("data-state", "ok");
});

/**
 * Card simple-roadmap-suggestion: protects = Oracle's date suggestion (dotted outline)
 * opens Accept · Edit dates · Dismiss; Accept puts the dates in the working draft and the
 * bar draws solid; Edit saves other dates; fails_when = the popover is missing an action or
 * Accept writes nothing; no_claim = how suggestions are made (S2's tests).
 */
test("Oracle's date suggestion: accept, edit", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]').click();
  const pop = page.getByTestId("suggestion-popover");
  await expect(pop).toContainText("Oracle suggests");
  await expect(pop.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await pop.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
  await expect(bar(page, "alert-sso")).toHaveAttribute("data-kind", "dated");
  const outline = page.locator('[data-testid="suggestion-open"]').first();
  const key = await outline.getAttribute("data-item");
  await outline.click();
  await pop.getByRole("button", { name: "Edit dates" }).click();
  await pop.getByLabel("Start").fill("2026-12-01");
  await pop.getByLabel("End").fill("2027-01-15");
  await pop.getByRole("button", { name: "Save dates" }).click();
  await expect(bar(page, key!)).toHaveAttribute("data-start", "2026-12-01");
  await expect(bar(page, key!)).toHaveAttribute("data-end", "2027-01-15");
});

/**
 * Card simple-roadmap-gantt: protects = the Gantt draws the same bars with day and week
 * scales, today's line and the dependency arrows, and the same card opens from a bar;
 * fails_when = the scale does not switch or a part is missing; no_claim = holiday bands
 * (no API serves holidays yet).
 */
test("the Gantt: day and week, today's line, arrows, the same card", async ({ page }) => {
  await open(page);
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-unit", "week");
  const weekW = (await page.getByTestId("chart-svg").boundingBox())!.width;
  await page.getByTestId("unit-day").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-unit", "day");
  expect((await page.getByTestId("chart-svg").boundingBox())!.width).toBeGreaterThan(weekW * 3);
  await expect(page.getByTestId("today-line")).toBeAttached();
  await expect(page.getByTestId("dep-arrow").first()).toBeAttached();
  await bar(page, "alert-rules").click();
  await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Alert rules engine" })).toBeVisible();
  // #47: the card floats over a dimmed backdrop that takes the page's clicks; close it first.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("floating-card")).toHaveCount(0);
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
});

/**
 * Card simple-roadmap-filters: protects = filters (goal, group by track) re-read the
 * roadmap with the API's parameters and redraw it; fails_when = a filter is ignored;
 * no_claim = the API's filtering (S2's test).
 */
test("filters and grouping", async ({ page }) => {
  await open(page);
  await page.getByLabel("Goal").selectOption("faster-activation");
  await expect(bar(page, "alert-rules")).toHaveCount(0);
  await expect(bar(page, "setup-checklist")).toBeVisible();
  await page.getByLabel("Goal").selectOption("");
  await page.getByTestId("group-track").click();
  await expect(page.getByTestId("chart-group").first()).toContainText("track");
});

/**
 * Card simple-roadmap-export: protects = Export PNG and Export PDF download the current
 * view (a PNG; a one-page PDF); fails_when = no file comes, or it is not a PNG / PDF;
 * no_claim = the picture's fidelity beyond its kind and size.
 */
test("export the view as PNG and PDF", async ({ page }) => {
  await open(page);
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export PNG" }).click()]);
  expect(png.suggestedFilename()).toBe("roadmap-timeline.png");
  const pngBytes = await (await png.createReadStream()).toArray();
  expect(Buffer.concat(pngBytes).subarray(1, 4).toString()).toBe("PNG");
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export PDF" }).click()]);
  expect(pdf.suggestedFilename()).toBe("roadmap-timeline.pdf");
  const pdfBytes = Buffer.concat(await (await pdf.createReadStream()).toArray());
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdfBytes.length).toBeGreaterThan(5000);
});

/**
 * Card simple-roadmap-viewer: protects = a viewer reads (bars and the card) but a drag
 * moves nothing and no tray shows; fails_when = a viewer's drag sends a change;
 * no_claim = the API's 403 (its tests).
 */
test("a viewer reads and cannot drag", async ({ page }) => {
  await open(page, "viewer@example.com");
  await expect(page.getByTestId("needs-decision")).toHaveCount(0);
  const before = await bar(page, "alert-export").getAttribute("data-start");
  await drag(page, "alert-export", 90);
  await expect(page.getByTestId("floating-card")).toBeVisible();
  await expect(bar(page, "alert-export")).toHaveAttribute("data-start", before!);
});

/**
 * Card simple-roadmap-flow: protects = only a proposal for a new feature (a draft item,
 * D15) carries a flow thumbnail, and clicking it widens the card in place with the "No
 * flow yet" state (no design bundle); a proposal to move a published item's dates carries
 * none; fails_when = a move_dates proposal on a published item shows a thumbnail, or the
 * feature's thumbnail does not widen the card; no_claim = S10's flows.
 */
test("only a new feature's proposal carries a flow thumbnail", async ({ page }) => {
  await open(page, "commenter@example.com");
  await drag(page, "alert-export", 90);
  await expect(page.getByText(/Moved 'Alert history export'.*proposed: it waits for .+ in Needs a decision/)).toBeVisible();
  await bar(page, "alert-export").click();
  const card = page.getByTestId("floating-card");
  await expect(card.getByTestId("card-proposals")).toContainText("Move the dates");
  await expect(card.getByTestId("flow-thumb")).toHaveCount(0);
  await card.getByRole("button", { name: "Close" }).click();
  await drag(page, "setup-ideas", 90);
  await expect(page.getByText(/Moved 'Team invite nudges'.*proposed: it waits for .+ in Needs a decision/)).toBeVisible();
  await bar(page, "setup-ideas").click();
  await card.getByTestId("flow-thumb").click();
  await expect(card).toHaveAttribute("data-wide", "true");
  await expect(card.getByTestId("flow-empty")).toContainText("No flow yet");
});

/**
 * Card simple-roadmap-callout-propose: protects = the broken link's callout offers its
 * one-click fixes to anyone who may change the roadmap, as the card and the tray do (a
 * commenter's fix is a proposal); fails_when = a commenter's callout has no fixes;
 * no_claim = the fixes' date arithmetic (the API's tests).
 */
test("a commenter proposes a fix from the callout", async ({ page }) => {
  await open(page, "commenter@example.com");
  const callout = page.locator('[data-testid="broken-callout"][data-item="alert-digest"]');
  await callout.getByRole("button", { name: "Move the dependents" }).click();
  await expect(page.getByText(/Moved what depends on 'Alert rules engine' proposed: it waits for .+ in Needs a decision/)).toBeVisible();
});

/**
 * Card simple-roadmap-keyboard: protects = a focused bar moves from the keyboard: an arrow
 * moves it by a week on the timeline, Shift+arrow moves only its end, each through the
 * change engine; fails_when = the keyboard cannot change a bar's dates; no_claim = the
 * API's engine.
 */
test("the keyboard moves and resizes a bar", async ({ page }) => {
  await open(page);
  const b = bar(page, "alert-export");
  const start = (await b.getAttribute("data-start"))!;
  const end = (await b.getAttribute("data-end"))!;
  const plus = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  await b.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/Moved 'Alert history export'.*in your working draft/)).toBeVisible();
  await expect(b).toHaveAttribute("data-start", plus(start, 7));
  await expect(b).toHaveAttribute("data-end", plus(end, 7));
  await b.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(b).toHaveAttribute("data-end", end);
  await expect(b).toHaveAttribute("data-start", plus(start, 7));
});

// A phone long-presses the Gantt's bars: its Timeline (timeline-overlap B3) draws thin lanes with no bars to pick up.
test.describe("phone, long-press", () => {
  test.use(PHONE);

  /**
   * Card simple-roadmap-long-press: protects = on a phone a long press picks a bar up and
   * the drag moves its dates through the change engine (applied, with Undo), the card is
   * a bottom sheet; fails_when = a touch drag does nothing; no_claim = native scrolling.
   */
  test("a long press drags a bar on a phone", async ({ page }) => {
    await open(page, undefined, true);
    const before = await bar(page, "alert-export").getAttribute("data-start");
    await longPressDrag(page, "alert-export", 60);
    await expect(page.getByText(/Moved 'Alert history export'/)).toBeVisible();
    await expect(bar(page, "alert-export")).not.toHaveAttribute("data-start", before!);
    await noSidewaysScroll(page);
  });

  /**
   * Card simple-roadmap-picked: protects = a long press marks the bar picked up (its cue)
   * until the finger lifts; fails_when = the bar never shows it; no_claim = the cue's look.
   */
  test("a long press shows the bar picked up", async ({ page }) => {
    await open(page, undefined, true);
    const box = (await body(page, "alert-export").boundingBox())!;
    const ev = { pointerId: 9, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await bar(page, "alert-export").dispatchEvent("pointerdown", ev);
    await expect(bar(page, "alert-export")).toHaveAttribute("data-picked", "true");
    await page.getByTestId("chart-svg").dispatchEvent("pointerup", { ...ev, buttons: 0 });
    await expect(bar(page, "alert-export")).not.toHaveAttribute("data-picked", "true");
  });

  /**
   * Card simple-roadmap-flow-phone: protects = on a phone, a feature proposal's flow opens
   * as a full-height sheet; fails_when = the widened sheet stops short of the screen's top;
   * no_claim = S10's flows.
   */
  test("a feature's flow opens full height on a phone", async ({ page }) => {
    await open(page, "commenter@example.com", true);
    await longPressDrag(page, "setup-ideas", 60);
    await expect(page.getByText(/Moved 'Team invite nudges'.*proposed: it waits for .+ in Needs a decision/)).toBeVisible();
    await page.getByTestId("chart-label").filter({ hasText: "Team invite nudges" }).click();
    const card = page.getByTestId("floating-card");
    await card.getByTestId("flow-thumb").click();
    await expect(card).toHaveAttribute("data-wide", "true");
    const c = (await card.boundingBox())!;
    expect(c.y).toBeLessThanOrEqual(1);
    expect(c.height).toBeGreaterThanOrEqual(844 - 2);
  });
});

// The 500-item first paint and drag speed: e2e/simple-roadmap-500-timing.spec.ts (@timing).
