import { expect, type Locator, type Page, test } from "@playwright/test";

import { SOURCES_STORAGE_KEY } from "../lib/api/mock/sources";
import { login } from "./helpers";

/*
 * Cards for the A4 named-picks cases (issue #143), each test below that names an AC:
 * protects=people see names, not ids, in plain words; fails_when=a row or menu shows ids
 * or "allowlist"; no_claim=the mock's PATCH stands in for the API's (the API tests cover it).
 */

/** A source's config as the mock API stored it (it runs in the page: no request to watch). */
async function savedConfig(page: Page, name: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    ([key, name]) => JSON.parse(localStorage.getItem(key)!).sources.find((s: { name: string }) => s.name === name)?.config,
    [SOURCES_STORAGE_KEY, name],
  );
}

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
  // AC 9: the row names the channels; no id is on the page.
  await expect(row.getByTestId("source-picks")).toHaveText("#customer-feedback, #roadmap");
  await expect(page.getByText("C0456FEEDBACK")).toHaveCount(0);
  expect((await savedConfig(page, "Feedback chat"))?.labels).toEqual({
    C0456FEEDBACK: "#customer-feedback",
    G0789ROADMAP: "#roadmap",
  });

  // Editing reopens the picker with the picks and the date.
  await row.getByRole("button", { name: "More actions for Feedback chat" }).click();
  await row.getByRole("menuitem", { name: "Edit channels" }).click();
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
  await chat.getByRole("menuitem", { name: "Edit channels" }).click();
  const picker = chat.getByRole("group", { name: "Slack channels" });
  await expect(picker.getByRole("checkbox", { name: "#product" })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: "#customer-feedback" })).toBeChecked();
  await expect(picker.getByTestId("picked-count")).toHaveText("2 selected");

  await picker.getByRole("checkbox", { name: "#customer-feedback" }).uncheck();
  await picker.getByRole("button", { name: "Load more" }).click();
  await picker.getByRole("checkbox", { name: "#partners" }).check();
  await chat.getByRole("button", { name: "Save channels" }).click();
  await expect(chat.getByRole("status")).toHaveText("Channels saved.");
  await expect(chat.getByTestId("source-picks")).toHaveText("#product, #partners");

  // Paste ids stays as a fallback and keeps the picks.
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit channels" }).click();
  await chat.getByRole("button", { name: "Paste ids" }).click();
  const ids = chat.getByLabel("Channel ids (one per line)");
  await expect(ids).toHaveValue("C0123PRODUCT\nC0120PARTNERS");
  await ids.fill("C0123PRODUCT\nC0999UNLISTED");
  await chat.getByRole("button", { name: "Pick from list" }).click();
  // An id the list does not show is still picked, by id.
  await expect(picker.getByRole("checkbox", { name: "C0999UNLISTED" })).toBeChecked();
  await chat.getByRole("button", { name: "Save channels" }).click();
  // A pick no list has named keeps its id.
  await expect(chat.getByTestId("source-picks")).toHaveText("#product, C0999UNLISTED");
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
  await repo.getByRole("menuitem", { name: "Edit repositories" }).click();
  const edit = repo.getByRole("group", { name: "GitHub repositories" });
  await expect(edit.getByRole("checkbox", { name: "example-org/example-app" })).toBeChecked();
  await edit.getByRole("checkbox", { name: "example-org/docs" }).check();
  await repo.getByRole("button", { name: "Save repositories" }).click();
  await expect(repo).toContainText("example-org/example-app, example-org/docs");
});

test("slack picker: a date range, since and until", async ({ page }) => {
  const form = await addForm(page, "slack");
  const picker = form.getByRole("group", { name: "Slack channels" });
  await picker.getByRole("checkbox", { name: "#product" }).check();
  await expect(picker.getByText("Narrowing the range removes messages outside it when you save.")).toBeVisible();

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
  await expect(row.getByTestId("source-picks")).toHaveText("#product");

  // Editing reopens the picker with both dates; clearing until keeps since.
  await row.getByRole("button", { name: "More actions for Q1 product chat" }).click();
  await row.getByRole("menuitem", { name: "Edit channels" }).click();
  const edit = row.getByRole("group", { name: "Slack channels" });
  await expect(edit.getByLabel("Since")).toHaveValue("2026-03-01");
  await expect(edit.getByLabel("Until")).toHaveValue("2026-03-31");
  await edit.getByLabel("Until").fill("");
  await row.getByRole("button", { name: "Save channels" }).click();
  await expect(row.getByRole("status")).toHaveText("Channels saved.");
  await row.getByRole("button", { name: "More actions for Q1 product chat" }).click();
  await row.getByRole("menuitem", { name: "Edit channels" }).click();
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

test("named picks: a Notion source's row lists its page titles (AC 10)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("notion");
  const picker = form.getByTestId("notion-picker");
  await picker.getByRole("checkbox", { name: "Product handbook", exact: true }).check();
  await picker.getByRole("checkbox", { name: "Team notes", exact: true }).check();
  await expect(picker.getByTestId("notion-picked-count")).toHaveText("2 picked");
  await form.getByLabel("Name").fill("Specs");
  await form.getByRole("button", { name: "Add source" }).click();

  const row = page.getByRole("listitem", { name: "Specs" });
  await expect(row.getByTestId("source-picks")).toHaveText("Product handbook, Team notes");
  await expect(row).not.toContainText("2 picked");
});

test("named picks: the row menus and the save read in plain words (AC 11)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("notion");
  await form.getByTestId("notion-picker").getByRole("checkbox", { name: "Product handbook", exact: true }).check();
  await form.getByLabel("Name").fill("Handbook");
  await form.getByRole("button", { name: "Add source" }).click();

  for (const [name, item] of [
    ["Product chat", "Edit channels"],
    ["Example repo", "Edit repositories"],
    ["Handbook", "Edit pages"],
  ] as const) {
    const row = page.getByRole("listitem", { name });
    await row.getByRole("button", { name: `More actions for ${name}` }).click();
    await expect(row.getByRole("menuitem", { name: item })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByText(/allowlist/i)).toHaveCount(0);

  const chat = page.getByRole("listitem", { name: "Product chat" });
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit channels" }).click();
  await expect(chat.getByRole("menuitem")).toHaveCount(0);
  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await expect(chat.getByRole("menuitem", { name: "Close channels" })).toBeVisible();
  await page.keyboard.press("Escape");
  await chat.getByRole("button", { name: "Save channels" }).click();
  await expect(chat.getByRole("status")).toHaveText("Channels saved.");
});

test("named picks: a source saved without names shows ids until it is saved again (AC 12)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await expect(chat.getByTestId("source-picks")).toHaveText("C0123PRODUCT, C0456FEEDBACK");
  await expect(chat.getByText("Channels", { exact: true })).toBeVisible();

  await chat.getByRole("button", { name: "More actions for Product chat" }).click();
  await chat.getByRole("menuitem", { name: "Edit channels" }).click();
  // Opening the editor lists the picks by name; nothing is ticked or unticked.
  await expect(chat.getByRole("checkbox", { name: "#customer-feedback" })).toBeChecked();
  await chat.getByRole("button", { name: "Save channels" }).click();
  await expect(chat.getByRole("status")).toHaveText("Channels saved.");
  await expect(chat.getByTestId("source-picks")).toHaveText("#product, #customer-feedback");
  expect(await savedConfig(page, "Product chat")).toEqual({
    channels: ["C0123PRODUCT", "C0456FEEDBACK"],
    labels: { C0123PRODUCT: "#product", C0456FEEDBACK: "#customer-feedback" },
  });
});

test("named picks: no field asks for ids one per line until Paste ids (AC 13)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const perLine = page.getByLabel(/\(one per line\)/);
  const form = page.getByRole("form", { name: "Add a source" });
  for (const kind of ["slack", "github", "notion"]) {
    await form.getByLabel("Kind").selectOption(kind);
    await expect(form.getByLabel("Connection")).toHaveValue(/.+/);
    await expect(perLine).toHaveCount(0);
  }
  const repo = page.getByRole("listitem", { name: "Example repo" });
  await repo.getByRole("button", { name: "More actions for Example repo" }).click();
  await repo.getByRole("menuitem", { name: "Edit repositories" }).click();
  await expect(repo.getByRole("checkbox", { name: "example-org/example-app" })).toBeChecked();
  await expect(perLine).toHaveCount(0);

  await repo.getByRole("button", { name: "Paste ids" }).click();
  await expect(perLine).toHaveCount(1);
  await expect(perLine).toBeVisible();
});

test("named picks: at 390 px five named channels stay on one line, the full list in its title (AC 14)", async ({ page }) => {
  const names = ["#product", "#customer-feedback", "#roadmap", "#general", "#design"];
  const form = await addForm(page, "slack");
  const picker = form.getByRole("group", { name: "Slack channels" });
  for (const name of names) await picker.getByRole("checkbox", { name }).check();
  await form.getByLabel("Name").fill("Five channels");
  await form.getByRole("button", { name: "Add source" }).click();
  const picks = page.getByRole("listitem", { name: "Five channels" }).getByTestId("source-picks");
  await expect(picks).toHaveText(names.join(", "));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picks).toHaveAttribute("title", names.join(", "));
  const box = await picks.evaluate((el) => ({
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    truncated: el.scrollWidth > el.clientWidth,
  }));
  expect(box).toEqual({ lines: 1, truncated: true });
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
});
