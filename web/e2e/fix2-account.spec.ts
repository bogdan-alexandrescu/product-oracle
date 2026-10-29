import { expect, test, type Locator } from "./test";

import { login } from "./helpers";

test.use({ viewport: { width: 1440, height: 900 } });

const DATE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;

/** Every cell of these rows that shows a date: whole ("Sep 28, 2026"), never cut. */
async function datesWhole(rows: Locator) {
  const cells = await rows.locator("td").evaluateAll((tds) =>
    tds.map((td) => ({ text: (td.textContent ?? "").trim(), cut: td.scrollWidth > td.clientWidth })),
  );
  const dates = cells.filter((c) => DATE.test(c.text));
  expect(dates.length).toBeGreaterThan(0);
  for (const d of dates) expect(d, `${d.text} is cut`).toEqual({ text: d.text, cut: false });
}

/** Scopes read as plain chips, none cut, no raw codes in monospace. */
async function scopesPlain(panel: Locator) {
  await expect(panel.locator(".font-mono")).toHaveCount(0);
  await expect(panel).not.toContainText("oracle:");
  const chips = panel.getByTestId("token-scopes").locator("[data-kind]");
  expect(await chips.count()).toBeGreaterThan(0);
  const cut = await chips.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cut).toEqual([]);
  // The cell holding them does not clip them either.
  const clipped = await panel
    .getByTestId("token-scopes")
    .evaluateAll((els) => els.filter((e) => e.closest("td")!.scrollWidth > e.closest("td")!.clientWidth).length);
  expect(clipped).toBe(0);
}

test("qa-settings-12/28/30: /account token tables show whole dates, plain scopes, and counts that match", async ({ page }) => {
  await login(page);
  await page.goto("/account");

  const tokens = page.getByTestId("tokens-panel");
  const tokenRows = page.getByTestId("my-token-row");
  await expect(tokenRows).toHaveCount(2);
  // qa-settings-30: one active of two rows, said as such.
  await expect(tokens.getByTestId("panel-count")).toHaveText("1 active · 2 total");
  await expect(tokenRows.filter({ hasText: "staging sync" })).toContainText("Sep 28, 2026");
  await datesWhole(tokenRows);
  // qa-settings-28: plain chips.
  await expect(tokenRows.filter({ hasText: "agent-track" }).getByTestId("token-scopes")).toHaveText("Read & write");
  await expect(tokenRows.filter({ hasText: "staging sync" }).getByTestId("token-scopes")).toHaveText("Read");
  await scopesPlain(tokens);
  // The create form's scope boxes are plain words too.
  const form = page.getByRole("form", { name: "Create a token" });
  await expect(form.getByRole("checkbox", { name: "Read" })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "Write" })).not.toBeChecked();

  const clients = page.getByTestId("clients-panel");
  const clientRows = page.getByTestId("my-client-row");
  await expect(clientRows).toHaveCount(2);
  await expect(clients.getByTestId("panel-count")).toHaveText("1 active · 2 total");
  await datesWhole(clientRows);
  await expect(clientRows.filter({ hasText: "Claude Desktop" }).getByTestId("token-scopes")).toHaveText("Read & write");
  await scopesPlain(clients);
});

test("qa-settings-28/29: Settings > API tokens names a run token by its flow and shows plain scopes", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  const rows = page.getByTestId("token-row");
  await expect(rows.first()).toBeVisible();
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Run" }).click();
  await expect(rows).toHaveCount(1);
  const run = rows.first();
  await expect(run).toContainText("Run · Baseline to PRD");
  await expect(run).not.toContainText("baseline to prd");
  await expect(run.getByTestId("token-scopes")).toHaveText("Read & draft");
  await expect(run).not.toContainText("read:baseline");
  await expect(run.getByTestId("token-scopes").locator("[data-kind]")).toHaveAttribute("title", /Read the baseline/);

  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "All" }).click();
  await expect(rows.filter({ hasText: "laptop cli" }).getByTestId("token-scopes")).toHaveText("Read");
  await expect(page.locator("table .font-mono")).toHaveCount(0);
  await datesWhole(rows);
});

test("qa-settings-28: the consent screen names scopes in plain words, as the tables do", async ({ page }) => {
  await login(page);
  await page.goto("/oauth/consent?request=mock-handle");
  const consent = page.getByTestId("consent");
  await expect(consent.locator('[data-scope="oracle:read"]')).toHaveText("Read");
  await expect(consent.locator('[data-scope="oracle:write"]')).toHaveText("Write");
  await expect(consent.locator(".font-mono").filter({ hasText: "oracle:" })).toHaveCount(0);
  await expect(consent).not.toContainText("oracle:read");
});
