import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/**
 * S4 Freshness: "N new items since draft k, refresh?" on a PRD draft. On the mock layer
 * ("draft-new-items" scenario: the D10 run-review seed, a Baseline to PRD run the admin started
 * that drafted usage-alerts v2; a Sync now of Product chat brings in one new message), driven as a
 * person would. Each test states its card: protects / fails_when / no_claim.
 */

const LATEST = "/documents/usage-alerts/v/2";
const banner = (page: Page) => page.getByTestId("draft-new-items");

async function start(page: Page, email?: string) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "draft-new-items"]);
  await login(page, email);
}

async function syncProductChat(page: Page) {
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Product chat" });
  await row.getByRole("button", { name: "Sync now" }).click();
  await expect(row.getByRole("status")).toContainText("Synced:");
}

test("the draft's author sees what synced since the draft and refreshes it", async ({ page }) => {
  // protects=S4 "N new items since draft k, refresh?"; fails_when=no line after a sync brings
  // in an item, a line before it, or Refresh does not start a Baseline to PRD run on this PRD;
  // no_claim=the API's counting rules (api/tests/test_draft_new_items.py).
  await start(page);
  await page.goto(LATEST);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  await syncProductChat(page);
  await page.goto(LATEST);
  await expect(banner(page)).toHaveText(/1 new or changed item in your sources since draft v2 read them/);

  await banner(page).getByRole("button", { name: "Refresh" }).click();
  const dialog = page.getByRole("dialog", { name: "Refresh draft" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Baseline to PRD/ })).toBeChecked();
  await expect(dialog.getByLabel("PRD document")).toHaveValue("usage-alerts");
});

test("an earlier version and another member show no line", async ({ page }) => {
  // protects=S5/S6, sources are private: only the author learns the number, and only on the
  // latest draft; fails_when=another member sees the count, or v1 shows it; no_claim=run tokens.
  await start(page);
  await syncProductChat(page);
  await page.goto("/documents/usage-alerts/v/1");
  await expect(page.getByText("You are viewing an earlier version.")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(LATEST);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});
