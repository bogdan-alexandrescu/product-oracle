import { expect, test, type Locator, type Page } from "./test";

import { SIMPLE_CHAT_POOL_SPENT_SCENARIO } from "../lib/api/mock/claude-accounts";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * spent-pool: when no Claude account in Oracle's pool can take the chat reader's call (every
 * one spent), Simple's Ask Oracle says until when, in the company's time zone and month
 * first, with no Retry, instead of "I couldn't read that just now.". The
 * "simple-chat-pool-spent" mock scenario: "simple-chat" on "pool-spent"'s spent pool, whose
 * weekly window clears Sat Oct 24, 6:00 PM (Pacific; the mock's now is Oct 22, 2026).
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

for (const phone of [false, true]) {
  test(`Ask Oracle on a spent Claude pool says until when, with no Retry (${phone ? "phone" : "desktop"})`, async ({ page }) => {
    // protects: a line Ask Oracle could not read because every Claude account is spent reads "Oracle's Claude accounts are used up until Sat Oct 24, 6:00 PM." and offers no Retry
    // fails_when: it shows "I couldn't read that just now.", a Retry button, an ISO time or the pool's raw error
    // no_claim: the line after the window clears (api tests: test_simple_chat_reader.py)
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(([key, name]) => localStorage.setItem(key, name), [MOCK_SCENARIO_KEY, SIMPLE_CHAT_POOL_SPENT_SCENARIO] as const);
    await signIn(page, "/simple/roadmap");
    await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await expect(panel.getByTestId("ask-chat")).toBeVisible();
    await panel.getByRole("textbox", { name: "Message Oracle" }).fill("can we push Delivery pipeline v2 out a quarter");
    await tap(panel.getByRole("button", { name: "Send" }));

    const line = panel.getByTestId("ask-chat-thread").getByTestId("chat-message").last();
    await expect(line).toHaveAttribute("data-kind", "failed");
    await expect(line.getByTestId("chat-message-body")).toHaveText("Oracle's Claude accounts are used up until Sat Oct 24, 6:00 PM.");
    await expect(line.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(panel.getByText("I couldn't read that just now.")).toHaveCount(0);
  });
}
