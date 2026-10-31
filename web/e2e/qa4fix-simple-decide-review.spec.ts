import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The qa4fix-simple-decide review's minors, driven through the UI on the mock's data.
 *
 * protects = the meeting chat's "Owners and each item's decider apply; others propose." shows
 * only under "Everyone except viewers" (the only rule it is true of); the person who applied a
 * chat card may undo it even when they no longer decide its item (chat._undo_bar).
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const chat = (page: Page) => page.getByTestId("meeting-chat").filter({ visible: true });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1512, height: 900 } });

  test("the meeting chat's apply-or-propose hint shows only under Everyone except viewers", async ({ page }) => {
    // fails_when: under "Only the presenter" the chat still says owners and deciders apply
    await login(page);
    await page.goto("/simple/meetings");
    await tap(page.getByRole("button", { name: "Start review" }).first());
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
    await sheet.getByRole("checkbox", { name: "Commenter", exact: true }).check();
    await tap(sheet.getByRole("button", { name: "Start", exact: true }));
    await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();

    const hint = chat(page).getByTestId("chat-rules-hint");
    await expect(hint).toHaveText("Owners and each item's decider apply; others propose.");
    await page.getByRole("combobox", { name: "Who changes things" }).selectOption("presenter");
    await expect(hint).toHaveCount(0);
    await page.getByRole("combobox", { name: "Who changes things" }).selectOption("everyone");
    await expect(hint).toHaveText("Owners and each item's decider apply; others propose.");
  });

  test("a roadmap's decider who hands an item's decision to someone else may still undo it", async ({ page }) => {
    // fails_when: the card's "Undo this change" is gone once its applier no longer decides the item
    await page.context().addInitScript((key) => localStorage.setItem(key, "simple-deciders"), MOCK_SCENARIO_KEY);
    await login(page, "dana.decider@example.com");
    await page.goto("/simple");
    await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await expect(panel.getByTestId("ask-chat")).toBeVisible();

    await panel.getByRole("textbox", { name: "Message Oracle" }).fill("make Approver the decider of New plan tiers");
    await tap(panel.getByRole("button", { name: "Send" }));
    const card = panel.getByTestId("chat-card").filter({ hasText: "Make Approver the decider of New plan tiers" }).last();
    await tap(card.getByRole("button", { name: "Apply", exact: true }));
    await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");
    await expect(card.getByRole("button", { name: "Undo this change" })).toBeVisible();
    await tap(card.getByRole("button", { name: "Undo this change" }));
    await expect(card.getByRole("button", { name: "Undo this change" })).toHaveCount(0);
    await expect(card.getByTestId("chat-card-outcome")).toContainText("Undone");
  });
});
