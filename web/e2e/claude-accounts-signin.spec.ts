import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// #405: the Add account panel had two look-alike "Sign in with Claude" controls (the dark
// one only picked the method; the real one looked disabled), and nothing showed which
// Claude account a sign-in added.

async function openAdd(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-claude-accounts").click();
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
  await page.getByRole("button", { name: "+ Add account" }).click();
  return page.getByTestId("add-account");
}

const fill = (el: Element) => getComputedStyle(el).backgroundColor;
const transparent = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";

test("claude accounts: the method is a choice and the one solid button in the panel starts the sign-in", async ({
  page,
}) => {
  const add = await openAdd(page);
  await add.getByLabel("Label").fill("team");

  // The method reads as a choice, not as buttons; nothing else says "Sign in with Claude".
  const method = add.getByRole("radiogroup", { name: "How to add it" });
  await expect(method.getByRole("radio", { name: "Sign in with Claude" })).toBeChecked();
  await expect(method.getByRole("radio", { name: "Paste Claude Code's saved login" })).not.toBeChecked();
  await expect(add.getByRole("tab")).toHaveCount(0);
  await expect(add.getByRole("button", { name: "Sign in with Claude" })).toHaveCount(0);

  // One action, enabled and filled; no other button in the panel has its fill.
  const open = add.getByRole("button", { name: "Open Claude's sign-in page" });
  await expect(open).toBeEnabled();
  const accent = await open.evaluate(fill);
  expect(transparent(accent)).toBe(false);
  const fills = await add.getByRole("button").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(fills.filter((c) => c === accent)).toHaveLength(1);
  await expect(add).toContainText(
    "Claude adds the account signed in on that page. To add a different one, open the link in a browser signed in to it",
  );

  // It starts the sign-in: Claude's page opens.
  const popup = page.waitForEvent("popup");
  await open.click();
  await (await popup).close();
  await expect(add.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", /claude\.com\/cai\/oauth\/authorize/);
  await expect(add.getByLabel("Code from the Claude page")).toBeVisible();
});

test("claude accounts: Copy link copies the authorize URL, and the inspector names the Claude account after the exchange", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const add = await openAdd(page);
  await add.getByLabel("Label").fill("team");

  // Copy link starts the sign-in without opening it here, for a browser signed in to another account.
  await add.getByRole("button", { name: "Copy link" }).click();
  const link = add.getByRole("link", { name: "Open", exact: true });
  await expect(link).toHaveAttribute("href", /claude\.com\/cai\/oauth\/authorize/);
  const href = await link.getAttribute("href");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);
  await expect(add.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  // Beside Open, and the line stays while the code is awaited.
  await add.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);
  await expect(add).toContainText("To add a different one, open the link in a browser signed in to it");

  await add.getByLabel("Code from the Claude page").fill("c0de-from-claude");
  await add.getByRole("button", { name: "Finish sign-in" }).click();
  const done = add.getByTestId("signin-done");
  await expect(done).toContainText("team is available");
  await expect(done).toContainText("Claude account: team@example.com · Example Studio");

  await page.getByTestId("account-row-team").getByRole("button").click();
  const detail = page.getByTestId("account-detail");
  await expect(detail.getByTestId("fact-claude-account")).toContainText("team@example.com");
  await expect(detail.getByTestId("fact-claude-account")).toContainText("Example Studio");
});

test("claude accounts: a pasted saved login says the Claude account is not known", async ({ page }) => {
  const add = await openAdd(page);
  await add.getByLabel("Label").fill("laptop-3");
  await add.getByRole("radio", { name: "Paste Claude Code's saved login" }).check();
  await add
    .getByLabel("Saved login", { exact: true })
    .fill('{"claudeAiOauth": {"accessToken": "a", "refreshToken": "r", "expiresAt": 1}}');
  await add.getByRole("button", { name: "Add account" }).click();
  await page.getByTestId("account-row-laptop-3").getByRole("button").click();
  await expect(page.getByTestId("account-detail").getByTestId("fact-claude-account")).toContainText("Not reported");
});
