import { expect, test } from "./test";

import { login } from "./helpers";

const LEGACY = "Legacy all-hands chat";
const MESSAGE = "Allowlist at most 100 channels: edit this source to sync it again";

test("settings › sources: a source needing attention shows why, refuses to sync, and Edit puts it right", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  // qa4-settings-6: with Product docs (lost access) and Drive folders (reconnect to choose files).
  await expect(page.getByTestId("sources-attention")).toHaveText("3 need attention");

  const row = page.getByRole("listitem", { name: LEGACY });
  const badge = row.locator('[data-kind="warn"]').filter({ hasText: "Needs attention" });
  await expect(badge).toBeVisible();
  // Warning tone, not the error one.
  await expect(row.locator('[data-kind="crit"]')).toHaveCount(0);
  await expect(row.getByTestId("last-error")).toHaveText(MESSAGE);
  await expect(row.getByTestId("needs-attention")).toHaveClass(/bg-warn-bg/);

  // A sync answers needs_attention: the state and message stay.
  await row.getByRole("button", { name: "Sync now" }).click();
  await expect(row.getByTestId("last-error")).toHaveText(MESSAGE);
  await expect(badge).toBeVisible();

  // Edit opens the picker; over 100 channels it says how many to untick, and the API refuses.
  await row.getByRole("button", { name: `Edit ${LEGACY}` }).click();
  const picker = row.getByRole("group", { name: "Slack channels" });
  await expect(picker.getByTestId("picked-count")).toHaveText("120 selected");
  await expect(picker.getByTestId("too-many-channels")).toHaveText("A source takes at most 100 channels: untick 20 to save it.");
  await row.getByRole("button", { name: "Save channels" }).click();
  await expect(row.getByRole("alert").filter({ hasText: "allowlist at most 100 channels" })).toBeVisible();

  // Back within the rules: active again, and the next sync goes through.
  await picker.getByRole("button", { name: "Paste ids" }).click();
  await row.getByLabel("Channel ids (one per line)").fill("C0100GENERAL\nC0109RELEASES");
  await row.getByRole("button", { name: "Save channels" }).click();
  await expect(row.getByRole("status")).toHaveText("Channels saved.");
  await expect(row).toContainText("Active");
  await expect(row.getByTestId("needs-attention")).toHaveCount(0);
  await expect(page.getByTestId("sources-attention")).toHaveText("2 need attention");
  await row.getByRole("button", { name: "Sync now" }).click();
  await expect(row.getByRole("status")).toContainText("Synced:");
});

test("inbox: my sources that need attention, with Edit opening the source", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const group = page.getByTestId("inbox-sources");
  await expect(group).toContainText(LEGACY);
  await expect(group).toContainText(MESSAGE);
  // Only the source needing attention, not the one in error.
  await expect(group).not.toContainText("Example repo");

  await group.getByRole("link", { name: `Edit ${LEGACY}` }).click();
  await expect(page).toHaveURL(/\/settings\/sources#source-/);
  const row = page.getByRole("listitem", { name: LEGACY });
  // Arrives with the editor open.
  await expect(row.getByRole("group", { name: "Slack channels" })).toBeVisible();
  await expect(row.getByTestId("picked-count")).toHaveText("120 selected");
});
