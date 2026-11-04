import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * item-chat-understands (owner, Nov 3): in Simple > Roadmap > an item's card > Talk to Oracle,
 * a line saying the item already exists ("this is already happening now in our other app's
 * review section ... will continue to improve it") is understood: a "Mark as already shipped"
 * card whose After says where it runs, in the person's words, and a "Keep improving it" card;
 * Apply marks the item Done. Plain talk with no change in it gets a short question with
 * choices, never "Say it another way". The "roadmap-talk" mock scenario (invented Adaptive
 * pacing); the mock's reader is deterministic. Desktop (1366x820) and phone (390x844).
 */

const LINE = "this is already happening now in our other app's review section. This is shipped and will continue to improve it";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple/roadmap");
  await tap(page.getByTestId("format-gantt"));
}

/** Opens Adaptive pacing's card from its bar, then its talk (a phone: the Talk to Oracle tab). */
async function openTalk(page: Page, phone: boolean): Promise<{ card: Locator; talk: Locator }> {
  const bar = page.locator('[data-testid="bar"][data-item="adaptive-pacing"]');
  await expect(bar).toBeVisible();
  await bar.click();
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  await tap(card.getByRole(phone ? "tab" : "button", { name: "Talk to Oracle" }));
  const talk = card.getByTestId("item-talk");
  await expect(talk.getByRole("textbox", { name: "Message Oracle" })).toBeVisible();
  return { card, talk };
}

async function say(talk: Locator, text: string) {
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(talk.getByRole("button", { name: "Send" }));
}

const last = (talk: Locator) => talk.getByTestId("chat-message").last();

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "roadmap-talk"), MOCK_SCENARIO_KEY);
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1366, height: 820 });
    });

    /**
     * Card item-chat-shipped: protects = "this already exists" in an item's talk gives a
     * "Mark as already shipped" card whose After is where it runs (the person's words) and a
     * "Keep improving it" card, and Apply marks the item Done; fails_when = the reply is
     * "Say it another way" or has no such card, or Apply leaves the item planned;
     * no_claim = the follow-up item's dates.
     */
    test(`a line saying the item already exists offers "Mark as already shipped" (${where})`, async ({ page }) => {
      await signIn(page);
      const { card, talk } = await openTalk(page, phone);
      await say(talk, LINE);
      await expect(last(talk).getByTestId("chat-message-body")).toHaveText("I understood: Adaptive pacing already runs. Runs in our other app's review section.");
      await expect(talk).not.toContainText("Say it another way");
      const ship = talk.getByTestId("chat-card").filter({ hasText: "Mark as already shipped" });
      await expect(ship.getByTestId("chat-card-summary")).toHaveText("Mark as already shipped: Adaptive pacing");
      await expect(ship.getByTestId("chat-card-change")).toHaveText("Before: Planned work → After: Already shipped · Runs in our other app's review section");
      const keep = talk.getByTestId("chat-card").filter({ hasText: "Keep improving it" });
      await expect(keep.getByTestId("chat-card-summary")).toHaveText("Keep improving it: add Improve Adaptive pacing to Next");
      await tap(ship.getByRole("button", { name: "Apply" }));
      await expect(ship).toHaveAttribute("data-status", "applied");
      if (phone) await tap(card.getByRole("tab", { name: "Details" }));
      await expect(card.getByTestId("card-status")).toHaveText("Done");
    });

    /**
     * Card item-chat-choices: protects = plain talk with no change in it gets a short
     * question with choices drawn from it ("Add this as a task?"), and a picked choice gives
     * its card; fails_when = the reply is "Say it another way" or has no choices;
     * no_claim = the choices' order past the first.
     */
    test(`plain talk gets a short question with choices (${where})`, async ({ page }) => {
      await signIn(page);
      const { talk } = await openTalk(page, phone);
      await say(talk, "the sales team liked the demo");
      const asked = last(talk);
      await expect(asked.getByTestId("chat-message-body")).toHaveText("What should I do with that?");
      await expect(talk).not.toContainText("Say it another way");
      const choices = asked.getByTestId("chat-choices").getByRole("button");
      await expect(choices).toHaveText(["Add this as a task?", "Add it as a feature ask?", "Neither"]);
      // A line that may mean it already exists offers that first.
      await say(talk, "folks have been using a version of this for a while");
      await expect(last(talk).getByTestId("chat-choices").getByRole("button")).toHaveText(["Mark it as already shipped?", "Add this as a task?", "Neither"]);
      await tap(last(talk).getByTestId("chat-choices").getByRole("button", { name: "Mark it as already shipped?" }));
      await expect(talk.getByTestId("chat-card").last().getByTestId("chat-card-summary")).toHaveText("Mark as already shipped: Adaptive pacing");
    });
  });
}
