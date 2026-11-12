import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Simple S10 (#723): a roadmap draft item's flow and a Priorities proposal's flow open in the
 * one flow viewer (FlowPanel), as a chat card's and a goal suggestion's do: the row's thumbnail
 * (the flow's own picture) widens the card in place on a desktop and opens a full-height sheet
 * on a phone, with the drawing, its numbered notes and its comments, against the mock's
 * `draft_item` and `feature` visuals. Invented data; desktop 1366x820 and phone 390x844.
 */

const DRAFT = "Quiet hours for teams";

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** An owner adds a draft item from the Roadmap and waits for Oracle to draft it; its card is open. */
async function addDraft(page: Page, phone: boolean): Promise<Locator> {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  if (phone) {
    await page.getByTestId("quick-add-open").click();
    const sheet = page.getByRole("dialog", { name: "Add an item" });
    await sheet.getByLabel("Title").fill(DRAFT);
    await sheet.getByLabel("Roadmap").selectOption({ label: "Alerts roadmap" });
    await sheet.getByLabel("Where").selectOption({ label: "Next" });
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sheet).toBeHidden();
  } else {
    await page.getByLabel("Add an item").fill(DRAFT);
    await page.getByTestId("quick-add-roadmap").selectOption({ label: "Alerts roadmap" });
    await page.getByLabel("Add an item").press("Enter");
  }
  const card = page.getByTestId("floating-card");
  await expect(card.getByRole("heading", { name: DRAFT })).toBeVisible();
  await expect(card.getByTestId("item-drafting")).toHaveCount(0, { timeout: 10_000 });
  return card;
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a roadmap draft item's flow opens in the viewer with its numbered notes (${where})`, async ({ page }) => {
      // protects: a draft item's flow is its draft_item visual in the one viewer: the row's thumbnail (the flow's picture) widens the card, which shows the drawing and its numbered notes
      // fails_when: the draft shows the old 4-box picture and plain step list, or the viewer has no drawing or notes
      // no_claim: the real drafting job (api tests of oracle.simple.additions)
      const card = await addDraft(page, phone);
      const thumb = card.getByTestId("item-flow-thumb");
      await expect(thumb.getByRole("img", { name: /^User flow: 1 / })).toBeVisible();
      await tap(thumb);
      await expect(card).toHaveAttribute("data-wide", "true");
      if (phone) expect(Math.round((await card.boundingBox())!.height)).toBeGreaterThanOrEqual(840);
      const opened = card.getByTestId("flow-view").getByTestId("flow-detail");
      await expect(opened.getByTestId("flow-svg")).toBeVisible();
      await expect(opened.getByTestId("flow-drawn")).toContainText("Version 1");
      const notes = opened.getByTestId("flow-annotations").getByRole("listitem");
      await expect(notes).toHaveCount(2);
      await expect(notes.first()).toContainText("1");
      await tap(opened.getByRole("button", { name: "Close the flow" }));
      await expect(card).toHaveAttribute("data-wide", "false");
    });

    test(`a Priorities proposal's flow opens in the viewer and takes a comment (${where})`, async ({ page }) => {
      // protects: a proposal's flow on Priorities is its visual in the one viewer: the row's thumbnail (the flow's picture) widens the card on a desktop, a full-height sheet on a phone, and a commenter comments on it
      // fails_when: the proposal shows the old 4-box picture, or its flow cannot be commented on
      // no_claim: who the proposal waits on (simple-priorities.spec.ts)
      await login(page, "commenter@example.com");
      await page.goto("/simple/priorities");
      const row = page.locator('[data-testid="prio-row"][data-code="alert-mobile"]');
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: /^Drag / }).focus();
      await page.keyboard.press("ArrowUp");
      const why = page.getByRole("dialog", { name: /^Why move / });
      await why.getByLabel("Reason").fill("Push is what the beta users asked for");
      await why.getByRole("button", { name: "Propose", exact: true }).click();
      await expect(why).toBeHidden();
      const proposal = row.getByTestId("prio-proposal");
      const thumb = proposal.getByRole("button", { name: "Open the flow for Mobile alert push" });
      await expect(thumb.getByRole("img", { name: /^User flow: 1 / })).toBeVisible();
      await tap(thumb);
      await expect(proposal).toHaveAttribute("data-wide", phone ? "false" : "true");
      const sheet = page.getByTestId("flow-sheet").getByRole("dialog");
      if (phone) expect(Math.round((await sheet.boundingBox())!.height)).toBeGreaterThanOrEqual(840);
      const opened = (phone ? sheet : proposal).getByTestId("flow-detail");
      await expect(opened.getByTestId("flow-svg")).toBeVisible();
      const comments = opened.getByTestId("flow-comments-panel");
      await comments.getByLabel("Comment on the flow").fill("Let people snooze from the push");
      await comments.getByRole("button", { name: "Post comment" }).click();
      await expect(comments.getByTestId("flow-comments")).toContainText("Let people snooze from the push");
    });
  });
}
