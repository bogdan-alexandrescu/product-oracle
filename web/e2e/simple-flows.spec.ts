import { MOCK_VISUAL_JOB_MS_KEY } from "../lib/api/mock/simple-visuals";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple flows (the owner's picks of 2026-10-28: A, a live thumbnail that opens a readable
 * view, with C, a full-screen viewer, and D, a storyboard of step cards): one Flow
 * component, its row, opened view, viewer and storyboard sharing the same data, driven
 * through the roadmap item card and a PRD bet line on the mock, desktop (1366x820) and phone
 * (390x844), light and dark.
 *
 * Test cards (protects / fails_when / no_claim):
 *
 * - "the row: no flow yet, drawing, then the drawing swaps in": protects=the item card's
 *   row says "No flow yet" with "Ask Oracle to draw it"; asked, it shows the stages "Read
 *   F-06 Weekly alert digest → Draw the steps → Draw the screen" with a bar and "Updates
 *   here by itself; you can close the card. Started ..."; when the job ends the live
 *   thumbnail swaps in without a reload with "5 steps · 1 screen · version 1 · drawn ..."
 *   and a "New" chip; fails_when=a state is missing, the drawing needs a reload or the row
 *   lacks its meta line; no_claim=the API's job timing (test_simple_flows_api).
 * - "the row: a failed drawing says nothing changed and Retry draws it": protects=the
 *   failed state's words and its Retry; fails_when=a failure reads as drawn or offers no
 *   Retry; no_claim=why the model failed.
 * - "opened, full screen and back": protects=Open the flow spreads it: the diagram (real
 *   shapes, step numbers), every step in full words with a decision's If yes / If no, the
 *   screen; Full screen opens the viewer over the page (on a phone the tabs Diagram |
 *   Steps | Screen), Escape and Exit full screen go back; fails_when=the opened view lacks
 *   a part, the viewer does not open or does not close; no_claim=pixel layout.
 * - "the storyboard in the opened view and the viewer": protects=[Diagram | Storyboard]
 *   shows each step as a card with who does it (User, App, Admin), the step in full words,
 *   a decision's Yes and No, the screen as the last card; on a phone one card at a time
 *   with Next / Previous; fails_when=a card lacks its actor or a decision lacks Yes/No, or
 *   the screen card is missing; no_claim=touch swipe physics (the row scroll-snaps).
 * - "a PRD bet line opens the same flow": protects=a one-pager bet line's flow opens the
 *   same opened view with the storyboard switch; fails_when=the PRD line shows another
 *   presentation; no_claim=the one-pager's own layout.
 */

const DESKTOP = { width: 1366, height: 820 };
const PHONE = { width: 390, height: 844 };
const JOB_MS = 4000;

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function openCard(page: Page, key: string): Promise<Locator> {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(bar(page, key)).toBeVisible();
  await bar(page, key).click();
  const card = page.getByTestId("floating-card");
  await expect(card.getByTestId("card-flow")).toBeVisible();
  return card;
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
        await expect(drawing.getByRole("list", { name: "Stages" })).toContainText("Read F-06 Weekly alert digest");
        await expect(drawing.getByRole("list", { name: "Stages" })).toContainText("Draw the steps");
        await expect(drawing.getByRole("list", { name: "Stages" })).toContainText("Draw the screen");
        await expect(drawing.getByRole("progressbar", { name: "Drawing" })).toBeVisible();
        await expect(drawing).toContainText("Updates here by itself; you can close the card. Started");
        // The job lands: the live thumbnail swaps itself in, no reload.
        await expect(row.getByTestId("flow-meta")).toContainText("5 steps · 1 screen · version 1 · drawn", { timeout: JOB_MS + 8000 });
        await expect(row.getByTestId("flow-new")).toHaveText("New");
        await expect(row.getByRole("button", { name: "Open the item's flow" }).locator('[data-shape="decision"]')).toHaveCount(1);
        expect(loads).toBe(0);
      });

      test(`the row: a failed drawing says nothing changed and Retry draws it (${where})`, async ({ page }) => {
        const card = await openCard(page, "alert-export");
        const row = card.getByTestId("flow-row");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(row.getByTestId("flow-empty")).toHaveText(/Oracle could not draw this flow\. Nothing changed on the item\./);
        await tap(row.getByRole("button", { name: "Retry" }));
        await expect(row.getByTestId("flow-meta")).toContainText("version 1");
      });

      test(`opened, full screen and back (${where})`, async ({ page }) => {
        const card = await openCard(page, "alert-export");
        const row = card.getByTestId("flow-row");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        await tap(row.getByRole("button", { name: "Retry" }));
        await tap(row.getByRole("button", { name: "Open the flow" }));
        const opened = row.getByTestId("flow-detail");
        await expect(opened.getByTestId("flow-svg")).toBeVisible();
        await expect(opened.getByTestId("flow-svg").locator('[data-shape="decision"]')).toHaveCount(1);
        await expect(opened.getByTestId("flow-steps")).toContainText("3 Decision: Is the user signed in? If yes: the next step opens. If no: the sign-in page opens.");
        await expect(opened.getByTestId("flow-wireframe")).toBeVisible();
        await tap(opened.getByRole("button", { name: "Full screen" }));
        const viewer = page.getByTestId("flow-fullscreen");
        await expect(viewer).toBeVisible();
        if (phone) {
          await expect(viewer.getByRole("tab", { name: "Diagram" })).toHaveAttribute("aria-selected", "true");
          await expect(viewer.getByTestId("flow-svg")).toBeVisible();
          await tap(viewer.getByRole("tab", { name: "Steps" }));
          await expect(viewer.getByTestId("flow-steps")).toContainText("If no: the sign-in page opens.");
          await tap(viewer.getByRole("tab", { name: "Screen" }));
          await expect(viewer.getByTestId("flow-wireframe")).toBeVisible();
        } else {
          await expect(viewer.getByTestId("flow-svg")).toBeVisible();
          await expect(viewer.getByTestId("flow-steps")).toBeVisible();
          await expect(viewer.getByTestId("flow-wireframe")).toBeVisible();
        }
        await expect(viewer.getByLabel("Comment on the flow")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
        await expect(card).toBeVisible();
        await tap(opened.getByRole("button", { name: "Full screen" }));
        await tap(page.getByTestId("flow-fullscreen").getByRole("button", { name: "Exit full screen" }));
        await expect(page.getByTestId("flow-fullscreen")).toHaveCount(0);
        await tap(opened.getByRole("button", { name: "Close the flow" }));
        await expect(row.getByTestId("flow-detail")).toHaveCount(0);
        await expect(row.getByTestId("flow-meta")).toBeVisible();
      });

      test(`the storyboard in the opened view and the viewer (${where})`, async ({ page }) => {
        const card = await openCard(page, "alert-export");
        const row = card.getByTestId("flow-row");
        await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
        await tap(row.getByRole("button", { name: "Retry" }));
        await tap(row.getByRole("button", { name: "Open the flow" }));
        const opened = row.getByTestId("flow-detail");
        await tap(opened.getByRole("group", { name: "Show the flow as" }).getByRole("button", { name: "Storyboard" }));
        const board = opened.getByTestId("flow-storyboard");
        const cards = board.getByTestId("story-card");
        await expect(cards).toHaveCount(6);
        await expect(cards.nth(0).getByTestId("story-who")).toHaveText("User");
        await expect(cards.nth(1).getByTestId("story-who")).toHaveText("App");
        await expect(cards.nth(4).getByTestId("story-who")).toHaveText("Admin");
        const decision = cards.nth(2);
        await expect(decision).toContainText("Decision: Is the user signed in?");
        await expect(decision.getByTestId("story-yes-no")).toContainText("YesThe next step opens.");
        await expect(decision.getByTestId("story-yes-no")).toContainText("NoThe sign-in page opens.");
        await expect(cards.nth(5)).toHaveAccessibleName("The screen");
        if (phone) {
          await expect(board.getByTestId("story-at")).toHaveText("Card 1 of 6");
          await tap(board.getByRole("button", { name: "Next" }));
          await tap(board.getByRole("button", { name: "Next" }));
          await expect(board.getByTestId("story-at")).toHaveText("Card 3 of 6");
          await expect(decision).toBeInViewport();
          await tap(board.getByRole("button", { name: "Previous" }));
          await expect(board.getByTestId("story-at")).toHaveText("Card 2 of 6");
        } else {
          await expect(cards.nth(0)).toBeInViewport();
          await expect(cards.nth(1)).toBeInViewport();
        }
        await tap(opened.getByRole("button", { name: "Full screen" }));
        const viewer = page.getByTestId("flow-fullscreen");
        await tap(viewer.getByRole("group", { name: "Show the flow as" }).getByRole("button", { name: "Storyboard" }));
        await expect(viewer.getByTestId("story-card")).toHaveCount(6);
        await expect(viewer.getByTestId("story-yes-no").first()).toContainText("The sign-in page opens.");
        await tap(viewer.getByRole("group", { name: "Show the flow as" }).getByRole("button", { name: "Diagram" }));
        await expect(viewer.getByTestId("flow-svg")).toBeVisible();
        await tap(viewer.getByRole("button", { name: "Exit full screen" }));
        await expect(viewer).toHaveCount(0);
      });

      test(`a PRD bet line opens the same flow (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await tap(page.getByRole("button", { name: "Flow for bet 2" }));
        const wide = page.getByRole("group", { name: "User flow of bet 2" });
        await expect(wide.getByTestId("flow-steps")).toContainText("Decision: Invite now or later? If yes: the invite form opens.");
        await tap(wide.getByRole("group", { name: "Show the flow as" }).getByRole("button", { name: "Storyboard" }));
        await expect(wide.getByTestId("story-card").last()).toHaveAccessibleName("The screen");
        await expect(wide.getByTestId("story-yes-no")).toContainText("The checklist moves on and asks again tomorrow.");
      });
    });
  }
}
