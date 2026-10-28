import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass on Settings › Sources (qa-settings-27, prod-11, qa-settings-32), driven as a person
 * would on the mock layer.
 */

const SOURCES_KEY = "po-mock-sources-v2";

async function openSources(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  await expect(page).toHaveURL(/\/settings\/sources$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
}

test("qa-settings-27: counts read as words, Slack channels by name, no ids", async ({ page }) => {
  await openSources(page);
  const chat = page.getByRole("listitem", { name: "Product chat" });
  // "2 items", never "2 item(s)".
  await expect(chat.getByTestId("source-items")).toHaveText("2 items");
  await expect(page.getByText(/item\(s\)/)).toHaveCount(0);
  // One source in error: "1 error" in the stats, not "1 Errors".
  await expect(page.getByTestId("stat-errors")).toContainText("Error");
  await expect(page.getByTestId("stat-errors")).not.toContainText("Errors");
  await expect(page.getByTestId("stat-errors")).toContainText("1");
  // Channels by name, from the connection's channel list: never C0123PRODUCT.
  await expect(chat.getByTestId("source-picks")).toHaveText("#product, #customer-feedback");
  await expect(chat).not.toContainText("C0123PRODUCT");
  // A channel left out reads by its name too.
  await expect(chat.getByRole("list", { name: "Unreadable files of Product chat" })).toContainText("#partner-launch");
  await expect(chat).not.toContainText("C0777PARTNER");
});

test("qa-settings-27: a Fireflies source does not name Fireflies' own API address", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-connections").click();
  const card = page.getByTestId("connection-card-fireflies");
  await card.getByRole("button", { name: "Paste a token" }).click();
  const form = card.getByRole("form", { name: "Fireflies token" });
  await form.getByLabel("Token", { exact: true }).fill("ff-example-key");
  await form.getByRole("button", { name: "Connect" }).click();
  const accounts = card.getByRole("list", { name: "Fireflies accounts" });
  await expect(accounts).toContainText("pat@example.com");
  // The connection's row says no endpoint either: the default one goes unsaid.
  await expect(accounts).not.toContainText("api.fireflies.ai");
  await expect(accounts).not.toContainText("Endpoint:");

  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  const calls = page.getByRole("listitem", { name: "Customer calls" });
  await expect(calls).toBeVisible();
  await expect(calls).not.toContainText("api.fireflies.ai");
  await expect(calls).not.toContainText(/Reads https?:/);
  await expect(calls.getByTestId("fireflies-endpoint")).toHaveCount(0);
});

test("prod-11: a large source reads 10,437 items, with the thousands separated", async ({ page }) => {
  await openSources(page);
  await expect(page.getByRole("listitem", { name: "Product chat" })).toBeVisible();
  // Another sync grew the source while this page was closed.
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    db.sources.find((s: { name: string }) => s.name === "Product chat").item_count = 10437;
    localStorage.setItem(key, JSON.stringify(db));
  }, SOURCES_KEY);
  await page.reload();
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await expect(chat.getByTestId("source-items")).toHaveText("10,437 items");
  await expect(page.getByTestId("stat-items")).toContainText(/1\d,\d{3}/);
  await expect(page.getByText("10437")).toHaveCount(0);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`qa-settings-32 (${viewport.name}): Add source says what is missing beside it`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openSources(page);
    const form = page.getByRole("form", { name: "Add a source" });
    const add = form.getByRole("button", { name: "Add source" });
    const why = form.getByTestId("add-source-why");

    // Upload: only a name is missing.
    await expect(add).toBeDisabled();
    await expect(why).toHaveText("Give the source a name.");
    await expect(add).toHaveAccessibleDescription("Give the source a name.");
    await form.getByLabel("Name").fill("Research notes");
    await expect(add).toBeEnabled();
    await expect(why).toHaveCount(0);

    // Notion with nothing ticked: the pages are missing, said before the name.
    await form.getByLabel("Kind").selectOption("notion");
    await expect(add).toBeDisabled();
    await expect(why).toHaveText("Tick at least one page.");

    // Fireflies with nothing picked.
    await form.getByLabel("Kind").selectOption("fireflies");
    await expect(add).toBeDisabled();
    await expect(why).toHaveText("Pick the meetings or series to pull in.");
    // Beside the button, whole: on a phone it wraps under it rather than running off the screen.
    await why.scrollIntoViewIfNeeded();
    await expect(why).toBeInViewport({ ratio: 1 });
  });
}
