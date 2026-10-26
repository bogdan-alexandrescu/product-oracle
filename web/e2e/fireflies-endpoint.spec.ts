import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

const CUSTOM = "https://ff.example.com/graphql";

async function openConnections(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-connections").click();
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  return page.getByTestId("connection-card-fireflies");
}

async function pasteKey(page: Page, endpoint: string) {
  const card = page.getByTestId("connection-card-fireflies");
  await card.getByRole("button", { name: "Paste a token" }).click();
  const form = card.getByRole("form", { name: "Fireflies token" });
  await form.getByLabel("Token").fill("ff-example-key");
  await form.getByLabel("GraphQL endpoint (optional)").fill(endpoint);
  await form.getByRole("button", { name: "Connect" }).click();
  return form;
}

test("fireflies endpoint: an owner sets it and sees it on the source; an approver sees it but cannot change it", async ({ page }) => {
  await login(page);
  const card = await openConnections(page);
  await pasteKey(page, CUSTOM);
  const accounts = card.getByRole("list", { name: "Fireflies accounts" });
  await expect(accounts).toContainText(`Endpoint: ${CUSTOM}`);

  // Changed again, with the key entered again.
  await accounts.getByRole("button", { name: "Change endpoint" }).click();
  const change = accounts.getByRole("form", { name: "pat@example.com endpoint" });
  await change.getByLabel("GraphQL endpoint").fill("https://ff.example.com/v2/graphql");
  await change.getByLabel("API key, again").fill("ff-example-key");
  await change.getByRole("button", { name: "Save endpoint" }).click();
  await expect(accounts).toContainText("Endpoint: https://ff.example.com/v2/graphql");

  // The source reading it shows which endpoint it reads.
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  await expect(page.getByRole("listitem", { name: "Customer calls" })).toContainText("Reads https://ff.example.com/v2/graphql");

  // So does the source's coverage on the Sources page (#602 review).
  await page.goto("/sources");
  await page.getByTestId("coverage-table").locator("tr[data-row]").filter({ hasText: "Customer calls" }).click();
  await expect(page.getByTestId("coverage-inspector").getByTestId("coverage-endpoint")).toHaveText("https://ff.example.com/v2/graphql");
  await page.goto("/settings/sources");

  // An approver sees it, with no way to change it or to set one.
  await page.evaluate(([k, r]) => localStorage.setItem(k, r), [MOCK_ROLE_KEY, "approver"] as const);
  await page.reload();
  await expect(page.getByRole("listitem", { name: "Customer calls" })).toContainText("Reads https://ff.example.com/v2/graphql");
  await openConnections(page);
  await expect(accounts).toContainText("Endpoint: https://ff.example.com/v2/graphql");
  await expect(accounts.getByRole("button", { name: "Change endpoint" })).toHaveCount(0);
  await card.getByRole("button", { name: "Paste a token" }).click();
  await expect(card.getByRole("form", { name: "Fireflies token" }).getByLabel("Token")).toBeVisible();
  await expect(card.getByLabel("GraphQL endpoint (optional)")).toHaveCount(0);
});

test("fireflies endpoint: an http:// or private-address URL shows the API's refusal in words", async ({ page }) => {
  await login(page);
  const card = await openConnections(page);
  const form = await pasteKey(page, "http://ff.example.com/graphql");
  await expect(form).toContainText("The endpoint must be an https:// URL.");
  await form.getByLabel("GraphQL endpoint (optional)").fill("https://10.0.0.5/graphql");
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(form).toContainText("private, local or internal network address");
  // An octal, hex or shortened IP address is refused in words too (#602 review).
  await form.getByLabel("GraphQL endpoint (optional)").fill("https://0177.0.0.1/graphql");
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(form).toContainText("private, local or internal network address");
  await form.getByLabel("GraphQL endpoint (optional)").fill("https://0x5db8d822/graphql");
  await form.getByRole("button", { name: "Connect" }).click();
  await expect(form).toContainText("write it as four decimal numbers");
  await expect(card.getByText("Not connected")).toBeVisible();
});
