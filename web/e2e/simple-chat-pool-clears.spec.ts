import { expect, test, type Locator, type Page } from "./test";

import { SIMPLE_CHAT_POOL_SPENT_SCENARIO } from "../lib/api/mock/claude-accounts";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * spent-pool follow-ups: an open Ask Oracle thread whose line failed on a spent Claude pool
 * reads itself again when the pool's window clears (the line's retry_after), so the used-up
 * line turns into "I couldn't read that just now." with Retry without a reload, and Retry
 * then reads it again. The "simple-chat-pool-spent" mock scenario's window clears Sat Oct 24,
 * 6:00 PM Pacific (the mock's now is Oct 22, 2026, 12:00 PM UTC).
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

test("an open Ask Oracle thread on a spent Claude pool offers Retry once the window clears, without a reload", async ({ page }) => {
  // protects: the used-up line ("…used up until Sat Oct 24, 6:00 PM.", no Retry) becomes "I couldn't read that just now." with Retry in the open thread once the window clears, and Retry reads the line again
  // fails_when: the open thread keeps the used-up line after the window until a reload, or Retry does not read it
  // no_claim: the API's wording (api tests: test_simple_chat_reader.py)
  await page.addInitScript(([key, name]) => localStorage.setItem(key, name), [MOCK_SCENARIO_KEY, SIMPLE_CHAT_POOL_SPENT_SCENARIO] as const);
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill("can we push Delivery pipeline v2 out a quarter");
  await tap(panel.getByRole("button", { name: "Send" }));

  const line = panel.getByTestId("ask-chat-thread").getByTestId("chat-message").last();
  await expect(line).toHaveAttribute("data-kind", "failed");
  await expect(line.getByTestId("chat-message-body")).toHaveText("Oracle's Claude accounts are used up until Sat Oct 24, 6:00 PM.");
  await expect(line.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Past the window (Oct 25, 1:00 AM UTC), with the thread still open: no reload.
  await page.clock.fastForward(62 * 60 * 60 * 1000);
  await expect(line.getByTestId("chat-message-body")).toHaveText("I couldn't read that just now.");
  await expect(panel.getByText("Oracle's Claude accounts are used up")).toHaveCount(0);

  // Retry reads the line again: the scenario's account is spent once more (its weekly window
  // counts from now), so the fresh read says until its next clearing, with no Retry.
  await tap(line.getByRole("button", { name: "Retry" }));
  await expect(line.getByTestId("chat-message-body")).toHaveText("Oracle's Claude accounts are used up until Tue Oct 27, 8:00 AM.");
  await expect(line.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(panel.getByText("I couldn't read that just now.")).toHaveCount(0);
});
