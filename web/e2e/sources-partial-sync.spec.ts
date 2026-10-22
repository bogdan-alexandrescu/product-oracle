import { expect, test } from "@playwright/test";

import { login } from "./helpers";

// #249: a sync that stopped on the provider's rate limit kept what it stored; the row says
// when it last ran and that it is incomplete, not "never synced".
test("settings › sources: a partial sync reads partly synced until a sync finishes", async ({ page }) => {
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

  const busy = page.getByRole("listitem", { name: "Busy chat" });
  const synced = busy.getByTestId("source-synced");
  await expect(synced).toHaveText("never synced");

  await busy.getByRole("button", { name: "Sync now" }).click();
  await expect(busy.getByRole("status")).toHaveText("Rate limited: the next sync resumes where this one stopped.");
  await expect(synced).toHaveText(/^partly synced .+ · resumes on the next sync$/);
  await expect(busy).not.toContainText("never synced");

  // Reloading keeps it: the row reads what the source stored, not the sync's notice.
  await page.reload();
  await expect(synced).toHaveText(/^partly synced .+ · resumes on the next sync$/);

  await busy.getByRole("button", { name: "Sync now" }).click();
  await expect(busy.getByRole("status")).toContainText("Synced:");
  await expect(synced).toHaveText(/^last sync .+/);
  await expect(busy).not.toContainText("partly synced");
});
