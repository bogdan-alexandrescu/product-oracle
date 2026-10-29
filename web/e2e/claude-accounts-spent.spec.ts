import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { POOL_SPENT_SCENARIO, SETUP_TOKEN_PREFIX } from "../lib/api/mock/claude-accounts";

import { login, openTab } from "./helpers";

/*
 * #403 through the UI, on the mock layer. The "pool-spent" scenario has one account,
 * "weekly", at 9% of its 5-hour window and 95% of its weekly one (clears in 2d 13h), so
 * the pool will not choose it; the "discussion-replies" seed's failed Oracle reply then
 * carries the gateway's refusal. The default pool's "work" account is 88% through its
 * week on an old reading, which the pool also refuses.
 *
 * Card (E2E): protects=the page says what the gateway does (Spent until, not Available),
 * the owner's AI-off notice, and the refusal's worded time; fails_when=a spent account
 * reads Available, no notice, or an ISO time, or a fallback set on a spent pool leaves the
 * notice saying the AI is off; no_claim=the pool's rule (pytest:
 * test_claude_accounts_api.py).
 */

const OWNER = "admin@example.com";
const APPROVER = "approver@example.com";
const WORDED = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d\d [AP]M P[DS]T/;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d/;

const withSpentPool = (page: Page) => page.addInitScript(([key, name]) => localStorage.setItem(key, name), [MOCK_SCENARIO_KEY, POOL_SPENT_SCENARIO]);
const row = (page: Page, label: string) => page.getByTestId(`account-row-${label}`);
const detail = (page: Page) => page.getByTestId("account-detail");
// Next keeps a visited route mounted but hidden: the notice on screen is the visible one.
const notice = (page: Page) => page.getByTestId("ai-off").filter({ visible: true });

async function openAccounts(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-claude-accounts").click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

test("a spent account reads Spent until a worded time, and the owner is told Oracle's AI is off", async ({ page }) => {
  await withSpentPool(page);
  await login(page, OWNER);

  // Home: one notice, what is off and until when, with the way to the fix.
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText("Oracle's AI is off");
  await expect(notice(page)).toContainText("live replies, interviews and Ask Oracle");
  await expect(notice(page)).toContainText(WORDED);
  await expect(notice(page)).not.toContainText(ISO);

  await notice(page).getByRole("link", { name: "Claude accounts" }).click();
  await expect(page).toHaveURL(/\/settings\/claude-accounts$/);

  // The list and the inspector say what the gateway decides by.
  await expect(row(page, "weekly")).toContainText(/Spent until/);
  await expect(row(page, "weekly")).toContainText(WORDED);
  await expect(row(page, "weekly")).not.toContainText("Available");
  await expect(detail(page).getByRole("heading", { name: "weekly" })).toBeVisible();
  await expect(detail(page)).toContainText("Spent until");
  await expect(detail(page)).toContainText("weekly limit");
  await expect(page.getByTestId("accounts-summary")).toContainText("1 account · 0 available");

  // The same notice here, once, with both ways out.
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText("Every Claude account is spent");
  await expect(notice(page)).toContainText(WORDED);
  await expect(notice(page)).toContainText("set a fallback credential (used while no account is added or every account is spent)");
  await expect(notice(page)).not.toContainText("used only while no account is added");
  await notice(page).getByRole("button", { name: "Set a fallback credential" }).click();
  await expect(page.getByLabel("Setup-token or API key")).toBeFocused();
  await notice(page).getByRole("button", { name: "Add an account" }).click();
  await expect(page.getByRole("button", { name: "+ Add account" })).toHaveAttribute("aria-expanded", "true");
});

test("setting a fallback on a spent pool turns Oracle's AI back on, on the fallback until the window clears", async ({ page }) => {
  await withSpentPool(page);
  await login(page, OWNER);
  await openAccounts(page);
  await expect(notice(page)).toContainText("Oracle's AI is off");

  await notice(page).getByRole("button", { name: "Set a fallback credential" }).click();
  const fallback = page.getByTestId("fallback");
  await fallback.getByLabel("Setup-token or API key").fill(`${SETUP_TOKEN_PREFIX}01-example-abcd`);
  await fallback.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("fallback-status")).toContainText("Claude setup-token …abcd");

  // Still one notice, now saying Oracle runs on the fallback, and until when.
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).not.toContainText("Oracle's AI is off");
  await expect(notice(page)).toContainText("Oracle is using the fallback credential until");
  await expect(notice(page)).toContainText(WORDED);
  await expect(notice(page)).not.toContainText(ISO);
  await expect(notice(page)).toContainText("Every Claude account is spent (weekly limit)");
  await expect(notice(page).getByRole("button", { name: "Set a fallback credential" })).toHaveCount(0);
  await expect(row(page, "weekly")).toContainText("Spent until");

  // Home says the same.
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-home").click();
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText("Oracle is using the fallback credential until");
  await expect(notice(page)).toContainText(WORDED);
});

test("the notice is the owner's: an approver sees the spent state but no notice", async ({ page }) => {
  await withSpentPool(page);
  await login(page, APPROVER);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await openAccounts(page);
  await expect(row(page, "weekly")).toContainText("Spent until");
  await expect(notice(page)).toHaveCount(0);
});

test("with an account that takes calls there is no notice, and a spent one beside it still reads spent", async ({ page }) => {
  await login(page, OWNER);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await openAccounts(page);
  await expect(page.getByTestId("accounts-summary")).toContainText("4 accounts · 2 available");
  await expect(row(page, "work")).toContainText("Spent until");
  await expect(row(page, "personal")).toContainText("Available");
  await expect(notice(page)).toHaveCount(0);
});

test("the discussion refusal gives the clearing time in words", async ({ page }) => {
  await withSpentPool(page);
  await login(page, OWNER);
  await page.goto("/documents/team-workspaces/v/2");
  await openTab(page, "Feedback");
  const panel = page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
  await panel.getByTestId("feedback-discussions").click();
  await panel.getByTestId("discussion-row").filter({ hasText: "Caps: ship without detection?" }).first().click();
  const error = page.getByTestId("discussion-thread").filter({ visible: true }).getByTestId("oracle-reply").last().getByTestId("oracle-reply-error");
  // A failed reply says what was so when it ran, not now (#644 re-review).
  await expect(error).toContainText("every Claude account was spent; the earliest window was due to clear");
  await expect(error).toContainText(WORDED);
  await expect(error).not.toContainText(ISO);
});
