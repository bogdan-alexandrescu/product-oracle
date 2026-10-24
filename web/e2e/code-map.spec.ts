import { expect, type Page, test } from "./test";

import { login } from "./helpers";

/**
 * F5-2 code maps on the mock layer: Settings › Sources' GitHub row maps each repo's code
 * (a code_map run), shows the map's state and who sees it, and its owner shares it with
 * the company or makes it private again. The fake runtime stands in for the indexer (the
 * mock finishes the run on its next read, docs only while the checkout is not
 * available); no model is called and no repository is read.
 */

const REPO = "example-org/example-app";

async function repoRow(page: Page) {
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Example repo" });
  await expect(row).toBeVisible();
  return row.getByTestId(`code-map-${REPO}`);
}

test("a GitHub source maps its code, then its owner shares the map with the company", async ({ page }) => {
  // protects=AC11 Map the code on a GitHub source row, the map's state after the run,
  // Private until shared, Share with the company and Make private; fails_when=the row
  // has no Map the code, never shows the ready map, or sharing does not change what the
  // row says; no_claim=what the map says of the code (the mock writes it).
  await login(page);
  const line = await repoRow(page);
  await expect(line).toContainText(REPO);
  await expect(line).toContainText("No code map yet");
  await line.getByRole("button", { name: "Map the code" }).click();
  await expect(line).toContainText("Code map: building");

  // The row checks again while the map builds; the mock's run then finishes.
  await expect(line).toContainText("Code map: ready · Private", { timeout: 15_000 });
  await expect(line).toContainText("Docs only: code not read");
  await expect(line.getByRole("button", { name: "Map the code" })).toHaveCount(0);

  await line.getByRole("button", { name: "Share with the company" }).click();
  const ask = page.getByRole("alertdialog", { name: "Share" });
  await expect(ask).toContainText("everyone in the company can read it and runs use it");
  await ask.getByRole("button", { name: "Share" }).click();
  await expect(line).toContainText("Code map: ready · Shared with the company");

  // It stays shared after a reload.
  await page.reload();
  const again = page.getByRole("listitem", { name: "Example repo" }).getByTestId(`code-map-${REPO}`);
  await expect(again).toContainText("Code map: ready · Shared with the company");
  await again.getByRole("button", { name: "Make private" }).click();
  await expect(again).toContainText("Code map: ready · Private");
  await expect(again.getByRole("button", { name: "Share with the company" })).toBeVisible();
});

test("only GitHub sources offer a code map", async ({ page }) => {
  // protects=Map the code is for repos only; fails_when=a chat or upload row offers it.
  await login(page);
  await page.goto("/settings/sources");
  const chat = page.getByRole("listitem", { name: "Product chat" });
  await expect(chat).toBeVisible();
  await expect(chat.getByRole("button", { name: "Map the code" })).toHaveCount(0);
});

test("a brief resting on a docs-only map says so", async ({ page }) => {
  // protects=the docs-only label where a brief cites a partial map; fails_when=a brief
  // built from docs reads as resting on the code.
  await login(page);
  await page.goto("/documents/checkout-redesign");
  await page.getByTestId("tech-briefs").getByRole("link", { name: "Show the full price early" }).click();
  await expect(page.getByTestId("brief-code-map")).toContainText("Docs only: code not read");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the source row's code map line fits without horizontal scroll", async ({ page }) => {
    // protects=AC15 for the code map line; fails_when=the repo name or the buttons widen
    // the page past 390 px.
    await login(page);
    const line = await repoRow(page);
    await line.getByRole("button", { name: "Map the code" }).click();
    await expect(line).toContainText("Code map: ready · Private", { timeout: 15_000 });
    await expect(line.getByRole("button", { name: "Share with the company" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
