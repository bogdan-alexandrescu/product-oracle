import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("settings › sources: my sources, status and last error, sync, allowlist, pause", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();

  const chat = page.getByRole("listitem", { name: "Product chat" });
  await expect(chat).toContainText("Slack");
  await expect(chat).toContainText("Active");
  await expect(chat).toContainText("C0123PRODUCT, C0456FEEDBACK");

  const repo = page.getByRole("listitem", { name: "Example repo" });
  await expect(repo).toContainText("Error");
  await expect(repo.getByTestId("last-error")).toHaveText("The connection was rejected: token expired");

  await chat.getByRole("button", { name: "Sync now" }).click();
  await expect(chat.getByRole("status")).toContainText("Synced: 2 item(s) seen, 1 new version(s)");

  // Edit allowlist and Delete sit in the row's More menu.
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit allowlist" }).click();
  await chat.getByRole("button", { name: "Paste ids" }).click();
  await chat.getByLabel("Channel ids (one per line)").fill("C0123PRODUCT\nC0789ROADMAP");
  await chat.getByRole("button", { name: "Save allowlist" }).click();
  await expect(chat.getByRole("status")).toHaveText("Allowlist saved.");
  await expect(chat).toContainText("C0123PRODUCT, C0789ROADMAP");

  await chat.getByRole("button", { name: "Pause" }).click();
  await expect(chat).toContainText("Paused");
  await expect(chat.getByRole("button", { name: "Sync now" })).toBeDisabled();
  await chat.getByRole("button", { name: "Resume" }).click();
  await expect(chat.getByRole("button", { name: "Sync now" })).toBeEnabled();

  // Resuming a source in error clears its error.
  await repo.getByRole("button", { name: "Pause" }).click();
  await repo.getByRole("button", { name: "Resume" }).click();
  await expect(repo.getByTestId("last-error")).toHaveCount(0);
});

test("settings › sources: add from my connections, upload files, delete", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });

  // A kind without a connector cannot be added.
  await form.getByLabel("Kind").selectOption("google_docs");
  await expect(form).toContainText("The Google Docs connector is not available yet.");
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();

  await form.getByLabel("Kind").selectOption("github");
  await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
  await form.getByLabel("Name").fill("Docs repo");
  await form.getByRole("button", { name: "Paste ids" }).click();
  await form.getByLabel("Repositories (one per line)").fill("example-org/docs");
  await form.getByRole("button", { name: "Add source" }).click();
  const docs = page.getByRole("listitem", { name: "Docs repo" });
  await expect(docs).toContainText("example-org/docs");
  await expect(docs).toContainText("never synced");

  await form.getByLabel("Kind").selectOption("upload");
  await form.getByLabel("Name").fill("Research notes");
  await form.getByRole("button", { name: "Add source" }).click();
  const notes = page.getByRole("listitem", { name: "Research notes" });
  await expect(notes).toContainText("0 item(s)");

  await notes.getByLabel("Upload files to Research notes").setInputFiles([
    { name: "interview.md", mimeType: "text/markdown", buffer: Buffer.from("# Interview\nThe export button is hard to find.") },
    { name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 mock") },
  ]);
  await expect(notes.getByRole("status")).toHaveText("Uploaded 2 file(s).");
  await expect(notes).toContainText("2 item(s)");

  await notes.getByLabel("Upload files to Research notes").setInputFiles([
    { name: "deck.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
  ]);
  await expect(notes.getByRole("alert")).toContainText("only .md, .txt and .pdf files can be uploaded");

  page.once("dialog", (d) => d.accept());
  await docs.getByRole("button", { name: "More actions for Docs repo" }).click();
  await docs.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("listitem", { name: "Docs repo" })).toHaveCount(0);
});

test("/sources: search ranks by confidence and explains the badge", async ({ page }) => {
  await login(page);
  await page.goto("/sources");
  await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();

  await page.getByLabel("Search", { exact: true }).fill("onboarding checklist");
  await page.getByRole("button", { name: "Search" }).click();
  const hits = page.getByTestId("search-hit");
  await expect(hits).toHaveCount(2);
  // The README (fresh, from code) outranks the older chat thread.
  await expect(hits.nth(0)).toContainText("README");
  await expect(hits.nth(0)).toContainText("GitHub");
  await expect(hits.nth(1)).toContainText("Customer question");
  await expect(hits.nth(0).locator("mark").first()).toHaveText("onboarding");

  const badge = hits.nth(0).getByTestId("confidence");
  await expect(badge).toContainText("High confidence");
  await badge.locator("summary").click();
  const factors = badge.getByRole("table", { name: "Confidence factors" });
  await expect(factors).toBeVisible();
  await expect(factors).toContainText("Kind of source");
  await expect(factors).toContainText("0.85");
  await expect(factors).toContainText("Freshness");
  await expect(hits.nth(1).getByTestId("confidence")).toContainText("Medium confidence");

  await page.getByLabel("Source").selectOption({ label: "Product chat" });
  await page.getByRole("button", { name: "Search" }).click();
  await expect(hits).toHaveCount(1);
  await expect(hits.nth(0)).toContainText("Customer question");

  await page.getByLabel("Search", { exact: true }).fill("nothing matches this");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Nothing in your sources matches")).toBeVisible();
});
