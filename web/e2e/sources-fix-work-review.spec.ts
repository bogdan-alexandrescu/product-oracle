import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SYNC_SUPERSEDED_KEY } from "../lib/api/mock/sources";
import { MOCK_FAIL_KEY, MOCK_ROLE_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * fix-work review on /sources, driven through the UI on the mock: the read-only note waits
 * for the capabilities, a sync that did not finish reads as on Settings > Sources, and an
 * item without a name reads by its id.
 */

const table = (page: Page): Locator => page.getByTestId("coverage-table");
const row = (page: Page, name: string): Locator => table(page).locator("tr[data-row]").filter({ hasText: name });
const inspector = (page: Page): Locator => page.getByTestId("coverage-inspector");

async function openCoverage(page: Page) {
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
  await expect(inspector(page)).toBeVisible();
}

test("fix-work review: while the capabilities load, an owner sees no read-only note, then Sync now", async ({ page }) => {
  await login(page);
  await page.evaluate(
    ([slow, ms, path]) => {
      localStorage.setItem(slow, path);
      localStorage.setItem(ms, "8000");
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, "/v1/me/capabilities"] as const,
  );
  await openCoverage(page);
  await expect(inspector(page).getByRole("heading", { name: "Product chat" })).toBeVisible();
  await expect(inspector(page).getByTestId("sync-viewer-note")).toHaveCount(0);
  await expect(inspector(page).getByRole("button", { name: "Sync now" })).toHaveCount(0);
  // Once the capabilities answer: Sync now, and still no note.
  await expect(inspector(page).getByRole("button", { name: "Sync now" })).toBeVisible({ timeout: 15_000 });
  await expect(inspector(page).getByTestId("sync-viewer-note")).toHaveCount(0);
});

test("fix-work review: when the capabilities fail, an owner gets the error with Retry, not the read-only note", async ({ page }) => {
  await login(page);
  await page.evaluate(([key, path]) => localStorage.setItem(key, path), [MOCK_FAIL_KEY, "/v1/me/capabilities"] as const);
  await openCoverage(page);
  const failed = page.getByTestId("caps-error").filter({ visible: true }).first();
  await expect(failed).toBeVisible();
  await expect(inspector(page).getByTestId("sync-viewer-note")).toHaveCount(0);
  await expect(inspector(page).getByRole("button", { name: "Sync now" })).toHaveCount(0);

  await page.evaluate((key) => localStorage.removeItem(key), MOCK_FAIL_KEY);
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(inspector(page).getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(inspector(page).getByTestId("sync-viewer-note")).toHaveCount(0);
});

test("fix-work review: a viewer's note says what they can't do in plain words", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY] as const);
  await login(page);
  await openCoverage(page);
  const note = inspector(page).getByTestId("sync-viewer-note");
  await expect(note).toHaveText("You can read coverage, but not sync or edit sources. Ask an owner if you need to.");
  await expect(note).not.toContainText(/commenter|viewer/i);
});

test("fix-work review: a rate-limited sync reads as on Settings > Sources, not as an error", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("slack");
  await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
  await form.getByLabel("Name").fill("Busy chat");
  await form.getByRole("button", { name: "Paste ids" }).click();
  // The mock's Slack rate-limits the first sync of this channel part way through.
  await form.getByLabel("Channel ids (one per line)").fill("C0RATELIMIT");
  await form.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("listitem", { name: "Busy chat" })).toBeVisible();

  await openCoverage(page);
  await row(page, "Busy chat").click();
  await expect(inspector(page).getByRole("heading", { name: "Busy chat" })).toBeVisible();
  await inspector(page).getByRole("button", { name: "Sync now" }).click();
  await expect(inspector(page).getByTestId("sync-notice")).toHaveText("Rate limited: the next sync resumes where this one stopped.");
  await expect(page.getByRole("alert").filter({ hasText: /rate limited|edited|did not finish/i })).toHaveCount(0);
});

test("fix-work review: a sync superseded by an edit reads as on Settings > Sources, not as an error", async ({ page }) => {
  await login(page);
  await openCoverage(page);
  await row(page, "Product chat").click();
  await expect(inspector(page).getByRole("heading", { name: "Product chat" })).toBeVisible();
  // Someone edits Product chat while its next sync runs.
  await page.evaluate(([key, name]) => localStorage.setItem(key, name), [MOCK_SYNC_SUPERSEDED_KEY, "Product chat"] as const);
  await inspector(page).getByRole("button", { name: "Sync now" }).click();
  await expect(inspector(page).getByTestId("sync-notice")).toHaveText(
    "Not synced: this source was edited while it synced. Sync again to use the new selection.",
  );
  await expect(page.getByRole("alert").filter({ hasText: /rate limited|edited|did not finish/i })).toHaveCount(0);
});

test("fix-work review: an item without a name is listed by its id under Not read", async ({ page }) => {
  await login(page);
  await openCoverage(page);
  await row(page, "Product docs").click();
  await expect(inspector(page).getByRole("heading", { name: "Product docs" })).toBeVisible();
  const notRead = inspector(page).getByRole("list", { name: "Not read" });
  await expect(notRead).toContainText("Item 1DocInterviewsExample");
  await expect(notRead).not.toContainText("Unnamed item");
});
