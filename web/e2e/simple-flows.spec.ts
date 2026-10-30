import { MOCK_VISUAL_FAIL_KEY, MOCK_VISUAL_JOB_MS_KEY } from "../lib/api/mock/simple-visuals";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple flows, drawn to the owner's picks of 2026-10-28 (simple-v3/talk/flow-display.html: A, a
 * live thumbnail that opens a readable view, with C, a full-screen viewer, and D, a storyboard of
 * step cards; "keep the mockup design very strictly"): one Flow component, its row, opened view,
 * viewer and storyboard sharing the same data, driven through the roadmap item card and a PRD
 * bet line on the mock, desktop (1366x820) and phone (390x844), light and dark.
 *
 * Test cards (protects / fails_when / no_claim):
 *
 * - "the row: no flow yet, drawing, then the drawing swaps in": protects=A's row: "No flow yet"
 *   with "Ask Oracle to draw it" and "Oracle draws the steps and the screen they touch, from the
 *   PRD."; asked, "Oracle is drawing the flow", the stages "Read F-06 · Draw the steps · Draw the
 *   screen" with a bar and "Updates here by itself; you can close the card. Started ..."; when the
 *   job ends the live thumbnail (the real shapes: a decision diamond) swaps in without a reload
 *   with the flow's name, "New", "5 steps · 1 screen" and "Version 1 · drawn ...", then "Open
 *   the flow" and "Open the storyboard"; fails_when=a state is missing, the drawing needs a
 *   reload or the row lacks its lines; no_claim=the API's job timing (test_simple_flows_api).
 * - "the row: a failed drawing says nothing changed and Retry draws it": protects=the failed
 *   state's words ("Oracle could not draw this flow." "Nothing changed on the item.") and its
 *   Retry; fails_when=a failure reads as drawn or offers no Retry; no_claim=why the model failed.
 * - "opened, full screen and back": protects=Open the flow spreads it across the page (A: over
 *   the roadmap, 16 px from the page's edges, the card out of the way; a phone: a full-height
 *   sheet with Back): the diagram with its decision diamond and its No branch, every step in full
 *   words with a decision's "If no:", the screen's numbered regions; Full screen opens the viewer
 *   (C: "Roadmap" back, Comment, Exit full screen, the diagram top to bottom beside the boxed
 *   steps, the screen below; a phone: Diagram | Steps | Screen); Comment opens the comments;
 *   Escape closes the comments, then the viewer, and Close the opened view; fails_when=a part is
 *   missing, a layer does not open or does not close, or the card shows through; no_claim=pixels.
 * - "the storyboard": protects=Open the storyboard (D) lays the step cards across the foot of the
 *   page (who does it, the step in full words, a decision's Yes and No, the screen last with Open
 *   the screen); on a phone one card at a time ("Step 1 of 5 · then the screen", Step 2 and back,
 *   the dots, the screen last); Open the screen opens the viewer on the screen; fails_when=a card
 *   lacks its actor, a decision its Yes/No, the screen card is missing or a phone shows them all;
 *   no_claim=touch swipe physics.
 * - "a PRD bet line is the same row, opened the same": protects=a one-pager bet line shows the
 *   card's row and opens the same opened view and storyboard; its states and the swap without a
 *   reload; fails_when=the line shows another presentation; no_claim=the one-pager's layout.
 * - "the drawing reaches its last stage": protects=while the job runs, "Draw the screen" becomes
 *   the current stage and the bar fills past half; fails_when=the bar stops at "Draw the steps".
 * - "the drawing names an item with no code by its title": protects=the stages read "Read Alert
 *   routing by team"; fails_when=the mock names the request's brief.
 * - "a drawing that landed while the card was closed is New": protects=closing the card while
 *   Oracle draws and opening it after the drawing landed shows "New".
 * - "a long flow stays readable": protects=an 8-step flow's thumbnail numbers and opened labels
 *   render at a readable size and a word longer than its box stays inside it; fails_when=the
 *   diagram is squeezed or a long word runs past its box; no_claim=pixel layout.
 * - "the viewer holds the focus": protects=Full screen moves the focus into the viewer, Tab stays
 *   in it, Escape gives the focus back to Full screen; fails_when=the focus stays on the page.
 */

const DESKTOP = { width: 1366, height: 820 };
const PHONE = { width: 390, height: 844 };
const JOB_MS = 4000;


async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function openCard(page: Page, key: string): Promise<Locator> {
  await login(page);
  await page.goto("/simple/roadmap");
  await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card.getByTestId("card-flow")).toBeVisible();
  return card;
}

/** Alert history export's first drawing fails; Retry draws it. */
async function drawnExport(page: Page): Promise<{ card: Locator; row: Locator }> {
  const card = await openCard(page, "alert-export");
  const row = card.getByTestId("flow-row");
  await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
  await tap(row.getByRole("button", { name: "Retry" }));
  await expect(row.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
  return { card, row };
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? PHONE : DESKTOP, colorScheme: scheme, hasTouch: phone, isMobile: phone });

      test(`the row: no flow yet, drawing, then the drawing swaps in (${where})`, async ({ page }) => {
        await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, String(JOB_MS)] as const);
        let loads = 0;
        const card = await openCard(page, "alert-digest");
        page.on("framenavigated", (f) => {
          if (f === page.mainFrame()) loads += 1;
        });
        const row = card.getByTestId("flow-row");
        await expect(row.getByTestId("flow-empty")).toContainText("No flow yet");
        await expect(row).toContainText("Oracle draws the steps and the screen they touch, from the PRD.");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        const drawing = row.getByTestId("flow-empty");
        await expect(drawing).toHaveAttribute("data-state", "drawing");
        await expect(drawing).toContainText("Oracle is drawing the flow");
        await expect(drawing).toContainText("About a minute");
        const stages = drawing.getByRole("list", { name: "Stages" }).getByRole("listitem");
        await expect(stages).toHaveText(["Read F-06", "Draw the steps", "Draw the screen"]);
        await expect(drawing.getByRole("progressbar", { name: "Drawing" })).toBeVisible();
        await expect(drawing).toContainText("Updates here by itself; you can close the card. Started");
        // The job lands: the live thumbnail swaps itself in, no reload.
        await expect(row.getByTestId("flow-meta")).toHaveText("5 steps · 1 screen", { timeout: JOB_MS + 8000 });
        await expect(row.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
        await expect(row.getByTestId("flow-new")).toHaveText("New");
        await expect(row.getByRole("button", { name: "Open the item's flow" }).locator('[data-shape="decision"]')).toHaveCount(1);
        await expect(row.getByRole("button", { name: "Open the flow", exact: true })).toBeVisible();
        await expect(row.getByRole("button", { name: "Open the storyboard" })).toBeVisible();
        expect(loads).toBe(0);
      });

      test(`the row: a failed drawing says nothing changed and Retry draws it (${where})`, async ({ page }) => {
        const card = await openCard(page, "alert-export");
        const row = card.getByTestId("flow-row");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(row.getByTestId("flow-empty")).toHaveAttribute("data-state", "failed");
        await expect(row.getByTestId("flow-empty")).toHaveText(/Oracle could not draw this flow\. Nothing changed on the item\./);
        await tap(row.getByRole("button", { name: "Retry" }));
        await expect(row.getByTestId("flow-drawn")).toContainText("Version 1");
      });

      test(`opened, full screen and back (${where})`, async ({ page }) => {
        const { card, row } = await drawnExport(page);
        await tap(row.getByRole("button", { name: "Open the flow", exact: true }));
        const opened = page.getByTestId("flow-detail");
        await expect(opened).toBeVisible();
        await expect(opened.getByRole("heading", { level: 2 })).toHaveText(phone ? "The new flow · flow" : "Alert history export · flow");
        const svg = opened.getByTestId("flow-svg");
        await expect(svg).toBeVisible();
        await expect(svg.locator('[data-shape="decision"]')).toHaveCount(1);
        await expect(svg).toContainText("The sign-in");
        await expect(opened.getByTestId("flow-steps")).toContainText("3 Decision: Is the user signed in? New If no: the sign-in page opens.");
        await expect(opened.getByTestId("flow-regions")).toContainText("Next step card");
        if (phone) {
          const b = (await opened.boundingBox())!;
          expect(b.y).toBeLessThanOrEqual(1);
          expect(b.height).toBeGreaterThanOrEqual(PHONE.height - 2);
          await expect(opened.getByRole("button", { name: "Back" })).toBeVisible();
        } else {
          // Across the page: 16 px inside the page, over the roadmap; the card steps out of the way.
          const fit = await opened.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const main = document.querySelector("main")!.getBoundingClientRect();
            return { left: r.left - main.left, right: main.right - r.right, top: r.top };
          });
          expect(Math.round(fit.left)).toBe(16);
          expect(Math.round(fit.right)).toBe(16);
          expect(Math.round(fit.top)).toBe(16);
          await expect(card).toHaveAttribute("data-flow-open", "true");
          await expect(card).toHaveCSS("opacity", "0");
          await expect(opened.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
        }
        await tap(opened.getByRole("button", { name: "Full screen" }));
        const viewer = page.getByTestId("flow-fullscreen");
        await expect(viewer).toBeVisible();
        if (phone) {
          await expect(viewer.getByRole("tab", { name: "Diagram" })).toHaveAttribute("aria-selected", "true");
          await expect(viewer.getByTestId("flow-svg")).toBeVisible();
          await tap(viewer.getByRole("tab", { name: "Steps" }));
          await expect(viewer.getByTestId("flow-steps")).toContainText("If no: the sign-in page opens.");
          await tap(viewer.getByRole("tab", { name: "Screen" }));
          await expect(viewer.getByTestId("flow-regions")).toContainText("Progress meter");
        } else {
          // The Roadmap card's viewer keeps its "Roadmap" back (the one-pager's has none: qa-simple-prd-p3-22).
          await expect(viewer.getByRole("button", { name: "Exit full screen" })).toBeVisible();
          await expect(viewer.getByRole("button", { name: "Roadmap" })).toBeVisible();
          await expect(viewer.getByRole("heading", { level: 2 })).toHaveText("Alert history export · flow");
          await expect(viewer.getByText("User flow", { exact: true })).toBeVisible();
          await expect(viewer.getByTestId("flow-svg")).toBeVisible();
          await expect(viewer.getByTestId("flow-steps")).toBeVisible();
          await expect(viewer.getByText("Screen it touches: Home")).toBeVisible();
          await expect(viewer.getByTestId("flow-regions")).toBeVisible();
        }
        await tap(viewer.getByRole("button", { name: "Comment" }));
        await expect(viewer.getByLabel("Comment on the flow")).toBeVisible();
        await expect(viewer.getByTestId("flow-version")).toHaveText("Version 1 of 1");
        await page.keyboard.press("Escape");
        await expect(viewer.getByLabel("Comment on the flow")).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
        await expect(opened).toBeVisible();
        await tap(opened.getByRole("button", { name: "Full screen" }));
        await tap(page.getByTestId("flow-fullscreen").getByRole("button", { name: "Exit full screen" }));
        await expect(page.getByTestId("flow-fullscreen")).toHaveCount(0);
        await tap(opened.getByRole("button", { name: phone ? "Back" : "Close" }));
        await expect(page.getByTestId("flow-detail")).toHaveCount(0);
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute("data-flow-open", "false");
        await expect(row.getByTestId("flow-meta")).toBeVisible();
      });

      test(`the storyboard (${where})`, async ({ page }) => {
        const { row } = await drawnExport(page);
        await tap(row.getByRole("button", { name: "Open the storyboard" }));
        const board = page.getByTestId("flow-storyboard");
        await expect(board).toBeVisible();
        const cards = board.getByTestId("story-card");
        if (phone) {
          // One card at a time.
          await expect(board.getByRole("heading", { level: 2 })).toHaveText("The new flow · storyboard");
          await expect(board.getByTestId("story-at")).toHaveText("Step 1 of 5 · then the screen");
          await expect(cards).toHaveCount(1);
          await expect(cards.getByTestId("story-who")).toHaveText("User");
          await expect(board.getByRole("button", { name: "Step 2" })).toBeVisible();
          await tap(board.getByRole("button", { name: "Step 2" }));
          await expect(cards.getByTestId("story-who")).toHaveText("App");
          await tap(board.getByRole("button", { name: "Step 3" }));
          await expect(board.getByTestId("story-at")).toHaveText("Step 3 of 5 · then the screen");
          await expect(cards).toContainText("Decision: Is the user signed in?");
          await expect(cards.getByTestId("story-yes-no")).toHaveText("Yes: the next step opens.No: the sign-in page opens.");
          await tap(board.getByRole("button", { name: "Step 2" }));
          await expect(board.getByTestId("story-at")).toHaveText("Step 2 of 5 · then the screen");
          for (const n of [3, 4, 5]) await tap(board.getByRole("button", { name: `Step ${n}` }));
          await expect(cards.getByTestId("story-who")).toHaveText("Admin");
          await tap(board.getByRole("button", { name: "The screen" }));
          await expect(board.getByTestId("story-at")).toHaveText("The screen · after step 5");
          await expect(cards).toHaveAccessibleName("The screen");
        } else {
          await expect(board.getByRole("heading", { level: 2 })).toHaveText("Alert history export · storyboard");
          // A band across the foot of the page.
          const fit = await board.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const main = document.querySelector("main")!.getBoundingClientRect();
            return { left: r.left - main.left, right: main.right - r.right, foot: window.innerHeight - r.bottom };
          });
          expect(Math.round(fit.left)).toBe(16);
          expect(Math.round(fit.right)).toBe(16);
          expect(Math.round(fit.foot)).toBe(16);
          await expect(cards).toHaveCount(6);
          await expect(cards.nth(0).getByTestId("story-who")).toHaveText("User");
          await expect(cards.nth(1).getByTestId("story-who")).toHaveText("App");
          await expect(cards.nth(4).getByTestId("story-who")).toHaveText("Admin");
          await expect(cards.nth(2)).toContainText("Is the user signed in?");
          await expect(cards.nth(2).getByTestId("story-yes-no")).toHaveText("Yes: the next step opens.No: the sign-in page opens.");
          await expect(cards.nth(5)).toHaveAccessibleName("The screen");
          for (const n of [0, 5]) await expect(cards.nth(n)).toBeInViewport();
        }
        await tap(board.getByRole("button", { name: "Open the screen" }));
        const viewer = page.getByTestId("flow-fullscreen");
        await expect(viewer.getByTestId("flow-regions")).toBeVisible();
        if (phone) await expect(viewer.getByRole("tab", { name: "Screen" })).toHaveAttribute("aria-selected", "true");
        await tap(viewer.getByRole("button", { name: "Exit full screen" }));
        await expect(viewer).toHaveCount(0);
        await tap(board.getByRole("button", { name: "Close" }));
        await expect(board).toHaveCount(0);
      });

      test(`a PRD bet line is the same row, opened the same (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple/one-pagers/guided-setup");
        const line = page.getByRole("group", { name: "User flow of “A setup checklist that shows" });
        await expect(line.getByTestId("flow-meta")).toHaveText("5 steps · 1 screen");
        await expect(line.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
        await tap(line.getByRole("button", { name: "Flow for “A setup checklist that shows" }));
        const opened = page.getByTestId("flow-detail");
        await expect(opened.getByRole("heading", { level: 2 })).toHaveText("Finish setup from the checklist · flow");
        await expect(opened.getByTestId("flow-steps")).toContainText("Decision: Invite now or later? New If no: the checklist moves on and asks again tomorrow.");
        await tap(opened.getByRole("button", { name: phone ? "Back" : "Close" }));
        await tap(line.getByRole("button", { name: "Open the storyboard" }));
        const board = page.getByTestId("flow-storyboard");
        if (phone) {
          for (const n of [2, 3]) await tap(board.getByRole("button", { name: `Step ${n}` }));
          await expect(board.getByTestId("story-yes-no")).toContainText("No: the checklist moves on and asks again tomorrow.");
        } else {
          await expect(board.getByTestId("story-card").last()).toHaveAccessibleName("The screen");
          await expect(board.getByTestId("story-yes-no")).toContainText("No: the checklist moves on and asks again tomorrow.");
        }
      });

      test(`a PRD bet line's states and the swap (${where})`, async ({ page }) => {
        await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, String(JOB_MS)] as const);
        await page.addInitScript(([key, bet]) => localStorage.setItem(key, bet), [MOCK_VISUAL_FAIL_KEY, "bets-2"] as const);
        await login(page);
        await page.goto("/simple/one-pagers/guided-setup");
        let loads = 0;
        page.on("framenavigated", (f) => {
          if (f === page.mainFrame()) loads += 1;
        });
        const drawn = page.getByRole("group", { name: "User flow of “A setup checklist that shows" });
        await expect(drawn.getByRole("button", { name: "Flow for “A setup checklist that shows" }).locator('[data-shape="decision"]')).toHaveCount(1);
        const row = page.getByRole("group", { name: "User flow of “A sample project created on" }).getByTestId("flow-row");
        // 2026-10-30: no "No flow yet" row under a bet; its line ends with "Draw the flow".
        await expect(row).toHaveCount(0);
        await tap(page.getByRole("button", { name: "Draw the flow for “A sample project created on" }));
        const stages = row.getByRole("list", { name: "Stages" });
        await expect(stages).toContainText("Read A sample project created on day one");
        await expect(stages).toContainText("Draw the screen");
        await expect(row.getByRole("progressbar", { name: "Drawing" })).toBeVisible();
        await expect(row.getByTestId("flow-empty")).toContainText("Updates here by itself; you can close the card. Started");
        await expect(row.getByTestId("flow-drawn")).toContainText("Version 1 · drawn", { timeout: JOB_MS + 8000 });
        await expect(row.getByTestId("flow-new")).toHaveText("New");
        await expect(row.getByRole("button", { name: "Flow for “A sample project created on" }).locator('[data-shape="decision"]')).toHaveCount(1);
        // The failed state, on the line itself.
        const failing = page.getByRole("group", { name: "User flow of “Invite suggestions from the admin's" }).getByTestId("flow-row");
        await tap(page.getByRole("button", { name: "Draw the flow for “Invite suggestions from the admin's" }));
        await expect(failing.getByTestId("flow-empty")).toHaveText(/Oracle could not draw this flow\. Nothing changed on the item\./, { timeout: JOB_MS + 8000 });
        await tap(failing.getByRole("button", { name: "Retry" }));
        await expect(failing.getByTestId("flow-drawn")).toContainText("Version 1", { timeout: JOB_MS + 8000 });
        expect(loads).toBe(0);
      });

      test(`the drawing reaches its last stage (${where})`, async ({ page }) => {
        await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, "120000"] as const);
        const card = await openCard(page, "alert-digest");
        const row = card.getByTestId("flow-row");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        const stages = row.getByRole("list", { name: "Stages" });
        await expect(stages.getByRole("listitem").nth(0)).toHaveAttribute("aria-current", "step");
        await page.clock.fastForward(62000);
        await expect(stages.getByRole("listitem").nth(1)).toHaveAttribute("aria-current", "step");
        await page.clock.fastForward(20000);
        await page.clock.fastForward(3000);
        await expect(stages.getByRole("listitem").nth(2)).toHaveAttribute("aria-current", "step");
        await expect(row.getByRole("progressbar", { name: "Drawing" })).toHaveAttribute("aria-valuenow", "3");
      });

      test(`the drawing names an item with no code by its title (${where})`, async ({ page }) => {
        await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, String(JOB_MS)] as const);
        const card = await openCard(page, "alert-sso");
        const row = card.getByTestId("flow-row");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(row.getByRole("list", { name: "Stages" })).toContainText("Read Alert routing by team");
      });

      test(`a drawing that landed while the card was closed is New (${where})`, async ({ page }) => {
        await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, String(JOB_MS)] as const);
        const card = await openCard(page, "alert-digest");
        await tap(card.getByTestId("flow-row").getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(card.getByTestId("flow-empty")).toHaveAttribute("data-state", "drawing");
        await tap(card.getByRole("button", { name: "Close" }).first());
        await expect(card).toHaveCount(0);
        await page.waitForTimeout(JOB_MS + 1000);
        await openRoadmapItem(page, "alert-digest");
        const again = page.getByTestId("floating-card").getByTestId("flow-row");
        await expect(again.getByTestId("flow-drawn")).toContainText("Version 1");
        await expect(again.getByTestId("flow-new")).toHaveText("New");
      });

      test(`a long flow stays readable (${where})`, async ({ page }) => {
        const card = await openCard(page, "alert-mobile");
        const row = card.getByTestId("flow-row");
        await expect(row.getByTestId("flow-meta")).toContainText("8 steps");
        const thumb = row.getByRole("button", { name: "Open the item's flow" });
        // The thumbnail's step numbers stay readable (at least 9 px tall on the screen).
        const numbers = await thumb.locator("text").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
        expect(Math.min(...numbers)).toBeGreaterThanOrEqual(9);
        await tap(row.getByRole("button", { name: "Open the flow", exact: true }));
        const svg = page.getByTestId("flow-detail").getByTestId("flow-svg");
        await expect(svg).toBeVisible();
        const fit = await svg.evaluate((el) =>
          [...el.querySelectorAll("g")].flatMap((g) => {
            const shape = g.querySelector<SVGGraphicsElement>("[data-shape]");
            if (!shape) return [];
            const box = shape.getBBox();
            return [...g.querySelectorAll<SVGTSpanElement>("tspan")].map((t) => {
              const b = t.getBBox();
              return { text: t.textContent, inside: b.x >= box.x - 1 && b.x + b.width <= box.x + box.width + 1, px: t.getBoundingClientRect().height };
            });
          }),
        );
        expect(fit.length).toBeGreaterThan(8);
        expect(fit.filter((f) => !f.inside)).toEqual([]);
        // Labels render at a readable size (at least 11 px tall), on a phone too.
        expect(Math.min(...fit.map((f) => f.px))).toBeGreaterThanOrEqual(11);
      });

      test(`the viewer holds the focus (${where})`, async ({ page }) => {
        const card = await openCard(page, "alert-mobile");
        await tap(card.getByTestId("flow-row").getByRole("button", { name: "Open the flow", exact: true }));
        const opener = page.getByTestId("flow-detail").getByRole("button", { name: "Full screen" });
        await tap(opener);
        const viewer = page.getByRole("dialog", { name: "Full screen: Act on a pushed alert" });
        await expect(viewer.getByRole("button", { name: "Exit full screen" })).toBeFocused();
        for (let i = 0; i < 25; i += 1) {
          await page.keyboard.press("Tab");
          expect(await viewer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
        }
        await page.keyboard.press("Shift+Tab");
        expect(await viewer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
        await expect(opener).toBeFocused();
      });
    });
  }
}
