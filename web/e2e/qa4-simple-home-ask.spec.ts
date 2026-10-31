import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * QA pass 4 fixes on Simple Home's Ask Oracle (mock-backed, desktop and phone):
 * - qa4-simple-home-2: a decision's Ask Oracle asks in words (no code) and Oracle answers it.
 * - qa4-simple-home-3: a citation number is a link to its source, named for a screen reader.
 * - qa4-simple-home-24: a Home chat reopened on Roadmap offers "This page" back in one click.
 * - qa4-simple-home-32: Recent chats titles show two lines at most.
 */

async function signIn(page: Page, size: { width: number; height: number }) {
  await page.context().addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await page.setViewportSize(size);
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

async function openAsk(page: Page, phone: boolean): Promise<Locator> {
  await page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

async function say(panel: Locator, text: string) {
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await panel.getByRole("button", { name: "Send" }).click();
}

for (const [device, size] of [
  ["desktop", { width: 1512, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  const phone = device === "phone";
  test.describe(device, () => {
    test(`qa4-simple-home-2 and -32 (${device}): a decision's Ask Oracle asks in words, is answered, and its chat title stays short`, async ({ page }) => {
      // fails_when: the box starts with the code "Q5", Oracle replies "I could not tell what to change", or the Recent chats title runs past two lines
      await signIn(page, size);
      const row = page.getByTestId("home-question").filter({ hasText: "Reminder default time" });
      await row.getByRole("button", { name: "Ask Oracle" }).click();
      const panel = page.getByTestId("hop-panel").filter({ visible: true });
      const box = panel.getByRole("textbox", { name: "Message Oracle" });
      await expect(box).toHaveValue(/^What should we decide on Reminder default time, in Guided setup/);
      await expect(box).not.toHaveValue(/Q\d/);
      await panel.getByRole("button", { name: "Send" }).click();
      await expect(panel.getByTestId("ask-answer").last()).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText(/I could not tell what to change/)).toHaveCount(0);

      await panel.getByRole("button", { name: /Recent chats/ }).click();
      const title = panel.getByTestId("ask-recent-row").filter({ hasText: "Reminder default time" }).first().getByTestId("ask-recent-question");
      await expect(title).toBeVisible();
      const lines = await title.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      expect(lines).toBeLessThanOrEqual(2);
    });

    test(`qa4-simple-home-3 (${device}): an answer's citation number opens its source and is named for a screen reader`, async ({ page }) => {
      // fails_when: the number is an aria-hidden superscript drawn by CSS that cannot be clicked
      await signIn(page, size);
      const panel = await openAsk(page, phone);
      await say(panel, "Which goal is most at risk this quarter?");
      const answer = panel.getByTestId("ask-answer").last();
      await expect(answer).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
      await expect(answer.locator("sup[aria-hidden]")).toHaveCount(0);
      const cites = answer.getByTestId("answer-cite");
      const n = await cites.count();
      for (let i = 0; i < n; i++) {
        await expect(cites.nth(i)).toHaveAttribute("href", /.+/);
        await expect(cites.nth(i)).toHaveAccessibleName(/^Source \d+: .+/);
        await expect(cites.nth(i)).toHaveText(/^\d+$/);
      }
      expect(n).toBeGreaterThan(0);
    });
  });
}

test("qa4-simple-home-24: a Home chat reopened on Roadmap offers This page back in one click", async ({ page }) => {
  // fails_when: the switch reads only "Home | General" with no way back to this page but New chat
  await signIn(page, { width: 1512, height: 900 });
  let panel = await openAsk(page, false);
  await say(panel, "who owns Weekly alert digest?");
  await expect(panel.locator('[data-testid="chat-message"][data-author="person"]')).not.toHaveCount(0);
  await panel.getByRole("button", { name: "Close Ask Oracle" }).click();
  await page.goto("/simple/roadmap");
  panel = await openAsk(page, false);
  await panel.getByRole("button", { name: "Recent chats" }).click();
  await panel.getByTestId("ask-recent-row").filter({ hasText: "Home ·" }).first().click();
  const about = panel.getByRole("group", { name: "About" });
  await expect(about.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-pressed", "true");
  await about.getByRole("button", { name: "This page" }).click();
  await expect(about.getByRole("button", { name: "This page" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Roadmap");
});
