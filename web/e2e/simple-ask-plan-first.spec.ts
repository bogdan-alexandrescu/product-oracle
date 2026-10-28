import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * The owner's production walk (2026-10-27): Oracle's Ask on Simple's pages reads the
 * company's plan first. Asked what a roadmap item is about and when it runs, Ask answers
 * from the plan (its dates, status and horizon), not "I don't have anything on it to go
 * on". The "simple-chat" mock scenario; desktop.
 *
 * Card: protects=a commenter's and an owner's question in Simple's one box that names a
 * roadmap item goes to Oracle's Ask and is answered from the plan, with the item's dates;
 * fails_when=the reply is the canned answer or lacks the item's dates; no_claim=the real
 * model's prompt (api/tests/test_simple_ask_plan.py), a failing source's plain line
 * (the API's scrub, same file).
 */

const EMAILS = { owner: ADMIN.email, commenter: "commenter@example.com" } as const;
const QUESTION = "what is Weekly alert digest about and when does it run?";

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

async function say(panel: Locator, text: string) {
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await panel.getByRole("button", { name: "Send" }).click();
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => {
    localStorage.setItem(key, "simple-chat");
  }, MOCK_SCENARIO_KEY);
});

for (const who of ["commenter", "owner"] as const) {
  test(`Ask answers a roadmap item's question from the plan (${who})`, async ({ page }) => {
    await signIn(page, EMAILS[who], "/simple");
    await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await expect(panel.getByTestId("ask-chat")).toBeVisible();
    await say(panel, QUESTION);
    const reply = panel.getByTestId("discussion-thread").getByTestId("oracle-reply").last();
    await expect(reply).toHaveAttribute("data-status", "complete");
    await expect(reply).toContainText(/From the plan: Weekly alert digest runs .+ – .+; it is /);
    await expect(reply).not.toContainText("to go on");
  });
}
