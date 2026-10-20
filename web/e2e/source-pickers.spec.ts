import { expect, type Locator, type Page, test } from "@playwright/test";

import { login } from "./helpers";

async function addForm(page: Page, kind: "slack" | "github"): Promise<Locator> {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption(kind);
  return form;
}

test("slack picker: search, pick channels and a since date, add the source", async ({ page }) => {
  const form = await addForm(page, "slack");
  const picker = form.getByRole("group", { name: "Slack channels" });
  await expect(picker.getByRole("checkbox", { name: "#product" })).toBeVisible();
  // Private channels carry a lock; members are counted. No ids to type.
  await expect(picker.getByTestId("pick-row").filter({ hasText: "#roadmap" }).getByTitle("Private")).toBeVisible();
  await expect(picker.getByTestId("pick-row").filter({ hasText: "#general" })).toContainText("128");
  await expect(form.getByLabel("Channel ids (one per line)")).toHaveCount(0);

  await picker.getByLabel("Search channels").fill("feed");
  await expect(picker.getByRole("checkbox")).toHaveCount(1);
  await picker.getByRole("checkbox", { name: "#customer-feedback" }).check();
  await picker.getByLabel("Search channels").fill("#road");
  await picker.getByRole("checkbox", { name: "#roadmap" }).check();
  await expect(picker.getByTestId("picked-count")).toHaveText("2 selected");

  // Clearing the search keeps the picks and lists them first.
  await picker.getByLabel("Search channels").fill("");
  await expect(picker.getByRole("checkbox", { name: "#customer-feedback" })).toBeChecked();
  await picker.getByLabel("Since").fill("2026-01-01");

  await form.getByLabel("Name").fill("Feedback chat");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Feedback chat" });
  await expect(row).toContainText("C0456FEEDBACK, G0789ROADMAP");

  // Editing reopens the picker with the picks and the date.
  await row.getByRole("button", { name: "More actions for Feedback chat" }).click();
  await row.getByRole("menuitem", { name: "Edit allowlist" }).click();
  const edit = row.getByRole("group", { name: "Slack channels" });
  await expect(edit.getByTestId("picked-count")).toHaveText("2 selected");
  await expect(edit.getByRole("checkbox", { name: "#roadmap" })).toBeChecked();
  await expect(edit.getByLabel("Since")).toHaveValue("2026-01-01");
});

test("slack picker: edit a source's channels, load more, paste ids", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit allowlist" }).click();
  const picker = chat.getByRole("group", { name: "Slack channels" });
  await expect(picker.getByRole("checkbox", { name: "#product" })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: "#customer-feedback" })).toBeChecked();
  await expect(picker.getByTestId("picked-count")).toHaveText("2 selected");

  await picker.getByRole("checkbox", { name: "#customer-feedback" }).uncheck();
  await picker.getByRole("button", { name: "Load more" }).click();
  await picker.getByRole("checkbox", { name: "#partners" }).check();
  await chat.getByRole("button", { name: "Save allowlist" }).click();
  await expect(chat.getByRole("status")).toHaveText("Allowlist saved.");
  await expect(chat).toContainText("C0123PRODUCT, C0120PARTNERS");

  // Paste ids stays as a fallback and keeps the picks.
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit allowlist" }).click();
  await chat.getByRole("button", { name: "Paste ids" }).click();
  const ids = chat.getByLabel("Channel ids (one per line)");
  await expect(ids).toHaveValue("C0123PRODUCT\nC0120PARTNERS");
  await ids.fill("C0123PRODUCT\nC0999UNLISTED");
  await chat.getByRole("button", { name: "Pick from list" }).click();
  // An id the list does not show is still picked, by id.
  await expect(picker.getByRole("checkbox", { name: "C0999UNLISTED" })).toBeChecked();
  await chat.getByRole("button", { name: "Save allowlist" }).click();
  await expect(chat).toContainText("C0123PRODUCT, C0999UNLISTED");
});

test("slack picker: a rate limit reads as a retry", async ({ page }) => {
  const form = await addForm(page, "slack");
  const picker = form.getByRole("group", { name: "Slack channels" });
  await picker.getByLabel("Search channels").fill("ratelimit");
  await expect(picker.getByRole("alert")).toHaveText("Slack is busy: try again in 30 seconds");
  await picker.getByRole("button", { name: "Retry" }).click();
  await expect(picker.getByRole("alert")).toHaveText("Slack is busy: try again in 30 seconds");
  await picker.getByLabel("Search channels").fill("pro");
  await expect(picker.getByRole("checkbox", { name: "#product" })).toBeVisible();
  await expect(picker.getByRole("alert")).toHaveCount(0);
});

test("github picker: search, pick repos, add, edit", async ({ page }) => {
  const form = await addForm(page, "github");
  const picker = form.getByRole("group", { name: "GitHub repositories" });
  const app = picker.getByTestId("pick-row").filter({ hasText: "example-org/example-app" });
  await expect(app.getByTitle("Private")).toBeVisible();
  await expect(app.getByTestId("last-push")).toBeVisible();
  await expect(form.getByLabel("Repositories to pull in (one per line)")).toHaveCount(0);

  await picker.getByLabel("Search repositories").fill("invoices");
  await expect(picker.getByRole("checkbox")).toHaveCount(1);
  await picker.getByRole("checkbox", { name: "example-org/billing-api" }).check();
  await picker.getByLabel("Search repositories").fill("partner");
  await picker.getByRole("checkbox", { name: "partner-org/webhooks" }).check();
  await expect(picker.getByTestId("picked-count")).toHaveText("2 selected");

  await form.getByLabel("Name").fill("Billing code");
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Billing code" });
  await expect(row).toContainText("example-org/billing-api, partner-org/webhooks");

  const repo = page.getByRole("listitem", { name: "Example repo" });
  await repo.getByRole("button", { name: "More actions for Example repo" }).click();
  await repo.getByRole("menuitem", { name: "Edit allowlist" }).click();
  const edit = repo.getByRole("group", { name: "GitHub repositories" });
  await expect(edit.getByRole("checkbox", { name: "example-org/example-app" })).toBeChecked();
  await edit.getByRole("checkbox", { name: "example-org/docs" }).check();
  await repo.getByRole("button", { name: "Save allowlist" }).click();
  await expect(repo).toContainText("example-org/example-app, example-org/docs");
});

test("slack picker: a date range, since and until", async ({ page }) => {
  const form = await addForm(page, "slack");
  const picker = form.getByRole("group", { name: "Slack channels" });
  await picker.getByRole("checkbox", { name: "#product" }).check();
  await expect(picker.getByText("Narrowing the range removes messages outside it at the next sync.")).toBeVisible();

  // An until before since is flagged here and refused by the API.
  await picker.getByLabel("Since").fill("2026-03-01");
  await picker.getByLabel("Until").fill("2026-02-01");
  await expect(picker.getByRole("alert")).toHaveText("Until must be on or after Since.");
  await expect(picker.getByLabel("Until")).toHaveAttribute("min", "2026-03-01");
  await form.getByLabel("Name").fill("Q1 product chat");
  await form.getByRole("button", { name: "Add source" }).click();
  await expect(form.getByText("until must be on or after since")).toBeVisible();

  await picker.getByLabel("Until").fill("2026-03-31");
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Q1 product chat" });
  await expect(row).toContainText("C0123PRODUCT");

  // Editing reopens the picker with both dates; clearing until keeps since.
  await row.getByRole("button", { name: "More actions for Q1 product chat" }).click();
  await row.getByRole("menuitem", { name: "Edit allowlist" }).click();
  const edit = row.getByRole("group", { name: "Slack channels" });
  await expect(edit.getByLabel("Since")).toHaveValue("2026-03-01");
  await expect(edit.getByLabel("Until")).toHaveValue("2026-03-31");
  await edit.getByLabel("Until").fill("");
  await row.getByRole("button", { name: "Save allowlist" }).click();
  await expect(row.getByRole("status")).toHaveText("Allowlist saved.");
  await row.getByRole("button", { name: "More actions for Q1 product chat" }).click();
  await row.getByRole("menuitem", { name: "Edit allowlist" }).click();
  await expect(edit.getByLabel("Since")).toHaveValue("2026-03-01");
  await expect(edit.getByLabel("Until")).toHaveValue("");
});

test("github picker: repos hidden by an organization's SSO read as a hint", async ({ page }) => {
  const form = await addForm(page, "github");
  const picker = form.getByRole("group", { name: "GitHub repositories" });
  await expect(picker.getByRole("note")).toHaveCount(0);
  await picker.getByLabel("Search repositories").fill("sso");
  await expect(picker.getByRole("note")).toContainText("1 organization hides its repositories");
  await expect(picker.getByRole("note")).toContainText("single sign-on (SAML)");
  await picker.getByLabel("Search repositories").fill("docs");
  await expect(picker.getByRole("note")).toHaveCount(0);
});

test("add form: changing the connection clears the picks, keeps the dates", async ({ page }) => {
  const form = await addForm(page, "slack");
  const picker = form.getByRole("group", { name: "Slack channels" });
  await picker.getByRole("checkbox", { name: "#product" }).check();
  await picker.getByLabel("Since").fill("2026-01-01");
  await expect(picker.getByTestId("picked-count")).toHaveText("1 selected");

  await form.getByLabel("Connection").selectOption({ label: "Partner workspace" });
  await expect(picker.getByTestId("picked-count")).toHaveText("0 selected");
  await expect(picker.getByRole("checkbox", { name: "#product" })).not.toBeChecked();
  await expect(picker.getByLabel("Since")).toHaveValue("2026-01-01");
});
