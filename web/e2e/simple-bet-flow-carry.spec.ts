import { MOCK_VISUAL_JOB_MS_KEY } from "../lib/api/mock/simple-visuals";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Carry the flow over (the owner's pick of 2026-10-29, qa-simple-prd-1): a bet's drawn user
 * flow belongs to the bet, not to its words. Editing a bet that has a flow and saving keeps the
 * flow on the line: its row, Open the flow and the storyboard, with no "stays with the old
 * words" note before saving. Driven through the one-pager on the mock, desktop and phone
 * (the flow row stacks under 600 px). Invented data.
 *
 * Test card: protects=the edited bet still shows its drawn flow (row, opened view,
 * storyboard), the note about the old words is gone; fails_when=the edit leaves the bet with
 * "No flow yet", or the note is shown; no_claim=the API's carry (test_simple_line_visuals_api).
 * And: a bet with no flow, reworded in the working draft, then asked for, is drawn from its
 * published words (who reads only the published page reads the drawing too, never the draft's
 * words); fails_when=the drawing is named after the draft's words; no_claim=the viewer's read
 * (test_draft_words_never_reach_who_reads_the_published_page).
 */

const NEW_WORDS = "A setup checklist that shows the next step and how long it takes";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function editBet(page: Page, phone: boolean) {
  await login(page);
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByTestId("one-pager")).toBeVisible();
  const bet = page.locator('[data-line="bets-1"]');
  const before = page.getByRole("group", { name: "User flow of “A setup checklist that shows" });
  await expect(before.getByTestId("flow-row-drawn")).toContainText("Finish setup from the checklist");
  if (phone) await bet.getByTestId("one-pager-line-text").tap();
  else await bet.hover();
  await tap(bet.getByRole("button", { name: "Edit “A setup checklist that shows" }));
  await page.getByLabel("New wording for").fill(NEW_WORDS);
  await expect(page.getByText("stays with the old words")).toHaveCount(0);
  await expect(page.getByTestId("flow-detach-warning")).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(bet).toHaveAttribute("data-state", "edited");
  await expect(bet.getByTestId("one-pager-line-text")).toContainText("and how long it takes");
}

const DRAFT_WORDS = "Invite suggestions from a shared team calendar link";

async function askForRewordedBet(page: Page, phone: boolean) {
  await page.addInitScript(([key, ms]) => localStorage.setItem(key, ms), [MOCK_VISUAL_JOB_MS_KEY, "1500"] as const);
  await login(page);
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByTestId("one-pager")).toBeVisible();
  const bet = page.locator('[data-line="bets-2"]');
  if (phone) await bet.getByTestId("one-pager-line-text").tap();
  else await bet.hover();
  await tap(bet.getByRole("button", { name: "Edit “Invite suggestions from" }));
  await page.getByLabel("New wording for").fill(DRAFT_WORDS);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(bet).toHaveAttribute("data-state", "edited");
  const row = bet.getByTestId("flow-row");
  await expect(row.getByTestId("flow-empty")).toContainText("No flow yet");
  await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
  await expect(row.getByTestId("flow-drawn")).toContainText("Version 1 · drawn", { timeout: 15000 });
  return row;
}

for (const [where, viewport, phone] of [
  ["desktop", { width: 1366, height: 820 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const) {
  test.describe(where, () => {
    test.use({ viewport, hasTouch: phone });

    test(`an edited bet keeps its drawn flow: the row, Open the flow and the storyboard (${where})`, async ({ page }) => {
      await editBet(page, phone);
      const flow = page.locator('[data-line="bets-1"]').getByRole("group", { name: /^User flow of “A setup checklist that shows/ });
      const row = flow.getByTestId("flow-row");
      await expect(row.getByTestId("flow-empty")).toHaveCount(0);
      await expect(row.getByTestId("flow-row-drawn")).toContainText("Finish setup from the checklist");
      await expect(row.getByTestId("flow-meta")).toHaveText("5 steps · 1 screen");
      await expect(row.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
      await tap(row.getByRole("button", { name: "Open the flow", exact: true }));
      const opened = page.getByTestId("flow-detail");
      await expect(opened.getByRole("heading", { level: 2 })).toHaveText("Finish setup from the checklist · flow");
      await expect(opened.getByTestId("flow-steps")).toContainText("Invite now or later?");
      await tap(opened.getByRole("button", { name: phone ? "Back" : "Close" }));
      await tap(row.getByRole("button", { name: "Open the storyboard" }));
      const board = page.getByTestId("flow-storyboard");
      await expect(board).toHaveAccessibleName("Finish setup from the checklist · storyboard");
      await expect(board).toContainText("Sign in as a new admin");
    });

    test(`a bet reworded in the draft is drawn from its published words (${where})`, async ({ page }) => {
      const row = await askForRewordedBet(page, phone);
      await expect(row.getByTestId("flow-row-drawn")).toContainText("Invite suggestions from the admin's calendar");
      await expect(row.getByTestId("flow-row-drawn")).not.toContainText("shared team calendar");
    });
  });
}
