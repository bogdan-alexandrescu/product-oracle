import { expect, test, type Page } from "./test";

import { POOL_SPENT_SCENARIO } from "../lib/api/mock/claude-accounts";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login, standInClaudePage } from "./helpers";

/*
 * QA fixes on Settings › Claude accounts (qa-settings-17 to -20, -44), driven through the UI
 * on the mock layer. The default pool: "personal" (live reading), "work" (88% of its week,
 * read 50 min ago, so the pool stops giving it calls), "spare" (never measured) and
 * "old-laptop" (its sign-in expired, last given out 9 days ago).
 */

const WORDED = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d\d [AP]M P[DS]T/;

async function openAccounts(page: Page, phone = false) {
  await standInClaudePage(page);
  await login(page);
  if (phone) await page.goto("/settings/claude-accounts");
  else {
    await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
    await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-claude-accounts").click();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
}

const row = (page: Page, label: string) => page.getByTestId(`account-row-${label}`);
const detail = (page: Page) => page.getByTestId("account-detail");

test("qa-settings-17: a spent account says why it is spent while its gauge reads 88%", async ({ page }) => {
  await openAccounts(page);
  await expect(row(page, "work")).toContainText("Spent until");
  await row(page, "work").getByRole("button").click();
  await expect(detail(page).getByRole("heading", { name: "work" })).toBeVisible();
  await expect(detail(page).getByTestId("tile-7d used")).toContainText("88%");
  const spent = detail(page).getByTestId("fact-spent");
  await expect(spent).toContainText("Near its weekly limit");
  await expect(spent).toContainText("88% of its 7-day window is used");
  await expect(spent).toContainText("less than 15% of a window is left");
  await expect(detail(page)).not.toContainText("Over its");
});

test("fix4 review: an account at 100% of its week reads At its weekly limit, without the 15% reason", async ({ page }) => {
  // The "pool-spent" scenario's only account, "weekly", has used all of its 7-day window.
  await page.addInitScript(([key, name]) => localStorage.setItem(key, name), [MOCK_SCENARIO_KEY, POOL_SPENT_SCENARIO]);
  await openAccounts(page);
  await expect(row(page, "weekly")).toContainText("Spent until");
  await expect(row(page, "weekly").locator('[title^="At its weekly limit"]')).toHaveCount(1);
  await row(page, "weekly").getByRole("button").click();
  await expect(detail(page).getByTestId("tile-7d used")).toContainText("100%");
  const spent = detail(page).getByTestId("fact-spent");
  await expect(spent).toContainText("At its weekly limit");
  await expect(spent).toContainText("100% of its 7-day window is used");
  await expect(spent).not.toContainText("Near its");
  await expect(spent).not.toContainText("15%");
});

test("qa-settings-18: the list and the pane read in plain words, no 5h, clears or 9d", async ({ page }) => {
  await openAccounts(page);
  const table = page.getByTestId("account-list");
  await expect(table.getByRole("columnheader", { name: "5-hour use" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Next reset" })).toBeVisible();
  await expect(row(page, "personal").getByTestId("clears")).toHaveText(/^5-hour window resets in 1h \d\dm$/);
  await expect(row(page, "work").getByTestId("clears")).toHaveText(/^7-day window resets in ~\d+h \d\dm$/);
  await expect(row(page, "spare").getByTestId("clears")).toHaveText("Not measured");
  await expect(page.getByTestId("accounts-foot")).toContainText("4 accounts · Usage read 2–50 min ago");
  await expect(table).not.toContainText(/clears|given out \d+d/);

  // The pane opens on old-laptop: its last job, in words.
  await expect(detail(page).getByRole("heading", { name: "old-laptop" })).toBeVisible();
  const given = detail(page).getByTestId("tile-Last given out");
  await expect(given).toContainText("Last given out");
  await expect(given).toContainText("9 days ago");
  await expect(given).not.toContainText(/\b9d\b/);
  await expect(detail(page).getByTestId("tile-Clears")).toContainText("Next reset");
});

test("qa-settings-19: one date style and one relative style on the screen", async ({ page }) => {
  await openAccounts(page);
  // Absolute times all read "Sat Oct 31, 12:56 AM PDT".
  await expect(row(page, "work")).toContainText(WORDED);
  await expect(detail(page).getByTestId("tile-Last given out")).toContainText(WORDED);
  // Relative ones all read "4 min ago", "9 days ago".
  await expect(page.getByTestId("refresh-sweep")).toHaveText(/^Last checked \d+ min ago$/);
  await expect(detail(page)).toContainText(/Sign-in needed · \d+ min ago/);
  for (const part of [page.getByTestId("account-list"), page.getByTestId("accounts-foot"), detail(page)])
    await expect(part).not.toContainText(/\b\d+[mhd] ago\b/);
});

test("qa-settings-20: an account that needs a sign-in cannot be made available, and says why", async ({ page }) => {
  await openAccounts(page);
  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: "old-laptop" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Make available", exact: true })).toBeDisabled();
  await expect(pane.getByText("It can be made available once someone signs in to it again", { exact: false })).toBeVisible();
  // An account with a working sign-in still can.
  await row(page, "work").getByRole("button").click();
  await expect(pane.getByRole("heading", { name: "work" })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
});

test("qa-settings-44: on a phone, tapping an account brings its pane into view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAccounts(page, true);
  await row(page, "personal").click();
  await expect(detail(page).getByRole("heading", { name: "personal" })).toBeInViewport();
});
