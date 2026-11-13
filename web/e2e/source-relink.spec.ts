import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * source-relink (owner Nov 3): a source whose connection was deleted (Disconnect) says so on
 * its card and offers the person's connections of the same provider, one click to link it;
 * with none, where to make one. The same person connecting the same account again links it
 * by itself. Edit meetings says what the card says.
 */

const REPO = "Example repo";
const CALLS = "Customer calls";
const NONE_YET = (provider: string) =>
  `This source has no connection. Connect ${provider} in Settings › Connections, then pick it here.`;
const PICK = (provider: string) =>
  `This source has no connection. Pick one of your ${provider} connections to sync it again.`;

const shots = process.env.SWARM_ARTIFACTS_DIR
  ? `${process.env.SWARM_ARTIFACTS_DIR}/screens/after`
  : null;

async function connections(page: Page, provider: string) {
  await page.goto("/settings/connections");
  await expect(
    page.getByRole("heading", { level: 1, name: "Connections" }),
  ).toBeVisible();
  return page.getByTestId(`connection-card-${provider}`);
}

async function disconnect(page: Page, provider: string) {
  const card = await connections(page, provider);
  await card.getByRole("button", { name: "Disconnect" }).click();
  await card.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(card).toContainText("Not connected");
}

async function connectToken(page: Page, provider: string, token: string) {
  const card = await connections(page, provider);
  await card
    .getByRole("button", { name: /Paste a token|Add another account/ })
    .click();
  // A provider with sign-in first offers the choice of signing in or a token.
  const choice = card.getByRole("group", { name: /^Add an? / });
  await expect(card.getByLabel("Token", { exact: true }).or(choice)).toBeVisible();
  if (await choice.isVisible()) await choice.getByRole("button", { name: "Paste a token" }).click();
  await card.getByLabel("Token", { exact: true }).fill(token);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Disconnect" }).first(),
  ).toBeVisible();
}

async function sourceRow(page: Page, name: string) {
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name });
  await expect(row).toBeVisible();
  return row;
}

/** Light and dark of what `row` shows now, at the test's size. */
async function capture(
  page: Page,
  row: ReturnType<Page["getByRole"]>,
  name: string,
  size: string,
) {
  const width = page.viewportSize()!.width;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(
      (t) => document.documentElement.setAttribute("data-theme", t),
      theme,
    );
    await row.scrollIntoViewIfNeeded();
    // Nothing on the card runs past the screen's width.
    const box = await row.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    if (shots)
      await page.screenshot({ path: `${shots}/${name}-${size}-${theme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "light"),
  );
}

for (const [size, viewport] of [
  ["1440", { width: 1440, height: 900 }],
  ["390", { width: 390, height: 844 }],
] as const) {
  test.describe(`at ${size}px`, () => {
    test.use({ viewport });

    test("source relink: after Disconnect the card offers another connection, Use links it and Sync now works", async ({
      page,
    }) => {
      await login(page);
      await disconnect(page, "github");

      // No GitHub connection left: the card says where to make one.
      let row = await sourceRow(page, REPO);
      let block = row.getByTestId("source-no-connection");
      await expect(block).toHaveText(NONE_YET("GitHub"));
      await expect(
        block.getByRole("link", { name: "Settings › Connections" }),
      ).toHaveAttribute("href", "/settings/connections");
      await expect(block.getByRole("button", { name: /^Use / })).toHaveCount(0);
  // Its old error stays, but no Reconnect beside it: the block says what to do.
  await expect(row.getByTestId("source-reconnect")).toHaveCount(0);
      await capture(page, row, "source-relink-none", size);
      await block.getByRole("link", { name: "Settings › Connections" }).click();
      await expect(page).toHaveURL(/\/settings\/connections$/);

      // Another GitHub account: never linked by itself, offered as a choice.
      await connectToken(page, "github", "example-github-token-2");
      row = await sourceRow(page, REPO);
      block = row.getByTestId("source-no-connection");
      await expect(block).toContainText(PICK("GitHub"));
      const use = block.getByRole("button", { name: "Use example-user" });
      await expect(use).toBeVisible();
      await capture(page, row, "source-relink-choice", size);

      await use.click();
      await expect(row.getByTestId("source-no-connection")).toHaveCount(0);
      await expect(
        row.getByText("Linked to example-user. Sync now to read it again."),
      ).toBeVisible();
      await row.getByRole("button", { name: "Sync now" }).click();
      await expect(row.getByText(/^Synced/)).toBeVisible();
      await expect(row.getByTestId("source-status")).toHaveText("Active");
      await capture(page, row, "source-relink-synced", size);

      // Linked: a reload keeps it.
      row = await sourceRow(page, REPO);
      await expect(row.getByTestId("source-no-connection")).toHaveCount(0);
    });

    test("source relink: Fireflies' card and Edit meetings agree, and connecting the same account again links it", async ({
      page,
    }) => {
      await login(page);
      await connectToken(page, "fireflies", "example-fireflies-1");
      await disconnect(page, "fireflies");

      let row = await sourceRow(page, CALLS);
      const block = row.getByTestId("source-no-connection");
      await expect(block).toHaveText(NONE_YET("Fireflies"));
      await row
        .getByRole("button", { name: `More actions for ${CALLS}` })
        .click();
      await row.getByRole("menuitem", { name: "Edit meetings" }).click();
      // Edit meetings shows the same words, and no picker it could not fill.
      await expect(row.getByTestId("source-no-connection")).toHaveText(
        NONE_YET("Fireflies"),
      );
      await expect(
        row.getByRole("button", { name: "Save meetings" }),
      ).toHaveCount(0);
      await expect(row).not.toContainText("reconnect Fireflies first");
      await capture(page, row, "source-relink-fireflies-edit", size);

      // The same Fireflies account again: the source is linked by itself and syncs.
      await connectToken(page, "fireflies", "example-fireflies-2");
      row = await sourceRow(page, CALLS);
      await expect(row.getByTestId("source-no-connection")).toHaveCount(0);
      await row.getByRole("button", { name: "Sync now" }).click();
      await expect(row.getByText(/^Synced/)).toBeVisible();
    });
  });
}
