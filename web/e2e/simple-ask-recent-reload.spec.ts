import { expect, test, type Page } from "./test";

import {
  MOCK_SCENARIO_KEY,
  MOCK_SLOW_KEY,
  MOCK_SLOW_MS_KEY,
} from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * Recent chats closed and opened again before its first load comes back: only the second
 * load fills the menu. The "simple-chat" mock scenario, the owner, desktop; Recent chats
 * answers late (the mock's slow key): 1.5 s for the first open, 6 s for the second.
 *
 * Card: protects=a reopened Recent chats shows "No chats yet." until its own load comes;
 * fails_when=the first, closed menu's load fills the reopened menu; no_claim=which chats
 * Recent lists (simple-ask-fresh.spec.ts), the menu's look (simple-ask-panel.spec.ts).
 */

const Q = "What is Weekly alert digest about and when does it run?";

async function signIn(page: Page, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

const slowChats = (page: Page, ms: number) =>
  page.evaluate(
    ([slow, msKey, wait]) => {
      localStorage.setItem(slow, "/v1/simple/chats");
      localStorage.setItem(msKey, wait);
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, String(ms)] as const,
  );

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([key]) => localStorage.setItem(key, "simple-chat"),
    [MOCK_SCENARIO_KEY] as const,
  );
});

test("Recent chats closed and opened again before its chats come: only the second load fills it", async ({
  page,
}) => {
  await signIn(page, "/simple");
  await page
    .getByTestId("simple-ask")
    .filter({ visible: true })
    .first()
    .click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(Q);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(
    panel.getByTestId("ask-answer").last().getByTestId("answer-title"),
  ).toHaveText(/^F-\d+\s*Weekly alert digest/); // its code, then its Current-state pill

  const recent = panel.getByRole("button", { name: "Recent chats" });
  const menu = panel.getByTestId("ask-recent-list");
  const rows = menu.getByTestId("ask-recent-row");
  // Opened (its chats come in 1.5 s), closed with Escape, opened again (its chats come in 6 s).
  await slowChats(page, 1500);
  const opened = Date.now();
  await recent.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await slowChats(page, 6000);
  await recent.click();
  await expect(menu).toBeVisible();
  // The first load is back by now; the reopened menu still waits on its own.
  await page.waitForTimeout(Math.max(0, opened + 3000 - Date.now()));
  await expect(rows).toHaveCount(0);
  await expect(menu).toContainText("No chats yet.");
  // Then its own load fills it.
  await expect(rows.first().getByTestId("ask-recent-question")).toHaveText(Q, {
    timeout: 10000,
  });
});
